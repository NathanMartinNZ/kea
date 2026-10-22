//! Linux's side of the helper's OS layer (`mod.rs`): `/proc`, read through `procfs.rs`, for process facts, the
//! terminal's processes, the footprint, listening ports and `procs`; pidfds for signals; glibc's `posix_spawn` for the
//! detached launch, put into a systemd user scope of its own when a user manager answers; admission by the client's
//! executable, its mappings and its parent's; a non-dumpable holder; and the libc names Linux has
//! (`__errno_location`, `MSG_NOSIGNAL`, `getrandom`, `CLOCK_MONOTONIC`).
//!
//! What the holder's steady loop calls (`STAT`: `name_into`, `cwd_into`, `ProcScan::descendants_into`) allocates
//! nothing (R-HLD-6): paths are built and files read in stack buffers, `/proc` is listed with `getdents64`.
//! Admission runs at accept, a rare path, and may allocate.

use std::ffi::{CString, c_char};
use std::mem::size_of;
use std::fmt::Write as _;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::procfs::{self, Row};
use super::{Listening, ProcInfo};
use crate::admission::{ADMIT, Check, PeerCheck, REFUSE};
use crate::args::Client;
use crate::limits::HOLDER_PROC_MAP_MAX;
use crate::sys::{StackBuf, cvt, pipe_cloexec, write_all};

/// Linux: `limits.rs` takes each number's Linux value where it has one.
pub const IS_LINUX: bool = true;

// ── reading /proc in fixed buffers ────────────────────────────────────────────────────────

/// Longest `/proc/<pid>/fd/<n>` and the like, with its NUL.
const PROC_PATH_MAX: usize = 64;
/// A `stat` or `comm` read: a `stat` line is a few hundred bytes (its name is at most 64).
const SMALL_READ: usize = 1024;
/// `PATH_MAX`: a `readlink` of `exe` or `cwd`.
const LINK_MAX: usize = 4096;

/// `/proc/<pid>/<file>`, NUL-terminated, in a stack buffer (`file` empty: `/proc/<pid>`).
fn proc_path(pid: i32, file: &str) -> StackBuf<PROC_PATH_MAX> {
    let mut p = StackBuf::new();
    let _ = if file.is_empty() { write!(p, "/proc/{pid}\0") } else { write!(p, "/proc/{pid}/{file}\0") };
    p
}

fn c(p: &StackBuf<PROC_PATH_MAX>) -> *const c_char {
    p.as_bytes().as_ptr().cast()
}

/// A missing `/proc/<pid>` means the process is gone: `ENOENT` (and `ESRCH` from a file of a dying one) become
/// `ESRCH`, which the subcommands print as "no such process".
fn gone(e: io::Error) -> io::Error {
    match e.raw_os_error() {
        Some(libc::ENOENT) | Some(libc::ESRCH) => io::Error::from_raw_os_error(libc::ESRCH),
        _ => e,
    }
}

/// Reads the start of a small file into `buf`; returns how many bytes (at most `buf.len()`).
fn read_into(path: &StackBuf<PROC_PATH_MAX>, buf: &mut [u8]) -> io::Result<usize> {
    let fd = cvt(unsafe { libc::open(c(path), libc::O_RDONLY | libc::O_CLOEXEC) }).map_err(gone)?;
    let mut n = 0;
    let r = loop {
        if n == buf.len() {
            break Ok(n);
        }
        let got = unsafe { libc::read(fd, buf[n..].as_mut_ptr().cast(), buf.len() - n) };
        match got {
            0 => break Ok(n),
            g if g > 0 => n += g as usize,
            _ if crate::sys::errno() == libc::EINTR => {}
            _ => break Err(gone(io::Error::last_os_error())),
        }
    };
    unsafe { libc::close(fd) };
    r
}

/// `readlink` into `buf`; `None` when it fails or the target does not fit.
fn readlink_into(path: &StackBuf<PROC_PATH_MAX>, buf: &mut [u8]) -> Option<usize> {
    let n = unsafe { libc::readlink(c(path), buf.as_mut_ptr().cast(), buf.len()) };
    (n >= 0 && (n as usize) < buf.len()).then_some(n as usize)
}

fn stat_of(pid: i32) -> io::Result<procfs::Stat> {
    let mut buf = [0u8; SMALL_READ];
    let n = read_into(&proc_path(pid, "stat"), &mut buf)?;
    procfs::parse_stat(&buf[..n]).filter(|s| s.pid == pid).ok_or_else(|| io::Error::from_raw_os_error(libc::ESRCH))
}

/// `btime` (`/proc/stat`), read once per process: the holder's start time is derived from it once, and a
/// `procs` run reads `/proc/stat` itself.
fn btime() -> u64 {
    static BTIME: OnceLock<u64> = OnceLock::new();
    *BTIME.get_or_init(|| std::fs::read("/proc/stat").ok().and_then(|b| procfs::btime(&b)).unwrap_or(0))
}

fn clk_tck() -> u64 {
    let t = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if t > 0 { t as u64 } else { 100 }
}

/// Calls `f` with every pid in `/proc`, in ascending order (`getdents64` into a stack buffer: no allocation).
/// `f` returns false to stop.
fn for_each_pid(mut f: impl FnMut(i32) -> bool) -> io::Result<()> {
    let fd = cvt(unsafe { libc::open(c"/proc".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) })?;
    let mut buf = [0u8; 4096];
    let r = 'scan: loop {
        let n = unsafe { libc::syscall(libc::SYS_getdents64, fd, buf.as_mut_ptr(), buf.len()) };
        if n < 0 {
            break Err(io::Error::last_os_error());
        }
        if n == 0 {
            break Ok(());
        }
        // struct linux_dirent64 { u64 d_ino; i64 d_off; u16 d_reclen; u8 d_type; char d_name[]; }
        let mut off = 0usize;
        while off + 19 <= n as usize {
            let reclen = u16::from_ne_bytes([buf[off + 16], buf[off + 17]]) as usize;
            if reclen == 0 || off + reclen > n as usize {
                break;
            }
            let name = &buf[off + 19..off + reclen];
            let name = &name[..name.iter().position(|&b| b == 0).unwrap_or(name.len())];
            if !name.is_empty() && name.iter().all(u8::is_ascii_digit) {
                let pid = name.iter().fold(0i64, |a, &d| (a * 10 + (d - b'0') as i64).min(i32::MAX as i64)) as i32;
                if !f(pid) {
                    break 'scan Ok(());
                }
            }
            off += reclen;
        }
    };
    unsafe { libc::close(fd) };
    r
}

// ── process facts ─────────────────────────────────────────────────────────────────────────

/// `/proc/<pid>/stat` and `status`.
pub fn proc_info(pid: i32) -> io::Result<ProcInfo> {
    if pid <= 0 {
        return Err(io::Error::from_raw_os_error(libc::ESRCH));
    }
    let st = stat_of(pid)?;
    let mut buf = [0u8; LINK_MAX];
    let n = read_into(&proc_path(pid, "status"), &mut buf)?;
    let uid = procfs::status_euid(&buf[..n]).ok_or_else(|| io::Error::from_raw_os_error(libc::ESRCH))?;
    Ok(ProcInfo {
        pid,
        ppid: st.ppid,
        pgid: st.pgrp,
        uid,
        tdev: st.tty_nr,
        start: st.starttime,
        start_us: procfs::start_us(st.starttime, btime(), clk_tck()),
        exiting: st.exiting(),
    })
}

/// The raw start the state json records beside `pidStartTime` (`pidStartTicks`): clock ticks after boot,
/// which a stepped wall clock does not move.
pub fn raw_start(info: &ProcInfo) -> Option<u64> {
    Some(info.start)
}

/// Children of `pid` written into `out` (one pass over `/proc/*/stat`); returns how many.
pub fn children_into(pid: i32, out: &mut [i32]) -> usize {
    if out.is_empty() {
        return 0;
    }
    let mut n = 0;
    let _ = for_each_pid(|p| {
        if stat_of(p).is_ok_and(|s| s.ppid == pid) {
            out[n] = p;
            n += 1;
        }
        n < out.len()
    });
    n
}

/// Every pid on the system.
pub fn all_pids() -> io::Result<Vec<i32>> {
    let mut v = Vec::new();
    for_each_pid(|p| {
        v.push(p);
        true
    })?;
    Ok(v)
}

/// The name of `pid` for a tab title: the basename of its executable when that can be read (not cut to 15 characters),
/// else `/proc/<pid>/comm`. Returns the length (0 when unknown).
pub fn name_into(pid: i32, buf: &mut [u8]) -> usize {
    if pid <= 0 {
        return 0;
    }
    let mut link = [0u8; LINK_MAX];
    if let Some(n) = readlink_into(&proc_path(pid, "exe"), &mut link) {
        let exe = procfs::exe_path(&link[..n]);
        let base = exe.rsplit(|&b| b == b'/').next().unwrap_or(exe);
        let len = base.len().min(buf.len());
        buf[..len].copy_from_slice(&base[..len]);
        return len;
    }
    let n = read_into(&proc_path(pid, "comm"), buf).unwrap_or(0);
    buf[..n].strip_suffix(b"\n").map_or(n, <[u8]>::len)
}

/// The current directory of `pid` (`readlink /proc/<pid>/cwd`) into `buf`; returns the length, 0 when unknown, cut
/// off, or a directory that has been removed (` (deleted)`).
pub fn cwd_into(pid: i32, buf: &mut [u8]) -> usize {
    if pid <= 0 {
        return 0;
    }
    match readlink_into(&proc_path(pid, "cwd"), buf) {
        Some(n) if !buf[..n].ends_with(b" (deleted)") => n,
        _ => 0,
    }
}

