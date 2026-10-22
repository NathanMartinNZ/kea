//! `kea-helper hook <adapter> --session <id> --home <KEA_HOME> --project '<projection JSON>'`: reads the agent's
//! payload on stdin, keeps only what the projection names, stamps it (with a random id) and writes one line to core's
//! socket; core answers each line with one `ACK` byte. Without that answer within `HOOK_BOUND_MS` (no socket, refused,
//! a hung core whose backlog took the line) the same line goes to the session spool, and core drops whichever copy of
//! an id comes second. Always exits 0 and prints nothing. It knows no agent: every field name arrives in
//! `--project`.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::args::valid_id;
use crate::limits::{
    HOOK_BOUND_MS, HOOK_ENVELOPE_MAX_BYTES, HOOK_STDIN_MAX_BYTES, HOOK_SUMMARY_MAX_CHARS, SPOOL_HARD_BYTES, SPOOL_REWRITES_MAX, SPOOL_SOFT_BYTES,
};
use crate::rundir::{SHARED_RUN_ROOT_PREFIX, check_own_socket, check_run_dir, run_dir};

type FieldPath = Vec<String>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Projection {
    pub keep: Vec<FieldPath>,
    pub count: Vec<FieldPath>,
    pub summarise: Vec<FieldPath>,
    pub critical: Option<(FieldPath, Vec<Value>)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HookArgs {
    pub adapter: String,
    pub session: String,
    pub home: PathBuf,
    pub projection: Projection,
}

fn field_path(v: &Value) -> Option<FieldPath> {
    let s = v.as_str()?;
    let parts: FieldPath = s.split('.').map(str::to_owned).collect();
    (!s.is_empty() && parts.iter().all(|p| !p.is_empty())).then_some(parts)
}

pub fn parse_projection(text: &str) -> Option<Projection> {
    let v: Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    let list = |k: &str| -> Option<Vec<FieldPath>> {
        match obj.get(k) {
            None => Some(Vec::new()),
            Some(Value::Array(a)) => a.iter().map(field_path).collect(),
            Some(_) => None,
        }
    };
    let critical = match obj.get("critical") {
        None | Some(Value::Null) => None,
        Some(c) => Some((field_path(c.get("field")?)?, c.get("values")?.as_array()?.clone())),
    };
    Some(Projection { keep: list("keep")?, count: list("count")?, summarise: list("summarise")?, critical })
}

pub fn parse_args(args: &[OsString]) -> Option<HookArgs> {
    let adapter = args.first()?.to_str()?.to_owned();
    let (mut session, mut home, mut project) = (None, None, None);
    let mut i = 1;
    while i < args.len() {
        let slot = match args[i].to_str()? {
            "--session" => &mut session,
            "--home" => &mut home,
            "--project" => &mut project,
            _ => return None,
        };
        if slot.replace(args.get(i + 1)?.clone()).is_some() {
            return None;
        }
        i += 2;
    }
    let session = session?.into_string().ok()?;
    let home = PathBuf::from(home?);
    if !valid_id(&adapter) || !valid_id(&session) || !home.is_absolute() {
        return None;
    }
    let projection = parse_projection(project?.to_str()?)?;
    Some(HookArgs { adapter, session, home, projection })
}

fn get<'a>(v: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(v, |v, k| v.as_object()?.get(k))
}

/// Inserts at a dotted path, creating objects on the way. On a collision (`a` and `a.b`) the value
/// written first wins.
fn insert(out: &mut Map<String, Value>, path: &[String], val: Value) {
    let Some((last, parents)) = path.split_last() else { return };
    let mut cur = out;
    for k in parents {
        let next = cur.entry(k.clone()).or_insert_with(|| Value::Object(Map::new()));
        let Value::Object(m) = next else { return };
        cur = m;
    }
    cur.entry(last.clone()).or_insert(val);
}

/// At most `max` characters, cut on a character boundary.
pub fn cut_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// A writer that stops (with an error) once it holds `cap` bytes: bounds serialising a huge value.
struct Capped {
    buf: Vec<u8>,
    cap: usize,
}

