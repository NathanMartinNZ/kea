//! The launcher: `kea-helper pty …` starts itself as `kea-helper pty-daemon … --ready-fd 3`, detached
//! (`os::spawn_detached`: a session of its own, stdio on `/dev/null`, every other fd closed; on macOS with
//! responsibility disclaimed), waits for `READY <pid> <childPid>` / `ERR <message>` on fd 3, prints one JSON line
//! and exits. Where the OS layer has a scope to put it in (Linux with a systemd user manager), the daemon is
//! started through that command (`systemd-run --user --scope … -- <daemon>`, which execs it in place: same pid, same
//! fd 3); when that command ends before the daemon's `READY`, or has not brought it to `READY` within
//! `SCOPE_START_TIMEOUT_MS` (a user manager that takes the connection and never answers), it is killed and the daemon
//! is spawned directly (session mode). `--no-detach` runs the holder in this process instead.

use std::ffi::{CString, OsString};
use std::io::Write;
use std::os::fd::{AsRawFd, RawFd};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::args::parse_pty;
use crate::limits::SCOPE_START_TIMEOUT_MS;
use crate::sys::cstring;

pub const DAEMON_SUBCOMMAND: &str = "pty-daemon";
/// The fd the daemon reports readiness on.
pub const READY_FD: RawFd = 3;

pub fn print_json_line(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn error_json(msg: &str) -> String {
    let mut s = String::from("{\"error\":");
    crate::holder::state::json_str(&mut s, msg.as_bytes());
    s.push('}');
    s
}

/// `kea-helper pty …`.
pub fn pty_main(raw: &[OsString]) -> i32 {
    let args = match parse_pty(raw, false) {
        Ok(a) => a,
        Err(e) => {
            print_json_line(&error_json(&e));
            return 1;
        }
    };
    if args.no_detach {
        return crate::holder::run_holder(args);
    }
    // The daemon gets the same arguments byte for byte, plus `--ready-fd 3` before the `--`.
    let mut daemon_args: Vec<OsString> = vec![DAEMON_SUBCOMMAND.into()];
    daemon_args.extend_from_slice(&raw[..args.separator]);
    daemon_args.extend(["--ready-fd".into(), READY_FD.to_string().into()]);
    daemon_args.extend_from_slice(&raw[args.separator..]);
    // the home whose holder this is: `--dir` is `<KEA_HOME>/sessions/<sessionId>`; it names the scope
    let home = args.dir.parent().and_then(Path::parent).unwrap_or(&args.dir);
    match spawn_daemon(&daemon_args, crate::os::scope_command(home, &args.id)) {
        Ok((pid, child)) => {
            print_json_line(&format!("{{\"pid\":{pid},\"childPid\":{child}}}"));
            0
        }
        Err(e) => {
            print_json_line(&error_json(&e));
            1
        }
    }
}

/// What one spawn of the daemon came to.
enum Ready {
    /// `READY <pid> <childPid>`.
    Ready(i32, i32),
    /// `ERR <message>`, or a line that is neither.
    Failed(String),
    /// The pipe closed with no line, or the deadline passed and what was spawned was killed: it has ended (and is
    /// reaped).
    Ended,
}

/// Spawns the daemon, in the scope `scope` names when there is one, and waits for its ready line. A scope that ends
/// before the daemon is ready (`systemd-run` found no manager to talk to, or the unit's name was taken), or is not
/// ready within `SCOPE_START_TIMEOUT_MS` (a manager that never answers), leaves the daemon to start directly, in a
/// session of its own.
fn spawn_daemon(args: &[OsString], scope: Option<Vec<CString>>) -> Result<(i32, i32), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate kea-helper: {e}"))?;
    let exe_c = cstring(exe.as_os_str()).map_err(|e| e.to_string())?;
    let mut daemon: Vec<CString> = vec![exe_c.clone()];
    for a in args {
        daemon.push(cstring(a).map_err(|e| e.to_string())?);
    }
    if let Some(mut argv) = scope {
        let run = argv[0].clone();
        argv.extend(daemon.iter().cloned());
        match spawn_once(&run, &argv, Some(Duration::from_millis(SCOPE_START_TIMEOUT_MS))) {
            Ok(Ready::Ready(p, c)) => return Ok((p, c)),
            Ok(Ready::Failed(msg)) => return Err(msg),
            // `systemd-run` could not start, or ended without starting the daemon: session mode
            Ok(Ready::Ended) | Err(_) => {}
        }
    }
    match spawn_once(&exe_c, &daemon, None)? {
        Ready::Ready(p, c) => Ok((p, c)),
        Ready::Failed(msg) => Err(msg),
        Ready::Ended => Err("the holder exited before it was ready".into()),
    }
}