/// The device of `pid`'s descriptor `fd` when it is a character device (a tty): `stat` through `/proc/<pid>/fd/<fd>`.
/// The low 32 bits of `st_rdev`, as `tty_nr` and the holder's own slave carry it.
pub fn fd_char_rdev(pid: i32, fd: i32) -> Option<u32> {
    let mut p = StackBuf::<PROC_PATH_MAX>::new();
    let _ = write!(p, "/proc/{pid}/fd/{fd}\0");
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::stat(c(&p), &mut st) } == 0 && st.st_mode & libc::S_IFMT == libc::S_IFCHR).then_some(st.st_rdev as u32)
}

/// CPU time `pid` has used, in ns: the first field of `/proc/<pid>/schedstat` (the scheduler's own count, exact,
/// where `stat`'s `utime` and `stime` are whole clock ticks).
pub fn cpu_time_ns(pid: i32) -> io::Result<u64> {
    let mut buf = [0u8; 128];
    let n = read_into(&proc_path(pid, "schedstat"), &mut buf)?;
    let first = buf[..n].split(|&b| b == b' ').next().unwrap_or(&[]);
    std::str::from_utf8(first).ok().and_then(|t| t.trim().parse().ok()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "schedstat"))
}

/// The numbers of `pid`'s open descriptors.
pub fn open_fds(pid: i32) -> io::Result<Vec<i32>> {
    let dir = std::fs::read_dir(format!("/proc/{pid}/fd")).map_err(gone)?;
    Ok(dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect())
}

// ── the terminal's processes ──────────────────────────────────────────────────────────────

/// The terminal's processes, for `TERMINATE` and `STAT`. In a systemd scope of its own they are the scope's members:
/// every process started under the PTY, double-forked ones included. Otherwise (session mode) one pass over
/// `/proc/*/stat` builds a ppid map, and the descendants are read from it.
pub struct ProcScan {
    /// The holder runs in a scope of its own: its state json's `detach`.
    in_scope: bool,
    /// `cgroup.procs` of that scope, when it could be opened at the start; otherwise (a hybrid cgroup hierarchy, a
    /// cgroup namespace) the processes are found as in session mode, never as none.
    scope_procs: Option<CString>,
    /// bounded: HOLDER_PROC_MAP_MAX (pid, ppid) pairs, reserved at start and only cleared and refilled: one scan's
    /// ppid map. Kernel threads and init's children are left out.
    map: Vec<(i32, i32)>,
}

impl ProcScan {
    /// `pty_id` names the holder's scope (`kea-<8 hex>-<ptyId>.scope`); its cgroup is read once, here.
    pub fn new(pty_id: &str) -> ProcScan {
        let cg = std::fs::read("/proc/self/cgroup").unwrap_or_default();
        ProcScan::of(procfs::cgroup_v2_path(&cg).filter(|p| procfs::is_own_scope(p, pty_id)))
    }

    /// How the holder left Kea, for its state json: `"scope"` in a scope of its own, `"session"` otherwise, `"none"`
    /// for `--no-detach`.
    pub fn detach(&self, no_detach: bool) -> Option<&'static str> {
        Some(if no_detach {
            "none"
        } else if self.in_scope {
            "scope"
        } else {
            "session"
        })
    }

    /// A scan of the cgroup at `path` (as `/proc/<pid>/cgroup` names it), or of the session when `None`.
    fn of(path: Option<&[u8]>) -> ProcScan {
        let readable = |c: &CString| match cvt(unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) }) {
            Ok(fd) => {
                unsafe { libc::close(fd) };
                true
            }
            Err(_) => false,
        };
        let scope_procs = path.and_then(|p| CString::new([b"/sys/fs/cgroup".as_slice(), p, b"/cgroup.procs"].concat()).ok()).filter(readable);
        ProcScan { in_scope: path.is_some(), scope_procs, map: Vec::with_capacity(HOLDER_PROC_MAP_MAX as usize) }
    }

    /// Every pid that may belong to the terminal, for `TERMINATE`'s snapshot (allocates: a rare path). The scope's
    /// members, or every pid when there is no scope to read or it cannot be read now.
    pub fn candidates(&self) -> io::Result<Vec<i32>> {
        match self.scope_procs.as_ref().map(|p| std::fs::read(Path::new(std::ffi::OsStr::from_bytes(p.as_bytes())))) {
            Some(Ok(text)) => Ok(text.split(|&b| b == b'\n').filter_map(|l| std::str::from_utf8(l).ok()?.trim().parse().ok()).collect()),
            Some(Err(_)) | None => all_pids(),
        }
    }

    /// The terminal's processes below `root` (the child), up to `out`'s capacity, allocating nothing: in a scope,
    /// every member but the holder and `root`; otherwise `root`'s descendants, breadth first.
    pub fn descendants_into(&mut self, root: i32, out: &mut Vec<i32>) {
        out.clear();
        let me = unsafe { libc::getpid() };
        if let Some(path) = &self.scope_procs {
            scope_members(path, |pid| {
                if pid != me && pid != root && !out.contains(&pid) {
                    out.push(pid);
                }
                out.len() < out.capacity()
            });
            return;
        }
        self.map.clear();
        let map = &mut self.map;
        let _ = for_each_pid(|pid| {
            if let Ok(s) = stat_of(pid)
                && s.ppid > 2
                && pid != 2
            {
                map.push((pid, s.ppid));
            }
            map.len() < map.capacity()
        });
        map.sort_unstable_by_key(|&(_, ppid)| ppid);
        let mut next = 0;
        let mut parent = root;
        loop {
            let from = map.partition_point(|&(_, pp)| pp < parent);
            for &(pid, _) in map[from..].iter().take_while(|&&(_, pp)| pp == parent) {
                if out.len() == out.capacity() {
                    return;
                }
                out.push(pid);
            }
            if next >= out.len() {
                return;
            }
            parent = out[next];
            next += 1;
        }
    }
}

/// Calls `f` with each pid in `cgroup.procs` at `path`, read in a stack buffer; `f` returns false to stop.
fn scope_members(path: &CString, mut f: impl FnMut(i32) -> bool) {
    let Ok(fd) = cvt(unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) }) else { return };
    let mut buf = [0u8; SMALL_READ];
    let mut have = 0usize;
    'read: loop {
        let n = unsafe { libc::read(fd, buf[have..].as_mut_ptr().cast(), buf.len() - have) };
        if n < 0 && crate::sys::errno() == libc::EINTR {
            continue;
        }
        let end = n <= 0;
        have += n.max(0) as usize;
        let mut start = 0;
        while let Some(nl) = buf[start..have].iter().position(|&b| b == b'\n') {
            if let Some(pid) = std::str::from_utf8(&buf[start..start + nl]).ok().and_then(|s| s.parse().ok())
                && !f(pid)
            {
                break 'read;
            }
            start += nl + 1;
        }
        buf.copy_within(start..have, 0);
        have -= start;
        if end || have == buf.len() {
            break;
        }
    }
    unsafe { libc::close(fd) };
}

/// Sends `sig` to the member `pid` through a pidfd opened while its start time (`ProcInfo::start`, clock ticks) still
/// matched: a pid the system has given to another process is never signalled. Without `pidfd_open` (a kernel
/// before 5.3, or a seccomp filter) the start time is checked just before a plain `kill`.
pub fn kill_member(pid: i32, start: u64, sig: libc::c_int) -> bool {
    let same = || stat_of(pid).is_ok_and(|s| s.starttime == start);
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
    if fd < 0 {
        return crate::sys::errno() == libc::ENOSYS && same() && unsafe { libc::kill(pid, sig) } == 0;
    }
    let sent = same() && unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, sig, std::ptr::null::<libc::siginfo_t>(), 0) } == 0;
    unsafe { libc::close(fd) };
    sent
}

// ── `kea-helper procs`, footprint, ports ──────────────────────────────────────────────────

/// This user's processes from `/proc` (`kea-helper procs`): every process, or only `pids`.
pub fn processes(pids: Option<&[i32]>) -> io::Result<Vec<Row>> {
    procfs::read_procs(Path::new("/proc"), unsafe { libc::getuid() }, pids, clk_tck())
}

/// `RssAnon + VmSwap` of `pid`: its own memory; a mapped file, such as a holder's ring, is not in it.
pub fn footprint(pid: i32) -> io::Result<u64> {
    if pid <= 0 {
        return Err(io::Error::from_raw_os_error(libc::ESRCH));
    }
    procfs::footprint_at(Path::new(&format!("/proc/{pid}/status"))).map_err(gone)
}

/// Each pid's listening sockets: a process's socket inodes against the TCP tables of its network namespace, each
/// namespace's tables read once per `ports` run.
pub struct Ports {
    /// bounded: one entry per network namespace among one run's pids (a few: a `ports` run names one session's).
    tables: Vec<(u64, Vec<u8>, Vec<u8>)>,
}

impl Ports {
    pub fn new() -> Ports {
        Ports { tables: Vec::new() }
    }

    pub fn listening(&mut self, pid: i32) -> io::Result<Vec<Listening>> {
        let inodes = socket_inodes(pid)?;
        self.listening_of(pid, &inodes)
    }

