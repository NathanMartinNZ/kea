//! In-process holder tests: the real loop, PTY and socket, with the peer check stubbed (R-HLD-5) and a
//! counting allocator (R-HLD-6).

use super::*;
use crate::admission::stub::Stub;
use crate::proto::{AttachMode, FrameReader, HolderFrame, encode_client, encode_input};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Upper bound for any wait in these tests (they run in parallel, under load).
const WAIT: Duration = Duration::from_secs(30);

struct T {
    h: Holder<Stub>,
    stub: Stub,
    dir: PathBuf,
    sock: PathBuf,
    _wake_wr: OwnedFd,
    _tmp: tempfile::TempDir,
}

/// A private (0700) temp dir, short enough for socket paths.
fn tmp() -> (tempfile::TempDir, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::Builder::new().prefix("khT").permissions(std::fs::Permissions::from_mode(0o700)).tempdir_in("/tmp").unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    (tmp, dir)
}

/// `kea-helper pty` arguments: state in `<dir>/st`, the socket at `sock`, `argv` as the child, the smallest ring.
fn pty_args(dir: &Path, sock: &Path, argv: &[&str]) -> PtyArgs {
    pty_args_ring(dir, sock, argv, RING_BYTES_MIN)
}

fn pty_args_ring(dir: &Path, sock: &Path, argv: &[&str], ring_bytes: u64) -> PtyArgs {
    let mut raw: Vec<OsString> = [
        "--id", "abcdefghij", "--session", "s1", "--kind", "shell", "--cols", "80", "--rows", "24", "--client-req", "always",
        "--ring-bytes",
    ]
    .iter()
    .map(Into::into)
    .collect();
    raw.push(ring_bytes.to_string().into());
    for (k, v) in [("--dir", dir.join("st")), ("--sock", sock.to_path_buf()), ("--cwd", dir.to_path_buf())] {
        raw.push(k.into());
        raw.push(v.into());
    }
    raw.push("--".into());
    raw.extend(argv.iter().map(Into::into));
    parse_pty(&raw, false).unwrap()
}

fn start(argv: &[&str]) -> T {
    start_ring(argv, RING_BYTES_MIN)
}

fn start_ring(argv: &[&str], ring_bytes: u64) -> T {
    let (tmp, dir) = tmp();
    let sock = dir.join("h.sock");
    let (wake_rd, wake_wr) = pipe_cloexec().unwrap();
    let stub = Stub::new(unsafe { libc::getuid() });
    let h = Holder::spawn(pty_args_ring(&dir, &sock, argv, ring_bytes), stub.clone(), wake_rd, None).unwrap();
    T { h, stub, dir, sock, _wake_wr: wake_wr, _tmp: tmp }
}

struct Client {
    s: UnixStream,
    r: FrameReader,
    out: Vec<u8>,
    frames: Vec<HolderFrame>,
    next_seq: u64,
    eof: bool,
}

impl Client {
    fn connect(t: &T) -> Client {
        let s = UnixStream::connect(&t.sock).unwrap();
        s.set_nonblocking(true).unwrap();
        Client { s, r: FrameReader::default(), out: Vec::new(), frames: Vec::new(), next_seq: 0, eof: false }
    }

    /// Small control frames always fit the socket buffer.
    fn send(&mut self, b: &[u8]) {
        self.s.set_nonblocking(false).unwrap();
        self.s.write_all(b).unwrap();
        self.s.set_nonblocking(true).unwrap();
    }

    fn poll(&mut self) {
        let mut buf = [0u8; 65536];
        loop {
            match self.s.read(&mut buf) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(n) => self.r.push(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    self.eof = true;
                    break;
                }
            }
        }
        while let Some(f) = self.r.next_frame() {
            match f.unwrap() {
                HolderFrame::Output { seq, data } => {
                    assert_eq!(seq, self.next_seq, "contiguous output");
                    self.next_seq = seq + data.len() as u64;
                    self.out.extend_from_slice(&data);
                }
                other => self.frames.push(other),
            }
        }
    }

    #[track_caller]
    fn hello_attach(&mut self, t: &mut T) {
        self.send(&encode_client(&ClientFrame::Hello { proto: proto::PROTO }));
        pump(t, self, |c| c.frames.iter().any(|f| matches!(f, HolderFrame::Hello(_))));
        let earliest = match &self.frames[0] {
            HolderFrame::Hello(h) => h.earliest,
            f => panic!("{f:?}"),
        };
        self.next_seq = earliest;
        self.send(&encode_client(&ClientFrame::Attach { mode: AttachMode::FromSeq, seq: earliest }));
    }

    fn saw(&self, needle: &[u8]) -> bool {
        self.out.windows(needle.len()).any(|w| w == needle)
    }
}

