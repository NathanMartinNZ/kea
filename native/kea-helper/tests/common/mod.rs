//! Drives the real `kea-helper` binary: spawns holders through the launcher, speaks the protocol, and
//! cleans up every holder it spawned (TERMINATE + RELEASE, else SIGKILL by pid).
#![allow(dead_code)]

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[allow(unused_imports)]
pub use kea_helper::proto::{AttachMode, ClientFrame, FrameReader, Hello, HolderFrame, SignalTarget, Stat};
use kea_helper::proto::{PROTO, encode_client, encode_input};
use serde_json::Value;

pub const BIN: &str = env!("CARGO_BIN_EXE_kea-helper");
/// Upper bound for any wait (tests run in parallel, under load).
pub const T: Duration = Duration::from_secs(30);
/// How often a condition is re-checked while waiting for it.
pub const POLL: Duration = Duration::from_millis(5);
/// One read slice while waiting for frames: conditions are re-checked at least this often.
const SLICE: Duration = Duration::from_millis(200);
/// Cleanup: how long a holder gets to end after TERMINATE + RELEASE before it is SIGKILLed.
const CLEANUP_WAIT: Duration = Duration::from_secs(10);
/// `SO_RCVTIMEO` of zero means "block forever": never pass less than this.
const MIN_READ_TIMEOUT: Duration = Duration::from_millis(1);
/// An echo round trip through a holder slower than this means its loop waited for something: a quarter of
/// the check deadline (`HOLDER_PEER_CHECK_TIMEOUT_MS`), far above a loaded machine's few milliseconds.
pub const ECHO_MAX: Duration = Duration::from_millis(kea_helper::limits::HOLDER_PEER_CHECK_TIMEOUT_MS / 4);

/// The designated requirement of this test binary (`codesign -d -r-`), so the holder admits us (macOS).
pub fn test_requirement() -> &'static str {
    static REQ: OnceLock<String> = OnceLock::new();
    REQ.get_or_init(|| {
        let exe = std::env::current_exe().unwrap();
        let out = Command::new("/usr/bin/codesign").args(["-d", "-r-"]).arg(&exe).output().unwrap(); // os-ok: macOS test tool
        let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
        let line = text.lines().find_map(|l| l.split_once("designated => ").map(|(_, r)| r.trim().to_string()));
        line.unwrap_or_else(|| panic!("no designated requirement for {}: {text}", exe.display()))
    })
}

/// The client option that admits this test binary: macOS, its designated requirement (`--client-req`); Linux,
/// its executable by path and inode (`--client-exe-unchecked`: a build's own binary is the user's).
pub fn test_client() -> [OsString; 2] {
    if kea_helper::os::IS_LINUX {
        ["--client-exe-unchecked".into(), std::env::current_exe().unwrap().into()]
    } else {
        ["--client-req".into(), test_requirement().into()]
    }
}

pub fn wait_until(what: &str, timeout: Duration, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(POLL);
    }
}

pub fn alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

/// A short temp dir under /tmp (macOS's `sun_path` is 104 bytes), canonical (`/private/tmp/khT…` on macOS),
/// private (0700: a holder refuses a socket directory other users can enter).
pub fn tmpdir() -> (tempfile::TempDir, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::Builder::new().prefix("khT").permissions(std::fs::Permissions::from_mode(0o700)).tempdir_in("/tmp").unwrap();
    let p = d.path().canonicalize().unwrap();
    (d, p)
}

/// Compiles one C file with `/usr/bin/cc` into `dir` (a test's temp dir); returns the binary.
pub fn cc(src: &Path, dir: &Path, name: &str) -> PathBuf {
    let out = dir.join(name);
    let r = Command::new("/usr/bin/cc").args(["-O2", "-Wall", "-o"]).arg(&out).arg(src).output().unwrap(); // os-ok: in /usr/bin on both systems
    assert!(r.status.success(), "cc {}: {}", src.display(), String::from_utf8_lossy(&r.stderr));
    out
}

/// `tests/common/intruder.c`: a same-user client that is not Kea (macOS: not Apple-signed, with an ad hoc linker
/// signature; Linux: an executable other than the test binary).
pub fn build_intruder(dir: &Path) -> PathBuf {
    cc(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/common/intruder.c"), dir, "intruder")
}

/// The process zoo's `forker` (tools/process-zoo/src/forker.c, used as is): process trees with `--fork`,
/// `--double-fork`, `--setsid`, `--stubborn`, `--log`.
pub fn build_forker(dir: &Path) -> PathBuf {
    cc(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/process-zoo/src/forker.c"), dir, "forker")
}

pub fn new_pty_id() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
    let mut x = ((std::process::id() as u64) << 32) ^ (N.fetch_add(1, Ordering::SeqCst) << 24) ^ nanos;
    let mut s = String::new();
    for _ in 0..10 {
        s.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(x % 36) as usize] as char);
        x /= 36;
    }
    s
}