    fn listening_of(&mut self, pid: i32, inodes: &[u64]) -> io::Result<Vec<Listening>> {
        let mut found = Vec::new();
        if inodes.is_empty() {
            return Ok(found);
        }
        let read = |f: &str| std::fs::read(format!("/proc/{pid}/net/{f}")).unwrap_or_default(); // tcp6: absent without IPv6
        let ns = std::fs::metadata(format!("/proc/{pid}/ns/net")).map(|m| m.ino()).ok();
        let at = match ns.and_then(|ns| self.tables.iter().position(|t| t.0 == ns)) {
            Some(i) => i,
            None => {
                self.tables.push((ns.unwrap_or(0), read("tcp"), read("tcp6")));
                let i = self.tables.len() - 1;
                if ns.is_none() {
                    // its namespace cannot be told: read for this pid alone, never shared
                    let (_, t4, t6) = self.tables.remove(i);
                    procfs::listeners(&t4, false, &inodes, &mut found);
                    procfs::listeners(&t6, true, &inodes, &mut found);
                    return Ok(found);
                }
                i
            }
        };
        let (_, t4, t6) = &self.tables[at];
        procfs::listeners(t4, false, inodes, &mut found);
        procfs::listeners(t6, true, inodes, &mut found);
        Ok(found)
    }
}

/// The socket inodes among `pid`'s descriptors (`readlink /proc/<pid>/fd/*`).
fn socket_inodes(pid: i32) -> io::Result<Vec<u64>> {
    if pid <= 0 {
        return Err(io::Error::from_raw_os_error(libc::ESRCH));
    }
    let mut inodes = Vec::new();
    for e in std::fs::read_dir(format!("/proc/{pid}/fd")).map_err(gone)? {
        let Ok(e) = e else { continue };
        if let Some(i) = std::fs::read_link(e.path()).ok().and_then(|l| procfs::socket_inode(l.as_os_str().as_bytes())) {
            inodes.push(i);
        }
    }
    Ok(inodes)
}

/// `kea-helper ports --all`: the listeners of every process of this user (effective uid), each with its pid, read as
/// `Ports::listening` reads one process's; then the listeners of the helper's own network namespace that none of them
/// holds, with no pid: another user's process holds those, and its descriptors cannot be read. A process that ends or
/// cannot be read meanwhile is left out.
pub fn all_listeners() -> io::Result<Vec<(Option<i32>, Listening)>> {
    let uid = unsafe { libc::geteuid() };
    let mut ports = Ports::new();
    let mut out = Vec::new();
    // bounded: the socket inodes of this user's processes, read once per `ports --all` run
    let mut owned = Vec::new();
    for pid in all_pids()? {
        if !proc_info(pid).is_ok_and(|i| i.uid == uid) {
            continue;
        }
        let Ok(inodes) = socket_inodes(pid) else { continue };
        if inodes.is_empty() {
            continue;
        }
        if let Ok(v) = ports.listening_of(pid, &inodes) {
            out.extend(v.into_iter().map(|l| (Some(pid), l)));
        }
        owned.extend(inodes);
    }
    let mut others = Vec::new();
    procfs::listeners_unowned(&std::fs::read("/proc/self/net/tcp").unwrap_or_default(), false, &owned, &mut others);
    procfs::listeners_unowned(&std::fs::read("/proc/self/net/tcp6").unwrap_or_default(), true, &owned, &mut others);
    out.extend(others.into_iter().map(|l| (None, l)));
    Ok(out)
}

impl Default for Ports {
    fn default() -> Self {
        Self::new()
    }
}

// ── the detached launch ───────────────────────────────────────────────────────────────────

/// A `posix_spawn*` result: 0, or the error it returns (glibc refuses an unknown flag with `EINVAL` and then applies
/// none, so none is ignored).
fn spawn_ok(r: libc::c_int, what: &str) -> io::Result<()> {
    if r == 0 { Ok(()) } else { Err(io::Error::new(io::Error::from_raw_os_error(r).kind(), format!("{what}: {}", io::Error::from_raw_os_error(r)))) }
}

/// The attribute and file-action objects of one spawn, destroyed however it ends.
struct SpawnObjects {
    attr: libc::posix_spawnattr_t,
    fa: libc::posix_spawn_file_actions_t,
    attr_init: bool,
    fa_init: bool,
}

impl Drop for SpawnObjects {
    fn drop(&mut self) {
        unsafe {
            if self.fa_init {
                libc::posix_spawn_file_actions_destroy(&mut self.fa);
            }
            if self.attr_init {
                libc::posix_spawnattr_destroy(&mut self.attr);
            }
        }
    }
}

/// `posix_spawn` with the detach attributes as glibc has them: `POSIX_SPAWN_SETSID` (0x80), signals reset and
/// unblocked, stdio on `/dev/null`, `ready_wr` as the daemon's fd `ready_fd`, every fd above it closed
/// (`posix_spawn_file_actions_addclosefrom_np`, glibc 2.34). The launcher spawns the daemon so in session mode,
/// and `systemd-run --user --scope` in its place when the daemon gets a scope of its own.
///
/// # Safety
/// `argv` is a null-terminated array of pointers to C strings that live for the call.
pub unsafe fn spawn_detached(exe: &CString, argv: &[*const libc::c_char], ready_wr: &OwnedFd, ready_fd: RawFd) -> io::Result<libc::pid_t> {
    unsafe {
        let mut o = SpawnObjects { attr: std::mem::zeroed(), fa: std::mem::zeroed(), attr_init: false, fa_init: false };
        spawn_ok(libc::posix_spawnattr_init(&mut o.attr), "posix_spawnattr_init")?;
        o.attr_init = true;
        spawn_ok(libc::posix_spawn_file_actions_init(&mut o.fa), "posix_spawn_file_actions_init")?;
        o.fa_init = true;

        let flags = libc::POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_SETSIGDEF as libc::c_short | libc::POSIX_SPAWN_SETSIGMASK as libc::c_short;
        spawn_ok(libc::posix_spawnattr_setflags(&mut o.attr, flags), "posix_spawnattr_setflags")?;
        let mut all: libc::sigset_t = std::mem::zeroed();
        libc::sigfillset(&mut all);
        spawn_ok(libc::posix_spawnattr_setsigdefault(&mut o.attr, &all), "posix_spawnattr_setsigdefault")?;
        let mut none: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut none);
        spawn_ok(libc::posix_spawnattr_setsigmask(&mut o.attr, &none), "posix_spawnattr_setsigmask")?;

        let devnull = c"/dev/null";
        for (fd, mode) in [(0, libc::O_RDONLY), (1, libc::O_WRONLY), (2, libc::O_WRONLY)] {
            spawn_ok(libc::posix_spawn_file_actions_addopen(&mut o.fa, fd, devnull.as_ptr(), mode, 0), "posix_spawn_file_actions_addopen")?;
        }
        // the same fd twice clears its close-on-exec flag (POSIX.1-2024; glibc 2.29)
        spawn_ok(libc::posix_spawn_file_actions_adddup2(&mut o.fa, ready_wr.as_raw_fd(), ready_fd), "posix_spawn_file_actions_adddup2")?;
        spawn_ok(libc::posix_spawn_file_actions_addclosefrom_np(&mut o.fa, ready_fd + 1), "posix_spawn_file_actions_addclosefrom_np")?;

        let mut pid = 0;
        let r = libc::posix_spawn(&mut pid, exe.as_ptr(), &o.fa, &o.attr, argv.as_ptr() as *const *mut _, libc::environ as *const *mut _);
        if r != 0 { Err(io::Error::from_raw_os_error(r)) } else { Ok(pid) }
    }
}

/// Where `systemd-run` is looked for: never on `PATH`.
const SYSTEMD_RUN: [&str; 2] = ["/usr/bin/systemd-run", "/bin/systemd-run"];
/// Present while systemd is the init system (`sd_booted`).
const SYSTEMD_BOOTED: &str = "/run/systemd/system";

/// Does a systemd user manager answer? systemd runs (`/run/systemd/system` is a directory) and
/// `$XDG_RUNTIME_DIR/systemd/private`, the user manager's own socket, is a socket of this user's.
fn user_manager() -> bool {
    let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_absolute()) else { return false };
    let booted = std::fs::symlink_metadata(SYSTEMD_BOOTED).is_ok_and(|m| m.is_dir());
    let private = std::fs::symlink_metadata(rt.join("systemd/private"));
    booted && private.is_ok_and(|m| std::os::unix::fs::FileTypeExt::is_socket(&m.file_type()) && m.uid() == unsafe { libc::getuid() })
}

/// The command line that puts the daemon in a systemd user scope of its own when a user manager answers:
/// `systemd-run --user --scope --collect --quiet --unit=kea-<8 hex of the home's hash>-<ptyId> --description=… --`,
/// followed by the daemon's own. No unit property: above all not `ManagedOOMPreference=avoid`, which would spare a
/// runaway build and send systemd-oomd to another app. `None` without a user manager (the daemon is spawned
/// directly, in a session of its own).
pub fn scope_command(home: &Path, pty_id: &str) -> Option<Vec<CString>> {
    let run = SYSTEMD_RUN.into_iter().find(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0))?;
    if !user_manager() {
        return None;
    }
    let hash = format!("{:016x}", crate::rundir::fnv1a64(home.as_os_str().as_bytes()));
    let words = [
        run.to_owned(),
        "--user".into(),
        "--scope".into(),
        "--collect".into(),
        "--quiet".into(),
        format!("--unit=kea-{}-{pty_id}", &hash[..8]),
        format!("--description=Kea terminal {pty_id}"),
        "--".into(),
    ];
    words.into_iter().map(|w| CString::new(w).ok()).collect()
}

/// The holder's hardening as it starts, before it binds its socket: non-dumpable, so no process of its user can ptrace
/// it, read or write its memory or take its descriptors (the PTY master above all), under every `ptrace_scope`; the
/// agent's `execve` makes the agent dumpable again. `INVOCATION_ID` (which `systemd-run` adds, and Kea's own unit may
/// have passed on) is removed, so the agent does not take itself for a part of a unit.
pub fn harden_holder() -> Result<(), String> {
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(format!("prctl(PR_SET_DUMPABLE): {}", io::Error::last_os_error()));
    }
    // SAFETY: the holder has started no thread
    unsafe { std::env::remove_var("INVOCATION_ID") };
    Ok(())
}

