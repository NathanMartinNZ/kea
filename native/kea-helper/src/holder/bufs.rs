//! The holder's fixed buffers: allocated once, never grown.
//!
//! They live in anonymous mappings rather than on the heap: `calloc` would zero (and so dirty) every
//! page up front, while mapped pages are zero-filled on first touch, so an idle holder's footprint
//! only counts the pages it has actually used.

use std::ops::{Deref, DerefMut};

/// `len` zeroed bytes in a private anonymous mapping.
pub struct Pages {
    ptr: *mut u8,
    len: usize,
}

impl Pages {
    pub fn new(len: usize) -> Self {
        assert!(len > 0);
        let p = unsafe {
            libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_PRIVATE | libc::MAP_ANON, -1, 0)
        };
        assert!(p != libc::MAP_FAILED, "mmap {len} bytes: {}", std::io::Error::last_os_error());
        Pages { ptr: p.cast(), len }
    }
}

impl Deref for Pages {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl DerefMut for Pages {
    fn deref_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}

impl Drop for Pages {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.ptr.cast(), self.len) };
    }
}

/// Pending input for the PTY: a byte ring of fixed capacity.
pub struct InputQueue {
    buf: Pages,
    head: usize,
    len: usize,
}

impl InputQueue {
    pub fn new(cap: usize) -> Self {
        InputQueue { buf: Pages::new(cap), head: 0, len: 0 }
    }
    #[allow(dead_code)] // tests
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn free(&self) -> usize {
        self.buf.len() - self.len
    }

    /// Appends as much of `data` as fits; returns how much was taken.
    pub fn push(&mut self, data: &[u8]) -> usize {
        let cap = self.buf.len();
        let n = data.len().min(self.free());
        let tail = (self.head + self.len) % cap.max(1);
        let first = n.min(cap - tail);
        self.buf[tail..tail + first].copy_from_slice(&data[..first]);
        self.buf[..n - first].copy_from_slice(&data[first..n]);
        self.len += n;
        n
    }

    /// The contiguous bytes at the front.
    pub fn front(&self) -> &[u8] {
        let n = self.len.min(self.buf.len() - self.head);
        &self.buf[self.head..self.head + n]
    }

    pub fn consume(&mut self, n: usize) {
        let n = n.min(self.len);
        self.head = (self.head + n) % self.buf.len().max(1);
        self.len -= n;
        if self.len == 0 {
            self.head = 0;
        }
    }

    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }
}

/// A fixed byte buffer with a consumed prefix: socket input (`[start, end)` unparsed) and frames out
/// (`[start, end)` unsent).
pub struct ByteBuf {
    buf: Pages,
    start: usize,
    end: usize,
}

impl ByteBuf {
    pub fn new(cap: usize) -> Self {
        ByteBuf { buf: Pages::new(cap), start: 0, end: 0 }
    }
    pub fn data(&self) -> &[u8] {
        &self.buf[self.start..self.end]
    }
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
    pub fn consume(&mut self, n: usize) {
        self.start = (self.start + n).min(self.end);
        if self.start == self.end {
            self.start = 0;
            self.end = 0;
        }
    }
    pub fn clear(&mut self) {
        self.start = 0;
        self.end = 0;
    }
    /// Free bytes once the consumed prefix is reclaimed.
    pub fn free(&self) -> usize {
        self.buf.len() - (self.end - self.start)
    }

    /// `n` writable bytes at the end (compacting first if needed), or `None` if they do not fit.
    /// Call [`ByteBuf::commit`] with how many were written.
    pub fn space(&mut self, n: usize) -> Option<&mut [u8]> {
        if self.free() < n {
            return None;
        }
        if self.buf.len() - self.end < n {
            self.buf.copy_within(self.start..self.end, 0);
            self.end -= self.start;
            self.start = 0;
        }
        Some(&mut self.buf[self.end..self.end + n])
    }

    /// All the writable bytes at the end (compacting first).
    pub fn spare(&mut self) -> &mut [u8] {
        if self.start > 0 {
            self.buf.copy_within(self.start..self.end, 0);
            self.end -= self.start;
            self.start = 0;
        }
        &mut self.buf[self.end..]
    }

    pub fn commit(&mut self, n: usize) {
        self.end = (self.end + n).min(self.buf.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::HOLDER_INPUT_CAP_BYTES;

    #[test]
    fn r_hld_6_input_queue_caps_and_drains_in_order() {
        let cap = HOLDER_INPUT_CAP_BYTES as usize;
        let mut q = InputQueue::new(cap);
        let data: Vec<u8> = (0..cap + 1000).map(|i| (i * 7 % 251) as u8).collect();
        assert_eq!(q.push(&data), cap, "stops exactly at the cap");
        assert_eq!((q.free(), q.push(b"more")), (0, 0));
        let mut out = Vec::new();
        // Drain in odd partial writes, refilling as space appears.
        let mut fed = cap;
        while !q.is_empty() {
            let n = q.front().len().min(4093);
            out.extend_from_slice(&q.front()[..n]);
            q.consume(n);
            fed += q.push(&data[fed..]);
        }
        assert_eq!(out, data);
    }

    #[test]
    fn r_hld_6_bytebuf_compacts_without_growing() {
        let mut b = ByteBuf::new(10);
        b.space(8).unwrap().copy_from_slice(b"abcdefgh");
        b.commit(8);
        b.consume(6);
        assert_eq!(b.data(), b"gh");
        assert!(b.space(9).is_none());
        b.space(8).unwrap().copy_from_slice(b"12345678");
        b.commit(8);
        assert_eq!(b.data(), b"gh12345678");
        assert_eq!(b.spare().len(), 0);
        b.consume(10);
        assert_eq!((b.is_empty(), b.spare().len()), (true, 10));
    }
}
