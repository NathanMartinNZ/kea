//! Holder wire protocol v1 (README "Wire protocol v1"), frozen once shipped.
//!
//! Frame = `type:u8 | len:u32le | payload`. Fixed little-endian structs; variable parts u16-length-prefixed.
//! Mirrored in `packages/protocol/src/holder.ts`; both test against `fixtures/protocol/holder-golden.json`.
//!
//! The holder side (client→holder decoding, holder→client encoding) never allocates and never panics
//! on input. The client side (`encode_client`, `FrameReader`, `decode_holder_frame`) is what tests use to drive a
//! holder, and allocates freely.

use crate::limits::{HOLDER_MAX_FRAME_BYTES, HOLDER_PROTOCOL_VERSION};

pub const HEADER_LEN: usize = 5;
pub const PROTO: u16 = HOLDER_PROTOCOL_VERSION as u16;
const MAX_LEN: u32 = HOLDER_MAX_FRAME_BYTES as u32;

/// Frame type codes.
pub mod ty {
    pub const HELLO: u8 = 0x01;
    pub const ATTACH: u8 = 0x02;
    pub const INPUT: u8 = 0x03;
    pub const RESIZE: u8 = 0x04;
    pub const ACK: u8 = 0x05;
    pub const SIGNAL: u8 = 0x06;
    pub const TERMINATE: u8 = 0x07;
    pub const STAT: u8 = 0x08;
    pub const DETACH: u8 = 0x09;
    pub const RELEASE: u8 = 0x0A;
    pub const H_HELLO: u8 = 0x81;
    pub const H_OUTPUT: u8 = 0x82;
    pub const H_EXIT: u8 = 0x83;
    pub const H_STAT: u8 = 0x84;
    pub const H_ERROR: u8 = 0x85;
}

/// `ERROR` codes.
pub mod code {
    pub const UNKNOWN_TYPE: u16 = 1;
    pub const BAD_LENGTH: u16 = 2;
    pub const BAD_PROTO: u16 = 3;
    pub const NOT_HELLO: u16 = 4;
    pub const INTERNAL: u16 = 5;
    pub const CHILD_ALIVE: u16 = 6;
    pub const NOT_ATTACHED: u16 = 7;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachMode {
    FromSeq = 0,
    Earliest = 1,
    Latest = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignalTarget {
    Child = 0,
    Foreground = 1,
    Session = 2,
}

/// A client→holder frame other than `INPUT` (whose payload is streamed, see [`Event::Input`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientFrame {
    Hello { proto: u16 },
    Attach { mode: AttachMode, seq: u64 },
    Resize { cols: u16, rows: u16, xpx: u16, ypx: u16 },
    Ack { seq: u64 },
    Signal { signo: u8, target: SignalTarget },
    Terminate { grace_ms: u32 },
    Stat,
    Detach,
    Release,
}

/// What the holder-side decoder yields.
#[derive(Debug, PartialEq, Eq)]
pub enum Event<'a> {
    Frame(ClientFrame),
    /// A chunk of an `INPUT` payload. An empty `INPUT` frame yields exactly one empty chunk.
    Input(&'a [u8]),
    /// A frame type this holder does not know; its payload is skipped. Answered with `ERROR{1}`, and the
    /// connection stays open, so new frame types can be added.
    Unknown(u8),
}

/// Malformed input: the holder answers `ERROR{2}` and closes that connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// `len` above `HOLDER_MAX_FRAME_BYTES`.
    TooLong { ty: u8, len: u32 },
    /// A fixed payload of the wrong size.
    BadLength { ty: u8, len: u32 },
    /// A fixed payload with an out-of-range enum (attach mode, signal target).
    BadValue { ty: u8 },
}

/// Payload size of each fixed client frame; `None` for `INPUT` and unknown types.
fn fixed_len(t: u8) -> Option<usize> {
    match t {
        ty::HELLO | ty::SIGNAL => Some(2),
        ty::ATTACH => Some(9),
        ty::RESIZE | ty::ACK => Some(8),
        ty::TERMINATE => Some(4),
        ty::STAT | ty::DETACH | ty::RELEASE => Some(0),
        _ => None,
    }
}

