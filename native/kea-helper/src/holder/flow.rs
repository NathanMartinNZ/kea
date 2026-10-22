//! Flow control and free-run as a pure state machine over seqs and milliseconds.
//!
//! - No attached client: always read the PTY (the ring overwrites its oldest bytes).
//! - Attached: stop reading when `latest − acked > HIGH`, resume below `LOW`, so unsent bytes are never
//!   overwritten (`HIGH + one read ≤ ring capacity`).
//! - Paused with no `ACK` for the stale timeout: free-run — read again, stop sending.
//! - The next `ACK` ends free-run; sending resumes at the next unsent seq, or `earliest` if overwritten.

use crate::limits::{HOLDER_FLOW_HIGH_BYTES, HOLDER_FLOW_LOW_BYTES};
use crate::proto::AttachMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Attached {
    /// Next seq to send.
    next: u64,
    /// The client has processed every byte below this.
    acked: u64,
    free_run: bool,
    /// Reading is paused at the high watermark.
    paused: bool,
    /// Time of the last `ACK`, or of the attach.
    last_ack_ms: u64,
    /// When the current pause began.
    paused_ms: u64,
}

#[derive(Clone, Debug)]
pub struct Flow {
    cap: u64,
    stale_ms: u64,
    latest: u64,
    client: Option<Attached>,
}

impl Flow {
    pub fn new(capacity: u64, stale_ms: u64) -> Self {
        Flow { cap: capacity, stale_ms, latest: 0, client: None }
    }

    pub fn latest(&self) -> u64 {
        self.latest
    }
    pub fn earliest(&self) -> u64 {
        self.latest.saturating_sub(self.cap)
    }
    pub fn attached(&self) -> bool {
        self.client.is_some()
    }
    pub fn free_run(&self) -> bool {
        self.client.is_some_and(|c| c.free_run)
    }
    pub fn paused(&self) -> bool {
        self.client.is_some_and(|c| c.paused && !c.free_run)
    }
    pub fn acked(&self) -> Option<u64> {
        self.client.map(|c| c.acked)
    }

    /// May the holder read the PTY now?
    pub fn can_read(&self) -> bool {
        !self.paused()
    }

    /// `ATTACH`: returns the seq streaming starts at (a seq before `earliest` is clamped).
    pub fn attach(&mut self, mode: AttachMode, seq: u64, now_ms: u64) -> u64 {
        let start = match mode {
            AttachMode::FromSeq => seq.clamp(self.earliest(), self.latest),
            AttachMode::Earliest => self.earliest(),
            AttachMode::Latest => self.latest,
        };
        self.client =
            Some(Attached { next: start, acked: start, free_run: false, paused: false, last_ack_ms: now_ms, paused_ms: now_ms });
        self.update(now_ms);
        start
    }

    pub fn detach(&mut self) {
        self.client = None;
    }

    /// `n` bytes were read from the PTY into the ring.
    pub fn on_read(&mut self, n: u64, now_ms: u64) {
        self.latest += n;
        self.update(now_ms);
    }

    /// `ACK{seq}`. Acks are clamped to what was sent and never move backwards; any ACK ends free-run.
    pub fn on_ack(&mut self, seq: u64, now_ms: u64) {
        let earliest = self.earliest();
        let Some(c) = self.client.as_mut() else { return };
        if c.free_run {
            c.free_run = false;
            c.paused = false;
            c.next = c.next.max(earliest);
        }
        c.acked = seq.clamp(c.acked, c.next.max(c.acked));
        c.last_ack_ms = now_ms;
        self.update(now_ms);
    }

    /// The range `[from, to)` to send next, if any. `from` is never below `earliest`.
    pub fn to_send(&self) -> Option<(u64, u64)> {
        let c = self.client?;
        if c.free_run || c.next >= self.latest {
            return None;
        }
        Some((c.next.max(self.earliest()), self.latest))
    }

    /// Bytes up to `upto` were framed for the client.
    pub fn on_sent(&mut self, upto: u64) {
        if let Some(c) = self.client.as_mut() {
            c.next = upto;
        }
    }

    /// Next instant [`Flow::tick`] has work: the stale-client deadline while paused.
    pub fn deadline(&self) -> Option<u64> {
        let c = self.client?;
        (c.paused && !c.free_run).then(|| c.last_ack_ms.max(c.paused_ms) + self.stale_ms)
    }

    /// Enters free-run when the paused client has been silent for the stale timeout.
    pub fn tick(&mut self, now_ms: u64) {
        if self.deadline().is_some_and(|d| now_ms >= d)
            && let Some(c) = self.client.as_mut()
        {
            c.free_run = true;
        }
    }

