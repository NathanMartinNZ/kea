use super::*;
use crate::limits::HOOK_TIMEOUT_S;
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixListener;

/// A temp `KEA_HOME` under /tmp (short, so the run dir is `<home>/run`) with `run/` (0700, as core makes
/// it) and the session dir.
struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
}

const SESSION: &str = "sess_01-A";

fn home() -> Home {
    let dir = tempfile::Builder::new().prefix("khT").tempdir_in("/tmp").unwrap();
    let home = dir.path().join("h");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(home.join("run")).unwrap();
    std::fs::create_dir_all(home.join("sessions").join(SESSION)).unwrap();
    Home { _dir: dir, home }
}

fn proj_json() -> Value {
    json!({
        "keep": ["event", "id", "nested.name", "flag", "obj"],
        "count": ["items", "map", "n"],
        "summarise": ["input", "text"],
        "critical": {"field": "event", "values": ["Stop", "Start"]}
    })
}

fn args(h: &Path, project: &Value) -> Vec<OsString> {
    ["fake-agent", "--session", SESSION, "--home", h.to_str().unwrap(), "--project", &project.to_string()]
        .iter()
        .map(Into::into)
        .collect()
}

/// A core that takes one connection, reads one line and answers it with `answer` (core's `ACK`, or
/// anything else, or nothing: `None` closes without answering); joins with the line it read.
fn core_answering(listener: UnixListener, answer: Option<u8>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut r = BufReader::new(conn.try_clone().unwrap());
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        if let Some(b) = answer {
            use std::io::Write;
            (&conn).write_all(&[b]).unwrap();
        }
        line
    })
}

fn spool_lines(h: &Path) -> Vec<Value> {
    let p = h.join("sessions").join(SESSION).join("spool.ndjson");
    match std::fs::read_to_string(p) {
        Ok(s) => s.lines().map(|l| serde_json::from_str(l).unwrap()).collect(),
        Err(_) => vec![],
    }
}

#[test]
fn r_agt_2_projection_keep_count_summarise() {
    let p = parse_projection(&proj_json().to_string()).unwrap();
    let payload = json!({
        "event": "PreTool", "id": 7, "flag": true, "obj": {"x": 1},
        "nested": {"name": "n".repeat(500), "secret": "s"},
        "items": [1, 2, 3], "map": {"a": 1, "b": 2}, "n": 12,
        "input": {"command": "ls -la"}, "text": "é".repeat(400),
        "unnamed": "x".repeat(5 * 1024 * 1024),
    });
    let out = Value::Object(project(&payload, &p));
    assert_eq!(out["event"], "PreTool");
    assert_eq!(out["id"], 7);
    assert_eq!(out["flag"], true);
    assert!(out.get("obj").is_none(), "keep copies scalars only");
    assert_eq!(out["nested"]["name"].as_str().unwrap().chars().count(), HOOK_SUMMARY_MAX_CHARS as usize, "kept strings capped");
    assert!(out["nested"].get("secret").is_none());
    assert_eq!((out["items"].as_u64(), out["map"].as_u64(), out["n"].as_u64()), (Some(3), Some(2), Some(12)));
    assert_eq!(out["input"], "{\"command\":\"ls -la\"}", "non-strings are summarised as compact JSON");
    let text = out["text"].as_str().unwrap();
    assert_eq!(text.chars().count(), HOOK_SUMMARY_MAX_CHARS as usize);
    assert!(text.chars().all(|c| c == 'é'), "cut on a character boundary");
    assert!(out.get("unnamed").is_none(), "a 5 MB field that is not named is dropped");
    assert!(is_critical(&json!({"event": "Stop"}), &p));
    assert!(!is_critical(&json!({"event": "PreTool"}), &p));
    assert!(!is_critical(&json!({}), &p));
}

#[test]
fn r_agt_2_cut_chars_boundaries() {
    assert_eq!(cut_chars("héllo", 2), "hé");
    assert_eq!(cut_chars("🦜🦜🦜", 2), "🦜🦜");
    assert_eq!(cut_chars("ab", 5), "ab");
    assert_eq!(cut_chars("", 0), "");
    // Huge non-string values are summarised without serialising them whole.
    let big = json!({"k": vec![1u8; 2_000_000]});
    let s = summary_text(&big).unwrap();
    assert_eq!(s.chars().count(), HOOK_SUMMARY_MAX_CHARS as usize);
}