// ── the libc names Linux has ──────────────────────────────────────────────────────────────

/// Where this thread's `errno` lives (async-signal-safe).
pub fn errno_ptr() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

/// Linux has no `SO_NOSIGPIPE`: [`send`] passes `MSG_NOSIGNAL` instead, so there is nothing to set.
pub fn set_nosigpipe(_fd: RawFd) -> io::Result<()> {
    Ok(())
}

/// Writes to a socket without `SIGPIPE` when its peer has gone (`MSG_NOSIGNAL`): the hook does not ignore the signal.
pub fn send(fd: RawFd, buf: &[u8]) -> isize {
    unsafe { libc::send(fd, buf.as_ptr().cast(), buf.len(), libc::MSG_NOSIGNAL) }
}

/// A non-blocking `connect` to a unix socket that failed with `errno` is still under way. On Linux only
/// `EINPROGRESS`: `EAGAIN` is a full backlog, a failure, and the hook spools at once.
pub fn connect_pending(errno: i32) -> bool {
    errno == libc::EINPROGRESS
}

/// The highest signal number, `SIGRTMAX`: a child's dispositions are reset up to it.
pub fn last_signal() -> libc::c_int {
    libc::SIGRTMAX()
}

/// Linux's `openpty` has no error to retry: `ENOSPC` is "no terminal device left" (`kernel.pty.max`).
pub const PTY_REDRIVE_ERRNO: Option<i32> = None;

/// `$XDG_RUNTIME_DIR` for the run dir's fallback when it is the user's own: absolute, a real directory (by `lstat`)
/// owned by this user and closed to everyone else, as the XDG spec requires. Anything else: none, and `/tmp/kea-<uid>`
/// serves.
pub fn runtime_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?);
    let m = std::fs::symlink_metadata(&dir).ok()?;
    (dir.is_absolute() && m.is_dir() && m.uid() == unsafe { libc::getuid() } && m.mode() & 0o077 == 0).then_some(dir)
}

/// Linux's `sockaddr_un` has no length field: nothing to set.
pub fn set_sun_len(_addr: &mut libc::sockaddr_un) {}

/// Nanoseconds of `CLOCK_MONOTONIC`: the hook envelope's `mono` stamp. Like macOS's `CLOCK_UPTIME_RAW` it stops while
/// the machine sleeps.
pub fn hook_clock_ns() -> io::Result<u64> {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    cvt(unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) })?;
    Ok(ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64)
}

/// Fills `buf` from the kernel's random generator (`getrandom`), retried when a signal interrupts it.
pub fn random_bytes(buf: &mut [u8]) -> io::Result<()> {
    let mut n = 0;
    while n < buf.len() {
        let r = unsafe { libc::getrandom(buf[n..].as_mut_ptr().cast(), buf.len() - n, 0) };
        if r < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        n += r as usize;
    }
    Ok(())
}

// ── admission ─────────────────────────────────────────────────────────────────────────────


/// `SO_PEERPIDFD` (`<asm-generic/socket.h>`, Linux 6.5): a pidfd of the peer that connected.
const SO_PEERPIDFD: libc::c_int = 77;

/// What a refusal's code (the byte after `REFUSE` on the verdict pipe) means, for the log.
const REFUSALS: [&str; 7] = [
    "its executable is not the file --client-exe names",
    "its executable, or a folder above it, can be changed by someone other than root",
    "its command line names no Node service utility process (it is not ptyhost)",
    "its parent is not Kea's main process",
    "a file mapped as code into it or its parent can be changed by someone other than root",
    "code from memory (an executable memfd mapping) in it or its parent",
    "it could not be read, or changed while it was checked",
];
const R_EXE: u8 = 0;
const R_OWNER: u8 = 1;
const R_TITLE: u8 = 2;
const R_PARENT: u8 = 3;
const R_MAPS: u8 = 4;
const R_MEMFD: u8 = 5;
const R_UNREADABLE: u8 = 6;

/// Why a peer was refused (`Refused::Identity`'s code).
pub fn refusal_reason(code: u8) -> &'static str {
    REFUSALS.get(code as usize).copied().unwrap_or("not admitted")
}

/// `SO_PEERCRED`: the peer's uid and pid, as they were at `connect`.
fn peer_cred(fd: RawFd) -> Option<(u32, i32)> {
    let mut c = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut c as *mut libc::ucred).cast(), &mut len) };
    (r == 0 && c.pid > 0).then_some((c.uid, c.pid))
}

/// The peer's pidfd (`SO_PEERPIDFD`): `Ok(None)` where the kernel has none (before 6.5), `Err` when the peer has
/// already been reaped.
fn peer_pidfd(fd: RawFd) -> Result<Option<OwnedFd>, ()> {
    let mut pidfd: libc::c_int = -1;
    let mut len = size_of::<libc::c_int>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, SO_PEERPIDFD, (&mut pidfd as *mut libc::c_int).cast(), &mut len) };
    match r {
        0 if pidfd >= 0 => {
            unsafe { libc::fcntl(pidfd, libc::F_SETFD, libc::FD_CLOEXEC) }; // the kernel gives it without
            Ok(Some(unsafe { std::os::fd::FromRawFd::from_raw_fd(pidfd) }))
        }
        _ if crate::sys::errno() == libc::ESRCH => Err(()),
        _ => Ok(None),
    }
}

/// Has the process behind `pidfd` exited (a pidfd polls readable once it has)?
fn pidfd_exited(pidfd: &OwnedFd) -> bool {
    let mut p = libc::pollfd { fd: pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    unsafe { libc::poll(&mut p, 1, 0) == 1 }
}

/// Has the peer hung up or shut its writing side (`POLLHUP`, `POLLRDHUP`), asked without reading?
fn hung_up(fd: RawFd) -> bool {
    let mut p = libc::pollfd { fd, events: libc::POLLIN | libc::POLLRDHUP, revents: 0 };
    unsafe { libc::poll(&mut p, 1, 0) == 1 && p.revents & (libc::POLLHUP | libc::POLLRDHUP) != 0 }
}

/// `stat` (following links) of a path given as bytes.
fn stat_bytes(path: &[u8]) -> Option<libc::stat> {
    let c = CString::new(path).ok()?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::stat(c.as_ptr(), &mut st) } == 0).then_some(st)
}

/// Directories found root-only during one check, so each is checked once.
struct Chains(Vec<Vec<u8>>);

impl Chains {
    /// Is every directory from `/` down to `dir` owned by root and writable by no one else?
    fn root_only(&mut self, dir: &[u8]) -> bool {
        let dir = if dir.is_empty() { b"/".as_slice() } else { dir };
        if self.0.iter().any(|d| d == dir) {
            return true;
        }
        let ok = stat_bytes(dir).is_some_and(|st| st.st_mode & libc::S_IFMT == libc::S_IFDIR && procfs::root_only(st.st_uid, st.st_mode));
        let parent_ok = dir == b"/" || self.root_only(parent_of(dir));
        if ok && parent_ok {
            self.0.push(dir.to_vec());
        }
        ok && parent_ok
    }

    /// Is the file at `path` (whose `stat` is `st`) a regular file only root can change, in a folder only root can?
    fn file_root_only(&mut self, path: &[u8], st: &libc::stat) -> bool {
        st.st_mode & libc::S_IFMT == libc::S_IFREG && procfs::root_only(st.st_uid, st.st_mode) && self.root_only(parent_of(path))
    }
}

/// The folder a path lies in (`/` for a file at the root).
fn parent_of(path: &[u8]) -> &[u8] {
    match path.iter().rposition(|&b| b == b'/') {
        Some(0) | None => b"/",
        Some(i) => &path[..i],
    }
}

/// Is `pid`'s executable the client's file: the file `exe` names now, or, after a package upgrade
/// replaced it under a running Kea, its old inode, shown as that path and ` (deleted)`, at any link count (dpkg keeps a
/// `.dpkg-tmp` link to it for a moment). `checked` also wants it, and every folder above it, root's alone.
fn same_executable(pid: i32, exe: &[u8], checked: bool, chains: &mut Chains) -> Result<(), u8> {
    let link_path = proc_path(pid, "exe");
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(c(&link_path), &mut st) } != 0 {
        return Err(R_UNREADABLE);
    }
    let mut link = [0u8; LINK_MAX];
    let n = readlink_into(&link_path, &mut link).ok_or(R_UNREADABLE)?;
    let now = stat_bytes(exe);
    let same = now.is_some_and(|w| (w.st_dev, w.st_ino) == (st.st_dev, st.st_ino));
    let upgraded = !same && link[..n].strip_suffix(b" (deleted)") == Some(exe);
    if !same && !upgraded {
        return Err(R_EXE);
    }
    if checked && !chains.file_root_only(exe, &st) {
        return Err(R_OWNER);
    }
    Ok(())
}

/// Every executable mapping of `pid` names a file only root can change, in a folder only root can, and none is code
/// from memory. A file deleted or replaced since it was mapped (a library a system update replaced) is
/// judged by its folder: only root can have put a file there.
fn mappings_root_only(pid: i32, chains: &mut Chains) -> Result<(), u8> {
    let maps = std::fs::read(format!("/proc/{pid}/maps")).map_err(|_| R_UNREADABLE)?;
    // the mapping just judged: the next one of the same file (a library's segments) is judged alike
    let mut last: Option<(&[u8], u64, bool)> = None;
    for m in procfs::exec_mappings(&maps) {
        match m {
            procfs::ExecMapping::Anonymous => {}
            procfs::ExecMapping::Memfd => return Err(R_MEMFD),
            procfs::ExecMapping::Other => return Err(R_MAPS),
            procfs::ExecMapping::File { path, ino, deleted } => {
                if last == Some((path, ino, deleted)) {
                    continue;
                }
                last = Some((path, ino, deleted));
                let ok = match stat_bytes(path) {
                    // the file mapped is the one at that path (by inode: btrfs reports another device in `maps`)
                    Some(st) if !deleted && st.st_ino == ino => chains.file_root_only(path, &st),
                    _ => chains.root_only(parent_of(path)),
                };
                if !ok {
                    return Err(R_MAPS);
                }
            }
        }
    }
    Ok(())
}

