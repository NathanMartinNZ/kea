//! Holder integration tests: the real binary, launched detached, driven over its socket.

mod common;

use common::*;
use kea_helper::limits::{
    HOLDER_FLOW_HIGH_BYTES, HOLDER_FOOTPRINT_MAX_BYTES, HOLDER_PEER_CHECK_TIMEOUT_MS, HOLDER_PENDING_CHECKS_MAX,
    HOLDER_READ_BUFFER_BYTES, HOLDER_REFUSAL_LOG_INTERVAL_MS, HOLDER_STALE_CLIENT_MS, RING_BYTES_DEFAULT, RING_BYTES_MIN,
    SOCKET_PATH_MAX_BYTES,
};
use std::ffi::OsString;
use std::io::BufRead;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::process::CommandExt;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A short `TERMINATE` grace: what ignores `SIGTERM` is `SIGKILL`ed soon after.
const SHORT_GRACE_MS: u32 = 300;
/// A `TERMINATE` grace as long as any wait: the `SIGKILL` phase then only comes from a second
/// `TERMINATE{0}` (the earlier deadline wins), so a test can watch the `SIGTERM` phase first.
const LONG_GRACE_MS: u32 = T.as_millis() as u32;

fn bsd(pid: i32) -> kea_helper::os::ProcInfo {
    kea_helper::os::proc_info(pid).unwrap()
}

/// The holder's child processes, zombies included (`os::children_into`).
fn children(pid: i32) -> Vec<i32> {
    let mut buf = [0i32; 64];
    let n = kea_helper::os::children_into(pid, &mut buf);
    buf[..n].to_vec()
}

/// An interactive shell with no rc files, for job control: macOS's zsh; on Linux bash, which every distribution has
/// (zsh is no default there). Its name as `STAT` gives it, and what it prints when ⌃Z suspends a job and when `fg`
/// takes it back (bash echoes the job's command after the typed `fg`).
struct Shell {
    argv: &'static [&'static str],
    name: &'static str,
    suspended: &'static str,
    continued: &'static str,
}

fn shell() -> Shell {
    if kea_helper::os::IS_LINUX {
        Shell { argv: &["/bin/bash", "--norc", "--noprofile", "-i"], name: "bash", suspended: "Stopped", continued: "fg\r\nsleep 100" }
    } else {
        Shell { argv: &["/bin/zsh", "-f", "-i"], name: "zsh", suspended: "suspended", continued: "continued" }
    }
}

#[test]
fn i_hld_1_echo_then_exit() {
    let h = spawn(Opts::new(&["/bin/echo", "hi"]));
    let mut s = h.session(AttachMode::Earliest);
    s.until("EXIT", |s| s.exit.is_some());
    assert_eq!(s.out, b"hi\r\n");
    assert_eq!(s.start, Some(0));
    assert_eq!(s.exit, Some((0, 0)));
    let j = h.wait_exited();
    assert_eq!((j["exitCode"].as_i64(), j["exitSignal"].is_null()), (Some(0), true));
}

#[test]
fn i_hld_2_argv_is_byte_exact() {
    // One argument far longer than a read buffer, ending in a multi-byte character.
    let mut big = "x".repeat(HOLDER_READ_BUFFER_BYTES as usize + HOLDER_READ_BUFFER_BYTES as usize / 2);
    big.push('é');
    let args: Vec<Vec<u8>> = vec![
        b"a b".to_vec(),
        b"\"q'\" $HOME `id` \\".to_vec(),
        b"line\nbreak\r\n".to_vec(),
        b"".to_vec(),
        b"--".to_vec(),
        b"-n".to_vec(),
        b"--id".to_vec(),
        vec![0xff, 0xfe, b'z'],
        big.into_bytes(),
    ];
    let mut o = Opts::sh("stty -opost; printf '%s\\0' \"$@\"");
    o.argv.push("sh".into());
    o.argv.extend(args.iter().map(|a| OsString::from_vec(a.clone())));
    let h = spawn(o);
    let mut s = h.session(AttachMode::Earliest);
    s.until("EXIT", |s| s.exit.is_some());
    let want: Vec<u8> = args.iter().flat_map(|a| a.iter().copied().chain([0])).collect();
    assert_eq!(s.out.len(), want.len());
    assert!(s.out == want, "argv bytes differ");
    assert_eq!(s.exit, Some((0, 0)));
}

#[test]
fn i_hld_3_child_sees_a_real_tty_with_job_control() {
    const COLS: u16 = 137;
    const ROWS: u16 = 41;
    let mut o = Opts::sh("tty; stty size; test -t 0 && test -t 1 && test -t 2 && echo isatty");
    (o.cols, o.rows) = (COLS, ROWS);
    let h = spawn(o);
    let mut s = h.session(AttachMode::Earliest);
    s.until("EXIT", |s| s.exit.is_some());
    let text = String::from_utf8_lossy(&s.out);
    let pts = if kea_helper::os::IS_LINUX { "/dev/pts/" } else { "/dev/ttys" };
    assert!(text.starts_with(pts), "{text:?}");
    assert!(text.contains(&format!("\r\n{ROWS} {COLS}\r\n")) && text.contains("isatty"), "{text:?}");

    // Job control in an interactive shell (no rc files): ⌃Z suspends, `fg` resumes, ⌃C interrupts.
    let sh = shell();
    let h = spawn(Opts::new(sh.argv));
    let mut s = h.session(AttachMode::Earliest);
    s.c.input(b"sleep 100\r");
    wait_fg(&mut s, "sleep");
    s.c.input(b"\x1a");
    s.wait_for(sh.suspended);
    wait_fg(&mut s, sh.name);
    s.c.input(b"fg\r");
    s.wait_for(sh.continued);
    wait_fg(&mut s, "sleep");
    s.c.input(b"\x03");
    wait_fg(&mut s, sh.name);
    s.c.input(b"exit\r");
    s.until("EXIT", |s| s.exit.is_some());
}

/// Polls `STAT` until the foreground process is `name`.
fn wait_fg(s: &mut Session, name: &str) -> Stat {
    let deadline = Instant::now() + T;
    loop {
        let st = s.stat();
        if st.fg_name == name.as_bytes() {
            return st;
        }
        assert!(Instant::now() < deadline, "foreground never became {name}: {st:?}");
        std::thread::sleep(POLL);
    }
}