#[derive(Clone)]
pub struct Opts {
    pub argv: Vec<OsString>,
    pub cols: u16,
    pub rows: u16,
    pub ring: Option<u64>,
    /// Debug-only knobs: `KEA_HELPER_TEST_STALE_MS`, `KEA_HELPER_TEST_LINGER_MS`, `KEA_HELPER_TEST_CHECK_DELAY_MS`
    /// (each client check waits this long first).
    pub stale_ms: Option<u64>,
    pub linger_ms: Option<u64>,
    pub check_delay_ms: Option<u64>,
    /// The client option and its value; `None`: [`test_client`].
    pub client: Option<[OsString; 2]>,
    pub sock: Option<PathBuf>,
    /// `--cwd`; the holder's temp root when `None`.
    pub cwd: Option<PathBuf>,
    pub kea_version: Option<String>,
    pub kind: &'static str,
    /// The launcher's environment beyond the test's: a variable set, or removed (`None`).
    pub env: Vec<(&'static str, Option<OsString>)>,
}

impl Opts {
    pub fn new(argv: &[&str]) -> Self {
        Opts {
            argv: argv.iter().map(Into::into).collect(),
            cols: 80,
            rows: 24,
            ring: None,
            stale_ms: None,
            linger_ms: None,
            check_delay_ms: None,
            client: None,
            sock: None,
            cwd: None,
            kea_version: None,
            kind: "shell",
            env: Vec::new(),
        }
    }
    pub fn sh(script: &str) -> Self {
        Self::new(&["/bin/sh", "-c", script])
    }
}

pub struct Holder {
    pub pid: i32,
    pub child: i32,
    pub id: String,
    pub root: PathBuf,
    pub state_dir: PathBuf,
    pub sock: PathBuf,
    /// Other processes a test created that must not outlive it.
    pub extra: Vec<i32>,
    pub tmp: Option<tempfile::TempDir>,
}

/// The launcher command line for `o` (not yet run).
pub fn launcher(o: &Opts, root: &Path, id: &str) -> Command {
    let mut c = Command::new(BIN);
    c.arg("pty").args(["--id", id, "--session", "sess1", "--kind", o.kind]);
    c.arg("--dir").arg(root.join("st"));
    c.arg("--sock").arg(o.sock.clone().unwrap_or_else(|| root.join("r").join(format!("{id}.sock"))));
    c.arg("--cwd").arg(o.cwd.as_deref().unwrap_or(root));
    c.args(["--cols", &o.cols.to_string(), "--rows", &o.rows.to_string()]);
    c.args(o.client.clone().unwrap_or_else(test_client));
    if let Some(r) = o.ring {
        c.args(["--ring-bytes", &r.to_string()]);
    }
    if let Some(v) = &o.kea_version {
        c.args(["--kea-version", v]);
    }
    c.arg("--").args(&o.argv);
    for (var, v) in [("KEA_HELPER_TEST_STALE_MS", o.stale_ms), ("KEA_HELPER_TEST_LINGER_MS", o.linger_ms), ("KEA_HELPER_TEST_CHECK_DELAY_MS", o.check_delay_ms)] {
        if let Some(v) = v {
            c.env(var, v.to_string());
        }
    }
    for (var, v) in &o.env {
        match v {
            Some(v) => c.env(var, v),
            None => c.env_remove(var),
        };
    }
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.process_group(0);
    c
}

pub fn spawn(o: Opts) -> Holder {
    let (tmp, root) = tmpdir();
    let id = new_pty_id();
    let out = launcher(&o, &root, &id).output().unwrap();
    let line = String::from_utf8_lossy(&out.stdout).into_owned();
    let v: Value = serde_json::from_str(line.trim()).unwrap_or_else(|_| panic!("launcher said {line:?} / {:?}", out.stderr));
    assert!(out.status.success() && v.get("error").is_none(), "launcher failed: {line}");
    Holder {
        pid: v["pid"].as_i64().unwrap() as i32,
        child: v["childPid"].as_i64().unwrap() as i32,
        sock: o.sock.clone().unwrap_or_else(|| root.join("r").join(format!("{id}.sock"))),
        state_dir: root.join("st"),
        id,
        root,
        extra: Vec::new(),
        tmp: Some(tmp),
    }
}

impl Holder {
    pub fn json(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.json_path()).unwrap()).unwrap()
    }
    pub fn json_path(&self) -> PathBuf {
        self.state_dir.join(format!("{}.json", self.id))
    }
    pub fn ring_path(&self) -> PathBuf {
        self.state_dir.join(format!("{}.ring", self.id))
    }
    pub fn ring_header(&self) -> kea_helper::ring::Header {
        let mut f = std::fs::File::open(self.ring_path()).unwrap();
        let mut b = [0u8; kea_helper::ring::HEADER];
        f.read_exact(&mut b).unwrap();
        kea_helper::ring::decode_header(&b).unwrap()
    }
    pub fn connect(&self) -> Client {
        Client::connect(&self.sock)
    }
    /// Connects, says HELLO, attaches (at `earliest` from the HELLO for `Earliest`), acks as it goes.
    pub fn session(&self, mode: AttachMode) -> Session {
        let mut s = Session::new(self.connect());
        s.hello();
        s.attach(mode, 0);
        s
    }
    pub fn wait_exited(&self) -> Value {
        wait_until("state json exited", T, || self.json()["exited"] == true);
        self.json()
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        if alive(self.pid)
            && let Ok(s) = UnixStream::connect(&self.sock)
        {
            let c = Client::from_stream(s);
            c.send(&ClientFrame::Hello { proto: PROTO });
            c.send(&ClientFrame::Terminate { grace_ms: 0 });
            let deadline = Instant::now() + CLEANUP_WAIT;
            let exited = |p: &Path| {
                std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|v| v["exited"] == true)
            };
            while !exited(&self.json_path()) && alive(self.pid) && Instant::now() < deadline {
                std::thread::sleep(POLL);
            }
            c.send(&ClientFrame::Release);
        }
        let deadline = Instant::now() + CLEANUP_WAIT;
        while alive(self.pid) && Instant::now() < deadline {
            std::thread::sleep(POLL);
        }
        for &p in [self.pid].iter().chain(&self.extra) {
            if alive(p) {
                unsafe { libc::kill(p, libc::SIGKILL) };
            }
        }
        if alive(self.child) {
            unsafe {
                libc::killpg(self.child, libc::SIGKILL);
                libc::kill(self.child, libc::SIGKILL);
            }
        }
    }
}

