//! `kea-helper hook` and `kea-helper statusline` as the agent runs them: a separate process, payload on stdin (R-AGT-1,
//! R-AGT-4).

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::{BIN, tmpdir};
use kea_helper::limits::{HOOK_ENVELOPE_MAX_BYTES, HOOK_SUMMARY_MAX_CHARS, HOOK_TIMEOUT_S, STATUSLINE_STDIN_MAX_BYTES};

fn run_hook(args: &[&str], stdin: &[u8]) -> (std::process::Output, Duration) {
    let (out, took, _) = run_sub("hook", args, stdin);
    (out, took)
}

/// One run of a subcommand with `stdin` fed from a thread; also whether every byte of it was taken.
fn run_sub(sub: &str, args: &[&str], stdin: &[u8]) -> (std::process::Output, Duration, bool) {
    let start = Instant::now();
    let mut p = Command::new(BIN).arg(sub).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut input = p.stdin.take().unwrap();
    let data = stdin.to_vec();
    let feeder = std::thread::spawn(move || input.write_all(&data).is_ok());
    let out = p.wait_with_output().unwrap();
    let taken = feeder.join().unwrap();
    (out, start.elapsed(), taken)
}

// test: R-AGT-4
#[test]
fn r_agt_4_binary_statusline_prints_nothing_and_exits_0() {
    let (_tmp, root) = tmpdir();
    let home = root.join("home");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(home.join("run")).unwrap();
    std::fs::create_dir_all(home.join("sessions/s-1")).unwrap();
    let project = r#"{"keep":["id","usage.short.pct","usage.short.at"],"count":[],"summarise":[]}"#;
    let args = ["fake-agent", "--session", "s-1", "--home", home.to_str().unwrap(), "--project", project];
    let payload = serde_json::json!({"id": "s", "path": "/where", "usage": {"short": {"pct": 42, "at": 1_794_426_600u64}}}).to_string();

    // Core away: the line is dropped, never spooled; nothing on stdout (the agent's footer gains no line), nothing on
    // stderr, exit 0.
    let (out, took, taken) = run_sub("statusline", &args, payload.as_bytes());
    assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len(), taken), (Some(0), 0, 0, true));
    assert!(took < Duration::from_secs(HOOK_TIMEOUT_S), "{took:?}");
    assert!(!home.join("sessions/s-1/spool.ndjson").exists(), "a status line is never spooled");

    // Core listening and answering each line with its ACK byte: the projected, marked line on the socket.
    let listener = UnixListener::bind(home.join("run/core.sock")).unwrap();
    let core = |listener: UnixListener| {
        std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(conn.try_clone().unwrap()).read_line(&mut line).unwrap();
            (&conn).write_all(&[kea_helper::hook::ACK]).unwrap();
            serde_json::from_str::<serde_json::Value>(&line).unwrap()
        })
    };
    let taking = core(listener.try_clone().unwrap());
    let (out, _, taken) = run_sub("statusline", &args, payload.as_bytes());
    assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len(), taken), (Some(0), 0, 0, true));
    let v = taking.join().unwrap();
    assert_eq!((v["statusline"].as_bool(), v["payload"].clone()), (Some(true), serde_json::json!({"id": "s", "usage": {"short": {"pct": 42, "at": 1_794_426_600u64}}})));

    // stdin past the cap is drained to its end (no broken pipe for the agent), still silent and 0.
    let big = vec![b' '; 4 * STATUSLINE_STDIN_MAX_BYTES as usize];
    let taking = core(listener);
    let (out, _, taken) = run_sub("statusline", &args, &big);
    assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len(), taken), (Some(0), 0, 0, true));
    let last = taking.join().unwrap();
    assert_eq!((last["oversize"].as_bool(), last["statusline"].as_bool()), (Some(true), Some(true)));
    assert!(!home.join("sessions/s-1/spool.ndjson").exists());

    // Garbage arguments and garbage stdin: exit 0, silent.
    for bad in [&["--nope"][..], &[][..], &["fake-agent", "--session", "s-1"][..]] {
        let (out, _, _) = run_sub("statusline", bad, b"\xff\xfe not json");
        assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len()), (Some(0), 0, 0), "{bad:?}");
    }
}

#[test]
fn r_agt_1_binary_exits_0_silently_with_1_mb_stdin() {
    let (_tmp, root) = tmpdir();
    let home = root.join("home");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(home.join("run")).unwrap();
    std::fs::create_dir_all(home.join("sessions/s-1")).unwrap();
    let project = r#"{"keep":["kind","who"],"count":["list"],"summarise":["body"],"critical":{"field":"kind","values":["end"]}}"#;
    let payload = serde_json::json!({"kind": "step", "who": "x", "list": [1, 2], "body": "b".repeat(2 * HOOK_SUMMARY_MAX_CHARS as usize), "blob": "z".repeat(1 << 20)}).to_string();
    let args = ["fake-agent", "--session", "s-1", "--home", home.to_str().unwrap(), "--project", project];

    // Core listening and answering each line with its ACK byte: delivered on the socket, nothing spooled.
    let listener = UnixListener::bind(home.join("run/core.sock")).unwrap();
    let core = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(conn.try_clone().unwrap()).read_line(&mut line).unwrap();
        (&conn).write_all(&[kea_helper::hook::ACK]).unwrap();
        (listener, line)
    });
    let (out, _) = run_hook(&args, payload.as_bytes());
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty(), "prints nothing");
    let (listener, line) = core.join().unwrap();
    assert!(!home.join("sessions/s-1/spool.ndjson").exists(), "delivered, not spooled");
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["payload"]["kind"], "step");
    assert_eq!(v["payload"]["list"], 2);
    assert_eq!(v["payload"]["body"].as_str().unwrap().len(), HOOK_SUMMARY_MAX_CHARS as usize);
    assert!(line.len() <= HOOK_ENVELOPE_MAX_BYTES as usize);
    drop(listener);

    // Core gone (stale socket file → ECONNREFUSED): spooled, still silent and 0.
    let (out, took) = run_hook(&args, payload.as_bytes());
    assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len()), (Some(0), 0, 0));
    // Well within the agent's own hook timeout, whatever the machine's load.
    assert!(took < Duration::from_secs(HOOK_TIMEOUT_S), "{took:?}");
    let spool = std::fs::read_to_string(home.join("sessions/s-1/spool.ndjson")).unwrap();
    assert_eq!(spool.lines().count(), 1);

    // Garbage arguments and garbage stdin: still exit 0 and silent.
    for bad in [&["--nope"][..], &[][..], &["fake-agent", "--session", "s-1"][..]] {
        let (out, _) = run_hook(bad, b"\xff\xfe not json");
        assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len()), (Some(0), 0, 0), "{bad:?}");
    }
}