/// Launches a holder from a parent standing in for ptyhost: it runs the launcher in its own process group
/// and stays alive (a `sleep`). Returns the holder and that parent, whose pid is the group's id.
fn launch_from_parent_group(o: &Opts) -> (Holder, std::process::Child) {
    let (tmp, root) = tmpdir();
    let id = new_pty_id();
    let launch = launcher(o, &root, &id);
    // A fixed script; the launcher's argv reaches it as positional parameters, never quoted into it.
    let parent = Command::new("/bin/sh")
        .args(["-c", r#""$0" "$@" > out.json; exec /bin/sleep 1000"#])
        .arg(launch.get_program())
        .args(launch.get_args())
        .current_dir(&root)
        .stdin(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let out = root.join("out.json");
    wait_until("launcher output", T, || std::fs::read_to_string(&out).is_ok_and(|t| t.ends_with('\n')));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let h = Holder {
        pid: v["pid"].as_i64().unwrap() as i32,
        child: v["childPid"].as_i64().unwrap() as i32,
        id: id.clone(),
        state_dir: root.join("st"),
        sock: root.join("r").join(format!("{id}.sock")),
        root,
        extra: vec![],
        tmp: Some(tmp),
    };
    (h, parent)
}

#[test]
fn i_hld_4_holder_survives_its_parent_group_being_killed() {
    // The parent's whole group is killed with SIGKILL right after the spawn.
    let (h, mut parent) = launch_from_parent_group(&Opts::new(&["/bin/sleep", "1000"]));
    unsafe { libc::killpg(parent.id() as i32, libc::SIGKILL) };
    parent.wait().unwrap();
    assert!(alive(h.pid) && alive(h.child), "holder and child survive");
    let mut s = h.session(AttachMode::Latest);
    assert_eq!(s.hello.as_ref().unwrap().child_pid, h.child as u32);
    // The holder reports its child once forked; until the child's `execvp`, STAT names the holder's own copy
    // (`kea-helper`). The child first closes every descriptor below its limit, which Node raises under `pnpm verify`,
    // so on a loaded machine the first STAT can come before the exec.
    let st = wait_fg(&mut s, "sleep");
    assert_eq!(st.fg_pid, h.child as u32, "the foreground sleep is the holder's own child");
}

/// Descriptors a daemon may hold besides its client: stdio (3), the wake pipe (2), the listener, the PTY
/// master and the slave it keeps, with room for syslog's socket.
const DAEMON_FDS_MAX: usize = 12;

#[test]
fn i_hld_21_daemon_is_reparented_session_leader_and_responsible_for_itself() {
    let (h, mut parent) = launch_from_parent_group(&Opts::new(&["/bin/cat"]));
    let group = parent.id() as i32;
    // The launcher has exited: the daemon belongs to launchd (on Linux to init, or to the subreaper above it: the
    // systemd user manager), leads its own session and group.
    wait_until("reparenting", T, || {
        let ppid = bsd(h.pid).ppid;
        if kea_helper::os::IS_LINUX {
            kea_helper::os::proc_info(ppid).is_ok_and(|p| p.pgid != group)
        } else {
            ppid == 1
        }
    });
    assert_eq!(unsafe { libc::getsid(h.pid) }, h.pid, "the daemon leads its own session");
    assert_eq!(bsd(h.pid).pgid, h.pid);
    assert_ne!(bsd(h.pid).pgid, group, "not in the spawner's process group");
    assert_ne!(unsafe { libc::getsid(h.pid) }, unsafe { libc::getsid(0) });
    assert_eq!(unsafe { libc::getsid(h.child) }, h.child, "the child leads the PTY's session");
    assert_eq!(bsd(h.child).ppid, h.pid);
    // The spawner's whole group dies (Kea crashing, or killed with its group): the holder does not.
    unsafe { libc::killpg(group, libc::SIGKILL) };
    parent.wait().unwrap();
    assert!(alive(h.pid) && alive(h.child), "holder and child survive the group kill");
    if kea_helper::os::IS_LINUX {
        // No responsibility on Linux, and the daemon's descriptors are checked where it is spawned (R-PLT-4 in
        // src/os/linux.rs): it is non-dumpable here, so they cannot be listed from outside. Typing still
        // works after the group kill.
        h.session(AttachMode::Latest).echo("typed after the group kill");
        return;
    }
    // Responsibility disclaimed. `responsibility_get_pid_responsible_for_pid` is private: if a macOS
    // drops it this must fail loudly, not pass unchecked (the disclaim must then be checked by hand).
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) }; // os-ok: the responsibility disclaim, macOS only
    assert!(
        !sym.is_null(),
        "responsibility_get_pid_responsible_for_pid is missing on this macOS: the responsibility disclaim \
         cannot be checked here — check it by hand and adapt this test"
    );
    let responsible: extern "C" fn(libc::pid_t) -> libc::pid_t = unsafe { std::mem::transmute(sym) };
    assert_eq!(responsible(h.pid), h.pid, "responsibility disclaimed: the daemon is responsible for itself");
    // Only fds 0–2 plus the holder's own survive the spawn: no inherited test descriptors.
    let fds = kea_helper::os::open_fds(h.pid).unwrap();
    assert!(fds.len() <= DAEMON_FDS_MAX, "{} fds open in the daemon", fds.len());
    // Reconnect, as a relaunched Kea does: the same child, still running, and typing works.
    let mut s = h.session(AttachMode::Latest);
    let hello = s.hello.clone().unwrap();
    assert!(!hello.exited && hello.child_pid == h.child as u32);
    s.echo("typed after the group kill");
}

/// Parses `R\n1\n2\n…` (output processing off: the macOS tty occasionally doubles the CR that ONLCR
/// inserts under flood) and checks every number appears once, in order.
fn check_counter(out: &[u8], last: u64) {
    let body = out.strip_prefix(b"R\n").unwrap_or_else(|| panic!("no ready marker: {:?}", &out[..out.len().min(20)]));
    let lines: Vec<&[u8]> = body.strip_suffix(b"\n").unwrap_or(body).split(|&b| b == b'\n').collect();
    assert_eq!(lines.len() as u64, last, "line count; first {:?}, last {:?}", &lines[..3.min(lines.len())], &lines[lines.len().saturating_sub(3)..]);
    for (i, l) in lines.iter().enumerate() {
        let n: u64 = std::str::from_utf8(l).ok().and_then(|t| t.parse().ok()).unwrap_or_else(|| panic!("line {i}: {l:?}"));
        assert_eq!(n, i as u64 + 1, "line {i}");
    }
}

/// `R`, then the numbers 1…n one per line, once the child reads a line (stty -echo -opost).
fn counter(n: u64) -> Opts {
    Opts::sh(&format!("stty -echo -opost; echo R; read x; exec /usr/bin/awk 'BEGIN {{ for (i = 1; i <= {n}; i++) print i }}'")) // os-ok: in /usr/bin on both systems
}

#[test]
fn i_hld_5_counter_is_lossless_with_an_acking_client() {
    // About seven bytes a line: several rings' worth through the smallest ring.
    const LINES: u64 = 1_000_000;
    let mut o = counter(LINES);
    o.ring = Some(RING_BYTES_MIN);
    let h = spawn(o);
    let mut s = h.session(AttachMode::Earliest);
    s.wait_for("R\n");
    s.c.input(b"go\r");
    s.until("EXIT", |s| s.exit.is_some());
    assert!(s.gaps.is_empty(), "{:?}", s.gaps);
    assert!(s.out.len() as u64 > 4 * RING_BYTES_MIN, "far more output than the ring holds");
    check_counter(&s.out, LINES);
}

#[test]
fn i_hld_6_never_acking_client_pauses_the_child_until_ack() {
    // Paused = the ring stopped growing for this many consecutive idle pumps of `IDLE_PUMP`.
    const STABLE_PUMPS: u32 = 40;
    const IDLE_PUMP: Duration = Duration::from_millis(10);
    let mut o = Opts::sh("stty -echo; echo R; read x; exec /usr/bin/yes"); // os-ok: in /usr/bin on both systems
    o.ring = Some(RING_BYTES_MIN);
    o.stale_ms = Some(2 * T.as_millis() as u64); // longer than any wait here: no free-run in this test
    let h = spawn(o);
    let mut s = h.session(AttachMode::Earliest);
    s.ack = false;
    s.wait_for("R");
    s.c.input(b"go\r");
    // Read everything sent, never ack: the holder must stop just past the high watermark. Paused =
    // the ring stopped growing while the client sat idle (no frame within a pump), not merely while
    // it was still working through frames already queued.
    let mut stable = 0;
    let mut last = 0;
    let deadline = Instant::now() + T;
    while stable < STABLE_PUMPS {
        let got = s.pump(IDLE_PUMP);
        let l = h.ring_header().latest;
        stable = if !got && l == last && l > 0 { stable + 1 } else { 0 };
        last = l;
        assert!(Instant::now() < deadline, "reading never paused (latest {l})");
    }
    assert!(last > HOLDER_FLOW_HIGH_BYTES && last <= HOLDER_FLOW_HIGH_BYTES + HOLDER_READ_BUFFER_BYTES, "paused at {last}");
    assert!(alive(h.child), "the child is blocked, not killed");
    assert_eq!(s.next_seq, Some(last), "everything read was sent");
    s.c.send(&ClientFrame::Ack { seq: last });
    wait_until("reading resumes", T, || {
        s.pump(IDLE_PUMP);
        h.ring_header().latest > last + HOLDER_FLOW_HIGH_BYTES
    });
}

#[test]
fn i_hld_7_flood_without_client_overwrites_oldest_then_attach_earliest() {
    let mut o = Opts::sh("stty -opost; exec /usr/bin/yes"); // os-ok: in /usr/bin on both systems
    o.ring = Some(RING_BYTES_MIN);
    let h = spawn(o);
    wait_until("3 rings of output", T, || h.ring_header().latest > 3 * RING_BYTES_MIN);
    let hdr = h.ring_header();
    assert_eq!(hdr.earliest, hdr.latest - RING_BYTES_MIN);
    let mut s = Session::new(h.connect());
    let hello = s.hello();
    assert!(hello.earliest > 0 && hello.latest - hello.earliest == RING_BYTES_MIN);
    s.c.send(&ClientFrame::Attach { mode: AttachMode::Earliest, seq: 0 });
    s.until("a ring's worth", |s| s.out.len() as u64 >= RING_BYTES_MIN);
    let start = s.start.unwrap();
    assert!(start >= hello.earliest, "streaming starts at earliestSeq");
    assert!(s.gaps.is_empty());
    // The output is (y\n)* from seq 0, so the byte with seq s is "y\n"[s % 2].
    for (i, b) in s.out[..RING_BYTES_MIN as usize].iter().enumerate() {
        assert_eq!(*b, b"y\n"[((start + i as u64) % 2) as usize], "byte {i} (seq {})", start + i as u64);
    }
}

/// The stale-client timeout for I-HLD-8 and I-HLD-22, set through a debug-only knob: a quarter of the real
/// one keeps them short.
const TEST_STALE_MS: u64 = HOLDER_STALE_CLIENT_MS / 4;

/// `yes` with output processing off (the byte with seq `s` is `"y\n"[s % 2]`) and a client that neither
/// reads nor acks, until the holder has read three rings past the attach point: free-run.
fn frozen_until_free_run() -> (Holder, Session) {
    let mut o = Opts::sh("stty -opost; exec /usr/bin/yes"); // os-ok: in /usr/bin on both systems
    o.ring = Some(RING_BYTES_MIN);
    o.stale_ms = Some(TEST_STALE_MS);
    let h = spawn(o);
    let s = h.session(AttachMode::Latest);
    let attached_at = h.ring_header().latest;
    wait_until("free-run", T, || h.ring_header().latest > attached_at + 3 * RING_BYTES_MIN);
    (h, s)
}

#[test]
fn i_hld_8_frozen_client_free_runs() {
    let (h, _s) = frozen_until_free_run();
    // The holder reads on, overwriting what the frozen client never received, and the child is never
    // blocked by it.
    let hdr = h.ring_header();
    assert_eq!(hdr.earliest, hdr.latest - RING_BYTES_MIN);
    wait_until("the child still writing", T, || h.ring_header().latest > hdr.latest + RING_BYTES_MIN);
    assert!(alive(h.child));
}

#[test]
fn i_hld_22_frozen_client_resumes_after_an_ack_with_exactly_one_gap() {
    let (h, mut s) = frozen_until_free_run();
    // Thaw: read and ack everything.
    s.until("the gap", |s| !s.gaps.is_empty());
    let (expected, got) = s.gaps[0];
    assert!(got > expected, "the next OUTPUT jumps forward");
    let after = s.out.len();
    s.until("more output after the gap", |s| s.out.len() > after + 2 * RING_BYTES_MIN as usize);
    assert_eq!(s.gaps.len(), 1, "exactly one gap: {:?}", s.gaps);
    // No byte duplicated or out of place on either side of the gap: each is "y\n"[its seq % 2].
    let start = s.start.unwrap();
    let cut = (expected - start) as usize;
    let seq_of = |i: usize| if i < cut { start + i as u64 } else { got + (i - cut) as u64 };
    for (i, b) in s.out.iter().enumerate() {
        assert_eq!(*b, b"y\n"[(seq_of(i) % 2) as usize], "byte {i} (seq {})", seq_of(i));
    }
    assert!(alive(h.child), "the child was never blocked");
}

#[test]
fn i_hld_9_detach_and_reattach_continue_exactly() {
    const LINES: u64 = 200_000;
    let h = spawn(counter(LINES));
    let mut s1 = h.session(AttachMode::Earliest);
    s1.wait_for("R\n");
    s1.c.input(b"go\r");
    // Detach part-way, about a quarter into the output (≈ 7 bytes a line).
    const DETACH_AFTER_BYTES: usize = 300_000;
    s1.until("some output", |s| s.out.len() > DETACH_AFTER_BYTES);
    let cut = s1.next_seq.unwrap();
    s1.c.send(&ClientFrame::Ack { seq: cut });
    s1.c.send(&ClientFrame::Detach);
    let first = s1.out.clone();
    drop(s1);
    h.wait_exited();
    let mut s2 = Session::new(h.connect());
    s2.hello();
    s2.attach(AttachMode::FromSeq, cut);
    s2.until("EXIT", |s| s.exit.is_some());
    assert_eq!(s2.start, Some(cut));
    assert!(s2.gaps.is_empty());
    let mut all = first;
    all.extend_from_slice(&s2.out);
    check_counter(&all, LINES);
}

#[test]
fn i_hld_10_second_client_replaces_the_first() {
    let h = spawn(Opts::new(&["/bin/cat"]));
    let mut a = h.session(AttachMode::Latest);
    a.c.input(b"one\r");
    a.wait_for("one");
    let mut b = h.session(AttachMode::Latest);
    a.c.wait_eof(T);
    b.c.input(b"two\r");
    b.wait_for("two");
}

#[test]
fn i_hld_12_resize_reaches_the_child() {
    const SIZE: (u16, u16, u16, u16) = (100, 30, 1000, 600);
    let h = spawn(Opts::sh("trap 'stty size' WINCH; echo ready; while :; do /bin/sleep 0.05; done"));
    let mut s = h.session(AttachMode::Earliest);
    s.wait_for("ready");
    s.c.send(&ClientFrame::Resize { cols: SIZE.0, rows: SIZE.1, xpx: SIZE.2, ypx: SIZE.3 });
    s.wait_for(&format!("{} {}", SIZE.1, SIZE.0));
    let mut s2 = Session::new(h.connect());
    let hello = s2.hello();
    assert_eq!((hello.cols, hello.rows), (SIZE.0, SIZE.1), "HELLO reports the current size");
}

#[test]
fn i_hld_13_signal_child_foreground_group_and_session() {
    let perl = r#"
        use POSIX;
        $| = 1;
        $SIG{TTOU} = 'IGNORE';
        sub h { my $n = shift; return sub { print "$n got $_[0]\n" } }
        sub serve { my $n = shift; $SIG{$_} = h($n) for qw(USR1 USR2 ALRM); print "$n ready\n"; sleep 1 while 1 }
        if (fork() == 0) { POSIX::setpgid(0, 0); POSIX::tcsetpgrp(0, $$); serve("B") }
        if (fork() == 0) { POSIX::setpgid(0, 0); serve("C") }
        serve("A");
    "#;
    let h = spawn(Opts::new(&["/usr/bin/perl", "-e", perl])); // os-ok: in /usr/bin on both systems
    let mut s = h.session(AttachMode::Earliest);
    s.until("all ready", |s| s.saw("A ready") && s.saw("B ready") && s.saw("C ready"));
    wait_until("B in the foreground", T, || {
        let st = s.stat();
        st.fg_pid != 0 && st.fg_pid != h.child as u32
    });
    s.c.send(&ClientFrame::Signal { signo: libc::SIGUSR1 as u8, target: SignalTarget::Child });
    s.wait_for("A got USR1");
    s.c.send(&ClientFrame::Signal { signo: libc::SIGUSR2 as u8, target: SignalTarget::Foreground });
    s.wait_for("B got USR2");
    s.c.send(&ClientFrame::Signal { signo: libc::SIGALRM as u8, target: SignalTarget::Session });
    s.until("ALRM everywhere", |s| s.saw("A got ALRM") && s.saw("B got ALRM") && s.saw("C got ALRM"));
    let text = String::from_utf8_lossy(&s.out);
    assert_eq!(text.matches("got USR1").count(), 1, "{text}");
    assert_eq!(text.matches("got USR2").count(), 1, "{text}");
}

/// One process of a `forker` tree, from its `--log` (tools/process-zoo/src/forker.c).
#[derive(Debug, Clone)]
struct Proc {
    role: String,
    pid: i32,
    sid: i32,
}

/// The complete JSON lines of a forker log (a line still being appended is skipped).
fn forker_lines(path: &Path) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let complete = &text[..text.rfind('\n').map_or(0, |i| i + 1)];
    complete.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn forker_procs(path: &Path) -> Vec<Proc> {
    forker_lines(path)
        .iter()
        .filter(|v| v["forker"] == "proc")
        .map(|v| Proc { role: v["role"].as_str().unwrap().into(), pid: v["pid"].as_i64().unwrap() as i32, sid: v["sid"].as_i64().unwrap() as i32 })
        .collect()
}

/// The signals `pid` reported, in order.
fn forker_signals(path: &Path, pid: i32) -> Vec<String> {
    forker_lines(path)
        .iter()
        .filter(|v| v["forker"] == "signal" && v["pid"] == pid)
        .map(|v| v["signal"].as_str().unwrap().into())
        .collect()
}

// Processes that leave the terminal's session, in four trees under one shell (the PTY's session leader;
// it ignores USR1/USR2 so the session signal leaves it running). Every forker process reports signals in
// its log and, being stubborn, survives everything but SIGKILL.
//   setsid      a child that called setsid: out of the session, still a descendant
//   orphan      a double-forked grandchild that called setsid: out of the session, reparented to pid 1
//               (launchd, or init on Linux), its stdio still on the PTY
//   in-session  a double-forked grandchild, reparented to pid 1, still in the session
//   detached    like orphan, with stdio away from the PTY: nothing ties it to the terminal any more
// SIGNAL to the session reaches only the session's process groups; TERMINATE reaches descendants, the
// session and whatever holds the PTY on its controlling tty or stdio — everything but `detached`.
#[test]
fn i_hld_13_setsid_and_double_forked_processes_signal_and_terminate() {
    let (_bin_tmp, bin_dir) = tmpdir();
    let forker = build_forker(&bin_dir);
    let f = forker.display();
    let script = format!(
        "trap '' USR1 USR2
         '{f}' --fork --setsid --stubborn --log setsid.log &
         '{f}' --double-fork --setsid --stubborn --log orphan.log &
         '{f}' --double-fork --stubborn --log in-session.log &
         '{f}' --double-fork --setsid --stubborn --log detached.log </dev/null >/dev/null 2>&1 &
         wait"
    );
    let mut h = spawn(Opts::sh(&script));
    let root = h.root.clone();
    let log = |name: &str| root.join(format!("{name}.log"));
    let trees = ["setsid", "orphan", "in-session", "detached"];
    for t in trees {
        wait_until(&format!("the {t} tree"), T, || forker_lines(&log(t)).iter().any(|v| v["forker"] == "ready"));
    }
    let procs: Vec<(&str, Vec<Proc>)> = trees.iter().map(|t| (*t, forker_procs(&log(t)))).collect();
    let find = |tree: &str, role: &str| procs.iter().find(|(t, _)| *t == tree).unwrap().1.iter().find(|p| p.role == role).unwrap().clone();
    let parents: Vec<(&str, Proc)> = trees.iter().map(|t| (*t, find(t, "parent"))).collect();
    let setsid = ("setsid", find("setsid", "child"));
    let orphan = ("orphan", find("orphan", "grandchild"));
    let in_session = ("in-session", find("in-session", "grandchild"));
    let detached = ("detached", find("detached", "grandchild"));
    let extra: Vec<i32> = parents.iter().map(|(_, p)| p.pid).chain([setsid.1.pid, orphan.1.pid, in_session.1.pid, detached.1.pid]).collect();
    h.extra.extend(extra); // whatever survives the test is SIGKILLed by the guard
    for (_, p) in [&orphan, &in_session, &detached] {
        wait_until("the grandchild is reparented", T, || bsd(p.pid).ppid == 1);
    }
    assert!(parents.iter().all(|(_, p)| p.sid == h.child) && in_session.1.sid == h.child, "in the session");
    assert!([&setsid, &orphan, &detached].iter().all(|(_, p)| p.sid != h.child), "out of the session");

    // SIGNAL to the session: its process groups only. (STAT's answer means the holder has signalled.)
    let mut s = h.session(AttachMode::Latest);
    s.c.send(&ClientFrame::Signal { signo: libc::SIGUSR1 as u8, target: SignalTarget::Session });
    s.stat();
    for (tree, p) in parents.iter().chain([&in_session]) {
        wait_until(&format!("USR1 in {tree} {}", p.role), T, || forker_signals(&log(tree), p.pid).contains(&"USR1".to_string()));
    }
    // Out of the session: a USR2 sent now is reported, and no USR1 before it (the holder's would have
    // been pending first, and pending signals are reported in number order).
    for (tree, p) in [&setsid, &orphan, &detached] {
        unsafe { libc::kill(p.pid, libc::SIGUSR2) };
        wait_until(&format!("USR2 in {tree}"), T, || forker_signals(&log(tree), p.pid).contains(&"USR2".to_string()));
        assert_eq!(forker_signals(&log(tree), p.pid), ["USR2"], "the session signal reached {tree} {p:?}");
    }

    // TERMINATE: SIGTERM reaches everything tied to the terminal (each logs it and ignores it)…
    s.c.send(&ClientFrame::Terminate { grace_ms: LONG_GRACE_MS });
    let reached: Vec<(&str, Proc)> = parents.iter().cloned().chain([setsid.clone(), orphan.clone(), in_session.clone()]).collect();
    for (tree, p) in &reached {
        wait_until(&format!("TERM in {tree} {}", p.role), T, || forker_signals(&log(tree), p.pid).contains(&"TERM".to_string()));
    }
    // …and the kill phase ends it (a second TERMINATE: the earlier deadline wins).
    s.c.send(&ClientFrame::Terminate { grace_ms: 0 });
    for (tree, p) in &reached {
        wait_until(&format!("{tree} {} gone", p.role), T, || !alive(p.pid));
    }
    // the session leader itself goes too (it may still be exiting after the last of its descendants)
    wait_until("the child gone", T, || !alive(h.child));
    // A daemon that left the session, was reparented and let go of the tty is not the terminal's any more.
    assert!(alive(detached.1.pid), "the detached daemon is not reached");
    assert!(!forker_signals(&log("detached"), detached.1.pid).contains(&"TERM".to_string()));
}

#[test]
fn i_hld_14_terminate_kills_double_forked_setsid_and_stubborn_processes() {
    let script = r#"
        trap '' TERM
        @perl@ -e '$SIG{TERM}="IGNORE"; open F,">stubborn.pid"; print F $$; close F; sleep 1000' &
        @perl@ -e 'use POSIX; $SIG{TERM}="IGNORE"; exit if fork; POSIX::setsid(); exit if fork; open F,">daemon.pid"; print F $$; close F; sleep 1000'
        @perl@ -e 'use IO::Socket::INET; $SIG{TERM}="IGNORE"; my $s = IO::Socket::INET->new(Listen => 5, LocalAddr => "127.0.0.1", LocalPort => 0) or die; open F,">port"; print F $s->sockport, " ", $$; close F; sleep 1000' &
        echo started
        wait
    "#
    .replace("@perl@", "/usr/bin/perl"); // os-ok: in /usr/bin on both systems
    let mut h = spawn(Opts::sh(&script));
    let read = |name: &str| std::fs::read_to_string(h.root.join(name)).ok().filter(|t| !t.is_empty());
    wait_until("the tree", T, || read("stubborn.pid").is_some() && read("daemon.pid").is_some() && read("port").is_some_and(|t| t.contains(' ')));
    let stubborn: i32 = read("stubborn.pid").unwrap().trim().parse().unwrap();
    let daemon: i32 = read("daemon.pid").unwrap().trim().parse().unwrap();
    let port_line = read("port").unwrap();
    let (port, listener) = port_line.trim().split_once(' ').unwrap();
    let (port, listener): (u16, i32) = (port.parse().unwrap(), listener.parse().unwrap());
    h.extra.extend([stubborn, daemon, listener]);
    wait_until("the double-forked daemon is reparented", T, || bsd(daemon).ppid == 1);
    assert_ne!(unsafe { libc::getsid(daemon) }, h.child, "it left the session");
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());

    let mut s = h.session(AttachMode::Latest);
    s.c.send(&ClientFrame::Terminate { grace_ms: SHORT_GRACE_MS });
    s.until("EXIT", |s| s.exit.is_some());
    for (name, pid) in [("child", h.child), ("stubborn", stubborn), ("daemon", daemon), ("listener", listener)] {
        wait_until(&format!("{name} {pid} gone"), T, || !alive(pid));
    }
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "no listening port left");
    assert_eq!(s.exit.unwrap().0, -1, "the child died of a signal");
}