const FIXED_MAX: usize = 9;

#[derive(Clone, Copy, Debug)]
enum State {
    Header,
    Fixed { ty: u8, len: usize },
    Input { remaining: usize },
    Skip { remaining: usize },
}

/// Incremental client→holder frame decoder: any split or merge of the byte stream decodes the same.
#[derive(Debug)]
pub struct Decoder {
    state: State,
    hdr: [u8; HEADER_LEN],
    hdr_got: usize,
    fixed: [u8; FIXED_MAX],
    fixed_got: usize,
    failed: Option<DecodeError>,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub const fn new() -> Self {
        Decoder { state: State::Header, hdr: [0; HEADER_LEN], hdr_got: 0, fixed: [0; FIXED_MAX], fixed_got: 0, failed: None }
    }

    /// Is the decoder between frames (no partial frame buffered)?
    pub fn at_boundary(&self) -> bool {
        matches!(self.state, State::Header) && self.hdr_got == 0
    }

    /// Decodes at most one event from the front of `buf`; returns the bytes consumed and the event.
    /// `INPUT` payload is handed out in chunks of at most `input_room` bytes; with no room it waits.
    /// After an error the decoder stays failed and returns that error again.
    pub fn next<'a>(&mut self, buf: &'a [u8], input_room: usize) -> (usize, Option<Result<Event<'a>, DecodeError>>) {
        if let Some(e) = self.failed {
            return (0, Some(Err(e)));
        }
        let mut used = 0;
        loop {
            match self.state {
                State::Header => {
                    let n = (HEADER_LEN - self.hdr_got).min(buf.len() - used);
                    self.hdr[self.hdr_got..self.hdr_got + n].copy_from_slice(&buf[used..used + n]);
                    self.hdr_got += n;
                    used += n;
                    if self.hdr_got < HEADER_LEN {
                        return (used, None);
                    }
                    self.hdr_got = 0;
                    let t = self.hdr[0];
                    let len = u32::from_le_bytes([self.hdr[1], self.hdr[2], self.hdr[3], self.hdr[4]]);
                    if len > MAX_LEN {
                        return (used, Some(Err(self.fail(DecodeError::TooLong { ty: t, len }))));
                    }
                    match fixed_len(t) {
                        Some(want) if want != len as usize => {
                            return (used, Some(Err(self.fail(DecodeError::BadLength { ty: t, len }))));
                        }
                        Some(0) => return (used, Some(parse_fixed(t, &[]).map(Event::Frame).map_err(|e| self.fail(e)))),
                        Some(_) => {
                            self.fixed_got = 0;
                            self.state = State::Fixed { ty: t, len: len as usize };
                        }
                        None if t == ty::INPUT => {
                            if len == 0 {
                                return (used, Some(Ok(Event::Input(&[]))));
                            }
                            self.state = State::Input { remaining: len as usize };
                        }
                        None => {
                            if len > 0 {
                                self.state = State::Skip { remaining: len as usize };
                            }
                            return (used, Some(Ok(Event::Unknown(t))));
                        }
                    }
                }
                State::Fixed { ty: t, len } => {
                    let n = (len - self.fixed_got).min(buf.len() - used);
                    self.fixed[self.fixed_got..self.fixed_got + n].copy_from_slice(&buf[used..used + n]);
                    self.fixed_got += n;
                    used += n;
                    if self.fixed_got < len {
                        return (used, None);
                    }
                    self.state = State::Header;
                    let fixed = self.fixed;
                    let r = parse_fixed(t, &fixed[..len]).map(Event::Frame).map_err(|e| self.fail(e));
                    return (used, Some(r));
                }
                State::Input { remaining } => {
                    let n = remaining.min(buf.len() - used).min(input_room);
                    if n == 0 {
                        return (used, None);
                    }
                    let chunk = &buf[used..used + n];
                    used += n;
                    self.state = if remaining == n { State::Header } else { State::Input { remaining: remaining - n } };
                    return (used, Some(Ok(Event::Input(chunk))));
                }
                State::Skip { remaining } => {
                    let n = remaining.min(buf.len() - used);
                    used += n;
                    if remaining == n {
                        self.state = State::Header;
                    } else {
                        self.state = State::Skip { remaining: remaining - n };
                        return (used, None);
                    }
                }
            }
        }
    }

    fn fail(&mut self, e: DecodeError) -> DecodeError {
        self.failed = Some(e);
        e
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    let mut a = [0; 8];
    a.copy_from_slice(&b[i..i + 8]);
    u64::from_le_bytes(a)
}