    fn update(&mut self, now_ms: u64) {
        let latest = self.latest;
        let Some(c) = self.client.as_mut() else { return };
        if c.free_run {
            return;
        }
        let window = latest - c.acked.min(latest);
        if c.paused && window < HOLDER_FLOW_LOW_BYTES {
            c.paused = false;
        } else if !c.paused && window > HOLDER_FLOW_HIGH_BYTES {
            c.paused = true;
            c.paused_ms = now_ms;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::{
        HOLDER_FLOW_HIGH_BYTES as HIGH, HOLDER_FLOW_LOW_BYTES as LOW, HOLDER_READ_BUFFER_BYTES as READ, HOLDER_STALE_CLIENT_MS as STALE,
        RING_BYTES_MIN as CAP,
    };

    /// Reads a full buffer and sends everything, as the holder loop does.
    fn pump(f: &mut Flow, now: u64) {
        f.on_read(READ, now);
        if let Some((_, to)) = f.to_send() {
            f.on_sent(to);
        }
    }

    #[test]
    fn r_hld_3_no_client_always_reads() {
        let mut f = Flow::new(CAP, STALE);
        for i in 0..100 {
            assert!(f.can_read());
            f.on_read(READ, i);
        }
        assert_eq!(f.earliest(), 100 * READ - CAP);
        assert_eq!(f.to_send(), None);
        assert_eq!(f.deadline(), None);
    }

    #[test]
    fn r_hld_3_pause_above_high_resume_below_low() {
        let mut f = Flow::new(CAP, STALE);
        assert_eq!(f.attach(AttachMode::Latest, 0, 0), 0);
        while f.can_read() {
            pump(&mut f, 10);
        }
        assert!(f.latest() > HIGH && f.latest() <= HIGH + READ, "paused just past the high watermark");
        assert!(f.latest() <= f.earliest() + CAP, "nothing unacked was overwritten");
        assert_eq!(f.deadline(), Some(10 + STALE));
        // Acks that leave the window at or above LOW keep it paused; below LOW resumes.
        f.on_ack(f.latest() - LOW, 20);
        assert!(f.paused());
        assert_eq!(f.deadline(), Some(20 + STALE), "an ACK restarts the stale timer");
        f.on_ack(f.latest() - LOW + 1, 30);
        assert!(f.can_read());
        assert_eq!(f.deadline(), None);
    }

    #[test]
    fn r_hld_3_stale_client_free_runs_then_resumes_at_next_unsent() {
        let mut f = Flow::new(CAP, STALE);
        f.attach(AttachMode::Latest, 0, 0);
        while f.can_read() {
            pump(&mut f, 100);
        }
        let sent = f.latest();
        f.tick(100 + STALE - 1);
        assert!(f.paused() && !f.free_run());
        f.tick(100 + STALE);
        assert!(f.free_run() && f.can_read());
        assert_eq!(f.to_send(), None, "free-run stops sending");
        // A little more output: still in the ring, so sending resumes exactly at the next unsent seq.
        const MORE: u64 = 1000;
        const ACKED: u64 = 500;
        f.on_read(MORE, 100 + STALE + 1);
        assert_eq!(f.deadline(), None);
        f.on_ack(ACKED, 100 + STALE + 2);
        assert!(!f.free_run());
        assert_eq!(f.to_send(), Some((sent, sent + MORE)));
        assert_eq!(f.acked(), Some(ACKED));
    }

    #[test]
    fn r_hld_3_free_run_past_the_ring_resumes_at_earliest() {
        let mut f = Flow::new(CAP, STALE);
        f.attach(AttachMode::Latest, 0, 0);
        while f.can_read() {
            pump(&mut f, 0);
        }
        let sent = f.latest();
        f.tick(STALE);
        for _ in 0..(3 * CAP / READ) {
            f.on_read(READ, STALE);
        }
        assert!(f.earliest() > sent);
        f.on_ack(sent, STALE + 1);
        let (from, to) = f.to_send().unwrap();
        assert_eq!((from, to), (f.earliest(), f.latest()), "the gap is visible: the next OUTPUT jumps");
        // The window is now over the watermark again, so reading pauses until the client catches up.
        assert!(f.paused());
        f.on_sent(to);
        f.on_ack(to, STALE + 2);
        assert!(f.can_read());
    }

    #[test]
    fn r_hld_3_attach_modes_and_ack_clamping() {
        let mut f = Flow::new(CAP, STALE);
        f.on_read(3 * CAP, 0);
        assert_eq!(f.attach(AttachMode::FromSeq, 5, 0), 2 * CAP, "a seq before earliest clamps");
        assert_eq!(f.attach(AttachMode::FromSeq, 10 * CAP, 0), 3 * CAP, "a future seq clamps to latest");
        assert_eq!(f.attach(AttachMode::FromSeq, 2 * CAP + 7, 0), 2 * CAP + 7);
        assert_eq!(f.attach(AttachMode::Earliest, 0, 0), 2 * CAP);
        assert_eq!(f.attach(AttachMode::Latest, 0, 0), 3 * CAP);
        f.on_read(100, 1);
        f.on_ack(u64::MAX, 2);
        assert_eq!(f.acked(), Some(3 * CAP), "cannot ack what was not sent");
        let (from, to) = f.to_send().unwrap();
        f.on_sent(to);
        f.on_ack(from + 50, 3);
        f.on_ack(from + 10, 4);
        assert_eq!(f.acked(), Some(from + 50), "acks never move backwards");
        f.detach();
        assert!(f.can_read() && f.to_send().is_none() && f.acked().is_none());
    }
}