/// The post-exit linger shortened for I-HLD-15, through the debug-only `KEA_HELPER_TEST_LINGER_MS` (the real
/// one is `HOLDER_LINGER_MS`).
const TEST_LINGER_MS: u64 = 500;

#[test]
fn i_hld_15_exit_without_client_then_attach_and_release() {
    let h = spawn(Opts::sh("echo final; exit 3"));
    let j = h.wait_exited();
    assert_eq!(j["exitCode"].as_i64(), Some(3));
    let mut s = Session::new(h.connect());
    let hello = s.hello();
    assert!(hello.exited);
    assert_eq!((hello.code, hello.signal), (3, 0));
    s.attach(AttachMode::Earliest, 0);
    s.until("EXIT", |s| s.exit.is_some());
    assert_eq!(s.out, b"final\r\n");
    assert_eq!(s.exit, Some((3, 0)));
    s.c.send(&ClientFrame::Release);
    s.c.wait_eof(T);
    wait_until("holder exit", T, || !alive(h.pid));
    assert!(!h.sock.exists(), "socket removed");
    assert!(h.ring_path().exists() && h.json_path().exists(), "ring and json kept");

    // Nobody comes back: once the linger is over the holder is gone, and a client connecting later
    // finds no socket at all (not a dead one), while the ring and json stay for a cold restore.
    let mut o = Opts::sh("echo unclaimed");
    o.linger_ms = Some(TEST_LINGER_MS);
    let h = spawn(o);
    h.wait_exited();
    wait_until("the linger to end", T, || !alive(h.pid));
    let late = std::os::unix::net::UnixStream::connect(&h.sock);
    assert_eq!(late.err().map(|e| e.kind()), Some(std::io::ErrorKind::NotFound), "the socket was unlinked");
    assert!(h.ring_path().exists() && h.json_path().exists(), "ring and json kept");
    assert_eq!(h.json()["exitCode"], 0);
}