impl io::Write for Capped {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let n = b.len().min(self.cap - self.buf.len());
        self.buf.extend_from_slice(&b[..n]);
        if n < b.len() { Err(io::Error::other("full")) } else { Ok(n) }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A summary: strings as-is, anything else as compact JSON (serialisation stops early for huge values).
fn summary_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(cut_chars(s, HOOK_SUMMARY_MAX_CHARS as usize).to_owned()),
        other => {
            // UTF-8 is at most 4 bytes per char; one char more than the cap tells the cut what to do.
            let mut w = Capped { buf: Vec::new(), cap: 4 * (HOOK_SUMMARY_MAX_CHARS as usize + 1) };
            let _ = serde_json::to_writer(&mut w, other);
            let text = String::from_utf8_lossy(&w.buf).into_owned();
            Some(cut_chars(&text, HOOK_SUMMARY_MAX_CHARS as usize).to_owned())
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Keep,
    Count,
    Summary,
}

/// One projected field, before shrinking.
#[derive(Clone, Debug)]
struct Item {
    kind: Kind,
    path: FieldPath,
    value: Value,
    critical: bool,
}

/// keep: scalars (strings capped); count: array length, object key count, numbers as-is;
/// summarise: strings (or compact JSON of anything else) cut on a character boundary.
fn items(payload: &Value, p: &Projection) -> Vec<Item> {
    let critical_path = p.critical.as_ref().map(|(f, _)| f);
    let mut out = Vec::new();
    for path in &p.keep {
        let value = match get(payload, path) {
            Some(Value::String(s)) => Value::String(cut_chars(s, HOOK_SUMMARY_MAX_CHARS as usize).to_owned()),
            Some(v @ (Value::Number(_) | Value::Bool(_) | Value::Null)) => v.clone(),
            _ => continue,
        };
        out.push(Item { kind: Kind::Keep, critical: critical_path == Some(path), path: path.clone(), value });
    }
    for path in &p.count {
        let value = match get(payload, path) {
            Some(Value::Array(a)) => Value::from(a.len()),
            Some(Value::Object(o)) => Value::from(o.len()),
            Some(v @ Value::Number(_)) => v.clone(),
            _ => continue,
        };
        out.push(Item { kind: Kind::Count, critical: false, path: path.clone(), value });
    }
    for path in &p.summarise {
        if let Some(text) = get(payload, path).and_then(summary_text) {
            out.push(Item { kind: Kind::Summary, critical: false, path: path.clone(), value: Value::String(text) });
        }
    }
    out
}

pub fn project(payload: &Value, p: &Projection) -> Map<String, Value> {
    build(&items(payload, p), HOOK_SUMMARY_MAX_CHARS as usize)
}

fn build(items: &[Item], summary_chars: usize) -> Map<String, Value> {
    let mut out = Map::new();
    for it in items {
        let v = match (&it.kind, &it.value) {
            (Kind::Summary, Value::String(s)) => Value::String(cut_chars(s, summary_chars).to_owned()),
            (_, v) => v.clone(),
        };
        insert(&mut out, &it.path, v);
    }
    out
}

pub fn is_critical(payload: &Value, p: &Projection) -> bool {
    p.critical.as_ref().is_some_and(|(field, values)| get(payload, field).is_some_and(|v| values.contains(v)))
}

/// The byte core answers each envelope line with (`HOOK_ACK_BYTE` in `@kea/protocol`).
pub const ACK: u8 = 0x06;

pub struct Stamp {
    /// The envelope's id: core applies each id once, whether the socket or the spool brings it.
    pub id: String,
    pub mono: u64,
    pub received_at: u64,
}

/// A fresh envelope id: 16 lowercase hex digits of the system's random generator.
pub fn envelope_id() -> io::Result<String> {
    let mut b = [0u8; 8];
    crate::os::random_bytes(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn render(a: &HookArgs, s: &Stamp, payload: &Map<String, Value>, flag: Option<&str>) -> String {
    let q = |v: &str| Value::String(v.to_owned()).to_string();
    let mut line = format!(
        "{{\"keaSessionId\":{},\"adapter\":{},\"id\":{},\"mono\":{},\"receivedAt\":{},\"payload\":{}",
        q(&a.session),
        q(&a.adapter),
        q(&s.id),
        s.mono,
        s.received_at,
        Value::Object(payload.clone())
    );
    if let Some(f) = flag {
        line.push_str(&format!(",{}:true", q(f)));
    }
    line.push_str("}\n");
    line
}

/// The envelope line (with its newline), at most `HOOK_ENVELOPE_MAX_BYTES`: summaries are
/// shortened (halved), then dropped, then non-critical keeps, then counts, until it fits.
pub fn envelope(a: &HookArgs, s: &Stamp, payload: Option<&Value>, flag: Option<&str>) -> String {
    let max = HOOK_ENVELOPE_MAX_BYTES as usize;
    let mut items = payload.map(|p| items(p, &a.projection)).unwrap_or_default();
    let mut chars = HOOK_SUMMARY_MAX_CHARS as usize;
    loop {
        let line = render(a, s, &build(&items, chars), flag);
        if line.len() <= max {
            return line;
        }
        let has = |k: Kind, items: &[Item]| items.iter().rposition(|i| i.kind == k && !i.critical);
        if chars > 0 && items.iter().any(|i| i.kind == Kind::Summary) {
            chars /= 2;
        } else if let Some(i) = has(Kind::Summary, &items).or_else(|| has(Kind::Keep, &items)).or_else(|| has(Kind::Count, &items)) {
            items.remove(i);
        } else if !items.is_empty() {
            items.clear();
        } else {
            return line; // ids are ≤ 64 chars: an empty envelope always fits
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    Spooled,
    /// Spool at the soft cap and the event is not critical, or at the hard cap.
    Capped,
    /// Bad arguments, unknown home or session directory (I-AGT-7).
    Dropped,
}

/// Connect, write and read core's `ACK` within `bound` in total. Non-blocking connect; partial
/// writes and the answer polled. A core that took the connection but does not answer in time (hung, or
/// busy past the bound) is a failure: the caller spools the line.
pub fn deliver(sock: &Path, line: &[u8], bound: Duration) -> io::Result<()> {
    let deadline = Instant::now() + bound;
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let raw = fd.as_raw_fd();
    crate::sys::set_cloexec(raw)?;
    crate::sys::set_nonblock(raw)?;
    let _ = crate::os::set_nosigpipe(raw);
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let path = sock.as_os_str().as_bytes();
    if path.len() >= addr.sun_path.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "socket path too long"));
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (d, &s) in addr.sun_path.iter_mut().zip(path) {
        *d = s as libc::c_char;
    }
    crate::os::set_sun_len(&mut addr);
    let r = unsafe { libc::connect(raw, (&addr as *const libc::sockaddr_un).cast(), size_of::<libc::sockaddr_un>() as libc::socklen_t) };
    if r != 0 {
        let e = io::Error::last_os_error();
        match e.raw_os_error() {
            // Linux: EAGAIN is a full backlog, a failure: spooled at once
            Some(code) if crate::os::connect_pending(code) => {
                wait_writable(raw, deadline)?;
                let mut err: libc::c_int = 0;
                let mut len = 4 as libc::socklen_t;
                unsafe { libc::getsockopt(raw, libc::SOL_SOCKET, libc::SO_ERROR, (&mut err as *mut libc::c_int).cast(), &mut len) };
                if err != 0 {
                    return Err(io::Error::from_raw_os_error(err));
                }
            }
            _ => return Err(e),
        }
    }
    let mut rest = line;
    while !rest.is_empty() {
        let n = crate::os::send(raw, rest);
        if n > 0 {
            rest = &rest[n as usize..];
            continue;
        }
        let e = io::Error::last_os_error();
        match e.raw_os_error() {
            Some(libc::EAGAIN) | Some(libc::EINTR) => wait_writable(raw, deadline)?,
            _ => return Err(e),
        }
    }
    read_ack(raw, deadline)
}

/// Core's answer to the line: exactly one `ACK` byte before `deadline`. End of stream, another byte or
/// the deadline is a failure.
fn read_ack(fd: libc::c_int, deadline: Instant) -> io::Result<()> {
    loop {
        let mut b = 0u8;
        let n = unsafe { libc::read(fd, (&mut b as *mut u8).cast(), 1) };
        if n == 1 {
            return if b == ACK { Ok(()) } else { Err(io::Error::new(io::ErrorKind::InvalidData, "not an acknowledgement")) };
        }
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        match crate::sys::errno() {
            libc::EAGAIN | libc::EINTR => wait_ready(fd, libc::POLLIN, deadline)?,
            _ => return Err(io::Error::last_os_error()),
        }
    }
}

fn wait_writable(fd: libc::c_int, deadline: Instant) -> io::Result<()> {
    wait_ready(fd, libc::POLLOUT, deadline)
}

fn wait_ready(fd: libc::c_int, events: libc::c_short, deadline: Instant) -> io::Result<()> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        let mut p = libc::pollfd { fd, events, revents: 0 };
        let ms = left.as_millis().clamp(1, i32::MAX as u128) as i32;
        let r = unsafe { libc::poll(&mut p, 1, ms) };
        if r > 0 {
            return Ok(());
        }
        if r < 0 && crate::sys::errno() != libc::EINTR {
            return Err(io::Error::last_os_error());
        }
    }
}

/// Appends the line to `<home>/sessions/<id>/spool.ndjson` with one `write` on an `O_APPEND` fd,
/// respecting the soft and hard caps. The session directory must already exist.
///
/// Core drains a spool by renaming it and reading what it renamed, so the append holds `flock(LOCK_EX)` on the fd,
/// which core takes before its rename. A spool core renamed between this open and the lock is no longer at the path
/// (its inode differs): the path is opened again, once, and the line goes into the fresh spool. Where core cannot take
/// the lock (Linux: Node has no `flock`) it can also rename the spool while the line is written, and may have
/// read it before: so after the write the path is looked at once more, and a spool core took meanwhile gets the line
/// again in a fresh one. Core applies each envelope id once, so the copy that comes second is dropped. On macOS
/// core renames only under the lock, and the second look always finds the file still there. Only a regular file is
/// written (`O_NONBLOCK`: a FIFO in its place never blocks).
pub fn spool(home: &Path, session: &str, line: &[u8], critical: bool) -> Outcome {
    spool_at(home, session, line, critical, &mut || {}, &mut || {})
}

/// `spool`, with `between` run after the first open, before the lock, and `written` after each write, before
/// the look that follows it (a test's ways in: core renaming the spool at those moments).
fn spool_at(home: &Path, session: &str, line: &[u8], critical: bool, between: &mut dyn FnMut(), written: &mut dyn FnMut()) -> Outcome {
    let dir = home.join("sessions").join(session);
    if !dir.is_dir() {
        return Outcome::Dropped;
    }
    let path = dir.join("spool.ndjson");
    let Some(mut f) = open_at_path(&path, between) else {
        return Outcome::Dropped;
    };
    let mut outcome = append(&f, line, critical);
    written();
    // core took the spool mid-write (Linux: it renames without the hook's lock), and may have read it before this line:
    // the line goes into the fresh one too, and again while that one is taken as well. Under the lock (macOS)
    // the spool is always still at the path, and this is never run.
    for _ in 0..SPOOL_REWRITES_MAX {
        if at_path(&f, &path) {
            break;
        }
        let Some(g) = open_at_path(&path, &mut || {}) else { break };
        let again = append(&g, line, critical);
        written();
        if outcome != Outcome::Spooled {
            outcome = again; // a full spool core took leaves room in the fresh one
        }
        f = g;
    }
    outcome
}

/// The spool at `path`, opened and locked; one that core renamed between the open and the lock is no longer
/// at the path (core took it before the hook held its lock: the line belongs in the next one), so the path is
/// opened again, once.
fn open_at_path(path: &Path, between: &mut dyn FnMut()) -> Option<std::fs::File> {
    let f = open_locked(path, between)?;
    if at_path(&f, path) {
        return Some(f);
    }
    open_locked(path, &mut || {}).filter(|g| at_path(g, path))
}

/// One `write` of the line, within the caps.
fn append(f: &std::fs::File, line: &[u8], critical: bool) -> Outcome {
    let size = f.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
    if size >= SPOOL_HARD_BYTES || (size >= SPOOL_SOFT_BYTES && !critical) {
        return Outcome::Capped;
    }
    let n = unsafe { libc::write(f.as_raw_fd(), line.as_ptr().cast(), line.len()) };
    if n == line.len() as isize { Outcome::Spooled } else { Outcome::Dropped }
}

/// Opens (creating) the spool for appending and takes its exclusive lock; `None` for anything but a
/// regular file. The lock goes with the fd.
fn open_locked(path: &Path, between: &mut dyn FnMut()) -> Option<std::fs::File> {
    let f = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    between();
    loop {
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Some(f);
        }
        if crate::sys::errno() != libc::EINTR {
            return None;
        }
    }
}

