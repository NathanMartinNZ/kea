//! The output ring file: `mmap` `MAP_SHARED`, a header of `HEADER` bytes then `capacity` data bytes.
//!
//! Header: magic `"KEAR"` · `version:u16` · `reserved:u16` · `capacity:u64` · `earliestSeq:u64` ·
//! `latestSeq:u64` · zero padding. The byte with sequence number `s` lives at `HEADER + s % capacity`;
//! `earliestSeq = max(0, latestSeq − capacity)`. Data is written before the header is updated.
//! The file outlives the holder, so ptyhost can still rebuild the terminal's last screen from it
//! (app/ptyhost/src/checkpoint/cold.ts).

use std::fs::OpenOptions;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{Ordering, fence};

use crate::limits::RING_HEADER_BYTES;

pub const MAGIC: &[u8; 4] = b"KEAR";
pub const VERSION: u16 = 1;
pub const HEADER: usize = RING_HEADER_BYTES as usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub capacity: u64,
    pub earliest: u64,
    pub latest: u64,
}

pub fn encode_header(h: &Header) -> [u8; HEADER] {
    let mut b = [0; HEADER];
    b[0..4].copy_from_slice(MAGIC);
    b[4..6].copy_from_slice(&VERSION.to_le_bytes());
    b[8..16].copy_from_slice(&h.capacity.to_le_bytes());
    b[16..24].copy_from_slice(&h.earliest.to_le_bytes());
    b[24..32].copy_from_slice(&h.latest.to_le_bytes());
    b
}

/// `None` unless the bytes are a version-1 header.
pub fn decode_header(b: &[u8]) -> Option<Header> {
    if b.len() < HEADER || &b[0..4] != MAGIC || b[4..6] != VERSION.to_le_bytes() {
        return None;
    }
    let u = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap_or([0; 8]));
    Some(Header { capacity: u(8), earliest: u(16), latest: u(24) })
}

pub struct Ring {
    map: *mut u8,
    map_len: usize,
    cap: u64,
    latest: u64,
}

impl Ring {
    /// Creates (or truncates) the ring file, mode 0600, and maps it.
    pub fn create(path: &Path, capacity: u64) -> io::Result<Ring> {
        if capacity == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "ring capacity must be > 0"));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)?;
        let map_len = HEADER + capacity as usize;
        file.set_len(map_len as u64)?;
        let map = unsafe {
            libc::mmap(std::ptr::null_mut(), map_len, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, file.as_raw_fd(), 0)
        };
        if map == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        let mut ring = Ring { map: map.cast(), map_len, cap: capacity, latest: 0 };
        ring.write_header();
        Ok(ring)
    }

    pub fn capacity(&self) -> u64 {
        self.cap
    }
    pub fn latest(&self) -> u64 {
        self.latest
    }
    pub fn earliest(&self) -> u64 {
        self.latest.saturating_sub(self.cap)
    }

    fn data(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.map.add(HEADER), self.cap as usize) }
    }
    fn data_ref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.map.add(HEADER), self.cap as usize) }
    }

    /// The contiguous free slot at `latestSeq`, at most `max` bytes: a PTY read lands here directly.
    pub fn slot(&mut self, max: usize) -> &mut [u8] {
        let off = (self.latest % self.cap) as usize;
        let n = max.min(self.cap as usize - off);
        &mut self.data()[off..off + n]
    }

    /// Publishes `n` bytes written into [`Ring::slot`].
    pub fn commit(&mut self, n: usize) {
        self.latest += n as u64;
        self.write_header();
    }

    pub fn append(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let slot = self.slot(bytes.len());
            let n = slot.len();
            slot.copy_from_slice(&bytes[..n]);
            self.commit(n);
            bytes = &bytes[n..];
        }
    }

    /// Copies bytes starting at `from` (clamped into `[earliest, latest]`) into `dst`.
    /// Returns the seq of the first byte copied and how many were copied.
    pub fn read(&self, from: u64, dst: &mut [u8]) -> (u64, usize) {
        let start = from.clamp(self.earliest(), self.latest);
        let n = dst.len().min((self.latest - start) as usize);
        let data = self.data_ref();
        let off = (start % self.cap) as usize;
        let first = n.min(self.cap as usize - off);
        dst[..first].copy_from_slice(&data[off..off + first]);
        dst[first..n].copy_from_slice(&data[..n - first]);
        (start, n)
    }

    fn write_header(&mut self) {
        // Data first, then the header that makes it visible.
        fence(Ordering::Release);
        let h = encode_header(&Header { capacity: self.cap, earliest: self.earliest(), latest: self.latest });
        unsafe { std::ptr::copy_nonoverlapping(h.as_ptr(), self.map, HEADER) };
    }
}

impl Drop for Ring {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.map.cast(), self.map_len) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn header_on_disk(path: &Path) -> Header {
        decode_header(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn r_hld_1_append_wrap_and_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.ring");
        let mut r = Ring::create(&path, 8).unwrap();
        r.append(b"abcde");
        assert_eq!(header_on_disk(&path), Header { capacity: 8, earliest: 0, latest: 5 });
        r.append(b"fghijk");
        assert_eq!(header_on_disk(&path), Header { capacity: 8, earliest: 3, latest: 11 });
        let mut buf = [0; 16];
        assert_eq!(r.read(0, &mut buf), (3, 8), "a read before earliest clamps");
        assert_eq!(&buf[..8], b"defghijk");
        assert_eq!(r.read(9, &mut buf), (9, 2));
        assert_eq!(&buf[..2], b"jk");
        assert_eq!(r.read(99, &mut buf), (11, 0), "a read past latest is empty");
        let mut small = [0; 3];
        assert_eq!(r.read(6, &mut small), (6, 3));
        assert_eq!(&small, b"ghi");
        // Byte s lives at HEADER + s % capacity in the file.
        let file = std::fs::read(&path).unwrap();
        assert_eq!(file.len(), HEADER + 8);
        assert_eq!(file[HEADER + (10 % 8)], b'k');
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o777, 0o600);
    }

    #[test]
    fn r_hld_1_slot_is_contiguous_up_to_the_wrap() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Ring::create(&dir.path().join("r.ring"), 10).unwrap();
        r.append(b"1234567");
        assert_eq!(r.slot(100).len(), 3);
        r.slot(2).copy_from_slice(b"89");
        r.commit(2);
        assert_eq!(r.slot(100).len(), 1);
        let mut buf = [0; 10];
        assert_eq!(r.read(0, &mut buf), (0, 9));
        assert_eq!(&buf[..9], b"123456789");
    }

    proptest! {
        #[test]
        fn r_hld_1_matches_model(cap in 1u64..300, chunks in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..200), 0..40),
                                 reads in proptest::collection::vec((any::<u64>(), 0usize..400), 0..20)) {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("r.ring");
            let mut r = Ring::create(&path, cap).unwrap();
            let mut model: Vec<u8> = Vec::new();
            for c in &chunks {
                r.append(c);
                model.extend_from_slice(c);
                let h = header_on_disk(&path);
                let latest = model.len() as u64;
                prop_assert_eq!(h, Header { capacity: cap, earliest: latest.saturating_sub(cap), latest });
            }
            let latest = model.len() as u64;
            for (from, n) in &reads {
                let from = from % (latest + 2);
                let mut buf = vec![0; *n];
                let (start, got) = r.read(from, &mut buf);
                let want_start = from.clamp(latest.saturating_sub(cap), latest);
                prop_assert_eq!(start, want_start);
                let want = &model[start as usize..(start as usize + n).min(model.len())];
                prop_assert_eq!(&buf[..got], want);
            }
        }
    }
}