#[test]
fn i_hld_16_sigterm_and_sighup_are_ignored_while_the_child_lives() {
    let h = spawn(Opts::new(&["/bin/sleep", "1000"]));
    let mut s = h.session(AttachMode::Latest);
    unsafe {
        libc::kill(h.pid, libc::SIGTERM);
        libc::kill(h.pid, libc::SIGHUP);
    }
    // Two round trips: the loop has seen the signals by now.
    s.stat();
    s.stat();
    assert!(alive(h.pid) && alive(h.child));
    s.c.send(&ClientFrame::Release);
    s.until("ERROR child alive", |s| s.others.iter().any(|f| matches!(f, HolderFrame::Error { code: 6, .. })));
    // Once the child is gone, SIGTERM ends the holder.
    s.c.send(&ClientFrame::Terminate { grace_ms: 0 });
    s.until("EXIT", |s| s.exit.is_some());
    assert!(alive(h.pid), "lingering after exit");
    unsafe { libc::kill(h.pid, libc::SIGTERM) };
    wait_until("holder exit", T, || !alive(h.pid));
    assert!(!h.sock.exists());
}

// The holder's half of C-KILL-6: a holder killed with SIGKILL loses only its own PTY, and its last
// output survives in the ring file for the cold restore.
#[test]
fn i_hld_28_sigkilled_holder_loses_only_its_own_pty() {
    let a = spawn(Opts::sh("stty -opost; printf 'last screen\\n'; exec /bin/sleep 1000"));
    let b = spawn(Opts::new(&["/bin/cat"]));
    let want = b"last screen\n";
    wait_until("the output in the ring", T, || a.ring_header().latest >= want.len() as u64);
    unsafe { libc::kill(a.pid, libc::SIGKILL) };
    wait_until("holder gone", T, || !alive(a.pid));
    wait_until("its child hung up", T, || !alive(a.child));
    let ring = std::fs::read(a.ring_path()).unwrap();
    let hdr = kea_helper::ring::decode_header(&ring).unwrap();
    assert_eq!((hdr.earliest, hdr.latest), (0, want.len() as u64));
    assert_eq!(&ring[kea_helper::ring::HEADER..][..want.len()], want);
    assert_eq!(a.json()["exited"], false, "the holder never saw an exit");
    // The other holder is untouched.
    assert!(alive(b.pid) && alive(b.child));
    let mut s = b.session(AttachMode::Latest);
    s.c.input(b"still here\r");
    s.wait_for("still here");
}