/// `p` has exactly `fixed_len(t)` bytes.
fn parse_fixed(t: u8, p: &[u8]) -> Result<ClientFrame, DecodeError> {
    Ok(match t {
        ty::HELLO => ClientFrame::Hello { proto: u16_at(p, 0) },
        ty::ATTACH => {
            let mode = match p[0] {
                0 => AttachMode::FromSeq,
                1 => AttachMode::Earliest,
                2 => AttachMode::Latest,
                _ => return Err(DecodeError::BadValue { ty: t }),
            };
            ClientFrame::Attach { mode, seq: u64_at(p, 1) }
        }
        ty::RESIZE => ClientFrame::Resize { cols: u16_at(p, 0), rows: u16_at(p, 2), xpx: u16_at(p, 4), ypx: u16_at(p, 6) },
        ty::ACK => ClientFrame::Ack { seq: u64_at(p, 0) },
        ty::SIGNAL => {
            let target = match p[1] {
                0 => SignalTarget::Child,
                1 => SignalTarget::Foreground,
                2 => SignalTarget::Session,
                _ => return Err(DecodeError::BadValue { ty: t }),
            };
            ClientFrame::Signal { signo: p[0], target }
        }
        ty::TERMINATE => ClientFrame::Terminate { grace_ms: u32_at(p, 0) },
        ty::STAT => ClientFrame::Stat,
        ty::DETACH => ClientFrame::Detach,
        _ => ClientFrame::Release,
    })
}

// ── holder → client encoders (no allocation) ────────────────────────────────

/// Bytes before the data of an `OUTPUT` frame: header + `seq:u64`.
pub const OUTPUT_HEADER_LEN: usize = HEADER_LEN + 8;
pub const EXIT_LEN: usize = HEADER_LEN + 5;

/// Sequential little-endian writer over a buffer the caller sized with the matching `*_len` function.
struct Cursor<'a> {
    b: &'a mut [u8],
    p: usize,
}

impl Cursor<'_> {
    fn bytes(&mut self, v: &[u8]) {
        self.b[self.p..self.p + v.len()].copy_from_slice(v);
        self.p += v.len();
    }
    fn u8(&mut self, v: u8) {
        self.bytes(&[v]);
    }
    fn u16(&mut self, v: u16) {
        self.bytes(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.bytes(&v.to_le_bytes());
    }
    /// u16-length-prefixed bytes (callers clamp with [`str16`]).
    fn str16(&mut self, v: &[u8]) {
        self.u16(v.len() as u16);
        self.bytes(v);
    }
    fn header(&mut self, t: u8, total: usize) {
        self.u8(t);
        self.u32((total - HEADER_LEN) as u32);
    }
}

/// A variable part clamped to what a u16 length can carry.
pub fn str16(v: &[u8]) -> &[u8] {
    &v[..v.len().min(u16::MAX as usize)]
}

pub fn output_header(seq: u64, data_len: usize) -> [u8; OUTPUT_HEADER_LEN] {
    let mut h = [0; OUTPUT_HEADER_LEN];
    let mut c = Cursor { b: &mut h, p: 0 };
    c.header(ty::H_OUTPUT, OUTPUT_HEADER_LEN + data_len);
    c.u64(seq);
    h
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HelloInfo<'a> {
    pub proto: u16,
    pub child_pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub earliest: u64,
    pub latest: u64,
    pub exited: bool,
    pub code: i32,
    pub signal: u8,
    pub pty_id: &'a [u8],
}