/// A protocol connection: frames out under a lock (so two threads can write), frames in from a clone.
pub struct Client {
    w: Arc<Mutex<UnixStream>>,
    r: UnixStream,
    reader: FrameReader,
    pub eof: bool,
}

impl Client {
    pub fn connect(path: &Path) -> Client {
        Self::from_stream(UnixStream::connect(path).unwrap_or_else(|e| panic!("connect {}: {e}", path.display())))
    }
    pub fn from_stream(s: UnixStream) -> Client {
        let r = s.try_clone().unwrap();
        Client { w: Arc::new(Mutex::new(s)), r, reader: FrameReader::default(), eof: false }
    }
    pub fn writer(&self) -> Arc<Mutex<UnixStream>> {
        self.w.clone()
    }
    pub fn send_raw(&self, b: &[u8]) {
        let _ = self.w.lock().unwrap().write_all(b);
    }
    pub fn send(&self, f: &ClientFrame) {
        self.send_raw(&encode_client(f));
    }
    pub fn input(&self, b: &[u8]) {
        self.send_raw(&encode_input(b));
    }

    /// The next frame, or `None` on timeout or EOF (`eof` set).
    pub fn next(&mut self, timeout: Duration) -> Option<HolderFrame> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(f) = self.reader.next_frame() {
                return Some(f.expect("well-formed holder frame"));
            }
            if self.eof {
                return None;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            // macOS refuses SO_RCVTIMEO (EINVAL) once the peer has closed; the read then returns EOF.
            let _ = self.r.set_read_timeout(Some(left.max(MIN_READ_TIMEOUT)));
            let mut buf = [0u8; 65536];
            match self.r.read(&mut buf) {
                Ok(0) => self.eof = true,
                Ok(n) => self.reader.push(&buf[..n]),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => self.eof = true,
            }
        }
    }

    pub fn expect(&mut self, timeout: Duration) -> HolderFrame {
        self.next(timeout).unwrap_or_else(|| panic!("no frame (eof = {})", self.eof))
    }

    /// Waits for EOF (the holder closed us), skipping frames.
    pub fn wait_eof(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !self.eof {
            assert!(Instant::now() < deadline, "connection not closed");
            let _ = self.next(SLICE);
        }
    }
}

/// An attached client that collects output, checks seqs and acks what it processed.
pub struct Session {
    pub c: Client,
    pub hello: Option<Hello>,
    pub out: Vec<u8>,
    /// Seq of `out[0]`.
    pub start: Option<u64>,
    pub next_seq: Option<u64>,
    /// `(expected, got)` for every OUTPUT that did not continue the previous one.
    pub gaps: Vec<(u64, u64)>,
    pub exit: Option<(i32, u8)>,
    pub others: VecDeque<HolderFrame>,
    pub ack: bool,
    /// `out` before this offset has been searched by `wait_for`.
    scanned: usize,
}