#[test]
fn i_hld_17_stat_reports_foreground_and_descendants() {
    let sh = shell();
    let h = spawn(Opts::new(sh.argv));
    let mut s = h.session(AttachMode::Earliest);
    let idle = wait_fg(&mut s, sh.name);
    assert_eq!(idle.child_pid, h.child as u32);
    assert!(idle.pids.is_empty(), "{idle:?}");
    assert_eq!(std::path::Path::new(std::str::from_utf8(&idle.cwd).unwrap()), h.root.as_path());
    s.c.input(b"sleep 30\r");
    let busy = wait_fg(&mut s, "sleep");
    assert_eq!(busy.pids, vec![busy.fg_pid], "the only descendant is the foreground sleep");
    assert_eq!(bsd(busy.fg_pid as i32).ppid, h.child);
    s.c.input(b"\x03");
    let back = wait_fg(&mut s, sh.name);
    assert!(back.pids.is_empty());
    // A non-interactive `sh -c` that forks: descendants are its children, each with the child as parent.
    let h = spawn(Opts::sh("/bin/sleep 30 & /bin/sleep 31; wait"));
    let mut s = h.session(AttachMode::Latest);
    let st = {
        let deadline = Instant::now() + T;
        loop {
            let st = s.stat();
            if st.pids.len() == 2 {
                break st;
            }
            assert!(Instant::now() < deadline, "{st:?}");
            std::thread::sleep(POLL);
        }
    };
    for p in &st.pids {
        assert_eq!(bsd(*p as i32).ppid, h.child);
    }
}

