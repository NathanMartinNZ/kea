//! Client admission: same uid and an identity that satisfies the client the holder was started with. The
//! system's check is `os::PeerAdmission` (macOS: a code signature against `--client-req`, checked on the peer's audit
//! token by a forked child; Linux: the peer's executable against `--client-exe`, its mappings and its parent's, checked
//! at accept and answered at once).
//!
//! The check never blocks the holder's loop: a connection whose uid matches waits in one of
//! `HOLDER_PENDING_CHECKS_MAX` slots — nothing read from it, nothing written to it — while the holder keeps
//! serving its attached client; the check's verdict pipe joins the holder's `poll` set, and the verdict
//! (or `HOLDER_PEER_CHECK_TIMEOUT_MS`) admits or refuses it. With every slot taken, a new connection is
//! refused at once. The system's part sits behind [`PeerCheck`] so tests can stub it (R-HLD-5).

use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use crate::limits::{HOLDER_PEER_CHECK_TIMEOUT_MS, HOLDER_PENDING_CHECKS_MAX, HOLDER_REFUSAL_LOG_INTERVAL_MS};
use crate::sys::{errno, set_nonblock};

/// Slots for connections awaiting their check.
pub const SLOTS: usize = HOLDER_PENDING_CHECKS_MAX as usize;

/// A check's verdict, written as the first byte on its pipe before it ends: admit, refuse (Linux follows it with the
/// code of the check that failed, `os::refusal_reason`), or [`ERROR`] followed by a message (the check could not run).
/// EOF before any byte (the check died) refuses.
pub const ADMIT: u8 = b'Y';
pub const REFUSE: u8 = b'N';
pub const ERROR: u8 = b'E';

pub trait PeerCheck {
    /// The peer's effective uid, `None` if it cannot be read.
    fn peer_uid(&self, fd: RawFd) -> Option<u32>;
    /// Starts checking the peer against the client the holder was started with (macOS: its code signature; Linux: its
    /// executable); the verdict arrives on [`Check::verdict`]. `None` refuses at once (fails closed).
    fn start_check(&self, fd: RawFd) -> Option<Check>;
    /// Is the peer process on its way out (exiting or exited) while its end still looks connected? macOS
    /// fails the check of an exiting process before it closes that process's sockets.
    fn peer_exiting(&self, fd: RawFd) -> bool;
}

/// A check that has started; its verdict arrives on the pipe.
pub struct Check {
    /// Read end of the verdict pipe.
    pub verdict: OwnedFd,
    /// The check process (`None` for a stub, and on Linux, which answers at once): killed once its verdict is in or
    /// its deadline passed, and always reaped.
    pub pid: Option<libc::pid_t>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    Uid,
    /// Every slot already held a connection awaiting its check.
    Busy,
    Signature,
    /// Not the client by its executable identity (Linux): which check failed, as `os::refusal_reason` names it.
    Identity(u8),
    /// The check could not run, or ended without a verdict.
    Unchecked,
    /// No verdict within `HOLDER_PEER_CHECK_TIMEOUT_MS`.
    Timeout,
}

impl Refused {
    pub fn reason(self) -> &'static str {
        match self {
            Refused::Uid => "uid mismatch",
            Refused::Busy => "too many connections awaiting a code check",
            Refused::Signature => "code signature does not satisfy the client requirement",
            Refused::Identity(code) => crate::os::refusal_reason(code),
            Refused::Unchecked => "the code signature could not be checked",
            Refused::Timeout => "the code check did not answer in time",
        }
    }
}

/// A refusal; `log` is `Some(n)` when it is time to log (at most once per interval), `n` being the
/// number of refusals since the last log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub why: Refused,
    pub log: Option<u64>,
}

/// What became of a connection that waited for its check.
#[derive(Debug)]
pub enum Decision {
    /// The connection, untouched since `accept`.
    Admit(OwnedFd),
    /// Already closed.
    Refuse(Refusal),
    /// The peer hung up before its verdict: closed, neither counted as a refusal nor admitted.
    Left,
}

struct Pending {
    conn: OwnedFd,
    check: Check,
    deadline: u64,
}

enum Slot {
    Free,
    Checking(Pending),
    /// Decided; the check process is not reaped yet (it keeps the slot until then, so at most `SLOTS`
    /// check processes exist at any time).
    Reaping(libc::pid_t),
}