pub fn hello_len(h: &HelloInfo) -> usize {
    HEADER_LEN + 2 + 4 + 2 + 2 + 8 + 8 + 1 + 4 + 1 + 2 + str16(h.pty_id).len()
}

pub fn encode_hello(dst: &mut [u8], h: &HelloInfo) -> usize {
    let total = hello_len(h);
    let mut c = Cursor { b: &mut dst[..total], p: 0 };
    c.header(ty::H_HELLO, total);
    c.u16(h.proto);
    c.u32(h.child_pid);
    c.u16(h.cols);
    c.u16(h.rows);
    c.u64(h.earliest);
    c.u64(h.latest);
    c.u8(h.exited as u8);
    c.u32(h.code as u32);
    c.u8(h.signal);
    c.str16(str16(h.pty_id));
    total
}

pub fn encode_exit(dst: &mut [u8], code: i32, signal: u8) -> usize {
    let mut c = Cursor { b: &mut dst[..EXIT_LEN], p: 0 };
    c.header(ty::H_EXIT, EXIT_LEN);
    c.u32(code as u32);
    c.u8(signal);
    EXIT_LEN
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatInfo<'a> {
    pub child_pid: u32,
    pub fg_pid: u32,
    pub fg_name: &'a [u8],
    pub cwd: &'a [u8],
    pub pids: &'a [u32],
}

fn stat_pids<'a>(s: &StatInfo<'a>) -> &'a [u32] {
    &s.pids[..s.pids.len().min(u16::MAX as usize)]
}

pub fn stat_len(s: &StatInfo) -> usize {
    HEADER_LEN + 4 + 4 + 2 + str16(s.fg_name).len() + 2 + str16(s.cwd).len() + 2 + 4 * stat_pids(s).len()
}

pub fn encode_stat(dst: &mut [u8], s: &StatInfo) -> usize {
    let total = stat_len(s);
    let mut c = Cursor { b: &mut dst[..total], p: 0 };
    c.header(ty::H_STAT, total);
    c.u32(s.child_pid);
    c.u32(s.fg_pid);
    c.str16(str16(s.fg_name));
    c.str16(str16(s.cwd));
    let pids = stat_pids(s);
    c.u16(pids.len() as u16);
    for &p in pids {
        c.u32(p);
    }
    total
}

pub fn error_len(message: &[u8]) -> usize {
    HEADER_LEN + 2 + 2 + str16(message).len()
}

pub fn encode_error(dst: &mut [u8], code: u16, message: &[u8]) -> usize {
    let total = error_len(message);
    let mut c = Cursor { b: &mut dst[..total], p: 0 };
    c.header(ty::H_ERROR, total);
    c.u16(code);
    c.str16(str16(message));
    total
}

// ── client side: what ptyhost (and the tests) speak ──────────────────────────

pub fn encode_client(f: &ClientFrame) -> Vec<u8> {
    let mut p = Vec::with_capacity(FIXED_MAX);
    let t = match *f {
        ClientFrame::Hello { proto } => {
            p.extend(proto.to_le_bytes());
            ty::HELLO
        }
        ClientFrame::Attach { mode, seq } => {
            p.push(mode as u8);
            p.extend(seq.to_le_bytes());
            ty::ATTACH
        }
        ClientFrame::Resize { cols, rows, xpx, ypx } => {
            for v in [cols, rows, xpx, ypx] {
                p.extend(v.to_le_bytes());
            }
            ty::RESIZE
        }
        ClientFrame::Ack { seq } => {
            p.extend(seq.to_le_bytes());
            ty::ACK
        }
        ClientFrame::Signal { signo, target } => {
            p.extend([signo, target as u8]);
            ty::SIGNAL
        }
        ClientFrame::Terminate { grace_ms } => {
            p.extend(grace_ms.to_le_bytes());
            ty::TERMINATE
        }
        ClientFrame::Stat => ty::STAT,
        ClientFrame::Detach => ty::DETACH,
        ClientFrame::Release => ty::RELEASE,
    };
    raw_frame(t, &p)
}