#[test]
fn i_hld_20_five_megabytes_of_input_while_output_flows() {
    const N: usize = 5 * 1024 * 1024;
    let script = format!("stty raw -echo; echo READY; (while :; do echo out; done) & head -c {N} | /usr/bin/shasum -a 256; kill $!"); // os-ok: in /usr/bin on both systems
    let h = spawn(Opts::sh(&script));
    let mut s = h.session(AttachMode::Earliest);
    s.wait_for("READY");
    let mut data = vec![0u8; N];
    let mut x: u32 = 0x1234_5678;
    for b in data.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    let file = h.root.join("input.bin");
    std::fs::write(&file, &data).unwrap();
    let sum = Command::new("/usr/bin/shasum").args(["-a", "256"]).arg(&file).output().unwrap(); // os-ok: in /usr/bin on both systems
    let want = String::from_utf8_lossy(&sum.stdout).split_whitespace().next().unwrap().to_string();
    let w = s.c.writer();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        for chunk in data.chunks(HOLDER_READ_BUFFER_BYTES as usize) {
            let frame = kea_helper::proto::encode_input(chunk);
            w.lock().unwrap().write_all(&frame).unwrap();
        }
    });
    s.wait_for(&want);
    writer.join().unwrap();
    assert!(s.saw("out\n"), "output was flowing meanwhile");
}

#[test]
fn i_hld_23_state_json_after_spawn_and_after_exit() {
    let t0 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let mut o = Opts::sh("read x; exit 7");
    o.kea_version = Some("9.9.9-test".into());
    o.kind = "agent";
    let h = spawn(o);
    let t1 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let j = h.json();
    assert_eq!(j["protocol"], kea_helper::limits::HOLDER_PROTOCOL_VERSION);
    assert_eq!(j["keaVersion"], "9.9.9-test");
    assert_eq!(j["helperVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!((j["ptyId"].as_str(), j["sessionId"].as_str(), j["kind"].as_str()), (Some(h.id.as_str()), Some("sess1"), Some("agent")));
    assert_eq!(j["cwd"].as_str().map(std::path::PathBuf::from), Some(h.root.clone()));
    assert_eq!(j["argv"], serde_json::json!(["/bin/sh", "-c", "read x; exit 7"]));
    assert_eq!((j["pid"].as_i64(), j["childPid"].as_i64()), (Some(h.pid as i64), Some(h.child as i64)));
    assert_eq!(j["pidStartTime"].as_u64(), Some(bsd(h.pid).start_us), "µs since epoch from PROC_PIDTBSDINFO");
    let created = j["createdAt"].as_u64().unwrap();
    assert!(t0 <= created && created <= t1);
    assert_eq!((j["exited"].as_bool(), j["exitCode"].is_null(), j["exitSignal"].is_null()), (Some(false), true, true));
    assert_eq!(j["refusals"], 0);
    assert_eq!(j["socket"].as_str().map(std::path::PathBuf::from), Some(h.sock.clone()));
    for p in [h.json_path(), h.ring_path(), h.sock.clone()] {
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&p).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o600, "{}", p.display());
    }
    let s = h.session(AttachMode::Latest);
    s.c.input(b"\r");
    let j = h.wait_exited();
    assert_eq!((j["exitCode"].as_i64(), j["exitSignal"].is_null()), (Some(7), true));
    assert_eq!(j["pidStartTime"].as_u64(), Some(bsd(h.pid).start_us));

    // A signal death: exitCode null, exitSignal set; EXIT carries code −1.
    let h = spawn(Opts::new(&["/bin/sleep", "1000"]));
    let mut s = h.session(AttachMode::Latest);
    s.c.send(&ClientFrame::Signal { signo: libc::SIGKILL as u8, target: SignalTarget::Child });
    s.until("EXIT", |s| s.exit.is_some());
    assert_eq!(s.exit, Some((-1, libc::SIGKILL as u8)));
    let j = h.wait_exited();
    assert_eq!((j["exitCode"].is_null(), j["exitSignal"].as_i64()), (true, Some(libc::SIGKILL as i64)));
}

/// `HELLO` and an `INPUT` of `text`, hex-encoded for the intruder's command line.
fn hello_and_input_hex(text: &[u8]) -> String {
    let mut frames = kea_helper::proto::encode_client(&ClientFrame::Hello { proto: kea_helper::proto::PROTO });
    frames.extend(kea_helper::proto::encode_input(text));
    frames.iter().map(|b| format!("{b:02x}")).collect()
}

/// One intruder connection's fate, from its report line.
#[derive(Debug, PartialEq)]
enum Fate {
    RefusedAtConnect,
    Closed { after: Duration, bytes: u64 },
    Open,
}