/// The command line of `pid` (as its `cmdline` reads, Chromium's rewritten title included).
fn cmdline_of(pid: i32) -> Result<Vec<u8>, u8> {
    std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|_| R_UNREADABLE)
}

/// The identity checks on the peer `pid`: its executable is the client's; unless `checked` is off
/// (`--client-exe-unchecked`: the file's identity only), its command line names ptyhost, its parent is Kea's main (the
/// same file), and every executable mapping of both is root's. The parent is read before and after: a parent that
/// changed (it exited and its pid was reused) is refused.
pub fn check_identity(exe: &[u8], checked: bool, pid: i32) -> Result<(), u8> {
    let mut chains = Chains(Vec::new());
    same_executable(pid, exe, checked, &mut chains)?;
    if !checked {
        return Ok(());
    }
    if !procfs::names_node_service(&cmdline_of(pid)?) {
        return Err(R_TITLE);
    }
    let parent = stat_of(pid).map_err(|_| R_UNREADABLE)?.ppid;
    let parent_start = stat_of(parent).map_err(|_| R_PARENT)?.starttime;
    same_executable(parent, exe, checked, &mut chains).map_err(|e| if e == R_UNREADABLE { e } else { R_PARENT })?;
    mappings_root_only(pid, &mut chains)?;
    mappings_root_only(parent, &mut chains)?;
    let still = stat_of(pid).is_ok_and(|s| s.ppid == parent) && stat_of(parent).is_ok_and(|s| s.starttime == parent_start);
    if still { Ok(()) } else { Err(R_UNREADABLE) }
}

/// Client admission: the peer's uid (`SO_PEERCRED`), then its executable identity, checked at accept (measured at about
/// 0.6 ms) and answered at once on a verdict pipe, so the admission slots (`admission.rs`) only ever hold a decided
/// check for a moment.
pub struct PeerAdmission {
    exe: Vec<u8>,
    checked: bool,
}

impl PeerAdmission {
    /// `--client-exe` must name a regular file that only root can change, in folders only root can (ptyhost passes it
    /// only then; anything else fails the spawn rather than refuse every client); `--client-exe-unchecked`, any
    /// regular file. A code requirement (`--client-req`) is macOS's.
    pub fn new(client: &Client) -> Result<Self, String> {
        let Client::Exe { path, checked } = client else {
            return Err("--client-req is a macOS code requirement: on Linux a holder admits its client by its executable, --client-exe or --client-exe-unchecked".into());
        };
        let exe = path.as_os_str().as_bytes().to_vec();
        let st = stat_bytes(&exe).ok_or_else(|| format!("--client-exe {}: {}", path.display(), io::Error::last_os_error()))?;
        if st.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(format!("--client-exe {} is not a regular file", path.display()));
        }
        if *checked && !Chains(Vec::new()).file_root_only(&exe, &st) {
            return Err(format!("--client-exe {}, or a folder above it, can be changed by someone other than root: pass --client-exe-unchecked", path.display()));
        }
        Ok(PeerAdmission { exe, checked: *checked })
    }

    /// The verdict on the peer of `fd`: `check_identity`, with the peer held still. Where the kernel gives a
    /// pidfd (`SO_PEERPIDFD`) the peer must still be alive behind it after the checks; otherwise its start time must be
    /// the same before and after (so a pid reused meanwhile is never the one judged).
    fn verdict(&self, fd: RawFd) -> Result<(), u8> {
        let (_, pid) = peer_cred(fd).ok_or(R_UNREADABLE)?;
        let pidfd = peer_pidfd(fd).map_err(|()| R_UNREADABLE)?;
        let before = stat_of(pid).map_err(|_| R_UNREADABLE)?.starttime;
        check_identity(&self.exe, self.checked, pid)?;
        let same = match &pidfd {
            Some(p) => !pidfd_exited(p),
            None => stat_of(pid).is_ok_and(|s| s.starttime == before),
        };
        if same { Ok(()) } else { Err(R_UNREADABLE) }
    }
}

impl PeerCheck for PeerAdmission {
    fn peer_uid(&self, fd: RawFd) -> Option<u32> {
        peer_cred(fd).map(|(uid, _)| uid)
    }

    fn start_check(&self, fd: RawFd) -> Option<Check> {
        let answer = match self.verdict(fd) {
            Ok(()) => [ADMIT, 0],
            Err(code) => [REFUSE, code],
        };
        let (rd, wr) = pipe_cloexec().ok()?;
        let n = if answer[0] == ADMIT { 1 } else { 2 };
        write_all(wr.as_raw_fd(), &answer[..n]).ok()?;
        Some(Check { verdict: rd, pid: None })
    }

    /// Gone before its verdict: its end is closed or shut (`POLLHUP`, `POLLRDHUP`), its pidfd polls readable, or its
    /// process is a zombie, dead or exiting.
    fn peer_exiting(&self, fd: RawFd) -> bool {
        if hung_up(fd) {
            return true;
        }
        let Some((_, pid)) = peer_cred(fd) else { return true };
        match peer_pidfd(fd) {
            Err(()) => true,
            Ok(Some(p)) if pidfd_exited(&p) => true,
            _ => stat_of(pid).map_or(true, |s| s.exiting()),
        }
    }
}