/// Is `f` still the file at `path` (core has not renamed it away)?
fn at_path(f: &std::fs::File, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (f.metadata(), std::fs::symlink_metadata(path)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Reads stdin to EOF. Over the cap it keeps draining (so the agent never sees a broken pipe) and
/// returns `None`.
pub fn read_stdin(r: &mut impl Read, cap: u64) -> Option<Vec<u8>> {
    let mut data = Vec::new();
    let mut over = false;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if !over {
                    data.extend_from_slice(&chunk[..n]);
                    if data.len() as u64 > cap {
                        over = true;
                        data = Vec::new();
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    (!over).then_some(data)
}

/// The whole hook, minus process concerns. `stdin_cap` is `HOOK_STDIN_MAX_BYTES` in production.
pub fn run(args: &[OsString], stdin: &mut impl Read, stdin_cap: u64) -> Outcome {
    let stamp = match (envelope_id(), crate::os::hook_clock_ns()) {
        (Ok(id), Ok(mono)) => Some(Stamp { id, mono, received_at: crate::sys::wall_ms() }),
        _ => None,
    };
    let input = read_stdin(stdin, stdin_cap);
    let Some(stamp) = stamp else { return Outcome::Dropped };
    let Some(a) = parse_args(args) else { return Outcome::Dropped };
    let rd = run_dir(&a.home, unsafe { libc::getuid() }, crate::os::runtime_dir().as_deref());
    if !rd.is_dir() {
        return Outcome::Dropped;
    }
    let (payload, flag) = match input {
        None => (None, Some("oversize")),
        Some(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => (Some(v), None),
            Err(_) => (None, Some("malformed")),
        },
    };
    let critical = payload.as_ref().is_some_and(|p| is_critical(p, &a.projection));
    let line = envelope(&a, &stamp, payload.as_ref(), flag);
    drop(payload);
    deliver_or_spool(&a, &rd.join("core.sock"), line.as_bytes(), critical, Duration::from_millis(HOOK_BOUND_MS))
}

/// The run-dir checks on core's socket before anything connects to it: its directory (and
/// `/tmp/kea-<uid>` when the run dir lies there; `shared` is that prefix) a real directory of this user's,
/// closed to everyone else, and the socket a real socket of this user's with a single link, all by `lstat`.
/// So an agent cannot point `--home` at a directory whose `core.sock` leads to another socket — a holder's —
/// and make this signed binary its client.
pub fn check_core_socket(sock: &Path, shared: &str) -> Result<(), String> {
    let dir = sock.parent().filter(|d| !d.as_os_str().is_empty()).ok_or_else(|| format!("{} has no directory", sock.display()))?;
    check_run_dir(dir, shared)?;
    check_own_socket(sock)
}

/// The line to core's socket and core's `ACK` back within `bound`, else (any failure: an
/// unsafe socket or directory, no socket, refused, timeout, a short write, no answer) to the session spool.
pub fn deliver_or_spool(a: &HookArgs, sock: &Path, line: &[u8], critical: bool, bound: Duration) -> Outcome {
    match check_core_socket(sock, SHARED_RUN_ROOT_PREFIX).map_err(io::Error::other).and_then(|()| deliver(sock, line, bound)) {
        Ok(()) => Outcome::Delivered,
        Err(_) => spool(&a.home, &a.session, line, critical),
    }
}

pub fn main(args: &[OsString]) -> i32 {
    // Never fail the agent and never print — not even a panic message.
    std::panic::set_hook(Box::new(|_| {}));
    let _ = std::panic::catch_unwind(|| run(args, &mut io::stdin().lock(), HOOK_STDIN_MAX_BYTES));
    0
}

#[cfg(test)]
mod tests;