/// Runs the intruder: `n` connections at once, each sending `hex`. While they wait, `during` runs (with the
/// intruder still running at least until its connections are open). Returns each connection's fate.
fn intrude(h: &Holder, n: u64, hex: &str, mut during: impl FnMut(&mut std::process::Child)) -> Vec<Fate> {
    let bin = build_intruder(&h.root);
    let mut p = Command::new(bin)
        .arg(&h.sock)
        .arg(n.to_string())
        .arg(hex)
        .arg(T.as_millis().to_string())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = std::io::BufReader::new(p.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert!(line.starts_with("connected "), "{line:?}");
    during(&mut p);
    let status = p.wait().unwrap();
    let fates: Vec<Fate> = out
        .lines()
        .map(|l| {
            let l = l.unwrap();
            let f: Vec<&str> = l.split(' ').collect();
            match f[2] {
                "refused-at-connect" => Fate::RefusedAtConnect,
                "closed" => Fate::Closed { after: Duration::from_secs_f64(f[3].parse::<f64>().unwrap() / 1e3), bytes: f[4].parse().unwrap() },
                _ => Fate::Open,
            }
        })
        .collect();
    assert_eq!(fates.len() as u64, n);
    assert!(status.success(), "intruder: {status:?}, {fates:?}");
    fates
}

/// "Refused at once": its check answered (no) well before the check deadline would have refused it.
const REFUSED_AT_ONCE: Duration = Duration::from_millis(HOLDER_PEER_CHECK_TIMEOUT_MS / 2);

#[test]
fn i_hld_24_unsigned_intruder_is_refused_and_signed_client_replaces() {
    let h = spawn(Opts::sh("stty -echo; while read l; do echo \"echo:$l\"; done"));
    let mut a = h.session(AttachMode::Earliest);
    a.c.input(b"a1\r");
    a.wait_for("echo:a1");
    // The intruder (tests/common/intruder.c): same user, not the client the holder admits (on macOS not
    // signed to the requirement, on Linux another executable), speaking the protocol properly. As many
    // connections as there are check slots, so each gets a real check.
    let mut rtts = Vec::new();
    let fates = intrude(&h, HOLDER_PENDING_CHECKS_MAX, &hello_and_input_hex(b"y\r"), |_| {
        // The attached client while the intruder's checks run.
        for i in 0..HOLDER_PENDING_CHECKS_MAX {
            let tag = format!("during{i}");
            a.c.input(format!("{tag}\r").as_bytes());
            let start = Instant::now();
            a.wait_for(&format!("echo:{tag}"));
            rtts.push(start.elapsed());
        }
    });
    for f in &fates {
        match f {
            Fate::Closed { after, bytes: 0 } => assert!(*after < REFUSED_AT_ONCE, "refused after {after:?}"),
            other => panic!("not refused at once with nothing answered: {other:?}"),
        }
    }
    assert!(rtts.iter().all(|r| *r < ECHO_MAX), "echo during the intrusion: {rtts:?}");
    // The first refusal is in the state json at once; the others are coalesced into the next write, at
    // most once per HOLDER_REFUSAL_LOG_INTERVAL_MS (longer than this test).
    wait_until("the refusal in the state json", T, || h.json()["refusals"] == 1);
    a.c.input(b"a2\r");
    a.wait_for("echo:a2");
    assert!(!a.saw("echo:y"), "nothing from the intruder reached the PTY");
    assert!(!a.c.eof, "the attached client was not disturbed");
    // The test's own client is admitted and replaces A.
    let mut b = h.session(AttachMode::Latest);
    a.c.wait_eof(T);
    b.c.input(b"b1\r");
    b.wait_for("echo:b1");
    const _: () = assert!(HOLDER_REFUSAL_LOG_INTERVAL_MS > T.as_millis() as u64);
    assert_eq!(h.json()["refusals"], 1, "later refusals wait for the interval");
}

/// The check delay for I-HLD-29, through the debug-only `KEA_HELPER_TEST_CHECK_DELAY_MS`: half the check deadline, so
/// every check still answers, each one only after this long.
const CHECK_DELAY_MS: u64 = HOLDER_PEER_CHECK_TIMEOUT_MS / 2;
/// Three times as many intruder connections as there are check slots.
const INTRUDERS: u64 = 3 * HOLDER_PENDING_CHECKS_MAX;

// A flood of connections whose checks are slow: the attached client's echo stays fast throughout (a loop
// that waited for even one check would take CHECK_DELAY_MS ≥ 2 × ECHO_MAX), no more checks run at once than
// there are slots, the rest are refused at once, every intruder is refused with nothing sent, the client
// is never dropped, every check process is reaped, and the footprint stays within P-MEM-4.
#[test]
fn i_hld_29_a_flood_of_slow_checks_never_stalls_the_attached_client() {
    const _: () = assert!(CHECK_DELAY_MS >= 2 * ECHO_MAX.as_millis() as u64);
    let mut o = Opts::new(&["/bin/cat"]);
    o.check_delay_ms = Some(CHECK_DELAY_MS);
    let h = spawn(o);
    let mut a = h.session(AttachMode::Latest); // admitted after its own (delayed) check
    a.echo("before");
    let mut rtts = Vec::new();
    let mut most_children = 0;
    let fates = intrude(&h, INTRUDERS, &hello_and_input_hex(b"intruder\r"), |p| {
        let mut i = 0;
        while p.try_wait().unwrap().is_none() {
            rtts.push(a.echo(&format!("ping{i}")));
            most_children = most_children.max(children(h.pid).len());
            i += 1;
        }
    });
    let max = rtts.iter().max().copied().unwrap_or_default();
    assert!(max < ECHO_MAX, "an echo took {max:?} during the flood ({} round trips)", rtts.len());
    // Linux refuses the whole flood at accept, often before a second round trip
    assert!(rtts.len() > 1 || kea_helper::os::IS_LINUX, "the client was served while the checks ran");
    assert!(most_children <= 1 + HOLDER_PENDING_CHECKS_MAX as usize, "{most_children} children: more checks than slots");
    let mut slow = 0;
    for f in &fates {
        match f {
            Fate::Closed { after, bytes: 0 } if *after >= Duration::from_millis(CHECK_DELAY_MS) => slow += 1,
            Fate::Closed { bytes: 0, .. } | Fate::RefusedAtConnect => {}
            other => panic!("an intruder was not refused, or was answered: {other:?}"),
        }
    }
    if kea_helper::os::IS_LINUX {
        // Linux checks a peer at accept, in the holder: no check process, none waits, the delay is macOS's
        assert_eq!((slow, most_children), (0, 1), "every intruder refused at accept: {fates:?}");
    } else {
        assert!((1..=HOLDER_PENDING_CHECKS_MAX).contains(&slow), "{slow} connections waited for a check: {fates:?}");
    }
    assert!(!a.c.eof && !a.saw("intruder"), "the client was not dropped and no intruder input arrived");
    a.echo("after");
    wait_until("every check process reaped", T, || children(h.pid) == [h.child]);
    let footprint = kea_helper::os::footprint(h.pid).unwrap();
    assert!(footprint <= HOLDER_FOOTPRINT_MAX_BYTES, "footprint {footprint} after the flood");
}

/// A check slower than the check deadline, through a debug-only knob: twice the deadline.
const CHECK_PAST_DEADLINE_MS: u64 = 2 * HOLDER_PEER_CHECK_TIMEOUT_MS;

#[test]
fn i_hld_29_a_check_past_the_deadline_is_killed_and_refused() {
    if kea_helper::os::IS_LINUX {
        println!("skipped: Linux checks a peer at accept, in the holder, in under a millisecond: no check can outlast the deadline");
        return;
    }
    let mut o = Opts::new(&["/bin/cat"]);
    o.check_delay_ms = Some(CHECK_PAST_DEADLINE_MS);
    let h = spawn(o);
    // The test runner itself, which satisfies the requirement: too slow a check refuses it anyway.
    let start = Instant::now();
    let mut c = h.connect();
    c.send(&ClientFrame::Hello { proto: kea_helper::proto::PROTO });
    assert!(c.next(T).is_none() && c.eof, "refused with nothing answered");
    let took = start.elapsed();
    // The holder keeps time in whole milliseconds (`now_ms` truncates), so its deadline can fall up to 1 ms early
    let clock_ms = Duration::from_millis(1);
    assert!(took + clock_ms >= Duration::from_millis(HOLDER_PEER_CHECK_TIMEOUT_MS), "refused before the deadline: {took:?}");
    assert!(took < Duration::from_millis(CHECK_PAST_DEADLINE_MS), "the check was waited for, not cut off: {took:?}");
    wait_until("the refusal in the state json", T, || h.json()["refusals"] == 1);
    wait_until("the check process killed and reaped", T, || children(h.pid) == [h.child]);
    // No client can get in to clean up (every check is too slow), so the test ends it another way: once
    // the child is gone, SIGTERM ends the holder.
    unsafe { libc::kill(h.child, libc::SIGKILL) };
    h.wait_exited();
    unsafe { libc::kill(h.pid, libc::SIGTERM) };
    wait_until("holder exit", T, || !alive(h.pid));
}

#[test]
fn i_hld_19_socket_path_at_and_over_the_limit() {
    let (_tmp, root) = tmpdir();
    let limit = SOCKET_PATH_MAX_BYTES as usize;
    let prefix = format!("{}/", root.display());
    let at = std::path::PathBuf::from(format!("{prefix}{}", "s".repeat(limit - prefix.len())));
    assert_eq!(at.as_os_str().len(), limit);
    let mut o = Opts::new(&["/bin/sleep", "1000"]);
    o.sock = Some(at.clone());
    let h = spawn(o);
    let mut s = h.session(AttachMode::Latest);
    assert!(!s.hello().exited);
    drop(s);
    drop(h);

    let (_tmp2, root2) = tmpdir();
    let over = std::path::PathBuf::from(format!("{}/{}", root2.display(), "s".repeat(limit + 1 - root2.as_os_str().len() - 1)));
    assert_eq!(over.as_os_str().len(), limit + 1);
    let mut o = Opts::new(&["/bin/sleep", "1000"]);
    o.sock = Some(over);
    let id = new_pty_id();
    let out = launcher(&o, &root2, &id).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let err = v["error"].as_str().unwrap();
    assert!(err.contains(&format!("socket path is {} bytes", limit + 1)) && err.contains(&format!("the limit is {limit}")), "{err}");
    assert!(!root2.join("st").exists(), "nothing was started");
}

#[test]
fn i_hld_27_no_detach_holder_ends_with_its_parent() {
    let (_tmp, root) = tmpdir();
    let id = new_pty_id();
    let cmd = launcher(&Opts::new(&["/bin/sleep", "1000"]), &root, &id);
    // `--no-detach` goes among the options, before `--`.
    let args: Vec<OsString> = cmd.get_args().map(Into::into).collect();
    let sep = args.iter().position(|a| a == "--").unwrap();
    let mut fixed = args[..sep].to_vec();
    fixed.push("--no-detach".into());
    fixed.extend_from_slice(&args[sep..]);
    let mut p = Command::new(BIN).args(&fixed).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(p.stdout.as_mut().unwrap()), &mut line).unwrap();
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["pid"].as_i64(), Some(p.id() as i64), "the process itself is the holder");
    let child = v["childPid"].as_i64().unwrap() as i32;
    let guard = Holder {
        pid: p.id() as i32,
        child,
        id: id.clone(),
        root: root.clone(),
        state_dir: root.join("st"),
        sock: root.join("r").join(format!("{id}.sock")),
        extra: vec![],
        tmp: None,
    };
    let mut s = guard.session(AttachMode::Latest);
    assert_eq!(s.hello().child_pid, child as u32);
    drop(p.stdin.take()); // the parent is gone
    let status = p.wait().unwrap();
    assert!(status.success(), "{status:?}");
    wait_until("child gone", T, || !alive(child));
    assert!(!guard.sock.exists());
}