pub fn encode_input(data: &[u8]) -> Vec<u8> {
    raw_frame(ty::INPUT, data)
}

/// Any frame, byte for byte (tests use it for unknown and malformed frames).
pub fn raw_frame(t: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(HEADER_LEN + payload.len());
    v.push(t);
    v.extend((payload.len() as u32).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub proto: u16,
    pub child_pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub earliest: u64,
    pub latest: u64,
    pub exited: bool,
    pub code: i32,
    pub signal: u8,
    pub pty_id: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stat {
    pub child_pid: u32,
    pub fg_pid: u32,
    pub fg_name: Vec<u8>,
    pub cwd: Vec<u8>,
    pub pids: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HolderFrame {
    Hello(Hello),
    Output { seq: u64, data: Vec<u8> },
    Exit { code: i32, signal: u8 },
    Stat(Stat),
    Error { code: u16, message: Vec<u8> },
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self.b.get(self.p..self.p + n).ok_or_else(|| format!("payload too short at {}", self.p))?;
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16_at(self.take(2)?, 0))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32_at(self.take(4)?, 0))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64_at(self.take(8)?, 0))
    }
    fn str16(&mut self) -> Result<Vec<u8>, String> {
        let n = self.u16()? as usize;
        Ok(self.take(n)?.to_vec())
    }
    fn end(&self) -> Result<(), String> {
        if self.p == self.b.len() { Ok(()) } else { Err(format!("{} trailing bytes", self.b.len() - self.p)) }
    }
}

pub fn decode_holder_frame(t: u8, payload: &[u8]) -> Result<HolderFrame, String> {
    let mut r = Reader { b: payload, p: 0 };
    let f = match t {
        ty::H_HELLO => HolderFrame::Hello(Hello {
            proto: r.u16()?,
            child_pid: r.u32()?,
            cols: r.u16()?,
            rows: r.u16()?,
            earliest: r.u64()?,
            latest: r.u64()?,
            exited: r.u8()? != 0,
            code: r.u32()? as i32,
            signal: r.u8()?,
            pty_id: r.str16()?,
        }),
        ty::H_OUTPUT => {
            let seq = r.u64()?;
            let data = r.take(payload.len() - 8)?.to_vec();
            HolderFrame::Output { seq, data }
        }
        ty::H_EXIT => HolderFrame::Exit { code: r.u32()? as i32, signal: r.u8()? },
        ty::H_STAT => {
            let (child_pid, fg_pid, fg_name, cwd) = (r.u32()?, r.u32()?, r.str16()?, r.str16()?);
            let n = r.u16()? as usize;
            let pids = (0..n).map(|_| r.u32()).collect::<Result<_, _>>()?;
            HolderFrame::Stat(Stat { child_pid, fg_pid, fg_name, cwd, pids })
        }
        ty::H_ERROR => HolderFrame::Error { code: r.u16()?, message: r.str16()? },
        _ => return Err(format!("unknown holder frame type 0x{t:02x}")),
    };
    r.end()?;
    Ok(f)
}

/// Encodes a holder frame through the holder's own (allocation-free) encoders.
pub fn encode_holder_frame(f: &HolderFrame) -> Vec<u8> {
    match f {
        HolderFrame::Hello(h) => {
            let info = HelloInfo {
                proto: h.proto,
                child_pid: h.child_pid,
                cols: h.cols,
                rows: h.rows,
                earliest: h.earliest,
                latest: h.latest,
                exited: h.exited,
                code: h.code,
                signal: h.signal,
                pty_id: &h.pty_id,
            };
            let mut v = vec![0; hello_len(&info)];
            encode_hello(&mut v, &info);
            v
        }
        HolderFrame::Output { seq, data } => {
            let mut v = output_header(*seq, data.len()).to_vec();
            v.extend_from_slice(data);
            v
        }
        HolderFrame::Exit { code, signal } => {
            let mut v = vec![0; EXIT_LEN];
            encode_exit(&mut v, *code, *signal);
            v
        }
        HolderFrame::Stat(s) => {
            let info = StatInfo { child_pid: s.child_pid, fg_pid: s.fg_pid, fg_name: &s.fg_name, cwd: &s.cwd, pids: &s.pids };
            let mut v = vec![0; stat_len(&info)];
            encode_stat(&mut v, &info);
            v
        }
        HolderFrame::Error { code, message } => {
            let mut v = vec![0; error_len(message)];
            encode_error(&mut v, *code, message);
            v
        }
    }
}