/// Steps the holder and reads the client until `done` holds.
#[track_caller] // a timeout names the wait that timed out, not this line
fn pump(t: &mut T, c: &mut Client, done: impl Fn(&Client) -> bool) {
    let deadline = Instant::now() + WAIT;
    loop {
        c.poll();
        if done(c) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out; output so far: {:?}; other frames: {:?}", String::from_utf8_lossy(&c.out), c.frames);
        let _ = t.h.step(5);
    }
}

fn json_refusals(t: &T) -> u64 {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(t.dir.join("st/abcdefghij.json")).unwrap()).unwrap();
    v["refusals"].as_u64().unwrap()
}

#[test]
fn r_hld_5_refused_peers_never_disturb_the_client_and_admitted_ones_replace_it() {
    let mut t = start(&["/bin/cat"]);
    let mut a = Client::connect(&t);
    a.hello_attach(&mut t);
    a.send(&encode_input(b"a1\r"));
    pump(&mut t, &mut a, |c| c.saw(b"a1"));

    // Signature not satisfied: refused at once, nothing reaches the PTY, A untouched.
    t.stub.ok.set(false);
    let mut intruder = Client::connect(&t);
    intruder.send(&encode_client(&ClientFrame::Hello { proto: proto::PROTO }));
    let _ = intruder.s.write_all(&encode_input(b"y\r"));
    pump(&mut t, &mut intruder, |c| c.eof);
    assert!(intruder.frames.is_empty(), "a refused peer gets nothing");
    assert_eq!((t.h.admission.refusals(), json_refusals(&t)), (1, 1), "counted, and the json says so");

    // Uid mismatch: refused too; the json is rewritten at most once a minute.
    t.stub.ok.set(true);
    t.stub.uid.set(t.stub.uid.get() + 1);
    let mut other_uid = Client::connect(&t);
    pump(&mut t, &mut other_uid, |c| c.eof);
    assert_eq!((t.h.admission.refusals(), json_refusals(&t)), (2, 1));
    assert!(t.h.json_due.is_some(), "the second refusal is written when the minute is up");

    a.send(&encode_input(b"a2\r"));
    pump(&mut t, &mut a, |c| c.saw(b"a2"));
    assert!(!a.eof && !a.saw(b"y"), "the attached client was never disturbed and no intruder input arrived");

    // Admitted: replaces A.
    t.stub.uid.set(unsafe { libc::getuid() });
    let mut b = Client::connect(&t);
    b.hello_attach(&mut t);
    pump(&mut t, &mut a, |c| c.eof);
    b.send(&encode_input(b"b1\r"));
    pump(&mut t, &mut b, |c| c.saw(b"b1"));
}

