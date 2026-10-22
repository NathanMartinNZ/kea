//! The PTY child: `openpty`; fork; the child makes the slave its controlling terminal in a new
//! session, puts it on 0/1/2, closes every other fd, resets signals, `chdir`s and `execvp`s. No shell.
//!
//! Everything the child needs is prepared before `fork`, so the child only makes async-signal-safe
//! calls (the holder is single-threaded, but tests run it inside a multi-threaded process).

use std::ffi::{CString, OsStr};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Mutex;

use crate::limits::HOLDER_PTY_OPEN_ATTEMPTS;
use crate::sys::{cstring, cvt, set_cloexec, set_nonblock};

pub struct Child {
    pub master: OwnedFd,
    /// The holder keeps a slave fd open so that output buffered in the tty survives the child's exit
    /// until it is drained, and so the master never reads EOF while orphans hold the slave.
    #[allow(dead_code)] // held for its fd
    pub slave: OwnedFd,
    pub pid: libc::pid_t,
    /// The slave's device number: identifies processes still attached to this terminal.
    pub tty_rdev: u32,
}

pub fn winsize(cols: u16, rows: u16, xpx: u16, ypx: u16) -> libc::winsize {
    libc::winsize { ws_col: cols, ws_row: rows, ws_xpixel: xpx, ws_ypixel: ypx }
}

pub fn spawn<'a>(argv: impl Iterator<Item = &'a OsStr>, cwd: &Path, ws: libc::winsize) -> io::Result<Child> {
    let argv: Vec<CString> = argv.map(cstring).collect::<io::Result<_>>()?;
    let file = argv.first().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty argv"))?.clone();
    let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());
    let cwd_c = cstring(cwd.as_os_str())?;
    let exec_msg = [b"kea-helper: exec ", file.as_bytes(), b": "].concat();
    let chdir_msg = [b"kea-helper: chdir ", cwd.as_os_str().as_bytes(), b": "].concat();
    let last_signal = crate::os::last_signal();
    let max_fd = {
        let mut rl = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) };
        // fds above this are not expected; the launcher already gives the daemon only 0–3.
        rl.rlim_cur.clamp(256, 1 << 16) as libc::c_int
    };

    let (master, slave) = open_pty(ws).map_err(|e| in_call("openpty", e))?;
    let s = slave.as_raw_fd();
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    cvt(unsafe { libc::fstat(s, &mut st) })?;

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(in_call("fork", io::Error::last_os_error()));
    }
    if pid == 0 {
        unsafe { child_after_fork(s, &file, &argv_ptrs, &cwd_c, &exec_msg, &chdir_msg, max_fd, last_signal) }
    }
    set_nonblock(master.as_raw_fd())?;
    Ok(Child { master, slave, pid, tty_rdev: st.st_rdev as u32 })
}

/// The failed call's name before the system's error: `openpty: Device not configured (os error 6)`. Kea reads a
/// resource limit from the two together: ENXIO (macOS) or ENOSPC (Linux, `kernel.pty.max`) from `openpty`
/// is "no terminal device left", EAGAIN from `fork` is "too many processes", and none means that from another call.
fn in_call(call: &str, e: io::Error) -> io::Error {
    io::Error::new(e.kind(), format!("{call}: {e}"))
}

/// Terminals are opened one at a time in this process: on macOS, `/dev/ptmx` opened by several threads of one
/// process at once fails far more often with the kernel's internal `EREDRIVEOPEN` (`os::PTY_REDRIVE_ERRNO`). The
/// holder is single-threaded, so this only ever waits in its tests, which run holders side by side on threads
/// (R-HLD-10).
static OPENING: Mutex<()> = Mutex::new(());