#[test]
fn i_hld_26_launch_errors_are_reported_clearly() {
    let (_tmp, root) = tmpdir();
    // A client the holder cannot admit by: the daemon reports ERR, the launcher prints it. macOS: a requirement that
    // does not compile, and Linux's executable; Linux: an executable that is not there, one its user can change named
    // as root's, and macOS's requirement.
    let me = std::env::current_exe().unwrap().into_os_string();
    let bad: Vec<([OsString; 2], &str)> = if kea_helper::os::IS_LINUX {
        vec![
            (["--client-exe".into(), "/nonexistent/kea-app".into()], "--client-exe /nonexistent/kea-app: No such file"),
            (["--client-exe".into(), me], "pass --client-exe-unchecked"),
            (["--client-req".into(), "anchor apple".into()], "--client-req is a macOS code requirement"),
        ]
    } else {
        vec![
            (["--client-req".into(), "this is (not a requirement".into()], "--client-req"),
            (["--client-exe".into(), me], "macOS admits a client by its code signature"),
        ]
    };
    for (client, want) in bad {
        let mut o = Opts::new(&["/bin/sleep", "1000"]);
        o.client = Some(client);
        let out = launcher(&o, &root, &new_pty_id()).output().unwrap();
        assert_eq!(out.status.code(), Some(1));
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(v["error"].as_str().unwrap().contains(want), "{v}");
    }
    // Bad arguments never reach the daemon.
    let out = Command::new(BIN).args(["pty", "--id", "x"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("\"error\""));
    // A socket directory that is a symlink: refused before anything starts, and left as it is.
    let real = root.join("real");
    std::fs::DirBuilder::new().mode(0o700).create(&real).unwrap();
    std::os::unix::fs::symlink(&real, root.join("link")).unwrap();
    let mut o = Opts::new(&["/bin/sleep", "1000"]);
    o.sock = Some(root.join("link/x.sock"));
    let out = launcher(&o, &root, &new_pty_id()).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(v["error"].as_str().unwrap().contains("is not a directory"), "{v}");
    assert!(std::fs::read_dir(&real).unwrap().next().is_none() && !root.join("st").exists(), "nothing was created");
    assert!(std::fs::symlink_metadata(root.join("link")).unwrap().file_type().is_symlink(), "never repaired");
    // An exec failure is the child's: message on the terminal, exit 127.
    let h = spawn(Opts::new(&["/nonexistent/kea-test-prog", "a"]));
    let mut s = h.session(AttachMode::Earliest);
    s.until("EXIT", |s| s.exit.is_some());
    assert!(s.saw("kea-helper: exec /nonexistent/kea-test-prog: No such file or directory"), "{}", s.tail());
    assert_eq!(s.exit, Some((127, 0)));
    // So is a missing --cwd: the holder starts, the child reports the chdir on the terminal.
    let mut o = Opts::new(&["/bin/echo", "unreached"]);
    o.cwd = Some(root.join("gone"));
    let h = spawn(o);
    let mut s = h.session(AttachMode::Earliest);
    s.until("EXIT", |s| s.exit.is_some());
    let want = format!("kea-helper: chdir {}: No such file or directory", root.join("gone").display());
    assert!(s.saw(&want) && !s.saw("unreached"), "{}", s.tail());
    assert_eq!(s.exit, Some((127, 0)));
    assert_eq!(h.wait_exited()["exitCode"], 127);
}

/// CPU time used by `pid` so far, in ns.
fn cpu_ns(pid: i32) -> u64 {
    kea_helper::os::cpu_time_ns(pid).unwrap()
}

/// How many idle holders I-HLD-18 measures.
const IDLE_HOLDERS: usize = 20;
/// "0 % CPU" over the idle window: at most 1 ms (0.01 % of 10 s), room for the one wake-up when the
/// client left, nothing for a timer or a busy loop.
const IDLE_CPU_MAX_NS: u64 = 1_000_000;

#[test]
fn i_hld_18_twenty_idle_holders_stay_small_and_use_no_cpu() {
    // The observation window: a defined measurement, not a wait for something.
    const IDLE: Duration = Duration::from_secs(10);
    // Each ring (the default size, twice HOLDER_FOOTPRINT_MAX_BYTES) is filled twice over, so every page of
    // its mapping is dirty: the footprint must not count it (the mapped ring is excluded).
    const _: () = assert!(RING_BYTES_DEFAULT >= 2 * HOLDER_FOOTPRINT_MAX_BYTES);
    let fill = 2 * RING_BYTES_DEFAULT;
    // `head` from /dev/zero, not `yes | head`: the tty hands an eager reader a few bytes per read from the
    // latter (≈ 2 MB/s), and whole 1 KiB blocks from the former.
    let fill_then_cat = format!("stty -opost; head -c {fill} /dev/zero; exec /bin/cat");
    let holders: Vec<Holder> = (0..IDLE_HOLDERS).map(|_| spawn(Opts::sh(&fill_then_cat))).collect();
    for h in &holders {
        wait_until("a full ring", T, || h.ring_header().latest >= fill);
        assert_eq!(h.ring_header().capacity, RING_BYTES_DEFAULT);
    }
    // Each admits a client once (on macOS the code check runs in a forked child, so its memory is not kept),
    // echoes, and is left idle with no client.
    for h in &holders {
        let mut s = h.session(AttachMode::Latest);
        s.echo("idle");
    }
    let before: Vec<u64> = holders.iter().map(|h| cpu_ns(h.pid)).collect();
    let start = Instant::now();
    let out = Command::new(BIN).arg("footprint").args(holders.iter().map(|h| h.pid.to_string())).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text.lines().count(), holders.len(), "{text}");
    for line in text.lines() {
        let bytes: u64 = line.split(' ').nth(1).and_then(|b| b.parse().ok()).unwrap_or_else(|| panic!("{line}"));
        assert!(bytes <= HOLDER_FOOTPRINT_MAX_BYTES, "footprint over P-MEM-4 with a full ring: {line}");
    }
    // 0 % CPU: blocked in poll(2) with no timer armed.
    std::thread::sleep(IDLE.saturating_sub(start.elapsed()));
    for (h, b) in holders.iter().zip(before) {
        let used = cpu_ns(h.pid) - b;
        assert!(used < IDLE_CPU_MAX_NS, "holder {} used {used} ns of CPU while idle", h.pid);
    }
}