// Checks that never answer (held back by the stub): the attached client keeps echoing, the pending
// connections get nothing, one more than the slots is refused at once, and the verdicts decide later.
#[test]
fn r_hld_5_pending_checks_never_block_the_client_and_are_capped() {
    let mut t = start(&["/bin/cat"]);
    let mut a = Client::connect(&t);
    a.hello_attach(&mut t);
    a.send(&encode_input(b"a1\r"));
    pump(&mut t, &mut a, |c| c.saw(b"a1"));

    t.stub.hold.set(true);
    let mut waiting: Vec<Client> = (0..admission::SLOTS).map(|_| Client::connect(&t)).collect();
    for (i, w) in waiting.iter_mut().enumerate() {
        w.send(&encode_client(&ClientFrame::Hello { proto: proto::PROTO }));
        w.send(&encode_input(format!("w{i}\r").as_bytes()));
    }
    let mut extra = Client::connect(&t);
    pump(&mut t, &mut extra, |c| c.eof);
    assert!(extra.frames.is_empty(), "refused at once, nothing sent");
    assert_eq!(t.h.admission.pending(), admission::SLOTS);
    assert_eq!((t.h.admission.refusals(), t.stub.started.get()), (1, 1 + admission::SLOTS as u32), "refused without a check");
    for i in 0..3 {
        let line = format!("during{i}\r");
        a.send(&encode_input(line.as_bytes()));
        pump(&mut t, &mut a, |c| c.saw(line.trim_end().as_bytes()));
    }
    for w in &mut waiting {
        w.poll();
        assert!(!w.eof && w.frames.is_empty(), "a pending connection is neither answered nor closed");
    }

    // The verdicts: all but the last refused (closed), the last admitted (replaces A).
    for _ in 1..admission::SLOTS {
        t.stub.answer(Some(admission::REFUSE));
    }
    t.stub.answer(Some(admission::ADMIT));
    let (refused, admitted) = waiting.split_at_mut(admission::SLOTS - 1);
    for w in refused {
        pump(&mut t, w, |c| c.eof);
        assert!(w.frames.is_empty());
    }
    let b = &mut admitted[0];
    pump(&mut t, b, |c| c.frames.iter().any(|f| matches!(f, HolderFrame::Hello(_))));
    pump(&mut t, &mut a, |c| c.eof);
    b.hello_attach(&mut t);
    let mine = format!("w{}", admission::SLOTS - 1);
    pump(&mut t, b, |c| c.saw(mine.as_bytes()));
    assert!(!b.saw(b"w0"), "no refused connection's input reached the PTY");
    assert_eq!(t.h.admission.refusals(), admission::SLOTS as u64);
    assert_eq!(t.h.admission.pending(), 0);
}