#[test]
fn r_agt_2_envelope_shrinks_to_the_cap() {
    let h = home();
    let a = parse_args(&args(&h.home, &proj_json())).unwrap();
    let stamp = Stamp { id: "0123456789abcdef".into(), mono: 1, received_at: 2 };
    let max = HOOK_ENVELOPE_MAX_BYTES as usize;
    // Control characters serialise as 6-byte escapes: 2 summaries × 300 chars × 6 > the cap.
    let ctrl = "\u{1}".repeat(1000);
    let payload = json!({"event": "Stop", "id": "i".repeat(250), "nested": {"name": "n".repeat(300)}, "input": ctrl, "text": ctrl, "items": [1]});
    let line = envelope(&a, &stamp, Some(&payload), None);
    assert!(line.len() <= max, "{} bytes", line.len());
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["payload"]["event"], "Stop");
    let s = v["payload"]["input"].as_str().unwrap_or_else(|| panic!("{line}"));
    assert!(!s.is_empty() && s.chars().count() < HOOK_SUMMARY_MAX_CHARS as usize, "summaries shortened before dropping anything: {} chars, {} bytes", s.chars().count(), line.len());
    assert_eq!(v["payload"]["id"].as_str().map(str::len), Some(250));
    assert_eq!(v["payload"]["nested"]["name"].as_str().map(str::len), Some(300));
    // Keep strings so escape-heavy that nothing but the critical field can stay.
    let mut wide = proj_json();
    wide["keep"] = json!(["event", "k1", "k2", "k3"]);
    let a = parse_args(&args(&h.home, &wide)).unwrap();
    let payload = json!({"event": "Stop", "k1": ctrl, "k2": ctrl, "k3": ctrl, "input": ctrl});
    let line = envelope(&a, &stamp, Some(&payload), None);
    assert!(line.len() <= max);
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["payload"]["event"], "Stop", "the critical field survives");
    assert!(v["payload"].get("input").is_none(), "summaries dropped first");
    assert!(v["payload"].get("k3").is_none(), "then keeps, last first");
    // The envelope's own fields.
    assert_eq!((v["keaSessionId"].as_str(), v["adapter"].as_str()), (Some(SESSION), Some("fake-agent")));
    assert_eq!((v["mono"].as_u64(), v["receivedAt"].as_u64()), (Some(1), Some(2)));
    assert_eq!(v["id"], "0123456789abcdef");
    assert!(line.ends_with("}\n") && line.matches('\n').count() == 1);
}

#[test]
fn r_agt_1_delivers_to_core_socket_from_args() {
    let h = home();
    let listener = UnixListener::bind(h.home.join("run/core.sock")).unwrap();
    let payload = json!({"event": "Start", "id": "abc", "unnamed": "z".repeat(1 << 20)}).to_string();
    assert!(payload.len() >= 1 << 20, "1 MB of stdin");
    let core = core_answering(listener, Some(ACK));
    let before = (crate::os::hook_clock_ns().unwrap(), crate::sys::wall_ms());
    let out = run(&args(&h.home, &proj_json()), &mut payload.as_bytes(), HOOK_STDIN_MAX_BYTES);
    let after = (crate::os::hook_clock_ns().unwrap(), crate::sys::wall_ms());
    assert_eq!(out, Outcome::Delivered);
    let line = core.join().unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["keaSessionId"], SESSION);
    assert_eq!(v["adapter"], "fake-agent");
    let mono = v["mono"].as_u64().unwrap();
    assert!(before.0 <= mono && mono <= after.0, "mono is CLOCK_UPTIME_RAW ns");
    let at = v["receivedAt"].as_u64().unwrap();
    assert!(before.1 <= at && at <= after.1);
    assert_eq!(v["payload"], json!({"event": "Start", "id": "abc"}));
    assert!(spool_lines(&h.home).is_empty());
}

/// A socket file nobody listens on (a core that died): bound, never `listen`ed, closed. Unlike a closed
/// listener, a copy of it that another test's fork holds for a moment still refuses connections.
fn stale_socket(path: &Path) {
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    assert!(fd >= 0);
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    crate::sys::set_cloexec(fd.as_raw_fd()).unwrap();
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (d, &s) in addr.sun_path.iter_mut().zip(path.as_os_str().as_bytes()) {
        *d = s as libc::c_char;
    }
    let len = size_of::<libc::sockaddr_un>() as libc::socklen_t;
    assert_eq!(unsafe { libc::bind(fd.as_raw_fd(), (&addr as *const libc::sockaddr_un).cast(), len) }, 0, "{}", io::Error::last_os_error());
}

