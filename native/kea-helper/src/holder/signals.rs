//! Signals → self-pipe (README: SIGCHLD via a self-pipe). `SIGTERM`/`SIGHUP` only set a flag: the
//! holder ignores them while the child lives and exits cleanly once it is gone.

use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

static WAKE_FD: AtomicI32 = AtomicI32::new(-1);
static GOT_TERM: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(sig: libc::c_int) {
    unsafe {
        let saved = *crate::os::errno_ptr();
        if sig == libc::SIGTERM || sig == libc::SIGHUP {
            GOT_TERM.store(true, Ordering::SeqCst);
        }
        let fd = WAKE_FD.load(Ordering::SeqCst);
        if fd >= 0 {
            libc::write(fd, b"!".as_ptr().cast(), 1);
        }
        *crate::os::errno_ptr() = saved;
    }
}

/// Routes SIGCHLD, SIGTERM and SIGHUP to `wake_wr` (non-blocking); ignores SIGPIPE.
pub fn install(wake_wr: RawFd) -> io::Result<()> {
    WAKE_FD.store(wake_wr, Ordering::SeqCst);
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_signal as *const () as usize;
        sa.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut sa.sa_mask);
        for sig in [libc::SIGCHLD, libc::SIGTERM, libc::SIGHUP] {
            if libc::sigaction(sig, &sa, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    Ok(())
}

/// Was SIGTERM or SIGHUP received since the last call?
pub fn take_term() -> bool {
    GOT_TERM.swap(false, Ordering::SeqCst)
}
