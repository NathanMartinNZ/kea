//! The helper's OS layer. Every call one system lacks — libproc and `/proc`, Security.framework,
//! `posix_spawn`'s flags, where `errno` lives, `SO_NOSIGPIPE` and `MSG_NOSIGNAL`, the hook's clock, the random source —
//! sits in `macos.rs` or `linux.rs` behind the items below. `#[cfg(target_os = …)]` is on those two module
//! declarations and nowhere else (`pnpm lint`, U-PLT-1). Both files define the same items; a capability one system
//! lacks, or does not have yet, answers with an error that says so (`not_available`), never with `unimplemented!`.
//! `procfs.rs` is Linux's `/proc` read as text: pure, built on both systems, so its tests run on macOS against recorded
//! files.
//!
//! What each file provides: `IS_LINUX` (the per-system numbers of `limits.rs`); process facts (`proc_info`,
//! `children_into`, `all_pids`, `name_into`, `cwd_into`, `fd_char_rdev`, `open_fds`, `cpu_time_ns`); `ProcScan`, the
//! terminal's processes for `TERMINATE` and `STAT`, and `kill_member`, a signal that never reaches a reused pid;
//! `processes` (`kea-helper procs`); `footprint`; `Ports` and `all_listeners` (`kea-helper ports --all`; macOS: not
//! available, core keeps `lsof`); `spawn_detached`, the launcher's detached spawn; `last_signal` and
//! `PTY_REDRIVE_ERRNO`, for the PTY child; `errno_ptr`, `set_nosigpipe`, `send`, `connect_pending`, `set_sun_len`;
//! `runtime_dir` (the run dir's fallback); `hook_clock_ns` and `random_bytes` (the hook envelope's `mono` and `id`);
//! `PeerAdmission` with `peer_checkable` and `refusal_reason` (client admission); `scope_command` and `harden_holder`
//! (on Linux, the holder's own systemd scope and its hardening); `raw_start` (the state json's `pidStartTicks`).

use std::io;

pub mod procfs;

/// Facts about one process, as `proc_info` reads them.
#[derive(Clone, Copy, Debug)]
pub struct ProcInfo {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    /// The effective uid.
    pub uid: u32,
    /// Controlling terminal device, `u32::MAX`/0 when none.
    pub tdev: u32,
    /// Start time as this system keeps it, what tells a process from a later one with the same pid (macOS: µs since
    /// the epoch; Linux: clock ticks after boot, exact and not moved by a stepped wall clock).
    pub start: u64,
    /// Start time, µs since the epoch (the state json's `pidStartTime`).
    pub start_us: u64,
    /// Working its way through `exit()`, or a zombie.
    pub exiting: bool,
}

/// A TCP socket in `LISTEN`, as `Ports::listening` reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listening {
    pub v6: bool,
    pub addr: String,
    pub port: u16,
}

/// The error of a capability this system lacks: `Unsupported`, with the one sentence that says why.
pub fn not_available(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, why)
}

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod imp;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod imp;

pub use imp::*;