#[test]
fn r_agt_1_spools_on_enoent_and_econnrefused() {
    let h = home();
    let a = args(&h.home, &proj_json());
    // ENOENT: no socket at all.
    assert_eq!(run(&a, &mut &br#"{"event":"A"}"#[..], HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    // ECONNREFUSED: a socket file nobody listens on.
    let sock = h.home.join("run/core.sock");
    stale_socket(&sock);
    let r = deliver(&sock, b"x\n", Duration::from_millis(HOOK_BOUND_MS));
    assert_eq!(r.err().and_then(|e| e.raw_os_error()), Some(libc::ECONNREFUSED));
    assert_eq!(run(&a, &mut &br#"{"event":"B"}"#[..], HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    let lines = spool_lines(&h.home);
    assert_eq!(lines.iter().map(|l| l["payload"]["event"].as_str().unwrap()).collect::<Vec<_>>(), ["A", "B"]);
    let mode = std::fs::metadata(h.home.join("sessions").join(SESSION).join("spool.ndjson")).unwrap().permissions();
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777, 0o600);
}

/// A listener nobody has connected to yet: `accept` would block.
fn untouched(l: &UnixListener) -> bool {
    l.set_nonblocking(true).unwrap();
    matches!(l.accept(), Err(e) if e.kind() == io::ErrorKind::WouldBlock)
}

// An agent controls `--home`, so the socket the hook connects to is checked first: a `core.sock`
// that is a symlink or a hard link to another socket — a holder's — or that lies in a directory that is a
// symlink or open to others, is never connected to; the event is spooled instead, and nothing is repaired.
// Without these checks Kea's own signed binary could be made a holder's client.
#[test]
fn r_hld_11_hook_never_connects_through_an_unsafe_core_socket() {
    let mode = |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
    // The target: a socket that is not this home's core (a holder's, in its own private run dir).
    let other = home();
    let target = other.home.join("run/abcdefghij.sock");
    let holder = UnixListener::bind(&target).unwrap();
    let event = |n: &str| format!("{{\"event\":\"{n}\"}}");

    // A symlink named core.sock.
    let h = home();
    let a = args(&h.home, &proj_json());
    std::os::unix::fs::symlink(&target, h.home.join("run/core.sock")).unwrap();
    assert!(check_core_socket(&h.home.join("run/core.sock"), SHARED_RUN_ROOT_PREFIX).unwrap_err().contains("not a socket"));
    assert_eq!(run(&a, &mut event("A").as_bytes(), HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    assert!(untouched(&holder), "never connected through a symlink");
    assert_eq!(spool_lines(&h.home).len(), 1, "the event is kept in the spool");

    // A hard link named core.sock: a real socket of the test's, but it has a second name elsewhere.
    let h = home();
    let a = args(&h.home, &proj_json());
    std::fs::hard_link(&target, h.home.join("run/core.sock")).unwrap();
    assert!(check_core_socket(&h.home.join("run/core.sock"), SHARED_RUN_ROOT_PREFIX).unwrap_err().contains("2 links"));
    assert_eq!(run(&a, &mut event("B").as_bytes(), HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    assert!(untouched(&holder), "never connected through a hard link");
    std::fs::remove_file(h.home.join("run/core.sock")).unwrap();

    // A real core socket, in a run directory other users can enter: refused, and the mode is left alone.
    let h = home();
    let a = args(&h.home, &proj_json());
    let core = UnixListener::bind(h.home.join("run/core.sock")).unwrap();
    std::fs::set_permissions(h.home.join("run"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(check_core_socket(&h.home.join("run/core.sock"), SHARED_RUN_ROOT_PREFIX).unwrap_err().contains("accessible to other users"));
    assert_eq!(run(&a, &mut event("C").as_bytes(), HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    assert!(untouched(&core), "never connected in an open directory");
    assert_eq!(mode(&h.home.join("run")), 0o755, "never repaired");
    // The same socket once the directory is private again: delivered (the checks pass on Kea's own layout).
    std::fs::set_permissions(h.home.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
    core.set_nonblocking(false).unwrap();
    let core = core_answering(core, Some(ACK));
    assert_eq!(run(&a, &mut event("D").as_bytes(), HOOK_STDIN_MAX_BYTES), Outcome::Delivered);
    let line = core.join().unwrap();
    assert!(line.contains("\"event\":\"D\""), "{line}");

    // A run directory that is a symlink to a private directory holding a real core socket.
    let h = home();
    let a = args(&h.home, &proj_json());
    let real = h.home.join("real");
    std::fs::rename(h.home.join("run"), &real).unwrap();
    std::os::unix::fs::symlink(&real, h.home.join("run")).unwrap();
    let core = UnixListener::bind(real.join("core.sock")).unwrap();
    assert_eq!(run(&a, &mut event("E").as_bytes(), HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    assert!(untouched(&core), "never connected through a symlinked directory");

    // The shared root (`/tmp/kea-<uid>` in production; here the same layout under a test directory).
    let h = home();
    let shared = format!("{}/kea-", h.home.display());
    let uid_dir = PathBuf::from(format!("{shared}{}", unsafe { libc::getuid() }));
    let run_dir = uid_dir.join("0123456789abcdef");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&run_dir).unwrap();
    let _core = UnixListener::bind(run_dir.join("core.sock")).unwrap();
    check_core_socket(&run_dir.join("core.sock"), &shared).unwrap();
    std::fs::set_permissions(&uid_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let err = check_core_socket(&run_dir.join("core.sock"), &shared).unwrap_err();
    assert!(err.contains(&uid_dir.display().to_string()) && err.contains("accessible to other users"), "{err}");
    // Not covered here: a directory or socket owned by another uid (creating one needs root).
}

/// The default send buffer of a unix stream socket: what a connection takes before a write blocks.
fn send_buffer_bytes() -> usize {
    let (s, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
    let mut v: libc::c_int = 0;
    let mut len = size_of::<libc::c_int>() as libc::socklen_t;
    assert_eq!(unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, (&mut v as *mut libc::c_int).cast(), &mut len) }, 0);
    v as usize
}

#[test]
fn r_agt_1_connect_and_write_are_bounded() {
    let h = home();
    let path = h.home.join("run/core.sock");
    let _listener = UnixListener::bind(&path).unwrap(); // never accepts, never reads
    let bound = Duration::from_millis(HOOK_BOUND_MS);
    let start = Instant::now();
    let err = deliver(&path, &vec![b'x'; 4 * send_buffer_bytes()], bound).unwrap_err();
    let took = start.elapsed();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    // It waited the whole bound, and gave up long before the agent's own hook timeout — the
    // property that matters to the agent; a tighter ceiling would only measure the machine's load.
    assert!(took >= bound && took < Duration::from_secs(HOOK_TIMEOUT_S), "took {took:?}");
}

// A core that accepts the connection and never reads: the write times out and the line is spooled.
// A real envelope (at most HOOK_ENVELOPE_MAX_BYTES) always fits a unix socket's send buffer, so `run`
// itself cannot be made to time out this way; the delivery step gets a line larger than that buffer.
#[test]
fn r_agt_1_spools_on_timeout() {
    let h = home();
    let a = parse_args(&args(&h.home, &proj_json())).unwrap();
    let path = h.home.join("run/core.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let sndbuf = send_buffer_bytes();
    assert!((HOOK_ENVELOPE_MAX_BYTES as usize) < sndbuf, "an envelope fits the send buffer");
    let mut line = format!("{{\"pad\":\"{}\"}}", "p".repeat(4 * sndbuf)).into_bytes();
    line.push(b'\n');
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let core = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap(); // accepts, never reads, never answers
        accepted_tx.send(()).unwrap();
        let _ = done_rx.recv();
        drop(conn);
    });
    let bound = Duration::from_millis(HOOK_BOUND_MS);
    let start = Instant::now();
    let outcome = deliver_or_spool(&a, &path, &line, false, bound);
    let took = start.elapsed();
    accepted_rx.recv_timeout(Duration::from_secs(HOOK_TIMEOUT_S)).expect("the core accepted the connection");
    done_tx.send(()).unwrap();
    core.join().unwrap();
    assert_eq!(outcome, Outcome::Spooled);
    assert!(took >= bound, "spooled only after the bound: {took:?}");
    let spooled = std::fs::read(h.home.join("sessions").join(SESSION).join("spool.ndjson")).unwrap();
    assert_eq!(spooled, line, "the whole line, once");
}

// A hung core's listening socket still completes the connection and takes the line into its
// backlog. Only core's answer counts as delivered: without it the line is spooled once the bound has
// passed, with the same id as the copy in the backlog, so a core that wakes up and reads it later drops
// whichever comes second.
#[test]
fn r_agt_1_spools_when_core_takes_the_line_but_never_answers() {
    let h = home();
    let path = h.home.join("run/core.sock");
    let listener = UnixListener::bind(&path).unwrap(); // listening, never accepting: a stopped core
    let bound = Duration::from_millis(HOOK_BOUND_MS);
    let start = Instant::now();
    let out = run(&args(&h.home, &proj_json()), &mut &br#"{"event":"Stop"}"#[..], HOOK_STDIN_MAX_BYTES);
    let took = start.elapsed();
    assert_eq!(out, Outcome::Spooled);
    assert!(took >= bound && took < Duration::from_secs(HOOK_TIMEOUT_S), "waited the bound for an answer, then spooled: {took:?}");
    let spooled = spool_lines(&h.home);
    assert_eq!(spooled.len(), 1);
    // the copy the hung core holds in its backlog is the same envelope, id included
    let (conn, _) = listener.accept().unwrap();
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).unwrap();
    let late: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(late, spooled[0]);
    assert!(late["id"].as_str().is_some_and(|id| id.len() == 16 && id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())), "{late}");
}

#[test]
fn r_agt_1_spools_when_core_closes_or_answers_otherwise() {
    for answer in [None, Some(b'x')] {
        let h = home();
        let core = core_answering(UnixListener::bind(h.home.join("run/core.sock")).unwrap(), answer);
        let out = run(&args(&h.home, &proj_json()), &mut &br#"{"event":"A"}"#[..], HOOK_STDIN_MAX_BYTES);
        let line = core.join().unwrap();
        assert_eq!(out, Outcome::Spooled, "answer {answer:?}");
        assert_eq!(spool_lines(&h.home), vec![serde_json::from_str::<Value>(&line).unwrap()], "the same envelope, spooled");
    }
}

#[test]
fn r_agt_1_each_envelope_has_its_own_id() {
    let ids: std::collections::HashSet<String> = (0..64).map(|_| envelope_id().unwrap()).collect();
    assert_eq!(ids.len(), 64);
    assert!(ids.iter().all(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))));
}

#[test]
fn r_agt_2_spool_soft_and_hard_caps() {
    let h = home();
    let spool_path = h.home.join("sessions").join(SESSION).join("spool.ndjson");
    std::fs::write(&spool_path, vec![b'\n'; SPOOL_SOFT_BYTES as usize]).unwrap();
    assert_eq!(spool(&h.home, SESSION, b"{}\n", false), Outcome::Capped, "soft cap: only critical events");
    assert_eq!(spool(&h.home, SESSION, b"{\"c\":1}\n", true), Outcome::Spooled);
    std::fs::write(&spool_path, vec![b'\n'; SPOOL_HARD_BYTES as usize]).unwrap();
    assert_eq!(spool(&h.home, SESSION, b"{}\n", true), Outcome::Capped, "hard cap: nothing");
    assert_eq!(std::fs::metadata(&spool_path).unwrap().len(), SPOOL_HARD_BYTES);
    // Through the whole hook: a critical event is still spooled at the soft cap.
    std::fs::write(&spool_path, vec![b'\n'; SPOOL_SOFT_BYTES as usize]).unwrap();
    let a = args(&h.home, &proj_json());
    assert_eq!(run(&a, &mut &br#"{"event":"PreTool"}"#[..], HOOK_STDIN_MAX_BYTES), Outcome::Capped);
    assert_eq!(run(&a, &mut &br#"{"event":"Stop"}"#[..], HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    let text = std::fs::read_to_string(&spool_path).unwrap();
    assert_eq!(text.trim().lines().filter(|l| !l.is_empty()).count(), 1, "the non-critical event was not spooled");
    assert!(text.trim_end().ends_with('}') && text.contains("\"Stop\""));
}

#[test]
fn r_agt_3_spool_renamed_between_open_and_write_takes_the_line_in_a_fresh_spool() {
    // Core drains a spool by renaming it, then reads what it renamed. A helper that opened the spool just
    // before the rename must not write into the renamed file (core may have read it already: the line
    // would be lost); it reopens the path and writes into a fresh spool.
    let h = home();
    let dir = h.home.join("sessions").join(SESSION);
    let spool_path = dir.join("spool.ndjson");
    let draining = dir.join("spool.draining.ndjson");
    std::fs::write(&spool_path, b"{\"old\":1}\n").unwrap();
    let mut core_renames = || std::fs::rename(&spool_path, &draining).unwrap();
    assert_eq!(spool_at(&h.home, SESSION, b"{\"new\":1}\n", true, &mut core_renames, &mut || {}), Outcome::Spooled);
    assert_eq!(std::fs::read_to_string(&draining).unwrap(), "{\"old\":1}\n", "nothing written into the file core took");
    assert_eq!(std::fs::read_to_string(&spool_path).unwrap(), "{\"new\":1}\n", "the line is in a fresh spool");
}

#[test]
fn r_agt_3_spool_renamed_while_written_gets_the_line_again_in_a_fresh_spool() {
    // Where core takes no lock before its rename (Linux: Node has no flock), it can rename the spool while a
    // helper writes, and may read it before the line lands. The helper looks again after its write: the line
    // goes once more into a fresh spool, and core drops whichever copy comes second by its id.
    let h = home();
    let dir = h.home.join("sessions").join(SESSION);
    let spool_path = dir.join("spool.ndjson");
    let draining = dir.join("spool.draining.ndjson");
    std::fs::write(&spool_path, b"{\"old\":1}\n").unwrap();
    let mut takes = 0;
    let mut core_renames = || {
        takes += 1;
        if takes == 1 {
            std::fs::rename(&spool_path, &draining).unwrap();
        }
    };
    assert_eq!(spool_at(&h.home, SESSION, b"{\"new\":1}\n", true, &mut || {}, &mut core_renames), Outcome::Spooled);
    assert_eq!(std::fs::read_to_string(&draining).unwrap(), "{\"old\":1}\n{\"new\":1}\n", "written before the rename was seen");
    assert_eq!(std::fs::read_to_string(&spool_path).unwrap(), "{\"new\":1}\n", "and again in a fresh spool");
    // a spool still at its path after the write gets the line once
    std::fs::remove_file(&draining).unwrap();
    assert_eq!(spool(&h.home, SESSION, b"{\"next\":1}\n", true), Outcome::Spooled);
    assert_eq!(std::fs::read_to_string(&spool_path).unwrap(), "{\"new\":1}\n{\"next\":1}\n");
    assert!(!draining.exists());
}

#[test]
fn r_agt_3_a_fresh_spool_taken_too_gets_the_line_again_up_to_the_bound() {
    // Two takes back to back (a sweep, then an envelope's drain) can take the fresh spool as well before the line
    // lands in it: the helper writes it again while the spool it wrote to has moved, at most SPOOL_REWRITES_MAX times.
    let h = home();
    let dir = h.home.join("sessions").join(SESSION);
    let spool_path = dir.join("spool.ndjson");
    let taken = |n: u32| dir.join(format!("taken-{n}.ndjson"));
    std::fs::write(&spool_path, b"").unwrap();
    let mut takes = 0;
    let mut core_takes_twice = || {
        takes += 1;
        if takes <= 2 {
            std::fs::rename(&spool_path, taken(takes)).unwrap();
        }
    };
    assert_eq!(spool_at(&h.home, SESSION, b"{\"n\":1}\n", true, &mut || {}, &mut core_takes_twice), Outcome::Spooled);
    for f in [taken(1), taken(2), spool_path.clone()] {
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"n\":1}\n", "{f:?}");
    }
    // a core that takes every spool: the helper stops after the bound, and the agent is not held
    std::fs::remove_file(&spool_path).unwrap();
    let mut n = 10;
    let mut core_takes_all = || {
        n += 1;
        std::fs::rename(&spool_path, taken(n)).unwrap();
    };
    assert_eq!(spool_at(&h.home, SESSION, b"{\"n\":2}\n", true, &mut || {}, &mut core_takes_all), Outcome::Spooled);
    assert_eq!(n - 10, 1 + SPOOL_REWRITES_MAX as u32, "one write, then the bound's");
}

#[test]
fn r_agt_3_a_full_spool_core_took_meanwhile_leaves_the_line_room_in_the_fresh_one() {
    // The spool was at its hard cap when the helper looked, but core took it (without the hook's lock, Linux) before
    // the look after the write: the fresh spool has room, and the line goes there.
    let h = home();
    let dir = h.home.join("sessions").join(SESSION);
    let spool_path = dir.join("spool.ndjson");
    let draining = dir.join("spool.draining.ndjson");
    std::fs::write(&spool_path, vec![b'\n'; SPOOL_HARD_BYTES as usize]).unwrap();
    let mut takes = 0;
    let mut core_takes_once = || {
        takes += 1;
        if takes == 1 {
            std::fs::rename(&spool_path, &draining).unwrap();
        }
    };
    assert_eq!(spool_at(&h.home, SESSION, b"{\"stop\":1}\n", true, &mut || {}, &mut core_takes_once), Outcome::Spooled);
    assert_eq!(std::fs::metadata(&draining).unwrap().len(), SPOOL_HARD_BYTES, "nothing added to the full one");
    assert_eq!(std::fs::read_to_string(&spool_path).unwrap(), "{\"stop\":1}\n");
}

#[test]
fn r_agt_1_identification_is_validated() {
    let h = home();
    let p = proj_json().to_string();
    let home = h.home.to_str().unwrap();
    let bad: Vec<Vec<&str>> = vec![
        vec!["fake-agent", "--session", "../x", "--home", home, "--project", &p],
        vec!["fake agent", "--session", SESSION, "--home", home, "--project", &p],
        vec!["fake-agent", "--session", SESSION, "--home", "relative/home", "--project", &p],
        vec!["fake-agent", "--session", SESSION, "--home", home, "--project", "{not json"],
        vec!["fake-agent", "--session", SESSION, "--home", home],
        vec!["fake-agent", "--session", SESSION, "--session", SESSION, "--home", home, "--project", &p],
        vec!["fake-agent", "--session", SESSION, "--home", "/nonexistent/kea-home", "--project", &p],
        vec!["fake-agent", "--session", "no-such-session", "--home", home, "--project", &p],
    ];
    for b in bad {
        let a: Vec<OsString> = b.iter().map(Into::into).collect();
        assert_eq!(run(&a, &mut &br#"{"event":"X"}"#[..], HOOK_STDIN_MAX_BYTES), Outcome::Dropped, "{b:?}");
    }
    assert!(spool_lines(&h.home).is_empty());
    // Environment variables are never read for identification.
    let src = include_str!("../hook.rs");
    assert!(!src.contains(concat!("env", "::var")) && !src.contains(concat!("var", "_os(")));
}

#[test]
fn r_agt_1_oversize_and_malformed_stdin() {
    let h = home();
    let a = args(&h.home, &proj_json());
    let big = vec![b'{'; 5000];
    assert_eq!(run(&a, &mut &big[..], 4096), Outcome::Spooled);
    assert_eq!(run(&a, &mut &b"not json"[..], HOOK_STDIN_MAX_BYTES), Outcome::Spooled);
    let lines = spool_lines(&h.home);
    assert_eq!(lines[0]["payload"], json!({}));
    assert_eq!(lines[0]["oversize"], true);
    assert_eq!(lines[1]["malformed"], true);
}

#[test]
fn r_agt_2_sources_name_no_agent_fields() {
    // Built from pieces so this test does not trip over itself.
    let forbidden: Vec<String> = [
        ["tool", "input"].join("_"),
        ["hook", "event", "name"].join("_"),
        ["session", "id"].join("_"),
        ["transcript", "path"].join("_"),
        ["tool", "name"].join("_"),
        ["tool", "use", "id"].join("_"),
        ["permission", "mode"].join("_"),
        ["notification", "type"].join("_"),
        ["last", "assistant", "message"].join("_"),
        ["background", "tasks"].join("_"),
        ["agent", "id"].join("_"),
        ["agent", "type"].join("_"),
        ["prompt", "id"].join("_"),
        ["session", "title"].join("_"),
        ["cla", "ude"].concat(),
        ["co", "dex"].concat(),
        ["command", "code"].concat(),
    ]
    .into_iter()
    .collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    let mut stack = vec![root.join("src"), root.join("tests")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "rs") {
                files.push(p);
            }
        }
    }
    assert!(files.len() > 10);
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap().to_lowercase();
        for word in &forbidden {
            assert!(!text.contains(word.as_str()), "{} mentions the agent-specific name {word:?}", f.display());
        }
    }
}