/// One detached spawn of `argv` (`argv[0]` run as `file`), with a fresh ready pipe on fd 3. An error names the call
/// that failed, `pipe` or `posix_spawn <file>`, as ptyhost reads it. With a `deadline`, what was spawned and
/// has written no line by then is killed (it is the launcher's child, so its pid is still its own) and reaped: `Ended`.
fn spawn_once(file: &CString, argv: &[CString], deadline: Option<Duration>) -> Result<Ready, String> {
    let mut ptrs: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let (rd, wr) = crate::sys::pipe_cloexec().map_err(|e| format!("pipe: {e}"))?;
    let pid = unsafe { crate::os::spawn_detached(file, &ptrs, &wr, READY_FD) }.map_err(|e| format!("posix_spawn {}: {e}", file.to_string_lossy()))?;
    drop(wr);

    let mut line = Vec::new();
    let mut buf = [0u8; 512];
    let until = deadline.map(|d| Instant::now() + d);
    loop {
        if let Some(until) = until {
            let mut pfd = libc::pollfd { fd: rd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let left = until.saturating_duration_since(Instant::now()).as_millis().min(i32::MAX as u128) as i32;
            let r = unsafe { libc::poll(&mut pfd, 1, left) };
            if r < 0 && crate::sys::errno() == libc::EINTR {
                continue;
            }
            if r == 0 {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                let mut status = 0;
                while unsafe { libc::waitpid(pid, &mut status, 0) } < 0 && crate::sys::errno() == libc::EINTR {}
                return Ok(Ready::Ended);
            }
        }
        let n = unsafe { libc::read(rd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n < 0 && crate::sys::errno() == libc::EINTR {
            continue;
        }
        if n <= 0 {
            break;
        }
        line.extend_from_slice(&buf[..n as usize]);
        if line.contains(&b'\n') {
            break;
        }
    }
    let line = String::from_utf8_lossy(&line);
    let line = line.lines().next().unwrap_or("");
    if let Some(rest) = line.strip_prefix("READY ") {
        let mut it = rest.split(' ').map(str::parse::<i32>);
        if let (Some(Ok(p)), Some(Ok(c))) = (it.next(), it.next()) {
            return Ok(Ready::Ready(p, c));
        }
    }
    if line.is_empty() {
        // The pipe closed with nothing on it: every copy of its write end is gone, so what was spawned has exited or is
        // exiting (the daemon closes it only after its line). Reaped here: it is this process's child.
        let mut status = 0;
        while unsafe { libc::waitpid(pid, &mut status, 0) } < 0 && crate::sys::errno() == libc::EINTR {}
        return Ok(Ready::Ended);
    }
    // Failed: reap the daemon if it already exited (it is this process's child).
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    Ok(Ready::Failed(match line.strip_prefix("ERR ") {
        Some(msg) => msg.to_string(),
        None => format!("unexpected ready line {line:?}"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(script: &str) -> (CString, Vec<CString>) {
        let sh = CString::new("/bin/sh").unwrap();
        (sh.clone(), vec![sh, CString::new("-c").unwrap(), CString::new(script).unwrap()])
    }

    // The launcher's wait for a ready line: a line in time is read; a spawn that writes none by the deadline
    // (`systemd-run` held by a user manager that never answers) is killed and reaped, and reads as ended, so the daemon
    // starts in session mode well within ptyhost's time for a launch; without a deadline (the direct spawn, and every
    // launch on macOS) it waits for a line or the pipe's end.
    #[test]
    fn r_plt_5_a_scope_spawn_that_stays_silent_past_the_deadline_is_killed_and_reads_as_ended() {
        let (sh, ready) = argv("echo 'READY 11 12' >&3");
        assert!(matches!(spawn_once(&sh, &ready, Some(Duration::from_secs(5))), Ok(Ready::Ready(11, 12))));
        let (sh, silent) = argv("exec sleep 600");
        let started = Instant::now();
        assert!(matches!(spawn_once(&sh, &silent, Some(Duration::from_millis(200))), Ok(Ready::Ended)));
        assert!(started.elapsed() < Duration::from_millis(SCOPE_START_TIMEOUT_MS), "killed at its deadline: {:?}", started.elapsed());
        let (sh, quits) = argv("exit 3");
        assert!(matches!(spawn_once(&sh, &quits, None), Ok(Ready::Ended)), "no deadline: the pipe's end");
        let (sh, err) = argv("echo 'ERR no terminal' >&3");
        assert!(matches!(spawn_once(&sh, &err, None), Ok(Ready::Failed(m)) if m == "no terminal"));
    }
}