/// Can the peer still be checked? Its credentials are there and its end is not closed (a stub check in the tests asks
/// this, as the real check reads the peer's process).
pub fn peer_checkable(fd: RawFd) -> bool {
    peer_cred(fd).is_some() && !hung_up(fd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::fd::FromRawFd;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::admission::{Admission, Decision, Refused};

    /// A child leading a process group of its own; the whole group is killed and the child reaped when the test ends,
    /// passed or failed.
    struct Kid(Child);

    impl Kid {
        fn pid(&self) -> i32 {
            self.0.id() as i32
        }
    }

    impl Drop for Kid {
        fn drop(&mut self) {
            unsafe { libc::kill(-self.pid(), libc::SIGKILL) };
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn spawn(cmd: &mut Command) -> Kid {
        Kid(cmd.process_group(0).stdin(Stdio::null()).spawn().unwrap())
    }

    // `ports --all` on this system: this process's own listeners, v4 and v6, with its pid; a connected socket is
    // none; every line it prints has the `ports` form, with `-` only for a pid it could not name.
    #[test]
    fn r_plt_7_ports_all_names_this_users_listeners_with_their_pid() {
        let me = std::process::id() as i32;
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let v6 = std::net::TcpListener::bind("[::1]:0").unwrap();
        let (p4, p6) = (v4.local_addr().unwrap().port(), v6.local_addr().unwrap().port());
        let client = std::net::TcpStream::connect(("127.0.0.1", p4)).unwrap();
        let client_port = client.local_addr().unwrap().port();
        let all = all_listeners().unwrap();
        assert!(all.contains(&(Some(me), Listening { v6: false, addr: "127.0.0.1".into(), port: p4 })), "{all:?}");
        assert!(all.contains(&(Some(me), Listening { v6: true, addr: "::1".into(), port: p6 })), "{all:?}");
        assert!(!all.iter().any(|(_, l)| l.port == client_port), "a connected socket is no listener: {all:?}");
        assert!(!all.iter().any(|(pid, l)| pid.is_none() && (l.port == p4 || l.port == p6)), "this user's listener is never another user's");
        assert_eq!(crate::ports::all_line(Some(me), &Listening { v6: false, addr: "127.0.0.1".into(), port: p4 }), format!("{me} tcp4 127.0.0.1 {p4}"));
        assert_eq!(crate::ports::all_line(None, &Listening { v6: true, addr: "::".into(), port: 22 }), "- tcp6 :: 22");
        drop((v4, v6, client));
    }

    /// A small process tree: `sh` (the root) starts `a`, a shell whose child `g` sleeps, and `o`, a sleep its subshell
    /// double-forks and leaves to be adopted; every pid is printed before the root waits. Returns the root and
    /// (a, g, o), or `None` when the launch printed nothing (a `systemd-run` that could not start a scope).
    fn zoo(launch: &[&str]) -> Option<(Kid, [i32; 3])> {
        const SCRIPT: &str = r#"sh -c 'sleep 600 & echo "g $!"; wait' & echo "a $!"; o=$(sleep 601 >/dev/null 2>&1 & echo $!); echo "o $o"; wait"#;
        let mut cmd = Command::new(launch.first().copied().unwrap_or("/bin/sh"));
        cmd.args(launch.iter().skip(1)).args(if launch.is_empty() { &["-c", SCRIPT][..] } else { &["/bin/sh", "-c", SCRIPT][..] });
        let mut kid = Kid(cmd.process_group(0).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap());
        let mut lines = BufReader::new(kid.0.stdout.take().unwrap());
        let mut pids = [0i32; 3];
        while pids.contains(&0) {
            let mut line = String::new();
            if lines.read_line(&mut line).unwrap() == 0 {
                return None;
            }
            let (role, pid) = line.trim().split_once(' ').unwrap();
            pids["ago".find(role).unwrap()] = pid.parse().unwrap();
        }
        Some((kid, pids))
    }

    fn sorted(mut v: Vec<i32>) -> Vec<i32> {
        v.sort_unstable();
        v
    }

    fn now_us() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64
    }

    // Session mode: the ppid map reaches every descendant, children and grandchildren; a double-forked process
    // has left the tree (the scope below is what finds it). STAT's path allocates nothing (R-HLD-6).
    #[test]
    fn r_plt_1_session_mode_finds_children_and_grandchildren_but_not_a_double_fork_and_allocates_nothing() {
        let (root, [a, g, o]) = zoo(&[]).unwrap();
        let mut scan = ProcScan::of(None);
        let mut out = Vec::with_capacity(64);
        let mut name = [0u8; 256];
        let mut cwd = [0u8; LINK_MAX];
        let ((), allocations) = crate::test_alloc::count(|| {
            scan.descendants_into(root.pid(), &mut out);
            let _ = name_into(g, &mut name);
            let _ = cwd_into(g, &mut cwd);
        });
        assert_eq!(allocations, 0, "STAT's reads allocate nothing");
        assert_eq!(sorted(out.clone()), sorted(vec![a, g]), "children and grandchildren; o ({o}) was adopted");
        assert_ne!(proc_info(o).unwrap().ppid, root.pid());
        let mut one = Vec::with_capacity(1);
        scan.descendants_into(root.pid(), &mut one);
        assert_eq!(one, [a], "never past the buffer's capacity, nearest first");
        let mut kids = [0i32; 4];
        let n = children_into(root.pid(), &mut kids);
        assert_eq!(&kids[..n], [a]);
        assert!(scan.candidates().unwrap().contains(&o), "TERMINATE's candidates: every pid");
    }

    // In a scope of its own the terminal's processes are the scope's members, double forks included. Needs a
    // systemd user manager: the scope is started with `systemd-run --user --scope` (skipped, and said so, without one).
    #[test]
    fn r_plt_1_in_a_scope_every_member_counts_double_forks_included() {
        let run = ["/usr/bin/systemd-run", "/bin/systemd-run"].into_iter().find(|p| Path::new(p).exists());
        let id = format!("rplt1-{}", std::process::id());
        let unit = format!("--unit=kea-0badf00d-{id}");
        let launched = run.and_then(|run| zoo(&[run, "--user", "--scope", "--collect", "--quiet", &unit, "--"]));
        let Some((root, [a, g, o])) = launched else {
            println!("skipped: no systemd user manager here (systemd-run --user --scope did not start)");
            return;
        };
        let cg = std::fs::read(format!("/proc/{}/cgroup", root.pid())).unwrap();
        let path = procfs::cgroup_v2_path(&cg).unwrap();
        assert!(procfs::is_own_scope(path, &id), "{}", String::from_utf8_lossy(path));
        let mut scan = ProcScan::of(Some(path));
        let mut out = Vec::with_capacity(64);
        let ((), allocations) = crate::test_alloc::count(|| scan.descendants_into(root.pid(), &mut out));
        assert_eq!(allocations, 0);
        assert_eq!(sorted(out), sorted(vec![a, g, o]), "every member but the root, the adopted one too");
        assert_eq!(sorted(scan.candidates().unwrap()), sorted(vec![root.pid(), a, g, o]));
    }

    // A scope whose `cgroup.procs` cannot be read (a hybrid cgroup hierarchy, a cgroup namespace): the holder still left
    // Kea in a scope, and finds its processes as in session mode, never none (TERMINATE would then reach no one).
    #[test]
    fn r_plt_1_a_scope_whose_members_cannot_be_read_is_scanned_as_a_session() {
        let (root, [a, g, _o]) = zoo(&[]).unwrap();
        let mut scan = ProcScan::of(Some(b"/kea-0badf00d-nosuchscop.scope"));
        assert_eq!(scan.detach(false), Some("scope"), "it is in a scope all the same");
        let mut out = Vec::with_capacity(64);
        scan.descendants_into(root.pid(), &mut out);
        assert_eq!(sorted(out), sorted(vec![a, g]), "STAT: the session-mode descendants");
        assert!(scan.candidates().is_ok_and(|c| c.contains(&a) && c.contains(&g)), "TERMINATE's candidates: every pid");
    }

    // proc_info: identity, the start time both ways and `kea-helper procs`'s value; the controlling terminal and a
    // descriptor's device agree (`tty_nr` is the low 32 bits of `st_rdev`).
    #[test]
    fn r_plt_1_proc_info_reads_identity_start_time_and_controlling_terminal() {
        let me = proc_info(unsafe { libc::getpid() }).unwrap();
        assert_eq!((me.ppid, me.pgid, me.uid), (unsafe { libc::getppid() }, unsafe { libc::getpgrp() }, unsafe { libc::geteuid() }));
        assert!(!me.exiting);

        let (mut master, mut slave) = (0, 0);
        assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), std::ptr::null()) }, 0);
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        let before = now_us();
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("600").stdin(slave.try_clone().unwrap()).stdout(Stdio::null());
        // SAFETY: async-signal-safe calls only, between fork and exec
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let kid = Kid(cmd.spawn().unwrap());
        let after = now_us();
        let info = proc_info(kid.pid()).unwrap();
        let rdev = fd_char_rdev(unsafe { libc::getpid() }, slave.as_raw_fd()).unwrap();
        assert_eq!(info.tdev, rdev, "tty_nr is the slave's device");
        assert_eq!(fd_char_rdev(kid.pid(), 0), Some(rdev));
        assert!(fd_char_rdev(unsafe { libc::getpid() }, master.as_raw_fd()).is_some(), "the master is a character device too");
        let file = std::fs::File::open("/proc/self/stat").unwrap();
        assert_eq!(fd_char_rdev(unsafe { libc::getpid() }, file.as_raw_fd()), None, "not a character device");
        assert_eq!((info.ppid, info.pgid, info.uid), (unsafe { libc::getpid() }, kid.pid(), me.uid));
        assert_eq!(info.start, stat_of(kid.pid()).unwrap().starttime);
        // btime is whole seconds and starttime whole ticks: the derived time is at most a second and a tick early
        assert!(info.start_us + 1_100_000 >= before && info.start_us <= after, "{} not in {before}..{after}", info.start_us);
        let row = processes(Some(&[kid.pid()])).unwrap();
        assert_eq!(row.len(), 1);
        assert_eq!(row[0].start_us, info.start_us, "procs and the state json take one source");
        assert!(proc_info(0).is_err() && proc_info(i32::MAX).is_err());
    }

    // The name for a tab title is the executable's basename, past comm's 15 characters, even once the file is
    // deleted; a removed working directory is none; a zombie is `exiting` and named by its comm. The named process is a
    // copy of `sh` that says so once it runs, then stops itself: `spawn` can return while the kernel is still installing
    // the new program (glibc's `posix_spawn` resumes the parent before `/proc/<pid>/exe` and `comm` change).
    #[test]
    fn r_plt_1_name_cwd_and_a_zombie() {
        let dir = tempfile::Builder::new().prefix("khL").tempdir_in("/tmp").unwrap();
        let exe = dir.path().join("sh-with-a-long-name");
        std::fs::copy("/bin/sh", &exe).unwrap();
        let mut cmd = Command::new(&exe);
        cmd.args(["-c", "echo ran; kill -STOP $$"]).current_dir(dir.path()).process_group(0).stdin(Stdio::null()).stdout(Stdio::piped());
        // another test's fork may still hold the copy open for writing until it execs (ETXTBSY): try again at once
        let child = (0..100).find_map(|_| match cmd.spawn() {
            Err(e) if e.kind() == io::ErrorKind::ExecutableFileBusy => None,
            r => Some(r.unwrap()),
        });
        let mut kid = Kid(child.expect("the copy stayed busy"));
        let mut ran = String::new();
        BufReader::new(kid.0.stdout.take().unwrap()).read_line(&mut ran).unwrap();
        assert_eq!(ran, "ran\n");
        let mut buf = [0u8; LINK_MAX];
        let n = name_into(kid.pid(), &mut buf);
        assert_eq!(&buf[..n], b"sh-with-a-long-name");
        let comm = std::fs::read(format!("/proc/{}/comm", kid.pid())).unwrap();
        assert_eq!(comm, b"sh-with-a-long-\n", "comm alone would cut it");
        let n = cwd_into(kid.pid(), &mut buf);
        assert_eq!(&buf[..n], std::fs::canonicalize(dir.path()).unwrap().as_os_str().as_bytes());
        assert_eq!(cwd_into(kid.pid(), &mut buf[..4]), 0, "cut off: none");
        std::fs::remove_file(&exe).unwrap();
        let path = dir.path().to_path_buf();
        dir.close().unwrap();
        assert!(!path.exists());
        assert_eq!(cwd_into(kid.pid(), &mut buf), 0, "a deleted directory is none");
        let n = name_into(kid.pid(), &mut buf);
        assert_eq!(&buf[..n], b"sh-with-a-long-name", "a deleted executable keeps its name");

        let zombie = spawn(Command::new("/bin/sh").args(["-c", "exit 0"]));
        let mut si: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // waits for its exit and leaves it a zombie (WNOWAIT): no polling
        assert_eq!(unsafe { libc::waitid(libc::P_PID, zombie.pid() as libc::id_t, &mut si, libc::WEXITED | libc::WNOWAIT) }, 0);
        assert!(proc_info(zombie.pid()).unwrap().exiting);
        let n = name_into(zombie.pid(), &mut buf);
        assert_eq!(&buf[..n], b"sh", "no executable to read: its comm");
        assert_eq!(cwd_into(zombie.pid(), &mut buf), 0);
    }

    // A signal reaches a member only while its start time still matches the snapshot's (a reused pid never does).
    #[test]
    fn r_plt_1_kill_member_signals_only_the_process_the_snapshot_saw() {
        let mut kid = spawn(Command::new("/bin/sleep").arg("600"));
        let start = proc_info(kid.pid()).unwrap().start;
        assert!(!kill_member(kid.pid(), start + 1, libc::SIGTERM), "another start time: another process");
        assert!(proc_info(kid.pid()).is_ok_and(|i| !i.exiting));
        assert!(kill_member(kid.pid(), start, libc::SIGTERM));
        assert_eq!(kid.0.wait().unwrap().signal(), Some(libc::SIGTERM));
        assert!(!kill_member(kid.pid(), start, libc::SIGTERM), "reaped: nothing to signal");
    }

    // The detached launch with glibc's flags: a session of its own with no controlling terminal, stdio
    // on /dev/null, the ready pipe on its fd and no other descriptor (a stray one without close-on-exec included), every
    // signal unblocked and at its default (this test process ignores SIGPIPE, as every Rust program does, and the
    // spawning thread blocks SIGUSR2). Read from outside, in `/proc`, once the child (a shell) has stopped itself: glibc's
    // `posix_spawn` returns while the new program is still being loaded, its loader's files still open. The holder
    // tests (tests/holder.rs, I-PLT-1) reach it through the launcher.
    #[test]
    fn r_plt_4_the_detached_launch_is_a_session_leader_holding_only_its_ready_pipe() {
        let (rd, wr) = crate::sys::pipe_cloexec().unwrap();
        let file = std::fs::File::open("/proc/self/stat").unwrap();
        let stray = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 10) }; // no close-on-exec
        assert!(stray >= 10);
        let argv: Vec<CString> = ["/bin/sh", "-c", "kill -STOP $$"].iter().map(|a| CString::new(*a).unwrap()).collect();
        let mut ptrs: Vec<*const c_char> = argv.iter().map(|a| a.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let (mut usr2, mut was) = unsafe { (std::mem::zeroed::<libc::sigset_t>(), std::mem::zeroed::<libc::sigset_t>()) };
        let pid = unsafe {
            libc::sigemptyset(&mut usr2);
            libc::sigaddset(&mut usr2, libc::SIGUSR2);
            libc::pthread_sigmask(libc::SIG_BLOCK, &usr2, &mut was);
            let pid = spawn_detached(&argv[0], &ptrs, &wr, 3);
            libc::pthread_sigmask(libc::SIG_SETMASK, &was, std::ptr::null_mut());
            libc::close(stray);
            pid.unwrap()
        };
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, libc::WUNTRACED) }, pid);
        assert!(libc::WIFSTOPPED(status), "status {status:#x}");
        let link = |fd: i32| std::fs::read_link(format!("/proc/{pid}/fd/{fd}")).map(|l| l.into_os_string().into_string().unwrap());
        let seen = (|| {
            let st = stat_of(pid)?;
            let fds = sorted(open_fds(pid)?);
            let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
            let sig = |name: &str| status.lines().find(|l| l.starts_with(name)).map(str::to_owned);
            io::Result::Ok(((st.session, st.tty_nr), fds, [link(0)?, link(1)?, link(2)?, link(3)?], [sig("SigBlk:"), sig("SigIgn:")]))
        })();
        unsafe { libc::kill(pid, libc::SIGKILL) };
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        let pipe = format!("pipe:[{}]", std::fs::metadata(format!("/proc/self/fd/{}", rd.as_raw_fd())).unwrap().ino());
        let (session, fds, links, sigs) = seen.unwrap();
        assert_eq!(session, (pid, 0), "a session of its own, no controlling terminal");
        assert_eq!(fds, [0, 1, 2, 3], "stdio and the ready pipe only");
        assert_eq!(links, ["/dev/null", "/dev/null", "/dev/null", pipe.as_str()]);
        let none = "0000000000000000";
        assert_eq!(sigs, [Some(format!("SigBlk:\t{none}")), Some(format!("SigIgn:\t{none}"))], "nothing blocked, nothing ignored");
        drop(wr);
    }

    // ── R-PLT-2: admission by the client's executable ───────────

    /// The stand-in for Kea's executable: Python, a root-owned interpreter every distribution has. As `parent` it is a
    /// Kea main starting its peer, as Kea's main forks ptyhost (the peer gets `KEA_CHILD_PRELOAD` as its `LD_PRELOAD`,
    /// never the parent's own); as `peer` it maps an executable memfd first when `KEA_MEMFD` is set, connects to the
    /// socket and waits until the connection is closed. The arguments after the socket (the utility title) are the
    /// peer's.
    const PEER_PY: &str = r#"