pub struct Admission<P> {
    peer: P,
    uid: u32,
    /// bounded: HOLDER_PENDING_CHECKS_MAX slots, fixed at start, never grown.
    slots: [Slot; SLOTS],
    refusals: u64,
    unlogged: u64,
    last_log_ms: Option<u64>,
}

impl<P: PeerCheck> Admission<P> {
    pub fn new(peer: P, uid: u32) -> Self {
        Admission { peer, uid, slots: std::array::from_fn(|_| Slot::Free), refusals: 0, unlogged: 0, last_log_ms: None }
    }

    pub fn refusals(&self) -> u64 {
        self.refusals
    }

    /// Slots in use: connections awaiting a check, and check processes not reaped yet.
    pub fn pending(&self) -> usize {
        self.slots.iter().filter(|s| !matches!(s, Slot::Free)).count()
    }

    /// A freshly accepted connection (nothing read from it). Refused at once on a wrong uid (checked first: it is
    /// cheap, and a wrong uid never reaches the system's check), when every slot is taken, or when no check can start;
    /// otherwise it waits in a slot until [`Admission::next_decision`] reports its verdict. A peer that hung up before
    /// its check could start left (on macOS its audit token is gone with the connection): closed, nothing counted.
    pub fn begin(&mut self, conn: OwnedFd, now: u64) -> Result<(), Refusal> {
        let fd = conn.as_raw_fd();
        if self.peer.peer_uid(fd) != Some(self.uid) {
            return Err(self.refuse(Refused::Uid, now));
        }
        self.reap();
        let Some(i) = self.slots.iter().position(|s| matches!(s, Slot::Free)) else {
            return if peer_gone(fd) || self.peer.peer_exiting(fd) { Ok(()) } else { Err(self.refuse(Refused::Busy, now)) };
        };
        let Some(check) = self.peer.start_check(fd) else {
            return if peer_gone(fd) || self.peer.peer_exiting(fd) { Ok(()) } else { Err(self.refuse(Refused::Unchecked, now)) };
        };
        if set_nonblock(check.verdict.as_raw_fd()).is_err() {
            if let Some(pid) = check.pid {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                self.slots[i] = Slot::Reaping(pid);
            }
            return Err(self.refuse(Refused::Unchecked, now));
        }
        self.slots[i] = Slot::Checking(Pending { conn, check, deadline: now + HOLDER_PEER_CHECK_TIMEOUT_MS });
        Ok(())
    }

    /// The verdict pipes of the pending checks, for `poll` (`fd = -1` in unused entries).
    pub fn poll_fds(&self, out: &mut [libc::pollfd; SLOTS]) {
        for (p, s) in out.iter_mut().zip(&self.slots) {
            let fd = match s {
                Slot::Checking(c) => c.check.verdict.as_raw_fd(),
                _ => -1,
            };
            *p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        }
    }

    /// The earliest check deadline, if a check is pending.
    pub fn deadline(&self) -> Option<u64> {
        self.slots
            .iter()
            .filter_map(|s| match s {
                Slot::Checking(p) => Some(p.deadline),
                _ => None,
            })
            .min()
    }

    /// The next decision: a verdict that arrived, or a check past its deadline. Reaps finished check
    /// processes on the way. Call it until `None` after every `poll` (it never blocks).
    pub fn next_decision(&mut self, now: u64) -> Option<Decision> {
        self.reap();
        for i in 0..SLOTS {
            let Slot::Checking(p) = &self.slots[i] else { continue };
            let outcome = match read_verdict(p.check.verdict.as_raw_fd()) {
                Some(v) => v,
                None if now >= p.deadline => Err(Refused::Timeout),
                None => continue,
            };
            let Slot::Checking(p) = std::mem::replace(&mut self.slots[i], Slot::Free) else { unreachable!() };
            if let Some(pid) = p.check.pid {
                // Done with it either way: a verdict is final, and a late check is cut off.
                unsafe { libc::kill(pid, libc::SIGKILL) };
                self.slots[i] = Slot::Reaping(pid);
            }
            let decision = match outcome {
                // It left; it was not refused, and an admission would only replace the attached client for nothing.
                _ if peer_gone(p.conn.as_raw_fd()) || self.peer.peer_exiting(p.conn.as_raw_fd()) => Decision::Left,
                Ok(()) => Decision::Admit(p.conn),
                Err(why) => {
                    drop(p.conn); // closed at once
                    Decision::Refuse(self.refuse(why, now))
                }
            };
            self.reap();
            return Some(decision);
        }
        None
    }