// The socket's directory (and `/tmp/kea-<uid>` above it) is checked with lstat before anything is
// created; an unsafe one fails the start, is logged, and is left exactly as it was.
#[test]
fn r_hld_9_socket_directory_must_be_private_and_is_never_repaired() {
    use std::os::unix::fs::PermissionsExt;
    let (_tmp, root) = tmp();
    let spawn_in = |name: &str, sock_dir: &Path| {
        let base = root.join(name);
        std::fs::create_dir(&base).unwrap();
        let (wake_rd, _wake_wr) = pipe_cloexec().unwrap();
        let r = Holder::spawn(pty_args(&base, &sock_dir.join("h.sock"), &["/bin/cat"]), Stub::new(unsafe { libc::getuid() }), wake_rd, None);
        (r.map(drop), base)
    };
    let mode = |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;

    // A symlink to a private directory.
    let real = root.join("real");
    DirBuilder::new().mode(0o700).create(&real).unwrap();
    std::os::unix::fs::symlink(&real, root.join("link")).unwrap();
    let (r, base) = spawn_in("a", &root.join("link"));
    assert!(r.unwrap_err().contains("is not a directory"));
    assert!(!real.join("h.sock").exists() && !base.join("st").exists(), "nothing was created");
    // A directory other users can enter: refused, and its mode is left alone.
    let open = root.join("open");
    std::fs::create_dir(&open).unwrap();
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (r, _) = spawn_in("b", &open);
    assert!(r.unwrap_err().contains("accessible to other users (mode 755)"));
    assert_eq!(mode(&open), 0o755, "never repaired");
    // Missing: created 0700, with its parents.
    let fresh = root.join("x/y");
    let (r, _) = spawn_in("c", &fresh);
    r.unwrap();
    assert_eq!((mode(&root.join("x")), mode(&fresh)), (0o700, 0o700));

    // The shared root (`/tmp/kea-<uid>` in production; here the same layout under this test's dir).
    let shared = format!("{}/kea-", root.display());
    let uid_dir = PathBuf::from(format!("{shared}{}", unsafe { libc::getuid() }));
    let run = uid_dir.join("0123456789abcdef");
    std::fs::create_dir(&uid_dir).unwrap();
    std::fs::set_permissions(&uid_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let err = private_socket_dir(&run, &shared).unwrap_err();
    assert!(err.contains(&uid_dir.display().to_string()) && err.contains("accessible to other users"), "{err}");
    assert!(!run.exists() && mode(&uid_dir) == 0o755, "nothing created under it, nothing repaired");
    std::fs::set_permissions(&uid_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    private_socket_dir(&run, &shared).unwrap();
    assert_eq!(mode(&run), 0o700);
    // The shared root replaced by a symlink to a private directory of the test's: still refused.
    std::fs::rename(&uid_dir, root.join("moved")).unwrap();
    std::os::unix::fs::symlink(root.join("moved"), &uid_dir).unwrap();
    assert!(private_socket_dir(&run, &shared).unwrap_err().contains("is not a directory"));
    // Which directory is the shared root (mirrors ptyhost's `/^\/tmp\/kea-\d+(?=\/|$)/`).
    let root_of = |p: &str| shared_root(Path::new(p), SHARED_RUN_ROOT_PREFIX).map(|r| r.to_string_lossy().into_owned());
    assert_eq!(root_of("/tmp/kea-501/0123456789abcdef").as_deref(), Some("/tmp/kea-501"));
    assert_eq!(root_of("/tmp/kea-501").as_deref(), Some("/tmp/kea-501"));
    assert_eq!(root_of("/tmp/kea-501x/a"), None);
    assert_eq!(root_of("/tmp/kea-/a"), None);
    assert_eq!(root_of("/private/tmp/kea-501/a"), None);
    // Not covered here: a directory owned by another uid (creating one needs root).
}

#[test]
fn i_hld_11_connection_from_another_uid_is_rejected() {
    // The peer credential is stubbed (a second uid cannot be had without root); the socket is real.
    let mut t = start(&["/bin/cat"]);
    t.stub.uid.set(unsafe { libc::getuid() } + 1);
    let mut c = Client::connect(&t);
    c.send(&encode_client(&ClientFrame::Hello { proto: proto::PROTO }));
    c.send(&encode_input(b"x\r"));
    pump(&mut t, &mut c, |c| c.eof);
    assert!(c.frames.is_empty() && c.out.is_empty(), "nothing is sent to a rejected peer");
    assert_eq!(t.h.admission.refusals(), 1);
    assert!(t.h.conn.is_none() && t.h.input.is_empty(), "not admitted, and its input never reached the PTY");
}

#[test]
fn r_hld_2_protocol_errors_close_only_that_connection() {
    let mut t = start(&["/bin/cat"]);
    // Not HELLO first → ERROR{4} and close.
    let mut c = Client::connect(&t);
    c.send(&encode_client(&ClientFrame::Stat));
    pump(&mut t, &mut c, |c| c.eof);
    assert!(matches!(c.frames[..], [HolderFrame::Error { code: code::NOT_HELLO, .. }]));
    // Unknown type → ERROR{1}, connection kept; bad proto → ERROR{3}, kept; oversized → ERROR{2}, closed.
    let mut c = Client::connect(&t);
    c.send(&encode_client(&ClientFrame::Hello { proto: 99 }));
    c.send(&encode_client(&ClientFrame::Hello { proto: proto::PROTO }));
    c.send(&proto::raw_frame(0x7f, b"abc"));
    c.send(&encode_client(&ClientFrame::Ack { seq: 1 }));
    c.send(&encode_client(&ClientFrame::Release));
    pump(&mut t, &mut c, |c| c.frames.len() >= 5);
    let codes: Vec<u16> = c.frames.iter().filter_map(|f| if let HolderFrame::Error { code, .. } = f { Some(*code) } else { None }).collect();
    assert_eq!(codes, [code::BAD_PROTO, code::UNKNOWN_TYPE, code::NOT_ATTACHED, code::CHILD_ALIVE]);
    assert!(c.frames.iter().any(|f| matches!(f, HolderFrame::Error { message, .. } if message == b"unknown frame type 0x7f")));
    assert!(!c.eof);
    let mut huge = vec![proto::ty::INPUT];
    huge.extend(((HOLDER_MAX_FRAME_BYTES + 1) as u32).to_le_bytes());
    c.send(&huge);
    pump(&mut t, &mut c, |c| c.eof);
    assert!(matches!(c.frames.last(), Some(HolderFrame::Error { code: code::BAD_LENGTH, .. })));
    // The holder still serves the next client.
    let mut d = Client::connect(&t);
    d.hello_attach(&mut t);
    d.send(&encode_input(b"ok\r"));
    pump(&mut t, &mut d, |c| c.saw(b"ok"));
}

#[test]
fn r_hld_6_socket_reads_stop_at_the_input_cap_and_resume_as_the_child_drains() {
    let script = "stty raw -echo; echo R; while [ ! -f gate ]; do sleep 0.02; done; exec cat >/dev/null";
    let mut t = start(&["/bin/sh", "-c", script]);
    let mut c = Client::connect(&t);
    c.hello_attach(&mut t);
    pump(&mut t, &mut c, |c| c.saw(b"R"));
    let total = 3 * HOLDER_INPUT_CAP_BYTES as usize;
    let mut stream = Vec::new();
    for chunk in vec![b'k'; total].chunks(60_000) {
        stream.extend(encode_input(chunk));
    }
    let mut written = 0;
    let deadline = Instant::now() + WAIT;
    // Feed until the holder holds a full input queue and has stopped reading its socket.
    loop {
        if let Ok(n) = c.s.write(&stream[written..]) {
            written += n;
        }
        let _ = t.h.step(5);
        if t.h.input.len() == HOLDER_INPUT_CAP_BYTES as usize && t.h.inbuf.free() == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "input queue at {} bytes", t.h.input.len());
    }
    // Stable: more steps change nothing while the child does not read.
    for _ in 0..20 {
        let _ = c.s.write(&stream[written..]).map(|n| written += n);
        let _ = t.h.step(5);
    }
    assert_eq!(t.h.input.len(), HOLDER_INPUT_CAP_BYTES as usize, "never more than the cap");
    assert!(written < stream.len(), "the client is back-pressured");
    std::fs::write(t.dir.join("gate"), b"").unwrap();
    let deadline = Instant::now() + WAIT;
    while written < stream.len() || !t.h.input.is_empty() || !t.h.inbuf.data().is_empty() {
        if let Ok(n) = c.s.write(&stream[written..]) {
            written += n;
        }
        let _ = t.h.step(5);
        assert!(Instant::now() < deadline, "stalled at {written} of {}", stream.len());
    }
}

#[test]
fn r_hld_6_steady_state_io_allocates_nothing() {
    let mut t = start(&["/bin/cat"]);
    let mut c = Client::connect(&t);
    c.hello_attach(&mut t);
    let mut allocations = 0;
    for round in 0..300u32 {
        let line = format!("r{round:05}\r");
        c.send(&encode_input(line.as_bytes()));
        if round % 10 == 0 {
            c.send(&encode_client(&ClientFrame::Stat));
        }
        let want = format!("r{round:05}\r\n");
        let deadline = Instant::now() + WAIT;
        loop {
            c.poll();
            if c.saw(want.as_bytes()) {
                break;
            }
            assert!(Instant::now() < deadline);
            let (_, n) = crate::test_alloc::count(|| t.h.step(5));
            if round >= 5 {
                allocations += n; // after start-up and warm-up
            }
        }
        c.send(&encode_client(&ClientFrame::Ack { seq: c.next_seq }));
    }
    assert!(c.frames.iter().filter(|f| matches!(f, HolderFrame::Stat(_))).count() >= 20);
    assert_eq!(allocations, 0, "the steady-state loop allocated");
}

// TERMINATEs that arrive during one grace period (core retrying, a tab closed twice) merge their
// snapshots into the pending SIGKILL's members: no process is listed twice and members that have exited
// are dropped, so the list never grows with the number of TERMINATEs. The grace period itself
// still ends at the earliest deadline and still reaches every member.
#[test]
fn r_hld_12_terminates_during_a_grace_period_never_grow_its_member_list() {
    // A child that ignores SIGTERM, so the grace period stays open (no path or user text in the script).
    // The shell prints the marker only once SIGTERM is ignored (inherited by `cat` across the exec). Waiting on typed
    // input instead would race: the terminal's own echo of it can arrive before the shell has run `trap`.
    let mut t = start(&["/bin/sh", "-c", "trap '' TERM; echo armed; exec /bin/cat"]);
    let mut c = Client::connect(&t);
    c.hello_attach(&mut t);
    pump(&mut t, &mut c, |c| c.saw(b"armed\r\n"));
    let child = t.h.child_pid();
    let grace = 60_000;
    t.h.terminate(grace);
    let first: Vec<i32> = t.h.term.as_ref().unwrap().members.iter().map(|m| m.pid).collect();
    assert!(first.contains(&child), "the child is a member: {first:?}");
    // A member that has exited since (a reaped process: its pid runs nothing with that start time).
    let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap(); // os-ok: in /usr/bin on both systems
    let gone_pid = gone.id() as i32;
    gone.wait().unwrap();
    t.h.term.as_mut().unwrap().members.push(tree::Member { pid: gone_pid, pgid: gone_pid, start: 1, in_session: false });
    let deadline = t.h.term.as_ref().unwrap().deadline;
    for _ in 0..50 {
        t.h.terminate(grace);
    }
    let members: Vec<i32> = t.h.term.as_ref().unwrap().members.iter().map(|m| m.pid).collect();
    assert_eq!(members, first, "no duplicates and no exited member after 50 more TERMINATEs");
    assert!(t.h.term.as_ref().unwrap().deadline <= deadline, "the earliest deadline still holds");
    assert!(crate::os::proc_info(child).is_ok(), "SIGTERM was ignored: the grace period is still open");
    // A TERMINATE with no grace ends the period now: every member is SIGKILLed.
    t.h.terminate(0);
    assert!(t.h.term.is_none());
    pump(&mut t, &mut c, |c| c.frames.iter().any(|f| matches!(f, HolderFrame::Exit { .. })));
}

// A holder's footprint is its own memory, never its ring: with the largest ring filled twice over, so every
// page of the mapping is dirty, the footprint `kea-helper footprint` reads for the holder's process (Linux:
// `RssAnon + VmSwap` from `/proc/<pid>/status`; macOS: `ri_phys_footprint`) moves by far less than the ring.
// The holder runs in a test process of its own (this test, run again alone): the footprint is the whole process's, and
// other tests allocate meanwhile.
#[test]
fn r_plt_3_a_holders_footprint_stays_flat_while_its_ring_fills() {
    const ALONE: &str = "KEA_HELPER_TEST_R_PLT_3_ALONE";
    const RING: u64 = crate::limits::RING_BYTES_MAX;
    /// A sixteenth of the ring: the process's own growth (the read path, the test's polling), far below a counted ring.
    const SLACK: u64 = RING / 16;
    if std::env::var_os(ALONE).is_none() {
        let name = "holder::tests::r_plt_3_a_holders_footprint_stays_flat_while_its_ring_fills";
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--test-threads=1", "--nocapture"])
            .env(ALONE, "1")
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success() && said.contains("1 passed"), "{said}");
        return;
    }
    let fill = 2 * RING;
    // `head` from /dev/zero (whole blocks per read, I-HLD-18), no output processing on the way
    let script = format!("stty -opost; head -c {fill} /dev/zero; exec /bin/cat");
    let mut t = start_ring(&["/bin/sh", "-c", &script], RING);
    let me = unsafe { libc::getpid() };
    let deadline = Instant::now() + WAIT;
    while t.h.ring.latest() == 0 {
        assert!(Instant::now() < deadline, "no output");
        let _ = t.h.step(5);
    }
    let before = crate::os::footprint(me).unwrap();
    while t.h.ring.latest() < fill {
        assert!(Instant::now() < deadline, "the ring holds {} of {fill} bytes", t.h.ring.latest());
        let _ = t.h.step(5);
    }
    let after = crate::os::footprint(me).unwrap();
    assert_eq!(t.h.ring.earliest(), t.h.ring.latest() - RING, "every byte of the ring was written, and overwritten");
    let grown = after.saturating_sub(before);
    println!("footprint {before} → {after} (+{grown}) with a {RING}-byte ring filled twice");
    assert!(grown < SLACK, "the footprint grew by {grown} bytes ({before} → {after}) while a {RING}-byte ring filled twice");
}

// A new terminal's child between `fork` and `exec` is still the holder under another pid: asked then, the holder
// reports no foreground name or folder, so a tab is never titled after Kea's own helper. A program of that name
// started in the terminal later is its own process group, and the shell that `exec`s it has its own name by then.
#[test]
fn r_hld_13_the_child_before_its_exec_is_never_reported_as_what_runs() {
    use super::not_execed_yet;
    assert!(not_execed_yet(4242, 4242, b"kea-helper", b"kea-helper"), "the child, still under the holder's name");
    assert!(!not_execed_yet(4242, 4242, b"zsh", b"kea-helper"), "the child after its exec");
    assert!(!not_execed_yet(4300, 4242, b"kea-helper", b"kea-helper"), "a kea-helper started in the terminal");
    assert!(!not_execed_yet(4242, 4242, b"", b""), "no name known on either side");
}