/// A new terminal: (master, slave), both close-on-exec, sized `ws`. On macOS it is retried at once on
/// `EREDRIVEOPEN`, at most `HOLDER_PTY_OPEN_ATTEMPTS` attempts in all; Linux has no such error.
pub fn open_pty(ws: libc::winsize) -> io::Result<(OwnedFd, OwnedFd)> {
    let _one_at_a_time = OPENING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    retry_redrive(HOLDER_PTY_OPEN_ATTEMPTS, crate::os::PTY_REDRIVE_ERRNO, || {
        let (mut m, mut s) = (-1, -1);
        let mut ws_copy = ws;
        cvt(unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws_copy) })?;
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
        set_cloexec(m)?;
        set_cloexec(s)?;
        Ok((master, slave))
    })
}

/// Runs `op` until it succeeds, fails with anything but `redrive` (none: anything at all), or has run `attempts`
/// times.
fn retry_redrive<T>(attempts: u64, redrive: Option<i32>, mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut tried = 1;
    loop {
        match op() {
            Err(e) if redrive.is_some() && e.raw_os_error() == redrive && tried < attempts => tried += 1,
            r => return r,
        }
    }
}

/// Runs in the forked child: async-signal-safe calls only, never returns.
unsafe fn child_after_fork(
    slave: libc::c_int,
    file: &CString,
    argv: &[*const libc::c_char],
    cwd: &CString,
    exec_msg: &[u8],
    chdir_msg: &[u8],
    max_fd: libc::c_int,
    last_signal: libc::c_int,
) -> ! {
    unsafe {
        // Signal dispositions and mask as a fresh process would have them (the holder ignores SIGPIPE,
        // and ignored signals survive exec).
        let mut dfl: libc::sigaction = std::mem::zeroed();
        dfl.sa_sigaction = libc::SIG_DFL;
        for sig in 1..=last_signal {
            if sig != libc::SIGKILL && sig != libc::SIGSTOP {
                libc::sigaction(sig, &dfl, std::ptr::null_mut());
            }
        }
        let mut empty: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());

        libc::setsid();
        libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
        for fd in 0..3 {
            libc::dup2(slave, fd);
        }
        for fd in 3..max_fd {
            libc::close(fd);
        }
        if libc::chdir(cwd.as_ptr()) != 0 {
            fail(chdir_msg);
        }
        libc::execvp(file.as_ptr(), argv.as_ptr());
        fail(exec_msg)
    }
}