    /// Frees the slots whose check process has exited (no zombies). Never blocks: a process not reaped yet
    /// is retried on the next call (its `SIGCHLD` wakes the holder's loop).
    fn reap(&mut self) {
        for s in self.slots.iter_mut() {
            if let Slot::Reaping(pid) = *s {
                let r = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
                if r == pid || (r < 0 && errno() == libc::ECHILD) {
                    *s = Slot::Free;
                }
            }
        }
    }

    /// Counts a refusal and decides whether to log it now.
    fn refuse(&mut self, why: Refused, now_ms: u64) -> Refusal {
        self.refusals += 1;
        self.unlogged += 1;
        let due = self.last_log_ms.is_none_or(|t| now_ms.saturating_sub(t) >= HOLDER_REFUSAL_LOG_INTERVAL_MS);
        let log = due.then(|| {
            self.last_log_ms = Some(now_ms);
            std::mem::take(&mut self.unlogged)
        });
        Refusal { why, log }
    }
}

impl<P> Drop for Admission<P> {
    /// Pending connections close; check processes are killed and reaped.
    fn drop(&mut self) {
        for s in self.slots.iter_mut() {
            let pid = match std::mem::replace(s, Slot::Free) {
                Slot::Checking(p) => p.check.pid,
                Slot::Reaping(pid) => Some(pid),
                Slot::Free => None,
            };
            if let Some(pid) = pid {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                while unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) } < 0 && errno() == libc::EINTR {}
            }
        }
    }
}

/// Has the peer hung up? Asked without reading: bytes it sent before going stay unread, and macOS reports
/// `POLLHUP` for a stream socket whose peer closed (or shut its writing side) even while they wait.
fn peer_gone(conn: RawFd) -> bool {
    let mut p = libc::pollfd { fd: conn, events: libc::POLLIN, revents: 0 };
    let ready = unsafe { libc::poll(&mut p, 1, 0) };
    ready == 1 && p.revents & libc::POLLHUP != 0
}

/// The verdict, if one arrived: `Some(Ok)` admit, `Some(Err)` refuse (`Signature` for a "no", `Identity` for a "no"
/// with Linux's code, `Unchecked` for an error or EOF before any byte), `None` while the check is still running.
fn read_verdict(fd: RawFd) -> Option<Result<(), Refused>> {
    // a verdict is written in one write of at most two bytes, so one read takes it whole
    let mut b = [0u8; 2];
    loop {
        let n = unsafe { libc::read(fd, b.as_mut_ptr().cast(), b.len()) };
        if n >= 1 {
            return Some(match (b[0], n) {
                (ADMIT, _) => Ok(()),
                (REFUSE, 2) => Err(Refused::Identity(b[1])),
                (REFUSE, _) => Err(Refused::Signature),
                _ => Err(Refused::Unchecked),
            });
        }
        if n == 0 {
            return Some(Err(Refused::Unchecked));
        }
        match errno() {
            libc::EINTR => continue,
            libc::EAGAIN => return None,
            _ => return Some(Err(Refused::Unchecked)),
        }
    }
}

/// A stub [`PeerCheck`] for in-process tests (R-HLD-5): a settable uid and verdict, answered at once
/// or held back until the test answers.
#[cfg(test)]
pub mod stub {
    use super::*;
    use crate::sys::{pipe_cloexec, write_all};
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    #[derive(Clone)]
    pub struct Stub {
        pub uid: Rc<Cell<u32>>,
        pub ok: Rc<Cell<bool>>,
        /// Hold verdicts back: the write ends wait in `held` until the test answers (or drops them).
        pub hold: Rc<Cell<bool>>,
        pub held: Rc<RefCell<Vec<OwnedFd>>>,
        /// Checks started so far.
        pub started: Rc<Cell<u32>>,
        /// The peer process is exiting (its end still connected).
        pub exiting: Rc<Cell<bool>>,
    }

    impl Stub {
        pub fn new(uid: u32) -> Stub {
            Stub {
                uid: Rc::new(Cell::new(uid)),
                ok: Rc::new(Cell::new(true)),
                hold: Rc::new(Cell::new(false)),
                held: Rc::new(RefCell::new(Vec::new())),
                started: Rc::new(Cell::new(0)),
                exiting: Rc::new(Cell::new(false)),
            }
        }

