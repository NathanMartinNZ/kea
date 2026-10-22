//! The holder (`kea-helper pty`): owns one PTY, its ring file and at most one Kea client.
//! Single-threaded `poll(2)` loop; non-blocking socket and master; fixed buffers.

mod bufs;
mod child;
pub mod flow;
mod signals;
pub mod state;
mod tree;

use std::ffi::OsString;
use std::fs::DirBuilder;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::Path;

use crate::admission::{self, Admission, Decision, PeerCheck, Refusal};
use crate::args::{PtyArgs, parse_pty};
use crate::limits::*;
use crate::proto::{self, ClientFrame, DecodeError, Event, SignalTarget, code};
use crate::ring::Ring;
use crate::rundir::{SHARED_RUN_ROOT_PREFIX, check_private_dir, shared_root};
use crate::sys::{StackBuf, errno, now_ms, pipe_cloexec, set_cloexec, set_nonblock, wall_ms};
use bufs::{ByteBuf, InputQueue};
use flow::Flow;
use state::{ExitInfo, Started, StateFile};

const READ_BUF: usize = HOLDER_READ_BUFFER_BYTES as usize;
const NAME_BUF: usize = 64;
const PATH_BUF: usize = 1024;
/// Room kept free in the outgoing buffer so any control reply (STAT is the largest) always fits.
const CTRL_RESERVE: usize =
    proto::HEADER_LEN + 4 + 4 + 2 + NAME_BUF + 2 + PATH_BUF + 2 + 4 * HOLDER_STAT_PIDS_MAX as usize;
const OUT_CAP: usize = 2 * (proto::OUTPUT_HEADER_LEN + READ_BUF) + CTRL_RESERVE;
/// Socket input buffer: one read's worth; INPUT payload streams through it into the input queue.
const IN_CAP: usize = READ_BUF;
/// `poll` entries besides the pending checks: wake pipe, parent, listener, PTY, client.
const FIXED_FDS: usize = 5;