impl Session {
    pub fn new(c: Client) -> Session {
        Session { c, hello: None, out: Vec::new(), start: None, next_seq: None, gaps: Vec::new(), exit: None, others: VecDeque::new(), ack: true, scanned: 0 }
    }

    pub fn hello(&mut self) -> Hello {
        self.c.send(&ClientFrame::Hello { proto: PROTO });
        loop {
            match self.c.expect(T) {
                HolderFrame::Hello(h) => {
                    self.hello = Some(h.clone());
                    return h;
                }
                other => self.others.push_back(other),
            }
        }
    }

    pub fn attach(&mut self, mode: AttachMode, seq: u64) {
        let (mode, seq) = match mode {
            AttachMode::Earliest => (AttachMode::FromSeq, self.hello.as_ref().map_or(0, |h| h.earliest)),
            m => (m, seq),
        };
        if mode == AttachMode::FromSeq {
            self.next_seq = Some(seq);
        }
        self.c.send(&ClientFrame::Attach { mode, seq });
    }

    /// Handles one frame; false on timeout/EOF.
    pub fn pump(&mut self, timeout: Duration) -> bool {
        let Some(f) = self.c.next(timeout) else { return false };
        match f {
            HolderFrame::Output { seq, data } => {
                assert!(self.exit.is_none(), "OUTPUT after EXIT");
                match self.next_seq {
                    Some(n) if n != seq => {
                        assert!(seq > n, "OUTPUT went backwards: expected {n}, got {seq}");
                        self.gaps.push((n, seq));
                    }
                    _ => {}
                }
                if self.start.is_none() {
                    self.start = Some(seq);
                }
                self.next_seq = Some(seq + data.len() as u64);
                self.out.extend_from_slice(&data);
                if self.ack {
                    self.c.send(&ClientFrame::Ack { seq: seq + data.len() as u64 });
                }
            }
            HolderFrame::Exit { code, signal } => self.exit = Some((code, signal)),
            other => self.others.push_back(other),
        }
        true
    }

    pub fn until(&mut self, what: &str, mut cond: impl FnMut(&Session) -> bool) {
        let deadline = Instant::now() + T;
        while !cond(self) {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}; output tail: {:?}", self.tail());
            if !self.pump(left.min(SLICE)) && self.c.eof {
                panic!("connection closed while waiting for {what}; output tail: {:?}", self.tail());
            }
        }
    }

    pub fn saw(&self, needle: &str) -> bool {
        self.out.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    /// Waits until `needle` appears in output not yet searched by an earlier `wait_for`.
    pub fn wait_for(&mut self, needle: &str) {
        let n = needle.as_bytes();
        let deadline = Instant::now() + T;
        loop {
            let from = self.scanned.saturating_sub(n.len());
            if let Some(i) = self.out[from..].windows(n.len()).position(|w| w == n) {
                self.scanned = from + i + n.len();
                return;
            }
            self.scanned = self.out.len();
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {needle:?}; output tail: {:?}", self.tail());
            if !self.pump(left.min(SLICE)) && self.c.eof {
                panic!("connection closed while waiting for {needle:?}; output tail: {:?}", self.tail());
            }
        }
    }

    pub fn tail(&self) -> String {
        String::from_utf8_lossy(&self.out[self.out.len().saturating_sub(300)..]).into_owned()
    }

    /// Types `tag` (a line) and waits for it to come back; returns the round trip.
    pub fn echo(&mut self, tag: &str) -> Duration {
        let start = Instant::now();
        self.c.input(format!("{tag}\r").as_bytes());
        self.wait_for(tag);
        start.elapsed()
    }

    pub fn stat(&mut self) -> Stat {
        self.c.send(&ClientFrame::Stat);
        let deadline = Instant::now() + T;
        loop {
            if let Some(pos) = self.others.iter().position(|f| matches!(f, HolderFrame::Stat(_)))
                && let Some(HolderFrame::Stat(s)) = self.others.remove(pos)
            {
                return s;
            }
            assert!(Instant::now() < deadline, "no STAT reply");
            self.pump(SLICE);
        }
    }
}

/// `printf '%s\0'`-style: the lines of `out` split on CRLF.
pub fn crlf_lines(out: &[u8]) -> Vec<&[u8]> {
    let mut v: Vec<&[u8]> = Vec::new();
    let mut rest = out;
    while let Some(i) = rest.windows(2).position(|w| w == b"\r\n") {
        v.push(&rest[..i]);
        rest = &rest[i + 2..];
    }
    if !rest.is_empty() {
        v.push(rest);
    }
    v
}