        /// Answers the oldest held check with `verdict` (`None`: ends it without one).
        pub fn answer(&self, verdict: Option<u8>) {
            let wr = self.held.borrow_mut().remove(0);
            if let Some(v) = verdict {
                write_all(wr.as_raw_fd(), &[v]).unwrap();
            }
        }
    }

    impl PeerCheck for Stub {
        fn peer_uid(&self, _: RawFd) -> Option<u32> {
            Some(self.uid.get())
        }
        fn start_check(&self, fd: RawFd) -> Option<Check> {
            if !crate::os::peer_checkable(fd) {
                return None; // like the real check: none can start once the peer has closed its end
            }
            self.started.set(self.started.get() + 1);
            let (rd, wr) = pipe_cloexec().unwrap();
            if self.hold.get() {
                self.held.borrow_mut().push(wr);
            } else {
                write_all(wr.as_raw_fd(), &[if self.ok.get() { ADMIT } else { REFUSE }]).unwrap();
            }
            Some(Check { verdict: rd, pid: None })
        }
        fn peer_exiting(&self, _: RawFd) -> bool {
            self.exiting.get()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::stub::Stub;
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    /// A connection as the holder sees it, and the peer's end.
    fn conn() -> (OwnedFd, UnixStream) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        (ours.into(), theirs)
    }

    /// Upper bound for any wait (the test binary runs other tests in parallel).
    const WAIT: std::time::Duration = std::time::Duration::from_secs(30);

    /// The next decision at logical time `now`, waiting (in `poll`, on the verdict pipes) for a verdict
    /// that is on its way: a test elsewhere in this binary may fork, and its child holds copies of the test's
    /// descriptors until it execs, which delays an EOF.
    fn next(a: &mut Admission<Stub>, now: u64) -> Decision {
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            if let Some(d) = a.next_decision(now) {
                return d;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!left.is_zero(), "no decision");
            let mut fds = [libc::pollfd { fd: -1, events: 0, revents: 0 }; SLOTS];
            a.poll_fds(&mut fds);
            unsafe { libc::poll(fds.as_mut_ptr(), SLOTS as libc::nfds_t, left.as_millis().min(i32::MAX as u128) as i32) };
        }
    }

    /// `begin` and, for a stub that answers at once, the decision (the peer stays connected until then).
    fn decide(a: &mut Admission<Stub>, now: u64) -> Result<(), Refusal> {
        let (ours, _peer) = conn();
        a.begin(ours, now)?;
        match next(a, now) {
            Decision::Admit(_) => Ok(()),
            Decision::Refuse(r) => Err(r),
            Decision::Left => panic!("the peer is still connected"),
        }
    }

    /// The peer's end sees the connection closed: EOF, or on Linux a reset when the holder's end was closed with bytes
    /// the peer sent still unread (waiting out a concurrent fork, see `next`).
    fn closed(s: &mut UnixStream) -> bool {
        // macOS refuses SO_RCVTIMEO (EINVAL) once the peer has closed; the read then returns EOF at once.
        let _ = s.set_read_timeout(Some(WAIT));
        match s.read(&mut [0u8; 16]) {
            Ok(0) => true,
            Err(e) => e.kind() == std::io::ErrorKind::ConnectionReset,
            Ok(_) => false,
        }
    }

    #[test]
    fn r_hld_5_uid_then_signature_counted_and_logged_once_a_minute() {
        let stub = Stub::new(501);
        let mut a = Admission::new(stub.clone(), 501);
        assert_eq!(decide(&mut a, 0), Ok(()));
        stub.uid.set(0);
        assert_eq!(decide(&mut a, 1_000), Err(Refusal { why: Refused::Uid, log: Some(1) }));
        assert_eq!(stub.started.get(), 1, "a wrong uid never reaches the signature check");
        stub.uid.set(501);
        stub.ok.set(false);
        assert_eq!(decide(&mut a, 2_000), Err(Refusal { why: Refused::Signature, log: None }));
        assert_eq!(decide(&mut a, 1_000 + HOLDER_REFUSAL_LOG_INTERVAL_MS - 1), Err(Refusal { why: Refused::Signature, log: None }));
        assert_eq!(a.refusals(), 3);
        // The next line reports everything suppressed meanwhile.
        assert_eq!(decide(&mut a, 1_000 + HOLDER_REFUSAL_LOG_INTERVAL_MS), Err(Refusal { why: Refused::Signature, log: Some(3) }));
        stub.ok.set(true);
        assert_eq!(decide(&mut a, 99_999_999), Ok(()));
        assert_eq!(a.refusals(), 4);
        assert_eq!(a.pending(), 0);
    }