/// Splits a holder→client byte stream into frames (client side).
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete frame, if buffered.
    pub fn next_frame(&mut self) -> Option<Result<HolderFrame, String>> {
        if self.buf.len() < HEADER_LEN {
            return None;
        }
        let len = u32_at(&self.buf, 1) as usize;
        if self.buf.len() < HEADER_LEN + len {
            return None;
        }
        let r = decode_holder_frame(self.buf[0], &self.buf[HEADER_LEN..HEADER_LEN + len]);
        self.buf.drain(..HEADER_LEN + len);
        Some(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Feeds `bytes` to a decoder in the given chunk sizes; collects events as owned values.
    fn decode_all(bytes: &[u8], chunks: &[usize], input_room: usize) -> Vec<Result<Owned, DecodeError>> {
        let mut d = Decoder::new();
        let mut out = Vec::new();
        let mut pos = 0;
        let mut ci = 0;
        while pos < bytes.len() {
            let step = chunks.get(ci).copied().unwrap_or(bytes.len()).max(1);
            ci += 1;
            let end = (pos + step).min(bytes.len());
            let mut buf = &bytes[pos..end];
            loop {
                let (used, ev) = d.next(buf, input_room);
                buf = &buf[used..];
                match ev {
                    None => break,
                    Some(Err(e)) => {
                        out.push(Err(e));
                        return merge_inputs(out);
                    }
                    Some(Ok(e)) => out.push(Ok(Owned::from(e))),
                }
            }
            assert!(buf.is_empty(), "decoder left bytes with room available");
            pos = end;
        }
        merge_inputs(out)
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Owned {
        Frame(ClientFrame),
        Input(Vec<u8>),
        Unknown(u8),
    }

    impl From<Event<'_>> for Owned {
        fn from(e: Event<'_>) -> Self {
            match e {
                Event::Frame(f) => Owned::Frame(f),
                Event::Input(b) => Owned::Input(b.to_vec()),
                Event::Unknown(t) => Owned::Unknown(t),
            }
        }
    }

    /// Chunked INPUT payloads are joined so different splits compare equal. Consecutive INPUT frames
    /// merge too, which is fine for comparison purposes.
    fn merge_inputs(v: Vec<Result<Owned, DecodeError>>) -> Vec<Result<Owned, DecodeError>> {
        let mut out: Vec<Result<Owned, DecodeError>> = Vec::new();
        for e in v {
            if let (Some(Ok(Owned::Input(prev))), Ok(Owned::Input(b))) = (out.last_mut(), &e) {
                prev.extend_from_slice(b);
                continue;
            }
            out.push(e);
        }
        out
    }

    fn arb_frame() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            any::<u16>().prop_map(|proto| encode_client(&ClientFrame::Hello { proto })),
            (0u8..3, any::<u64>()).prop_map(|(m, seq)| {
                let mode = [AttachMode::FromSeq, AttachMode::Earliest, AttachMode::Latest][m as usize];
                encode_client(&ClientFrame::Attach { mode, seq })
            }),
            proptest::collection::vec(any::<u8>(), 0..300).prop_map(|b| encode_input(&b)),
            (any::<u16>(), any::<u16>(), any::<u16>(), any::<u16>())
                .prop_map(|(cols, rows, xpx, ypx)| encode_client(&ClientFrame::Resize { cols, rows, xpx, ypx })),
            any::<u64>().prop_map(|seq| encode_client(&ClientFrame::Ack { seq })),
            (any::<u8>(), 0u8..3).prop_map(|(signo, t)| {
                let target = [SignalTarget::Child, SignalTarget::Foreground, SignalTarget::Session][t as usize];
                encode_client(&ClientFrame::Signal { signo, target })
            }),
            any::<u32>().prop_map(|grace_ms| encode_client(&ClientFrame::Terminate { grace_ms })),
            Just(encode_client(&ClientFrame::Stat)),
            Just(encode_client(&ClientFrame::Detach)),
            Just(encode_client(&ClientFrame::Release)),
            (0x0bu8..=0xff, proptest::collection::vec(any::<u8>(), 0..40)).prop_map(|(t, b)| raw_frame(t, &b)),
        ]
    }

    #[test]
    fn r_hld_2_partial_reads_decode_identically() {
        let mut stream = Vec::new();
        stream.extend(encode_client(&ClientFrame::Hello { proto: 1 }));
        stream.extend(encode_input(b"hello world"));
        stream.extend(encode_client(&ClientFrame::Ack { seq: 77 }));
        stream.extend(encode_input(b""));
        stream.extend(raw_frame(0x7f, b"xyz"));
        stream.extend(encode_client(&ClientFrame::Stat));
        let whole = decode_all(&stream, &[], usize::MAX);
        assert_eq!(
            whole,
            vec![
                Ok(Owned::Frame(ClientFrame::Hello { proto: 1 })),
                Ok(Owned::Input(b"hello world".to_vec())),
                Ok(Owned::Frame(ClientFrame::Ack { seq: 77 })),
                Ok(Owned::Input(vec![])),
                Ok(Owned::Unknown(0x7f)),
                Ok(Owned::Frame(ClientFrame::Stat)),
            ]
        );
        let ones = vec![1; stream.len()];
        assert_eq!(decode_all(&stream, &ones, usize::MAX), whole);
        assert_eq!(decode_all(&stream, &ones, 1), whole);
    }

    #[test]
    fn r_hld_2_max_length_and_bad_frames_fail_closed() {
        // Exactly at the cap is accepted (streamed), one above fails before any payload is read.
        let mut at = vec![ty::INPUT];
        at.extend(MAX_LEN.to_le_bytes());
        let mut d = Decoder::new();
        assert_eq!(d.next(&at, 0), (5, None));
        let mut over = vec![ty::INPUT];
        over.extend((MAX_LEN + 1).to_le_bytes());
        let mut d = Decoder::new();
        assert_eq!(d.next(&over, usize::MAX), (5, Some(Err(DecodeError::TooLong { ty: ty::INPUT, len: MAX_LEN + 1 }))));
        // Failed decoders stay failed.
        assert_eq!(d.next(b"anything", usize::MAX).1, Some(Err(DecodeError::TooLong { ty: ty::INPUT, len: MAX_LEN + 1 })));
        // An unknown type over the cap is also fatal.
        let mut big_unknown = vec![0x55];
        big_unknown.extend(u32::MAX.to_le_bytes());
        assert!(matches!(Decoder::new().next(&big_unknown, 0).1, Some(Err(DecodeError::TooLong { .. }))));
        // Wrong fixed sizes and enum values.
        assert_eq!(
            decode_all(&raw_frame(ty::ACK, &[1, 2, 3]), &[], usize::MAX),
            vec![Err(DecodeError::BadLength { ty: ty::ACK, len: 3 })]
        );
        assert_eq!(
            decode_all(&raw_frame(ty::STAT, &[0]), &[], usize::MAX),
            vec![Err(DecodeError::BadLength { ty: ty::STAT, len: 1 })]
        );
        assert_eq!(
            decode_all(&raw_frame(ty::ATTACH, &[3, 0, 0, 0, 0, 0, 0, 0, 0]), &[], usize::MAX),
            vec![Err(DecodeError::BadValue { ty: ty::ATTACH })]
        );
        assert_eq!(decode_all(&raw_frame(ty::SIGNAL, &[2, 9]), &[], usize::MAX), vec![Err(DecodeError::BadValue { ty: ty::SIGNAL })]);
        // Holder→client types sent by a client are simply unknown here.
        assert_eq!(decode_all(&raw_frame(ty::H_OUTPUT, &[1, 2]), &[], usize::MAX), vec![Ok(Owned::Unknown(ty::H_OUTPUT))]);
    }

    #[test]
    fn r_hld_2_input_waits_for_room() {
        let f = encode_input(b"abcdef");
        let mut d = Decoder::new();
        assert_eq!(d.next(&f, 0), (5, None));
        assert_eq!(d.next(&f[5..], 0), (0, None));
        assert_eq!(d.next(&f[5..], 4), (4, Some(Ok(Event::Input(b"abcd")))));
        assert_eq!(d.next(&f[9..], 4), (2, Some(Ok(Event::Input(b"ef")))));
        assert!(d.at_boundary());
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

        // C-FUZZ-1, random frames: any split of the stream (truncated headers and payloads included)
        // decodes exactly like the whole stream.
        #[test]
        fn c_fuzz_1_any_split_decodes_the_same(frames in proptest::collection::vec(arb_frame(), 0..12),
                                              chunks in proptest::collection::vec(1usize..40, 0..60),
                                              room in 1usize..64) {
            let stream: Vec<u8> = frames.concat();
            let whole = decode_all(&stream, &[], usize::MAX);
            prop_assert_eq!(decode_all(&stream, &chunks, room), whole.clone());
            prop_assert!(whole.iter().all(|e| e.is_ok()));
        }

        // C-FUZZ-1, mutated frames and junk: no panic, no hang, and an error is final.
        #[test]
        fn c_fuzz_1_random_and_mutated_bytes_never_panic(frames in proptest::collection::vec(arb_frame(), 0..8),
                                                        flips in proptest::collection::vec((any::<usize>(), any::<u8>()), 0..8),
                                                        junk in proptest::collection::vec(any::<u8>(), 0..200),
                                                        cut in any::<usize>(),
                                                        chunks in proptest::collection::vec(1usize..32, 0..40)) {
            let mut stream: Vec<u8> = frames.concat();
            for (i, v) in flips {
                if !stream.is_empty() {
                    let n = stream.len();
                    stream[i % n] ^= v;
                }
            }
            stream.extend(junk);
            stream.truncate(cut % (stream.len() + 1));
            // No panic, no hang, and errors are terminal.
            let events = decode_all(&stream, &chunks, 7);
            if let Some(i) = events.iter().position(|e| e.is_err()) {
                prop_assert_eq!(i, events.len() - 1);
            }
        }

        #[test]
        fn r_hld_2_holder_frames_round_trip(seq in any::<u64>(), data in proptest::collection::vec(any::<u8>(), 0..100),
                                            name in proptest::collection::vec(any::<u8>(), 0..40),
                                            pids in proptest::collection::vec(any::<u32>(), 0..20),
                                            code in any::<i32>(), signal in any::<u8>()) {
            let frames = [
                HolderFrame::Output { seq, data: data.clone() },
                HolderFrame::Exit { code, signal },
                HolderFrame::Error { code: code as u16, message: name.clone() },
                HolderFrame::Stat(Stat { child_pid: code as u32, fg_pid: seq as u32, fg_name: name.clone(), cwd: data.clone(), pids }),
                HolderFrame::Hello(Hello { proto: 1, child_pid: 9, cols: 80, rows: 24, earliest: seq / 2, latest: seq,
                    exited: signal % 2 == 0, code, signal, pty_id: name }),
            ];
            let mut r = FrameReader::default();
            for f in &frames {
                for b in encode_holder_frame(f) {
                    r.push(&[b]);
                }
            }
            for f in &frames {
                prop_assert_eq!(r.next_frame(), Some(Ok(f.clone())));
            }
            prop_assert_eq!(r.next_frame(), None);
        }
    }
}