/// `<msg><strerror>\n` to the terminal, then exit 127 (README: exec failure).
unsafe fn fail(msg: &[u8]) -> ! {
    unsafe {
        let err = *crate::os::errno_ptr();
        libc::write(2, msg.as_ptr().cast(), msg.len());
        let s = libc::strerror(err);
        if !s.is_null() {
            libc::write(2, s.cast(), libc::strlen(s));
        }
        libc::write(2, b"\n".as_ptr().cast(), 1);
        libc::_exit(127)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    /// `<sys/ttycom.h>`: the size of the buffer `TIOCPTYGNAME` (under `ptsname_r`) fills.
    const PTY_NAME_MAX: usize = 128;

    unsafe extern "C" {
        /// macOS 10.13.4+; the `libc` crate does not declare it for Apple targets.
        fn ptsname_r(fd: libc::c_int, buf: *mut libc::c_char, buflen: libc::size_t) -> libc::c_int;
    }

    fn rdev(st: libc::stat) -> libc::dev_t {
        st.st_rdev
    }

    /// Does `slave` belong to `master`? Asked of the master itself, into a buffer of the caller's.
    fn belongs(master: libc::c_int, slave: libc::c_int) -> Result<bool, String> {
        let mut buf = [0 as libc::c_char; PTY_NAME_MAX];
        if unsafe { ptsname_r(master, buf.as_mut_ptr(), buf.len()) } != 0 {
            return Err(format!("ptsname_r: {}", io::Error::last_os_error()));
        }
        let (mut by_name, mut by_fd): (libc::stat, libc::stat) = unsafe { (std::mem::zeroed(), std::mem::zeroed()) };
        cvt(unsafe { libc::stat(buf.as_ptr(), &mut by_name) }).map_err(|e| format!("stat {:?}: {e}", unsafe { CStr::from_ptr(buf.as_ptr()) }))?;
        cvt(unsafe { libc::fstat(slave, &mut by_fd) }).map_err(|e| format!("fstat: {e}"))?;
        Ok(rdev(by_name) == rdev(by_fd))
    }

    // The holder is single-threaded, but its tests run holders side by side on threads: terminals opened at the
    // same moment must each open, and each get the slave of their own master (without `OPENING` and the retry, a
    // few in every hundred failed with errno -6).
    #[test]
    fn r_hld_10_terminals_opened_at_once_on_many_threads_each_get_their_own_slave() {
        const THREADS: usize = 16;
        const ROUNDS: usize = 100;
        let at_once = std::sync::Barrier::new(THREADS);
        // bounded: one entry per open that went wrong, at most THREADS × ROUNDS
        let wrong: Mutex<Vec<String>> = Mutex::new(Vec::new());
        std::thread::scope(|s| {
            for _ in 0..THREADS {
                s.spawn(|| {
                    for _ in 0..ROUNDS {
                        at_once.wait(); // never skipped: a thread that stopped early would strand the others here
                        let outcome = match open_pty(winsize(80, 24, 0, 0)) {
                            Ok((master, slave)) => belongs(master.as_raw_fd(), slave.as_raw_fd()).and_then(|own| if own { Ok(()) } else { Err("the slave of another master".into()) }),
                            Err(e) => Err(format!("open: {e}")),
                        };
                        if let Err(e) = outcome {
                            wrong.lock().unwrap().push(e);
                        }
                    }
                });
            }
        });
        let wrong = wrong.into_inner().unwrap();
        assert!(wrong.is_empty(), "{} of {} terminals went wrong, e.g. {:?}", wrong.len(), THREADS * ROUNDS, &wrong[..wrong.len().min(3)]);
    }

    #[test]
    fn r_hld_10_an_open_failing_with_eredriveopen_is_retried_at_once_up_to_the_cap_and_no_other_error_is() {
        /// macOS's errno; the retry is macOS's only (`os::PTY_REDRIVE_ERRNO`)
        const EREDRIVEOPEN: i32 = -6;
        let redrive = || io::Error::from_raw_os_error(EREDRIVEOPEN);
        let calls = std::cell::Cell::new(0u64);
        let flaky = |fails: u64| {
            calls.set(0);
            retry_redrive(HOLDER_PTY_OPEN_ATTEMPTS, Some(EREDRIVEOPEN), || {
                calls.set(calls.get() + 1);
                if calls.get() <= fails { Err(redrive()) } else { Ok(calls.get()) }
            })
        };
        assert_eq!(flaky(HOLDER_PTY_OPEN_ATTEMPTS - 1).unwrap(), HOLDER_PTY_OPEN_ATTEMPTS, "the last attempt opens");
        assert_eq!(flaky(HOLDER_PTY_OPEN_ATTEMPTS).unwrap_err().raw_os_error(), Some(EREDRIVEOPEN));
        assert_eq!(calls.get(), HOLDER_PTY_OPEN_ATTEMPTS, "never more than the cap");
        calls.set(0);
        let other = retry_redrive(HOLDER_PTY_OPEN_ATTEMPTS, Some(EREDRIVEOPEN), || -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(io::Error::from_raw_os_error(libc::ENXIO))
        });
        assert_eq!((other.unwrap_err().raw_os_error(), calls.get()), (Some(libc::ENXIO), 1), "any other error is final");
        calls.set(0);
        let none = retry_redrive(HOLDER_PTY_OPEN_ATTEMPTS, None, || -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(redrive())
        });
        assert_eq!((none.unwrap_err().raw_os_error(), calls.get()), (Some(EREDRIVEOPEN), 1), "no redrive errno (Linux): nothing is retried");
    }
}