    // The holder-side state machine on a logical clock: checks wait in capped slots, untouched, until a
    // verdict or the deadline decides them.
    #[test]
    fn r_hld_5_checks_wait_in_capped_slots_until_a_verdict_or_the_deadline() {
        let stub = Stub::new(501);
        stub.hold.set(true);
        let mut a = Admission::new(stub.clone(), 501);
        // Peers in the order their checks started, each with a tag it wrote before admission.
        let mut peers = std::collections::VecDeque::new();
        let mut n = 0u32;
        let mut start = |a: &mut Admission<Stub>, now: u64, peers: &mut std::collections::VecDeque<(UnixStream, Vec<u8>)>| {
            let (ours, mut theirs) = conn();
            let tag = format!("peer {n}").into_bytes();
            n += 1;
            theirs.write_all(&tag).unwrap();
            a.begin(ours, now).unwrap();
            peers.push_back((theirs, tag));
        };
        for _ in 0..SLOTS {
            start(&mut a, 0, &mut peers);
        }
        assert_eq!(a.pending(), SLOTS);
        assert!(a.next_decision(0).is_none(), "no verdict yet");
        let mut fds = [libc::pollfd { fd: -1, events: 0, revents: 0 }; SLOTS];
        a.poll_fds(&mut fds);
        assert!(fds.iter().all(|p| p.fd >= 0 && p.events == libc::POLLIN), "every pending verdict pipe is polled");
        assert_eq!(a.deadline(), Some(HOLDER_PEER_CHECK_TIMEOUT_MS));

        // Every slot taken: the next connection is refused at once, without a check.
        let (ours, mut extra) = conn();
        assert_eq!(a.begin(ours, 1), Err(Refusal { why: Refused::Busy, log: Some(1) }));
        assert!(closed(&mut extra));
        assert_eq!(stub.started.get(), SLOTS as u32);

        // Verdicts, oldest check first; each frees a slot that a new connection takes at t = 1.
        for (verdict, want) in [(Some(ADMIT), None), (Some(REFUSE), Some(Refused::Signature)), (Some(ERROR), Some(Refused::Unchecked)), (None, Some(Refused::Unchecked))] {
            stub.answer(verdict);
            let (mut peer, tag) = peers.pop_front().unwrap();
            match (next(&mut a, 1), want) {
                (Decision::Admit(fd), None) => {
                    // The connection comes back untouched: its bytes are still unread.
                    let mut got = vec![0u8; tag.len()];
                    UnixStream::from(fd).read_exact(&mut got).unwrap();
                    assert_eq!(got, tag, "nothing was read before admission");
                }
                (Decision::Refuse(r), Some(why)) => {
                    assert_eq!(r.why, why);
                    assert!(closed(&mut peer), "refused and closed at once");
                }
                (d, w) => panic!("{verdict:?}: got {d:?}, want {w:?}"),
            }
            assert!(a.next_decision(1).is_none());
            start(&mut a, 1, &mut peers);
        }
        // The deadline: checks still pending (started at t = 0 or 1) expire `HOLDER_PEER_CHECK_TIMEOUT_MS`
        // after they started, never before.
        let mut expired = 0;
        for now in [HOLDER_PEER_CHECK_TIMEOUT_MS - 1, HOLDER_PEER_CHECK_TIMEOUT_MS, HOLDER_PEER_CHECK_TIMEOUT_MS + 1] {
            while let Some(d) = a.next_decision(now) {
                assert!(now >= HOLDER_PEER_CHECK_TIMEOUT_MS, "nothing expires early");
                assert!(matches!(d, Decision::Refuse(Refusal { why: Refused::Timeout, .. })), "{d:?}");
                expired += 1;
            }
        }
        assert_eq!(expired, SLOTS);
        assert_eq!(a.pending(), 0);
        for (mut p, _) in peers {
            assert!(closed(&mut p));
        }
        assert_eq!(a.refusals(), 1 + 3 + SLOTS as u64);
    }

