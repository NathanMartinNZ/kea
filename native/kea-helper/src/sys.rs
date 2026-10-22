//! Thin libc helpers shared by the subcommands.

use std::ffi::{CString, OsStr};
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;

pub fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r == -1 { Err(io::Error::last_os_error()) } else { Ok(r) }
}

pub fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

pub fn set_nonblock(fd: RawFd) -> io::Result<()> {
    let flags = cvt(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }).map(drop)
}

pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) }).map(drop)
}

/// A pipe with both ends close-on-exec.
pub fn pipe_cloexec() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    cvt(unsafe { libc::pipe(fds.as_mut_ptr()) })?;
    let (r, w) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    set_cloexec(fds[0])?;
    set_cloexec(fds[1])?;
    Ok((r, w))
}

/// Monotonic milliseconds (never jumps with the wall clock).
pub fn now_ms() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1000 + ts.tv_nsec as u64 / 1_000_000
}

/// Unix time in milliseconds.
pub fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn cstring(s: &OsStr) -> io::Result<CString> {
    CString::new(s.as_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "argument contains a NUL byte"))
}

/// Blocking write of the whole buffer (EINTR retried).
pub fn write_all(fd: RawFd, mut buf: &[u8]) -> io::Result<()> {
    while !buf.is_empty() {
        let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        buf = &buf[n as usize..];
    }
    Ok(())
}

/// Is `pid` alive (or a zombie)? `kill(pid, 0)` succeeds or fails with EPERM.
pub fn pid_alive(pid: libc::pid_t) -> bool {
    pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || errno() == libc::EPERM)
}

/// Writes formatted text into a fixed stack buffer (no allocation); output beyond the buffer is dropped.
pub struct StackBuf<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> StackBuf<N> {
    pub fn new() -> Self {
        StackBuf { buf: [0; N], len: 0 }
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }
}

impl<const N: usize> Default for StackBuf<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> std::fmt::Write for StackBuf<N> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let n = s.len().min(N - self.len);
        self.buf[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
        self.len += n;
        Ok(())
    }
}