import mmap, os, socket, subprocess, sys
RUN = "import os; exec(os.environ['KEA_PEER_PY'])"
role, sock, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
if role == 'parent':
    env = dict(os.environ)
    env.pop('LD_PRELOAD', None)
    if 'KEA_CHILD_PRELOAD' in env:
        env['LD_PRELOAD'] = env.pop('KEA_CHILD_PRELOAD')
    sys.exit(subprocess.call([sys.executable, '-c', RUN, 'peer', sock, *rest], env=env))
if os.environ.get('KEA_MEMFD'):
    fd = os.memfd_create('code')
    os.write(fd, bytes(mmap.PAGESIZE))
    code = mmap.mmap(fd, mmap.PAGESIZE, prot=mmap.PROT_READ | mmap.PROT_EXEC)
s = socket.socket(socket.AF_UNIX)
s.connect(sock)
s.recv(1)
"#;
    /// What `-c` runs: the script, from the environment, so a parent passes it on unchanged.
    const RUN_PEER_PY: &str = "import os; exec(os.environ['KEA_PEER_PY'])";
    /// ptyhost's title as Chromium rewrites it.
    const TITLE: &[&str] = &["--type=utility", "--utility-sub-type=node.mojom.NodeService"];
    /// Upper bound for a peer to start and connect.
    const WAIT: std::time::Duration = std::time::Duration::from_secs(30);

    /// The interpreter behind `/usr/bin/python3`, or `None` (the test then says it skipped).
    fn python3() -> Option<PathBuf> {
        std::fs::canonicalize("/usr/bin/python3").ok()
    }

    /// A listening socket in a private folder of its own, which peers connect to one after another.
    struct Door {
        path: PathBuf,
        listener: std::os::unix::net::UnixListener,
        dir: tempfile::TempDir,
    }

    fn door() -> Door {
        let dir = tempfile::Builder::new().prefix("khA").tempdir_in("/tmp").unwrap();
        let path = dir.path().join("s");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        Door { path, listener, dir }
    }

    impl Door {
        /// The next connection, waited for (a peer that failed to start never connects).
        fn accept(&self) -> OwnedFd {
            let mut p = libc::pollfd { fd: self.listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            assert_eq!(unsafe { libc::poll(&mut p, 1, WAIT.as_millis() as i32) }, 1, "the peer never connected");
            OwnedFd::from(self.listener.accept().unwrap().0)
        }
    }

    /// Spawns `cmd` in a process group of its own; a copied executable that another test's fork still holds open for
    /// writing until it execs (`ETXTBSY`) is tried again at once.
    fn spawn_copy(cmd: &mut Command) -> Kid {
        cmd.process_group(0).stdin(Stdio::null());
        let child = (0..100).find_map(|_| match cmd.spawn() {
            Err(e) if e.kind() == io::ErrorKind::ExecutableFileBusy => None,
            r => Some(r.unwrap()),
        });
        Kid(child.expect("the copy stayed busy"))
    }

    /// `exe` running `PEER_PY` as `role` towards `door`, with `args` after the socket and `env` added.
    fn python(exe: &Path, role: &str, door: &Door, args: &[&str], env: &[(&str, &str)]) -> Kid {
        let mut cmd = Command::new(exe);
        cmd.args(["-c", RUN_PEER_PY, role]).arg(&door.path).args(args);
        cmd.env_remove("LD_PRELOAD").env("KEA_PEER_PY", PEER_PY).env("PYTHONHOME", "/usr").envs(env.iter().copied());
        spawn_copy(cmd.current_dir("/").stdout(Stdio::null()).stderr(Stdio::null()))
    }

    /// The peer's pid on `conn` (`SO_PEERCRED`).
    fn peer_pid(conn: &OwnedFd) -> i32 {
        peer_cred(conn.as_raw_fd()).unwrap().1
    }

    /// What the holder makes of `conn` when its client is `exe`: the admission state machine with the
    /// executable check.
    fn judge(exe: &Path, checked: bool, conn: OwnedFd) -> Result<(), Refused> {
        let peer = PeerAdmission::new(&Client::Exe { path: exe.to_owned(), checked }).unwrap();
        let mut a = Admission::new(peer, unsafe { libc::geteuid() });
        a.begin(conn, 0).map_err(|r| r.why)?;
        match a.next_decision(0) {
            Some(Decision::Admit(_)) => Ok(()),
            Some(Decision::Refuse(r)) => Err(r.why),
            other => panic!("no verdict at accept: {other:?}"),
        }
    }

    /// A copy of a library this test maps (libgcc_s, which Rust's unwinder loads) in `dir`, which its user can change.
    fn writable_library(dir: &Path) -> PathBuf {
        let maps = std::fs::read("/proc/self/maps").unwrap();
        let lib = procfs::exec_mappings(&maps)
            .find_map(|m| match m {
                procfs::ExecMapping::File { path, .. } if path.ends_with(b"/libgcc_s.so.1") => Some(std::ffi::OsStr::from_bytes(path).to_owned()),
                _ => None,
            })
            .expect("libgcc_s mapped in the test");
        let to = dir.join("libpreload.so");
        std::fs::copy(lib, &to).unwrap();
        to
    }

    /// A package upgrade of the file at `exe` under a running process: a new inode renamed over it, the old one keeping
    /// `links` other names (dpkg's `.dpkg-tmp` is 1; it is gone a moment later, 0).
    fn upgrade(exe: &Path, from: &Path, links: u64) {
        let new = exe.with_extension("dpkg-new");
        std::fs::copy(from, &new).unwrap();
        if links == 1 {
            std::fs::hard_link(exe, exe.with_extension("dpkg-tmp")).unwrap();
        }
        std::fs::rename(&new, exe).unwrap();
    }

    /// The peer's executable is the old inode, shown deleted, with `links` names left.
    fn assert_upgraded(pid: i32, exe: &Path, links: u64) {
        let link = std::fs::read_link(format!("/proc/{pid}/exe")).unwrap();
        assert_eq!(link.as_os_str().as_bytes(), [exe.as_os_str().as_bytes(), b" (deleted)"].concat());
        assert_eq!(std::fs::metadata(format!("/proc/{pid}/exe")).unwrap().nlink(), links);
    }

    // A root-owned "Kea" (Python) admits its ptyhost (the utility title, Kea's main as its parent, root's code only)
    // and refuses another executable, a process of Kea's without the title, a utility whose parent is not Kea's main,
    // a user-writable library from LD_PRELOAD mapped in the peer or only in its parent, an executable memfd, and a
    // user-writable copy of Kea's executable.
    #[test]
    fn r_plt_2_admission_by_the_executable_refuses_every_foreign_code_path() {
        let Some(py) = python3() else {
            println!("skipped: no /usr/bin/python3 to stand in for Kea's executable");
            return;
        };
        let d = door();
        let lib = writable_library(d.dir.path());
        let lib = lib.to_str().unwrap();
        let sh = std::fs::canonicalize("/bin/sh").unwrap();
        let cases: [(&str, &str, &[&str], &[(&str, &str)], &Path, Result<(), Refused>); 7] = [
            ("ptyhost", "parent", TITLE, &[], &py, Ok(())),
            ("another executable", "parent", TITLE, &[], &sh, Err(Refused::Identity(R_EXE))),
            ("no utility title", "parent", &[], &[], &py, Err(Refused::Identity(R_TITLE))),
            ("not Kea's main above it", "peer", TITLE, &[], &py, Err(Refused::Identity(R_PARENT))),
            ("LD_PRELOAD in the peer", "parent", TITLE, &[("KEA_CHILD_PRELOAD", lib)], &py, Err(Refused::Identity(R_MAPS))),
            ("LD_PRELOAD in its parent only", "parent", TITLE, &[("LD_PRELOAD", lib)], &py, Err(Refused::Identity(R_MAPS))),
            ("an executable memfd", "parent", TITLE, &[("KEA_MEMFD", "1")], &py, Err(Refused::Identity(R_MEMFD))),
        ];
        for (what, role, args, env, exe, want) in cases {
            let _kid = python(&py, role, &d, args, env);
            let conn = d.accept();
            let pid = peer_pid(&conn);
            let maps = std::fs::read_to_string(format!("/proc/{pid}/maps")).unwrap();
            assert_eq!(maps.contains("libpreload"), what == "LD_PRELOAD in the peer", "{what}: the library is where the case puts it");
            assert_eq!(judge(exe, true, conn), want, "{what}");
        }

        // A copy of Kea's executable its user can change: no checked holder starts for it, and a peer running it fails
        // the ownership check
        let copy = d.dir.path().join("kea");
        std::fs::copy(&py, &copy).unwrap();
        let err = PeerAdmission::new(&Client::Exe { path: copy.clone(), checked: true }).err().unwrap();
        assert!(err.contains("pass --client-exe-unchecked"), "{err}");
        let _kid = python(&copy, "parent", &d, TITLE, &[]);
        let conn = d.accept();
        assert_eq!(check_identity(copy.as_os_str().as_bytes(), true, peer_pid(&conn)), Err(R_OWNER));
    }

    // `--client-exe-unchecked` (a development build): the file's identity only, so a user-writable copy is
    // admitted with no title, the test as its parent and a user-writable library preloaded; after an upgrade replaced
    // it under the peer, the old inode is still the client, at link count 0 and 1.
    #[test]
    fn r_plt_2_unchecked_admits_by_identity_alone_and_the_pre_upgrade_inode() {
        let Some(py) = python3() else {
            println!("skipped: no /usr/bin/python3 to stand in for Kea's executable");
            return;
        };
        let d = door();
        let lib = writable_library(d.dir.path());
        let copy = d.dir.path().join("kea");
        std::fs::copy(&py, &copy).unwrap();
        let _kid = python(&copy, "peer", &d, &[], &[("LD_PRELOAD", lib.to_str().unwrap()), ("KEA_MEMFD", "1")]);
        assert_eq!(judge(&copy, false, d.accept()), Ok(()));
        for links in [0, 1] {
            let _kid = python(&copy, "peer", &d, &[], &[]);
            let conn = d.accept();
            upgrade(&copy, &py, links);
            assert_upgraded(peer_pid(&conn), &copy, links);
            assert_eq!(judge(&copy, false, conn), Ok(()), "the old inode at link count {links}");
            let _ = std::fs::remove_file(copy.with_extension("dpkg-tmp"));
        }
        let _other = python(&py, "peer", &d, &[], &[]);
        assert_eq!(judge(&copy, false, d.accept()), Err(Refused::Identity(R_EXE)), "another file is not the client");
    }

    /// Where Kea's own root-owned Electron for the admission tests is installed (tools/process-zoo/src/admission-app);
    /// a test without it skips.
    const KEA_TEST_APP: &str = "/opt/kea-test/kea-app";

    // The real thing: the root-owned Electron at /opt/kea-test runs the admission app, whose utility process (Node's
    // service, as ptyhost is) connects. It is admitted; its main, the same executable without the title, is not.
    #[test]
    fn r_plt_2_admits_ptyhost_of_a_root_owned_electron_by_its_rewritten_title() {
        if !Path::new(KEA_TEST_APP).exists() {
            println!("skipped: {KEA_TEST_APP} is not installed (tools/process-zoo/src/admission-app/README.md)");
            return;
        }
        let d = door();
        let dir = d.dir.path();
        let mut cmd = Command::new(KEA_TEST_APP);
        cmd.args(["--no-sandbox", "--ozone-platform=headless", "--disable-gpu"]).arg(format!("--user-data-dir={}", dir.join("data").display()));
        cmd.env("KEA_ADMISSION_SOCK", &d.path).env("KEA_ADMISSION_OUT", dir.join("out")).env("KEA_ADMISSION_RESULT", dir.join("result"));
        let _app = spawn(cmd.current_dir("/").stdout(Stdio::null()).stderr(Stdio::null()));
        let conn = d.accept();
        let utility = peer_pid(&conn);
        let main = stat_of(utility).unwrap().ppid;
        assert!(procfs::names_node_service(&std::fs::read(format!("/proc/{utility}/cmdline")).unwrap()));
        assert_eq!(judge(Path::new(KEA_TEST_APP), true, conn), Ok(()), "ptyhost is admitted");
        assert_eq!(check_identity(KEA_TEST_APP.as_bytes(), true, main), Err(R_TITLE), "Kea's main is not ptyhost");
    }

    // Root's part (run the test binary with sudo; skipped otherwise): a peer of another uid; Kea's executable 0775,
    // refused until it is 0755; and a checked holder's client upgraded by a package under its running peer, at link
    // count 0 and 1. The copies live in a root-only folder under /var/lib (/run is noexec).
    #[test]
    fn r_plt_2_as_root_another_uid_a_group_writable_kea_and_a_checked_upgrade() {
        let Some(py) = python3().filter(|_| unsafe { libc::geteuid() } == 0) else {
            println!("skipped: needs root (sudo the test binary) and /usr/bin/python3");
            return;
        };
        let d = door();
        std::fs::set_permissions(d.dir.path(), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&d.path, std::os::unix::fs::PermissionsExt::from_mode(0o777)).unwrap();
        let mut cmd = Command::new(&py);
        cmd.args(["-c", RUN_PEER_PY, "peer"]).arg(&d.path).env("KEA_PEER_PY", PEER_PY).current_dir("/").stdout(Stdio::null()).stderr(Stdio::null());
        let _nobody = spawn(cmd.uid(65534).gid(65534));
        assert_eq!(judge(&py, true, d.accept()), Err(Refused::Uid), "another uid's peer");

        let root = tempfile::Builder::new().prefix("kea-rplt2-").tempdir_in("/var/lib").unwrap();
        let kea = root.path().join("kea");
        std::fs::copy(&py, &kea).unwrap();
        std::fs::set_permissions(&kea, std::os::unix::fs::PermissionsExt::from_mode(0o775)).unwrap();
        let err = PeerAdmission::new(&Client::Exe { path: kea.clone(), checked: true }).err().unwrap();
        assert!(err.contains("pass --client-exe-unchecked"), "{err}");
        let _kid = python(&kea, "parent", &d, TITLE, &[]);
        let conn = d.accept();
        assert_eq!(check_identity(kea.as_os_str().as_bytes(), true, peer_pid(&conn)), Err(R_OWNER), "0775");
        std::fs::set_permissions(&kea, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert_eq!(judge(&kea, true, conn), Ok(()), "0755");

        for links in [0, 1] {
            let _kid = python(&kea, "parent", &d, TITLE, &[]);
            let conn = d.accept();
            let pid = peer_pid(&conn);
            upgrade(&kea, &py, links);
            assert_upgraded(pid, &kea, links);
            assert_upgraded(stat_of(pid).unwrap().ppid, &kea, links);
            assert_eq!(judge(&kea, true, conn), Ok(()), "the old inode at link count {links}");
            let _ = std::fs::remove_file(kea.with_extension("dpkg-tmp"));
        }
    }
}