    // A peer that hung up before its verdict left; it was not refused (a ptyhost killed during its own check,
    // C-KILL-14). It is closed without counting a refusal, and an "admit" for it replaces no one.
    #[test]
    fn r_hld_5_a_peer_that_hung_up_before_its_verdict_left_neither_refused_nor_admitted() {
        let stub = Stub::new(501);
        stub.hold.set(true);
        let mut a = Admission::new(stub.clone(), 501);
        let mut peers = Vec::new();
        for _ in 0..SLOTS {
            let (ours, mut theirs) = conn();
            theirs.write_all(b"hello before going").unwrap(); // bytes it sent stay unread: it still left
            a.begin(ours, 0).unwrap();
            peers.push(theirs);
        }
        // Hang up with `shutdown`, not just a close: a child another test here forked holds copies of the test's
        // descriptors until it execs, so a closed end may not read as closed yet (see `next`).
        let mut peers = peers.into_iter().map(|p| move || p.shutdown(std::net::Shutdown::Both).unwrap());
        // left, then "refuse" / "admit" / no verdict at all: each a departure, nothing counted
        for verdict in [Some(REFUSE), Some(ADMIT), Some(ERROR)] {
            peers.next().unwrap()();
            stub.answer(verdict);
            assert!(matches!(next(&mut a, 1), Decision::Left), "{verdict:?}");
        }
        // and one whose check never answers: past the deadline it is gone, not timed out
        peers.next().unwrap()();
        assert!(matches!(a.next_decision(HOLDER_PEER_CHECK_TIMEOUT_MS), Some(Decision::Left)));
        assert_eq!((a.refusals(), a.pending()), (0, 0));

        // a peer still there is refused and counted as before
        stub.hold.set(false);
        stub.ok.set(false);
        assert_eq!(decide(&mut a, 2), Err(Refusal { why: Refused::Signature, log: Some(1) }));
        assert_eq!(a.refusals(), 1);
    }

    #[test]
    fn r_hld_5_a_peer_exiting_when_its_check_says_no_left() {
        // macOS fails the check of an exiting process (a SIGKILLed ptyhost) a moment before it closes that
        // process's sockets: the "no" for a peer on its way out is a departure (C-KILL-14)
        let stub = Stub::new(501);
        stub.ok.set(false);
        let mut a = Admission::new(stub.clone(), 501);
        stub.exiting.set(true);
        let (ours, _still_connected) = conn();
        a.begin(ours, 0).unwrap();
        assert!(matches!(next(&mut a, 0), Decision::Left));
        assert_eq!((a.refusals(), a.pending()), (0, 0));
        // a live peer whose check says no is refused
        stub.exiting.set(false);
        assert_eq!(decide(&mut a, 1), Err(Refusal { why: Refused::Signature, log: Some(1) }));
        assert_eq!(a.refusals(), 1);
    }

    #[test]
    fn r_hld_5_a_peer_that_hung_up_before_its_check_could_start_left() {
        // A killed client closes its end before the holder accepts it: its uid is still known, its audit
        // token is not (`LOCAL_PEERTOKEN` needs a live connection), so no check can start (C-KILL-14).
        let stub = Stub::new(501);
        let mut a = Admission::new(stub.clone(), 501);
        let (ours, theirs) = conn();
        theirs.shutdown(std::net::Shutdown::Both).unwrap(); // reads as hung up even if a forked child holds a copy
        drop(theirs);
        assert_eq!(a.begin(ours, 0), Ok(()));
        if a.pending() > 0 {
            // a child another test forked still held the peer's end, so the token was read: it leaves at its verdict
            assert!(matches!(next(&mut a, 0), Decision::Left));
        }
        assert_eq!((a.refusals(), a.pending()), (0, 0));

        // with every slot taken, a peer that already left is not refused as "busy" either
        stub.hold.set(true);
        let mut waiting = Vec::new();
        for _ in 0..SLOTS {
            let (ours, theirs) = conn();
            a.begin(ours, 1).unwrap();
            waiting.push(theirs);
        }
        let (ours, theirs) = conn();
        theirs.shutdown(std::net::Shutdown::Both).unwrap();
        drop(theirs);
        assert_eq!(a.begin(ours, 1), Ok(()));
        assert_eq!(a.refusals(), 0);
        // a connected peer that finds every slot taken still is
        let (ours, _theirs) = conn();
        assert_eq!(a.begin(ours, 1), Err(Refusal { why: Refused::Busy, log: Some(1) }));
        assert_eq!(a.refusals(), 1);
    }
}
