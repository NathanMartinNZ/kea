//! Linux's holder tests: a holder in a systemd user scope of its own outlives the scope Kea runs in, and falls back to
//! a session of its own where no user manager answers (I-PLT-1); nothing of its own user can reach into it (I-PLT-2).

use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::common::*;

const SYSTEMCTL: &str = "/usr/bin/systemctl";
const SYSTEMD_RUN: &str = "/usr/bin/systemd-run";
/// Present while systemd is the init system.
const SYSTEMD_BOOTED: &str = "/run/systemd/system";

/// Does a systemd user manager answer here?
fn user_manager() -> bool {
    let status = Command::new(SYSTEMCTL).args(["--user", "show", "-p", "Version"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    status.is_ok_and(|s| s.success())
}

/// `systemctl` with `args`, which must succeed; its output, trimmed.
fn systemctl(args: &[&str]) -> String {
    let out = Command::new(SYSTEMCTL).args(args).output().unwrap();
    assert!(out.status.success(), "systemctl {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// The systemd unit `pid` runs in: the last part of its cgroup v2 path.
fn unit_of(pid: i32) -> String {
    let cg = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    let path = cg.lines().find_map(|l| l.strip_prefix("0::")).unwrap();
    path.rsplit('/').next().unwrap().to_owned()
}

/// Waits until `pid` runs the program named `comm`: a holder's child is the holder's own copy, not dumpable,
/// until its `execve`, so its `environ` cannot be read before that.
fn wait_exec(pid: i32, comm: &str) {
    wait_until("the agent's exec", T, || std::fs::read_to_string(format!("/proc/{pid}/comm")).is_ok_and(|c| c.trim() == comm));
}

/// Does `pid`'s environment (as its `execve` set it) have `var`?
fn environ_has(pid: i32, var: &str) -> bool {
    let env = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
    env.split(|&b| b == 0).any(|e| e.starts_with(format!("{var}=").as_bytes()))
}

/// The scope a holder of `h`'s puts itself in: `kea-<8 hex of the home's hash>-<ptyId>.scope`, the home being
/// `--dir`'s grandparent.
fn holder_scope(h: &Holder) -> String {
    let home = h.state_dir.parent().and_then(Path::parent).unwrap();
    let hash = format!("{:016x}", kea_helper::rundir::fnv1a64(home.as_os_str().as_bytes()));
    format!("kea-{}-{}.scope", &hash[..8], h.id)
}

/// Kea's stand-in: `/bin/sh` that runs the launcher for `o` (its line into `out.json`) and then stays, as Kea's main
/// does, or quits (`stay` false: a plain quit). Started through `wrap` (`systemd-run --user --scope`, as a desktop
/// starts an app), or directly when it is empty.
fn launch_from_kea(o: &Opts, wrap: &[&str], stay: bool) -> (Holder, Child) {
    let (tmp, root) = tmpdir();
    let id = new_pty_id();
    let launch = launcher(o, &root, &id);
    // a fixed script; the launcher's argv reaches it as positional parameters, never quoted into it
    let script = if stay { r#""$0" "$@" > out.json; exec /bin/sleep 1000"# } else { r#""$0" "$@" > out.json"# };
    let mut kea = match wrap.split_first() {
        Some((run, rest)) => {
            let mut c = Command::new(run);
            c.args(rest).arg("/bin/sh");
            c
        }
        None => Command::new("/bin/sh"),
    };
    kea.args(["-c", script]).arg(launch.get_program()).args(launch.get_args());
    for (var, v) in launch.get_envs() {
        match v {
            Some(v) => kea.env(var, v),
            None => kea.env_remove(var),
        };
    }
    let kea = kea.current_dir(&root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().unwrap();
    let out = root.join("out.json");
    wait_until("launcher output", T, || std::fs::read_to_string(&out).is_ok_and(|t| t.ends_with('\n')));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert!(v.get("error").is_none(), "launcher failed: {v}");
    let h = Holder {
        pid: v["pid"].as_i64().unwrap() as i32,
        child: v["childPid"].as_i64().unwrap() as i32,
        state_dir: root.join("st"),
        sock: root.join("r").join(format!("{id}.sock")),
        id,
        root,
        extra: vec![],
        tmp: Some(tmp),
    };
    (h, kea)
}

// Kea started in a scope of its own, as a desktop starts an app; its terminal's holder puts itself in another
// (`kea-<hash>-<ptyId>.scope`, the agent with it) and outlives Kea's scope stopped (`systemctl --user stop`, as a
// session's end or `systemd-oomd` does) and Kea killed (every process of its scope `SIGKILL`ed). The agent's
// environment has no `INVOCATION_ID` (systemd-run sets one for Kea's scope and for the holder's); the holder's scope
// sets no `ManagedOOMPreference`. Skipped, and said so, without a user manager.
#[test]
fn i_plt_1_a_holder_in_its_own_scope_outlives_kea_s_scope_stopped_and_kea_killed() {
    if !user_manager() {
        println!("skipped: no systemd user manager answers here (I-PLT-1's session fallback still runs)");
        return;
    }
    for end in ["stop", "kill"] {
        let unit = format!("keatest-{}", new_pty_id());
        let wrap = [SYSTEMD_RUN, "--user", "--scope", "--collect", "--quiet", &format!("--unit={unit}"), "--"];
        let (h, mut kea) = launch_from_kea(&Opts::new(&["/bin/cat"]), &wrap, true);
        let kea_pid = kea.id() as i32;
        assert_eq!(h.json()["detach"], "scope");
        assert_eq!(unit_of(kea_pid), format!("{unit}.scope"), "Kea runs in a scope of its own");
        let scope = holder_scope(&h);
        assert_eq!(unit_of(h.pid), scope, "the holder is in its own scope");
        assert_eq!(unit_of(h.child), scope, "and its agent with it");
        assert!(environ_has(kea_pid, "INVOCATION_ID"), "systemd-run gives a scope's command an INVOCATION_ID");
        wait_exec(h.child, "cat");
        assert!(!environ_has(h.child, "INVOCATION_ID"), "the holder removed it before starting the agent");
        assert_eq!(systemctl(&["--user", "show", "-p", "ManagedOOMPreference", "--value", &scope]), "none");
        match end {
            "stop" => systemctl(&["--user", "stop", &format!("{unit}.scope")]),
            _ => systemctl(&["--user", "kill", "--signal=SIGKILL", &format!("{unit}.scope")]),
        };
        kea.wait().unwrap();
        assert!(alive(h.pid) && alive(h.child), "{end}: the holder and its agent live on");
        assert_eq!(unit_of(h.pid), scope);
        h.session(AttachMode::Latest).echo(&format!("typed after {end}"));
    }
}

// Session mode: with no user manager (no `XDG_RUNTIME_DIR`), when one seems to answer but `systemd-run`
// cannot start (its socket is dead and there is no bus: it fails before READY), and when one seems to answer
// but never does (its socket takes the connection and nothing reads it: `systemd-run` would wait for its bus timeout,
// past ptyhost's), the holder is spawned in a session of its own within ptyhost's time for a launch and the state json
// says so; Kea quits plainly and the holder lives on. `INVOCATION_ID` is removed in this mode too.
#[test]
fn i_plt_1_session_mode_without_a_user_manager_and_when_systemd_run_fails() {
    let (_tmp, dir) = tmpdir();
    let dead = dir.join("rt");
    std::fs::DirBuilder::new().mode(0o700).recursive(true).create(dead.join("systemd")).unwrap();
    drop(std::os::unix::net::UnixListener::bind(dead.join("systemd/private")).unwrap()); // the socket stays, no one listens
    let hung = dir.join("hung");
    std::fs::DirBuilder::new().mode(0o700).recursive(true).create(hung.join("systemd")).unwrap();
    let _silent = std::os::unix::net::UnixListener::bind(hung.join("systemd/private")).unwrap(); // listens, never accepts
    let mut cases = vec![("no user manager", None)];
    if Path::new(SYSTEMD_RUN).exists() && Path::new(SYSTEMD_BOOTED).is_dir() {
        cases.push(("systemd-run failed", Some(dead.clone().into_os_string())));
        cases.push(("systemd-run hung", Some(hung.clone().into_os_string())));
    } else {
        println!("skipped: systemd-run failing or hanging before READY (no systemd here)");
    }
    for (what, xdg) in cases {
        let mut o = Opts::new(&["/bin/cat"]);
        o.env = vec![("XDG_RUNTIME_DIR", xdg), ("DBUS_SESSION_BUS_ADDRESS", None), ("INVOCATION_ID", Some("0123456789abcdef0123456789abcdef".into()))];
        let started = std::time::Instant::now();
        let (h, mut kea) = launch_from_kea(&o, &[], false);
        let took = started.elapsed();
        assert!(took.as_millis() < u128::from(kea_helper::limits::HOLDER_LAUNCH_TIMEOUT_MS), "{what}: launched in {took:?}, within ptyhost's time for a launch");
        assert!(kea.wait().unwrap().success(), "{what}: Kea quit");
        assert_eq!(h.json()["detach"], "session", "{what}");
        assert_eq!(unit_of(h.pid), unit_of(std::process::id() as i32), "{what}: no scope, the test's own unit");
        assert!(alive(h.pid) && alive(h.child), "{what}: the holder lives on after Kea's plain quit");
        assert_eq!(unsafe { libc::getsid(h.pid) }, h.pid, "{what}: a session of its own");
        wait_exec(h.child, "cat");
        assert!(!environ_has(h.child, "INVOCATION_ID"), "{what}: removed in session mode too");
        h.session(AttachMode::Latest).echo("typed after the quit");
    }
}

/// The calling thread's `errno` after a failed call.
fn errno() -> Option<i32> {
    std::io::Error::last_os_error().raw_os_error()
}

// A holder is non-dumpable: a process of its own user can neither ptrace it (`PTRACE_ATTACH`,
// `PTRACE_SEIZE`), open its memory, read it with `process_vm_readv`, nor take its descriptors with `pidfd_getfd`,
// under the `ptrace_scope` this machine runs (a full run covers 0, 1 and 2 in turn); its `stat`, `status` and
// `cmdline` stay readable (`kea-helper procs`, STAT), and its client is still served. A plain process of the test's,
// the control, is seized wherever that scope allows it (0 and 1).
#[test]
fn i_plt_2_a_holder_cannot_be_reached_by_a_process_of_its_own_user() {
    let scope = std::fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope").ok().and_then(|s| s.trim().parse::<u32>().ok());
    println!("ptrace_scope {scope:?}");
    let h = spawn(Opts::new(&["/bin/cat"]));
    let mut s = h.session(AttachMode::Latest);
    s.echo("before");
    let none = std::ptr::null_mut::<libc::c_void>();
    for (name, req) in [("PTRACE_ATTACH", libc::PTRACE_ATTACH), ("PTRACE_SEIZE", libc::PTRACE_SEIZE)] {
        let r = unsafe { libc::ptrace(req, h.pid, none, none) };
        assert_eq!((r, errno()), (-1, Some(libc::EPERM)), "{name}");
    }
    let mem = std::fs::File::open(format!("/proc/{}/mem", h.pid));
    assert_eq!(mem.err().map(|e| e.kind()), Some(std::io::ErrorKind::PermissionDenied), "/proc/<holder>/mem");
    let mut buf = [0u8; 8];
    let local = libc::iovec { iov_base: buf.as_mut_ptr().cast(), iov_len: buf.len() };
    let remote = libc::iovec { iov_base: buf.as_mut_ptr().cast(), iov_len: buf.len() }; // any address: access is checked first
    let r = unsafe { libc::process_vm_readv(h.pid, &local, 1, &remote, 1, 0) };
    assert_eq!((r, errno()), (-1, Some(libc::EPERM)), "process_vm_readv");
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, h.pid, 0) } as i32;
    assert!(pidfd >= 0, "pidfd_open: {:?}", errno());
    for fd in 0..8 {
        let r = unsafe { libc::syscall(libc::SYS_pidfd_getfd, pidfd, fd, 0) };
        assert_eq!((r, errno()), (-1, Some(libc::EPERM)), "pidfd_getfd of fd {fd}");
    }
    unsafe { libc::close(pidfd) };
    for f in ["stat", "status", "cmdline"] {
        assert!(!std::fs::read(format!("/proc/{}/{f}", h.pid)).unwrap().is_empty(), "{f} readable");
    }
    assert!(kea_helper::os::proc_info(h.pid).is_ok_and(|p| !p.exiting), "proc_info reads it (STAT, procs)");

    let mut plain = Command::new("/bin/sleep").arg("600").stdin(Stdio::null()).spawn().unwrap();
    let seized = unsafe { libc::ptrace(libc::PTRACE_SEIZE, plain.id() as i32, none, none) } == 0;
    plain.kill().unwrap();
    plain.wait().unwrap();
    if let Some(scope) = scope {
        assert_eq!(seized, scope <= 1, "the control under ptrace_scope {scope}");
    }
    s.echo("after");
}