pub enum Step {
    Running,
    Exit(i32),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Read {
    Data,
    Empty,
    Eof,
}

struct Conn {
    fd: OwnedFd,
    dec: proto::Decoder,
    hello: bool,
    attached: bool,
    /// `EXIT` already sent on this attachment.
    exit_sent: bool,
}

struct Terminate {
    deadline: u64,
    /// bounded: the processes of this terminal still alive at the latest TERMINATE (`tree::merge` drops
    /// exited members and never lists a process twice), so repeated TERMINATEs during one grace period
    /// never grow it.
    members: Vec<tree::Member>,
}

pub struct Holder<P: PeerCheck> {
    args: PtyArgs,
    /// Master + kept slave; `None` once the child exited and the PTY was drained.
    pty: Option<child::Child>,
    child_pid: i32,
    /// The slave's device while the PTY is open; `None` once closed, because tty devices are reused
    /// and a later PTY's processes must never match this holder's tree.
    tty_rdev: Option<u32>,
    my_pid: i32,
    exit: Option<ExitInfo>,
    /// Bytes read since the child exited: bounds the drain when orphans keep writing.
    read_since_exit: u64,
    master_eof: bool,
    /// bounded: one file-backed mapping of `--ring-bytes`, overwritten in place.
    ring: Ring,
    flow: Flow,
    listener: OwnedFd,
    sock_id: (u64, u64),
    conn: Option<Conn>,
    /// bounded: `IN_CAP` (one read's worth, HOLDER_READ_BUFFER_BYTES), fixed at start.
    inbuf: ByteBuf,
    /// bounded: `OUT_CAP` (two OUTPUT frames plus room for the largest control reply), fixed at start.
    out: ByteBuf,
    /// bounded: HOLDER_INPUT_CAP_BYTES; past it the socket is not read.
    input: InputQueue,
    wake: OwnedFd,
    /// `--no-detach`: EOF here means the parent is gone.
    parent: Option<RawFd>,
    quit_after_exit: bool,
    admission: Admission<P>,
    state: StateFile,
    json_refusals: u64,
    json_due: Option<u64>,
    last_refusal_json: Option<u64>,
    term: Option<Terminate>,
    ws: libc::winsize,
    /// The post-exit linger, `HOLDER_LINGER_MS` (debug builds: `KEA_HELPER_TEST_LINGER_MS`).
    linger_ms: u64,
    linger_until: Option<u64>,
    released: bool,
    /// The terminal's processes for `TERMINATE` and `STAT`, as this system finds them (Linux: the scope's cgroup or one
    /// pass over `/proc`), with whatever fixed buffers that needs, made at start.
    scan: crate::os::ProcScan,
    /// bounded: HOLDER_STAT_PIDS_MAX, allocated at start and only cleared and refilled.
    stat_pids: Vec<i32>,
    /// bounded: HOLDER_STAT_PIDS_MAX, as `stat_pids`.
    stat_u32: Vec<u32>,
}

/// The stale-client timeout. Debug builds read `KEA_HELPER_TEST_STALE_MS` so tests stay fast.
fn stale_ms() -> u64 {
    #[cfg(debug_assertions)]
    if let Some(v) = std::env::var("KEA_HELPER_TEST_STALE_MS").ok().and_then(|v| v.parse().ok()) {
        return v;
    }
    HOLDER_STALE_CLIENT_MS
}

/// The post-exit linger. Debug builds read `KEA_HELPER_TEST_LINGER_MS` so I-HLD-15 can watch
/// a linger end; release builds ignore it.
fn linger_ms() -> u64 {
    #[cfg(debug_assertions)]
    if let Some(v) = std::env::var("KEA_HELPER_TEST_LINGER_MS").ok().and_then(|v| v.parse().ok()) {
        return v;
    }
    HOLDER_LINGER_MS
}

fn log(msg: &str) {
    eprintln!("kea-helper: {msg}");
    if let Ok(c) = std::ffi::CString::new(msg.replace('\0', " ")) {
        unsafe { libc::syslog(libc::LOG_NOTICE | libc::LOG_USER, c"kea-helper: %s".as_ptr(), c.as_ptr()) };
    }
}

fn mkdir_0700(dir: &Path) -> io::Result<()> {
    if dir.is_dir() { Ok(()) } else { DirBuilder::new().recursive(true).mode(0o700).create(dir) }
}

/// Creates the socket's directory (0700, with missing parents) and checks it, and `/tmp/kea-<uid>` when it
/// lies there (`shared` is that prefix), with [`check_private_dir`] (ptyhost's `ensurePrivateDir`).
/// Anything else is refused and logged, never repaired. An existing shared root is checked before
/// anything is created under it.
fn private_socket_dir(dir: &Path, shared: &str) -> Result<(), String> {
    let root = shared_root(dir, shared).filter(|r| *r != dir);
    let checked = || -> Result<(), String> {
        if let Some(r) = root
            && std::fs::symlink_metadata(r).is_ok()
        {
            check_private_dir(r)?;
        }
        mkdir_0700(dir).map_err(|e| format!("cannot create the socket directory {}: {e}", dir.display()))?;
        root.map_or(Ok(()), check_private_dir)?;
        check_private_dir(dir)
    };
    checked().inspect_err(|e| log(e))
}

/// Binds the socket (mode 0600) after unlinking a stale socket file; refuses to replace anything else.
/// The directory was checked by [`private_socket_dir`].
fn listen(path: &Path) -> Result<(OwnedFd, (u64, u64)), String> {
    let err = |what: &str, e: io::Error| format!("{what} {}: {e}", path.display());
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_socket() => std::fs::remove_file(path).map_err(|e| err("cannot remove stale socket", e))?,
        Ok(_) => return Err(format!("{} exists and is not a socket", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(err("cannot stat", e)),
    }
    // chmod rather than umask: umask is process-wide. The directory is 0700, so the moment between
    // bind and chmod exposes nothing.
    let listener = UnixListener::bind(path).map_err(|e| err("cannot listen on", e))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| err("cannot chmod", e))?;
    listener.set_nonblocking(true).map_err(|e| err("cannot configure", e))?;
    let meta = std::fs::symlink_metadata(path).map_err(|e| err("cannot stat", e))?;
    Ok((listener.into(), (meta.dev(), meta.ino())))
}

fn setsockopt_int(fd: RawFd, opt: libc::c_int, v: libc::c_int) {
    unsafe {
        libc::setsockopt(fd, libc::SOL_SOCKET, opt, (&v as *const libc::c_int).cast(), size_of::<libc::c_int>() as libc::socklen_t)
    };
}

impl<P: PeerCheck> Holder<P> {
    /// Creates the ring, the socket and the child, and writes the state json.
    pub fn spawn(args: PtyArgs, peer: P, wake: OwnedFd, parent: Option<RawFd>) -> Result<Self, String> {
        // Before anything is created: an unsafe socket directory fails the launch.
        if let Some(dir) = args.sock.parent().filter(|d| !d.as_os_str().is_empty()) {
            private_socket_dir(dir, SHARED_RUN_ROOT_PREFIX)?;
        }
        mkdir_0700(&args.dir).map_err(|e| format!("cannot create --dir {}: {e}", args.dir.display()))?;
        // A missing --cwd is not a launch error: the child reports the failed chdir on the PTY.
        let ring_path = args.dir.join(format!("{}.ring", args.id));
        let ring = Ring::create(&ring_path, args.ring_bytes).map_err(|e| format!("cannot create {}: {e}", ring_path.display()))?;
        let (listener, sock_id) = listen(&args.sock)?;
        let ws = child::winsize(args.cols, args.rows, 0, 0);
        let pty = match child::spawn(args.argv(), &args.cwd, ws) {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&args.sock);
                return Err(format!("cannot start the child: {e}"));
            }
        };
        let my_pid = unsafe { libc::getpid() };
        let me = crate::os::proc_info(my_pid).ok();
        let scan = crate::os::ProcScan::new(&args.id);
        let started = Started {
            pid: my_pid,
            start_us: me.map_or(0, |i| i.start_us),
            start_ticks: me.and_then(|i| crate::os::raw_start(&i)),
            detach: scan.detach(args.no_detach),
        };
        let state = StateFile::new(&args, started, pty.pid, wall_ms());
        if let Err(e) = state.write(None, 0) {
            unsafe { libc::kill(pty.pid, libc::SIGKILL) };
            unsafe { libc::waitpid(pty.pid, std::ptr::null_mut(), 0) };
            let _ = std::fs::remove_file(&args.sock);
            return Err(format!("cannot write the state json in {}: {e}", args.dir.display()));
        }
        if let Some(fd) = parent {
            let _ = set_nonblock(fd);
        }
        let _ = set_nonblock(wake.as_raw_fd());
        Ok(Holder {
            child_pid: pty.pid,
            tty_rdev: Some(pty.tty_rdev),
            my_pid,
            pty: Some(pty),
            exit: None,
            read_since_exit: 0,
            master_eof: false,
            flow: Flow::new(args.ring_bytes, stale_ms()),
            ring,
            listener,
            sock_id,
            conn: None,
            inbuf: ByteBuf::new(IN_CAP),
            out: ByteBuf::new(OUT_CAP),
            input: InputQueue::new(HOLDER_INPUT_CAP_BYTES as usize),
            wake,
            parent,
            quit_after_exit: false,
            admission: Admission::new(peer, unsafe { libc::getuid() }),
            state,
            json_refusals: 0,
            json_due: None,
            last_refusal_json: None,
            term: None,
            ws,
            linger_ms: linger_ms(),
            linger_until: None,
            released: false,
            scan,
            stat_pids: Vec::with_capacity(HOLDER_STAT_PIDS_MAX as usize),
            stat_u32: Vec::with_capacity(HOLDER_STAT_PIDS_MAX as usize),
            args,
        })
    }

    pub fn child_pid(&self) -> i32 {
        self.child_pid
    }

    /// One turn of the loop: wait at most `max_wait_ms` (−1 = until something happens).
    pub fn step(&mut self, max_wait_ms: i32) -> Step {
        self.service();
        if self.should_exit() {
            return Step::Exit(self.shutdown());
        }
        let mut fds = [libc::pollfd { fd: -1, events: 0, revents: 0 }; FIXED_FDS + admission::SLOTS];
        let (wake_i, parent_i, listen_i, pty_i, conn_i) = (0, 1, 2, 3, 4);
        // The pending checks' verdict pipes: their answers are read in `service`.
        let mut checks = [libc::pollfd { fd: -1, events: 0, revents: 0 }; admission::SLOTS];
        self.admission.poll_fds(&mut checks);
        fds[FIXED_FDS..].copy_from_slice(&checks);
        fds[wake_i] = libc::pollfd { fd: self.wake.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        if let Some(p) = self.parent {
            fds[parent_i] = libc::pollfd { fd: p, events: libc::POLLIN, revents: 0 };
        }
        fds[listen_i] = libc::pollfd { fd: self.listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        if let Some(pty) = &self.pty {
            let mut ev = 0;
            if self.flow.can_read() && !self.master_eof {
                ev |= libc::POLLIN;
            }
            if !self.input.is_empty() {
                ev |= libc::POLLOUT;
            }
            if ev != 0 {
                fds[pty_i] = libc::pollfd { fd: pty.master.as_raw_fd(), events: ev, revents: 0 };
            }
        }
        if let Some(c) = &self.conn {
            let mut ev = 0;
            if self.inbuf.free() > 0 {
                ev |= libc::POLLIN;
            }
            if !self.out.is_empty() {
                ev |= libc::POLLOUT;
            }
            fds[conn_i] = libc::pollfd { fd: c.fd.as_raw_fd(), events: ev, revents: 0 };
        }
        let timeout = self.poll_timeout(max_wait_ms);
        let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if r < 0 {
            return Step::Running; // EINTR: the self-pipe tells the rest
        }
        let ready = |i: usize| fds[i].fd >= 0 && fds[i].revents != 0;
        if ready(wake_i) {
            let mut b = [0u8; 64];
            while unsafe { libc::read(self.wake.as_raw_fd(), b.as_mut_ptr().cast(), b.len()) } > 0 {}
        }
        if ready(parent_i) {
            self.on_parent_readable();
        }
        if ready(listen_i) {
            self.accept_one();
        }
        if ready(pty_i) && fds[pty_i].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 && self.flow.can_read() {
            let _ = self.read_pty();
        }
        if ready(conn_i) && fds[conn_i].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            self.read_conn();
        }
        self.service();
        if self.should_exit() {
            return Step::Exit(self.shutdown());
        }
        Step::Running
    }

    /// Everything that does not wait on poll: reaping, timers, draining, frames in and out.
    fn service(&mut self) {
        let now = now_ms();
        self.reap();
        self.admissions(now);
        self.timers(now);
        self.drain_after_exit();
        self.process_inbuf();
        self.write_input();
        self.fill_output();
        self.flush_out();
    }

    fn should_exit(&mut self) -> bool {
        // SIGTERM/SIGHUP are discarded while the child lives and end the holder once it is gone.
        let term = signals::take_term();
        let Some(_) = self.exit else { return false };
        term || self.released
            || self.linger_until.is_some_and(|t| now_ms() >= t)
            || (self.quit_after_exit && self.term.is_none() && self.pty.is_none())
    }

    fn poll_timeout(&self, max_wait_ms: i32) -> i32 {
        let deadlines = [
            self.flow.deadline(),
            self.term.as_ref().map(|t| t.deadline),
            self.json_due,
            self.linger_until,
            self.admission.deadline(),
        ];
        let Some(next) = deadlines.into_iter().flatten().min() else { return max_wait_ms };
        let wait = next.saturating_sub(now_ms()).min(i32::MAX as u64) as i32;
        if max_wait_ms < 0 { wait } else { wait.min(max_wait_ms) }
    }

    /// Unlinks the socket (if it is still this holder's); ring and json stay. Returns the exit code.
    fn shutdown(&mut self) -> i32 {
        if let Ok(m) = std::fs::symlink_metadata(&self.args.sock)
            && (m.dev(), m.ino()) == self.sock_id
        {
            let _ = std::fs::remove_file(&self.args.sock);
        }
        self.conn = None;
        0
    }

    // ── child ────────────────────────────────────────────────────────────────

    fn reap(&mut self) {
        if self.exit.is_some() {
            return;
        }
        let mut status = 0;
        if unsafe { libc::waitpid(self.child_pid, &mut status, libc::WNOHANG) } != self.child_pid {
            return;
        }
        let info = ExitInfo::from_wait_status(status);
        self.exit = Some(info);
        self.write_json();
    }

    /// After exit, read until the tty is empty, then close the PTY and start lingering.
    fn drain_after_exit(&mut self) {
        if self.exit.is_none() || self.pty.is_none() {
            return;
        }
        while self.pty.is_some() && self.flow.can_read() {
            if self.read_pty() != Read::Data {
                self.finish_drain();
            }
        }
    }

    fn finish_drain(&mut self) {
        self.pty = None;
        self.tty_rdev = None;
        self.input.clear();
        if !self.quit_after_exit {
            self.linger_until = Some(now_ms() + self.linger_ms);
        }
    }

    /// One read from the master straight into the ring.
    fn read_pty(&mut self) -> Read {
        let Some(pty) = &self.pty else { return Read::Eof };
        if self.master_eof {
            return Read::Eof;
        }
        let fd = pty.master.as_raw_fd();
        let slot = self.ring.slot(READ_BUF);
        let n = unsafe { libc::read(fd, slot.as_mut_ptr().cast(), slot.len()) };
        if n <= 0 {
            if n < 0 && (errno() == libc::EAGAIN || errno() == libc::EINTR) {
                return Read::Empty;
            }
            // EOF/EIO means every slave is closed, which cannot happen while the holder keeps one;
            // stop polling the master rather than spin.
            self.master_eof = true;
            return Read::Eof;
        }
        let n = n as usize;
        self.ring.commit(n);
        self.flow.on_read(n as u64, now_ms());
        if self.exit.is_some() {
            self.read_since_exit += n as u64;
            if self.read_since_exit >= self.ring.capacity() {
                self.finish_drain();
            }
        }
        Read::Data
    }

    fn write_input(&mut self) {
        let Some(pty) = &self.pty else {
            self.input.clear();
            return;
        };
        while !self.input.is_empty() {
            let front = self.input.front();
            let n = unsafe { libc::write(pty.master.as_raw_fd(), front.as_ptr().cast(), front.len()) };
            if n > 0 {
                self.input.consume(n as usize);
            } else {
                if n < 0 && errno() != libc::EAGAIN && errno() != libc::EINTR {
                    self.input.clear();
                }
                return;
            }
        }
    }

    // ── timers ───────────────────────────────────────────────────────────────

    fn timers(&mut self, now: u64) {
        self.flow.tick(now);
        if self.term.as_ref().is_some_and(|t| now >= t.deadline) {
            self.kill_phase();
        }
        if self.json_due.is_some_and(|t| now >= t) {
            self.json_due = None;
            if self.admission.refusals() != self.json_refusals {
                self.last_refusal_json = Some(now);
                self.write_json();
            }
        }
    }

    fn write_json(&mut self) {
        let refusals = self.admission.refusals();
        match self.state.write(self.exit, refusals) {
            Ok(()) => self.json_refusals = refusals,
            Err(e) => log(&format!("pty {}: cannot write the state json: {e}", self.args.id)),
        }
    }

    // ── signals and termination ──────────────────────────────────────────────

    fn snapshot(&self) -> Vec<tree::Member> {
        tree::snapshot(&self.scan, self.child_pid, self.exit.is_some(), self.tty_rdev, self.my_pid)
    }

    fn signal(&mut self, signo: u8, target: SignalTarget) {
        let sig = signo as libc::c_int;
        match target {
            // Never by pid once reaped: the pid may have been reused.
            SignalTarget::Child if self.exit.is_none() => unsafe {
                libc::kill(self.child_pid, sig);
            },
            SignalTarget::Foreground => {
                if let Some(pty) = &self.pty {
                    let pg = unsafe { libc::tcgetpgrp(pty.master.as_raw_fd()) };
                    if pg > 1 {
                        unsafe { libc::killpg(pg, sig) };
                    }
                }
            }
            SignalTarget::Session => tree::signal_session(&self.snapshot(), sig),
            SignalTarget::Child => {}
        }
    }

    /// `TERMINATE{graceMs}`: snapshot, SIGTERM now, SIGKILL the survivors at the deadline.
    fn terminate(&mut self, grace_ms: u64) {
        let members = self.snapshot();
        tree::term(&members);
        let deadline = now_ms() + grace_ms;
        match &mut self.term {
            Some(t) => {
                t.deadline = t.deadline.min(deadline);
                tree::merge(&mut t.members, members);
            }
            None => self.term = Some(Terminate { deadline, members }),
        }
        if grace_ms == 0 {
            self.kill_phase();
        }
    }

    fn kill_phase(&mut self) {
        if let Some(t) = self.term.take() {
            tree::kill(&t.members);
            tree::kill(&self.snapshot()); // whatever appeared during the grace period
        }
    }

    fn on_parent_readable(&mut self) {
        let Some(fd) = self.parent else { return };
        let mut b = [0u8; 256];
        let n = unsafe { libc::read(fd, b.as_mut_ptr().cast(), b.len()) };
        if n == 0 || (n < 0 && errno() != libc::EAGAIN && errno() != libc::EINTR) {
            // --no-detach: the parent is gone, so the terminal goes with it.
            self.parent = None;
            self.quit_after_exit = true;
            self.linger_until = None;
            self.terminate(HOLDER_PARENT_GONE_GRACE_MS);
        }
    }

    // ── clients ──────────────────────────────────────────────────────────────

    /// Accepts one pending connection per loop turn and starts its check, which runs beside the
    /// loop: the connection waits, untouched, until `admissions` sees the verdict. A wrong uid,
    /// or every check slot taken, refuses it at once. The listener stays readable, so the next turn
    /// takes the next connection; no turn ever waits for a check.
    fn accept_one(&mut self) {
        let fd = unsafe { libc::accept(self.listener.as_raw_fd(), std::ptr::null_mut(), std::ptr::null_mut()) };
        if fd < 0 {
            return;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let raw = fd.as_raw_fd();
        if set_cloexec(raw).is_err() || set_nonblock(raw).is_err() {
            return;
        }
        let _ = crate::os::set_nosigpipe(raw);
        let now = now_ms();
        if let Err(refusal) = self.admission.begin(fd, now) {
            self.refused(refusal, now); // closed at once; the attached client is not touched
        }
    }

    /// Acts on the checks that answered or ran out of time: admit (replacing the client) or refuse.
    fn admissions(&mut self, now: u64) {
        while let Some(d) = self.admission.next_decision(now) {
            match d {
                Decision::Admit(fd) => self.admit(fd),
                Decision::Refuse(refusal) => self.refused(refusal, now),
                Decision::Left => {} // closed; the attached client is not touched
            }
        }
    }

    /// Logs (at most once per interval) and records a refusal in the state json.
    fn refused(&mut self, refusal: Refusal, now: u64) {
        if let Some(n) = refusal.log {
            log(&format!(
                "pty {}: refused {n} connection(s) since the last report ({}); {} in total",
                self.args.id,
                refusal.why.reason(),
                self.admission.refusals()
            ));
        }
        if self.last_refusal_json.is_none_or(|t| now.saturating_sub(t) >= HOLDER_REFUSAL_LOG_INTERVAL_MS) {
            self.last_refusal_json = Some(now);
            self.write_json();
        } else if self.json_due.is_none() {
            self.json_due = self.last_refusal_json.map(|t| t + HOLDER_REFUSAL_LOG_INTERVAL_MS);
        }
    }

    /// An admitted connection replaces the previous client.
    fn admit(&mut self, fd: OwnedFd) {
        self.drop_conn();
        setsockopt_int(fd.as_raw_fd(), libc::SO_SNDBUF, READ_BUF as libc::c_int);
        setsockopt_int(fd.as_raw_fd(), libc::SO_RCVBUF, READ_BUF as libc::c_int);
        self.conn = Some(Conn { fd, dec: proto::Decoder::new(), hello: false, attached: false, exit_sent: false });
    }

    fn drop_conn(&mut self) {
        self.conn = None;
        self.flow.detach();
        self.inbuf.clear();
        self.out.clear();
    }

    fn read_conn(&mut self) {
        let Some(c) = &self.conn else { return };
        let fd = c.fd.as_raw_fd();
        let spare = self.inbuf.spare();
        if spare.is_empty() {
            return;
        }
        let n = unsafe { libc::read(fd, spare.as_mut_ptr().cast(), spare.len()) };
        if n > 0 {
            self.inbuf.commit(n as usize);
        } else if n == 0 || (errno() != libc::EAGAIN && errno() != libc::EINTR) {
            self.drop_conn();
        }
    }

    /// Decodes buffered client frames. Stops while the input queue is full (back-pressure to the
    /// client through its socket) or while a reply would not fit.
    fn process_inbuf(&mut self) {
        enum Act {
            Wait,
            Next,
            Fatal,
            Frame(ClientFrame),
            Unknown(u8),
        }
        loop {
            let Some(conn) = self.conn.as_mut() else { return };
            if self.out.free() < CTRL_RESERVE {
                return;
            }
            let room = if conn.hello { self.input.free() } else { 1 };
            let (used, act) = match conn.dec.next(self.inbuf.data(), room) {
                (used, None) => (used, Act::Wait),
                (used, Some(Err(e))) => {
                    bad_frame_message(e, &mut self.out);
                    (used, Act::Fatal)
                },
                (used, Some(Ok(Event::Input(chunk)))) => {
                    if !conn.hello {
                        not_hello(&mut self.out);
                        (used, Act::Fatal)
                    } else {
                        if self.pty.is_some() {
                            self.input.push(chunk);
                        }
                        (used, Act::Next)
                    }
                }
                (used, Some(Ok(Event::Unknown(t)))) => (used, Act::Unknown(t)),
                (used, Some(Ok(Event::Frame(f)))) => (used, Act::Frame(f)),
            };
            self.inbuf.consume(used);
            match act {
                Act::Wait => return,
                Act::Next => {}
                Act::Fatal => {
                    self.flush_out();
                    self.drop_conn();
                    return;
                }
                Act::Unknown(t) => {
                    if !self.conn.as_ref().is_some_and(|c| c.hello) {
                        not_hello(&mut self.out);
                        self.flush_out();
                        self.drop_conn();
                        return;
                    }
                    let mut m = StackBuf::<64>::new();
                    let _ = std::fmt::Write::write_fmt(&mut m, format_args!("unknown frame type 0x{t:02x}"));
                    push_error(&mut self.out, code::UNKNOWN_TYPE, m.as_bytes());
                }
                Act::Frame(f) => {
                    if !self.on_frame(f) {
                        self.flush_out();
                        self.drop_conn();
                        return;
                    }
                }
            }
        }
    }

    /// Handles one frame; false closes the connection.
    fn on_frame(&mut self, f: ClientFrame) -> bool {
        let now = now_ms();
        let Some(conn) = self.conn.as_mut() else { return false };
        if !conn.hello && !matches!(f, ClientFrame::Hello { .. }) {
            not_hello(&mut self.out);
            return false;
        }
        match f {
            ClientFrame::Hello { proto } => {
                if proto != proto::PROTO {
                    // The connection stays open: the client may send another HELLO.
                    let mut m = StackBuf::<64>::new();
                    let _ = std::fmt::Write::write_fmt(&mut m, format_args!("unsupported protocol {proto}; this holder speaks {}", proto::PROTO));
                    push_error(&mut self.out, code::BAD_PROTO, m.as_bytes());
                } else {
                    conn.hello = true;
                    self.push_hello();
                }
            }
            ClientFrame::Attach { mode, seq } => {
                conn.attached = true;
                conn.exit_sent = false;
                self.flow.attach(mode, seq, now);
            }
            ClientFrame::Resize { cols, rows, xpx, ypx } => {
                self.ws = child::winsize(cols, rows, xpx, ypx);
                if let Some(pty) = &self.pty {
                    unsafe { libc::ioctl(pty.master.as_raw_fd(), libc::TIOCSWINSZ, &self.ws) };
                }
            }
            ClientFrame::Ack { seq } => {
                if conn.attached {
                    self.flow.on_ack(seq, now);
                } else {
                    push_error(&mut self.out, code::NOT_ATTACHED, b"ACK while not attached");
                }
            }
            ClientFrame::Signal { signo, target } => self.signal(signo, target),
            ClientFrame::Terminate { grace_ms } => self.terminate(grace_ms as u64),
            ClientFrame::Stat => self.push_stat(),
            ClientFrame::Detach => {
                conn.attached = false;
                self.flow.detach();
            }
            ClientFrame::Release => {
                if self.exit.is_none() {
                    push_error(&mut self.out, code::CHILD_ALIVE, b"RELEASE while the child is alive");
                } else {
                    self.released = true;
                }
            }
        }
        true
    }

    fn push_hello(&mut self) {
        let (code, signal) = self.exit.map(ExitInfo::wire).unwrap_or((0, 0));
        let info = proto::HelloInfo {
            proto: proto::PROTO,
            child_pid: self.child_pid as u32,
            cols: self.ws.ws_col,
            rows: self.ws.ws_row,
            earliest: self.ring.earliest(),
            latest: self.ring.latest(),
            exited: self.exit.is_some(),
            code,
            signal,
            pty_id: self.args.id.as_bytes(),
        };
        let len = proto::hello_len(&info);
        if let Some(dst) = self.out.space(len) {
            proto::encode_hello(dst, &info);
            self.out.commit(len);
        }
    }

    /// Child pid, foreground group (`tcgetpgrp`) with its name and cwd, descendants.
    fn push_stat(&mut self) {
        let fg = self.pty.as_ref().map(|p| unsafe { libc::tcgetpgrp(p.master.as_raw_fd()) }).filter(|&p| p > 0).unwrap_or(0);
        let mut name = [0u8; NAME_BUF];
        let mut cwd = [0u8; PATH_BUF];
        let name_len = crate::os::name_into(fg, &mut name);
        let cwd_len = crate::os::cwd_into(fg, &mut cwd);
        if self.exit.is_none() {
            self.scan.descendants_into(self.child_pid, &mut self.stat_pids);
        } else {
            self.stat_pids.clear();
        }
        self.stat_u32.clear();
        self.stat_u32.extend(self.stat_pids.iter().map(|&p| p as u32));
        let info = proto::StatInfo {
            child_pid: self.child_pid as u32,
            fg_pid: fg as u32,
            fg_name: &name[..name_len],
            cwd: &cwd[..cwd_len],
            pids: &self.stat_u32,
        };
        let len = proto::stat_len(&info);
        if let Some(dst) = self.out.space(len) {
            proto::encode_stat(dst, &info);
            self.out.commit(len);
        }
    }

    /// Frames ring bytes for the attached client, then `EXIT` once everything was sent.
    fn fill_output(&mut self) {
        let Some(conn) = self.conn.as_mut() else { return };
        if !conn.attached {
            return;
        }
        while let Some((from, to)) = self.flow.to_send() {
            let room = self.out.free().saturating_sub(CTRL_RESERVE + proto::OUTPUT_HEADER_LEN);
            let n = ((to - from) as usize).min(READ_BUF).min(room);
            if n == 0 {
                return;
            }
            let Some(dst) = self.out.space(proto::OUTPUT_HEADER_LEN + n) else { return };
            dst[..proto::OUTPUT_HEADER_LEN].copy_from_slice(&proto::output_header(from, n));
            let (start, got) = self.ring.read(from, &mut dst[proto::OUTPUT_HEADER_LEN..]);
            debug_assert_eq!((start, got), (from, n));
            self.out.commit(proto::OUTPUT_HEADER_LEN + n);
            self.flow.on_sent(from + n as u64);
        }
        if let Some(exit) = self.exit
            && self.pty.is_none()
            && !conn.exit_sent
            && !self.flow.free_run()
            && let Some(dst) = self.out.space(proto::EXIT_LEN)
        {
            let (code, signal) = exit.wire();
            proto::encode_exit(dst, code, signal);
            self.out.commit(proto::EXIT_LEN);
            conn.exit_sent = true;
        }
    }

    fn flush_out(&mut self) {
        let Some(c) = &self.conn else { return };
        let fd = c.fd.as_raw_fd();
        while !self.out.is_empty() {
            let d = self.out.data();
            let n = crate::os::send(fd, d);
            if n > 0 {
                self.out.consume(n as usize);
            } else {
                if n < 0 && errno() != libc::EAGAIN && errno() != libc::EINTR {
                    self.drop_conn();
                }
                return;
            }
        }
    }
}

impl<P: PeerCheck> Drop for Holder<P> {
    fn drop(&mut self) {
        // Only reached with a live child in tests or on a bug: do not leave the child behind.
        if self.exit.is_none() {
            unsafe { libc::kill(self.child_pid, libc::SIGKILL) };
            // A session leader's exit waits for its tty's output to drain: hang the tty up first.
            self.pty = None;
            unsafe { libc::waitpid(self.child_pid, std::ptr::null_mut(), 0) };
        }
    }
}

fn push_error(out: &mut ByteBuf, code: u16, msg: &[u8]) {
    let len = proto::error_len(msg);
    if let Some(dst) = out.space(len) {
        proto::encode_error(dst, code, msg);
        out.commit(len);
    }
}

fn not_hello(out: &mut ByteBuf) {
    push_error(out, code::NOT_HELLO, b"the first frame must be HELLO");
}

fn bad_frame_message(e: DecodeError, out: &mut ByteBuf) {
    let mut m = StackBuf::<96>::new();
    let _ = match e {
        DecodeError::TooLong { ty, len } => {
            std::fmt::Write::write_fmt(&mut m, format_args!("frame 0x{ty:02x} of {len} bytes exceeds {HOLDER_MAX_FRAME_BYTES}"))
        }
        DecodeError::BadLength { ty, len } => std::fmt::Write::write_fmt(&mut m, format_args!("frame 0x{ty:02x} has a bad length {len}")),
        DecodeError::BadValue { ty } => std::fmt::Write::write_fmt(&mut m, format_args!("frame 0x{ty:02x} has an out-of-range value")),
    };
    push_error(out, code::BAD_LENGTH, m.as_bytes());
}

// ── process entry points ──────────────────────────────────────────────────────

/// Where the ready line goes: the launcher's pipe (daemon) or stdout as JSON (`--no-detach`).
enum Ready {
    Fd(RawFd),
    Stdout,
}

impl Ready {
    fn ok(&self, pid: i32, child: i32) {
        match self {
            Ready::Fd(fd) => {
                let _ = crate::sys::write_all(*fd, format!("READY {pid} {child}\n").as_bytes());
                unsafe { libc::close(*fd) };
            }
            Ready::Stdout => crate::launch::print_json_line(&format!("{{\"pid\":{pid},\"childPid\":{child}}}")),
        }
    }

    fn fail(&self, msg: &str) -> i32 {
        let one_line = msg.replace(['\n', '\r'], " ");
        match self {
            Ready::Fd(fd) => {
                let _ = crate::sys::write_all(*fd, format!("ERR {one_line}\n").as_bytes());
            }
            Ready::Stdout => crate::launch::print_json_line(&crate::launch::error_json(&one_line)),
        }
        1
    }
}

/// `kea-helper pty-daemon …` (started by the launcher only).
pub fn daemon_main(raw: &[OsString]) -> i32 {
    match parse_pty(raw, true) {
        Ok(args) => run_holder(args),
        Err(e) => {
            // The launcher validated these arguments; report on its pipe if it is there.
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            let fd = crate::launch::READY_FD;
            if unsafe { libc::fstat(fd, &mut st) } == 0 && st.st_mode & libc::S_IFMT == libc::S_IFIFO {
                Ready::Fd(fd).fail(&e);
            } else {
                eprintln!("kea-helper: {e}");
            }
            2
        }
    }
}

/// Runs a holder in this process until it exits (daemon or `--no-detach`).
pub fn run_holder(args: PtyArgs) -> i32 {
    let ready = match args.ready_fd {
        Some(fd) => {
            let _ = set_cloexec(fd);
            Ready::Fd(fd)
        }
        None => Ready::Stdout,
    };
    // Before anything is bound or started: the holder closed to its user's other processes (Linux: non-dumpable, no
    // `INVOCATION_ID` for the agent); nothing on macOS.
    if let Err(e) = crate::os::harden_holder() {
        return ready.fail(&e);
    }
    let peer = match crate::os::PeerAdmission::new(&args.client) {
        Ok(p) => p,
        Err(e) => return ready.fail(&e),
    };
    let (wake_rd, wake_wr) = match pipe_cloexec() {
        Ok(p) => p,
        Err(e) => return ready.fail(&format!("pipe: {e}")),
    };
    let _ = set_nonblock(wake_wr.as_raw_fd());
    if let Err(e) = signals::install(wake_wr.as_raw_fd()) {
        return ready.fail(&format!("signals: {e}"));
    }
    let parent = args.no_detach.then_some(libc::STDIN_FILENO);
    let mut holder = match Holder::spawn(args, peer, wake_rd, parent) {
        Ok(h) => h,
        Err(e) => return ready.fail(&e),
    };
    ready.ok(unsafe { libc::getpid() }, holder.child_pid());
    let code = loop {
        if let Step::Exit(code) = holder.step(-1) {
            break code;
        }
    };
    drop(holder);
    let _ = wake_wr.into_raw_fd(); // the signal handler may still write to it until exit
    code
}

#[cfg(test)]
mod tests;
