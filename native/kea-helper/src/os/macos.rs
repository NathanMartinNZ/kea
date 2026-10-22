//! macOS's side of the helper's OS layer (`mod.rs`): libproc (layouts checked against the macOS SDK's
//! `sys/proc_info.h`, sizes asserted in the tests below), Security.framework loaded at run time in a forked child,
//! `posix_spawn` with Apple's extensions, and the libc names only Apple has.

use std::ffi::{CStr, CString, c_void};
use std::io;
use std::mem::{MaybeUninit, size_of};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::panic::AssertUnwindSafe;

use super::procfs::Row;
use super::{Listening, ProcInfo};
use crate::admission::{ADMIT, Check, ERROR, PeerCheck, REFUSE};
use crate::args::Client;
use crate::limits::HOLDER_PEER_CHECK_TIMEOUT_MS;
use crate::sys::{cvt, errno, now_ms, pipe_cloexec, write_all};

/// Not Linux: `limits.rs` takes each number's macOS value.
pub const IS_LINUX: bool = false;

// ── libproc: process facts and the footprint ───────────────────────────────────────────────────

/// `struct proc_fileinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct ProcFileInfo {
    fi_openflags: u32,
    fi_status: u32,
    fi_offset: i64,
    fi_type: i32,
    fi_guardflags: u32,
}

/// `struct vnode_fdinfo` (`PROC_PIDFDVNODEINFO`).
#[repr(C)]
#[derive(Clone, Copy)]
struct VnodeFdInfo {
    pfi: ProcFileInfo,
    pvi: libc::vnode_info,
}

const PROC_PIDFDVNODEINFO: libc::c_int = 1;
const PROC_PIDFDSOCKETINFO: libc::c_int = 3;


/// `PROC_FLAG_INEXIT` (`<sys/proc_info.h>`): the process is working its way in `exit()`.
const PROC_FLAG_INEXIT: u32 = 4;
/// `SZOMB` (`<sys/proc.h>`): exited, not yet reaped.
const SZOMB: u32 = 5;

fn last_err() -> io::Error {
    io::Error::last_os_error()
}

/// `proc_pidinfo(PROC_PIDTBSDINFO)`.
pub fn proc_info(pid: i32) -> io::Result<ProcInfo> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if n != size {
        let e = last_err();
        return Err(if n <= 0 && e.raw_os_error().is_some_and(|c| c != 0) { e } else { io::Error::from_raw_os_error(libc::ESRCH) });
    }
    let i = unsafe { info.assume_init() };
    let start_us = i.pbi_start_tvsec * 1_000_000 + i.pbi_start_tvusec;
    Ok(ProcInfo {
        pid: i.pbi_pid as i32,
        ppid: i.pbi_ppid as i32,
        pgid: i.pbi_pgid as i32,
        uid: i.pbi_uid,
        tdev: i.e_tdev,
        start: start_us,
        start_us,
        exiting: i.pbi_flags & PROC_FLAG_INEXIT != 0 || i.pbi_status == SZOMB,
    })
}

/// Children of `pid` written into `out`; returns how many (at most `out.len()`).
pub fn children_into(pid: i32, out: &mut [i32]) -> usize {
    if out.is_empty() {
        return 0;
    }
    let size = size_of_val(out).min(libc::c_int::MAX as usize) as libc::c_int;
    let n = unsafe { libc::proc_listchildpids(pid, out.as_mut_ptr().cast(), size) };
    (n.max(0) as usize).min(out.len())
}

/// The terminal's processes: libproc needs nothing made at start.
pub struct ProcScan;

impl ProcScan {
    pub fn new(_pty_id: &str) -> ProcScan {
        ProcScan
    }

    /// How the holder left Kea, for its state json: macOS records none, since it has one way to detach (`posix_spawn`
    /// with SETSID).
    pub fn detach(&self, _no_detach: bool) -> Option<&'static str> {
        None
    }

    /// Every pid that may belong to the terminal, for `TERMINATE`'s snapshot: every pid on the system.
    pub fn candidates(&self) -> io::Result<Vec<i32>> {
        all_pids()
    }

    /// Every descendant of `root` (not `root` itself), breadth first, up to `out`'s capacity (`proc_listchildpids`).
    /// Allocation-free when `out` has capacity reserved.
    pub fn descendants_into(&mut self, root: i32, out: &mut Vec<i32>) {
        out.clear();
        let mut next = 0;
        let mut parent = root;
        loop {
            let len = out.len();
            let spare = out.spare_capacity_mut();
            if spare.is_empty() {
                return;
            }
            for slot in spare.iter_mut() {
                slot.write(0);
            }
            // SAFETY: every slot of the spare capacity was just initialised.
            let buf = unsafe { std::slice::from_raw_parts_mut(spare.as_mut_ptr().cast::<i32>(), spare.len()) };
            let n = children_into(parent, buf);
            // SAFETY: the first `n` spare slots are initialised (by the kernel's pids).
            unsafe { out.set_len(len + n) };
            if next >= out.len() {
                return;
            }
            parent = out[next];
            next += 1;
        }
    }
}

/// Sends `sig` to the member `pid`. macOS has no pidfd: `TERMINATE`'s second phase checks the start time just before
/// (`tree::alive`), its first phase signals the snapshot it has just taken.
pub fn kill_member(pid: i32, _start: u64, sig: libc::c_int) -> bool {
    unsafe { libc::kill(pid, sig) == 0 }
}

/// The raw start the state json records beside `pidStartTime`: macOS's start is µs since the epoch already, so none.
pub fn raw_start(_info: &ProcInfo) -> Option<u64> {
    None
}

/// Every pid on the system (`proc_listallpids`).
pub fn all_pids() -> io::Result<Vec<i32>> {
    let hint = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) }.max(0) as usize;
    let mut pids = vec![0i32; hint + 256];
    let size = (pids.len() * size_of::<i32>()) as libc::c_int;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), size) }.max(0) as usize;
    pids.truncate(n.min(pids.len()));
    pids.retain(|&p| p > 0);
    Ok(pids)
}

/// `proc_name` into `buf`; returns the length (0 when unknown).
pub fn name_into(pid: i32, buf: &mut [u8]) -> usize {
    if pid <= 0 {
        return 0;
    }
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n.max(0) as usize).min(buf.len())
}

/// Current directory of `pid` (`PROC_PIDVNODEPATHINFO`) into `buf`; returns the length (0 when unknown).
pub fn cwd_into(pid: i32, buf: &mut [u8]) -> usize {
    if pid <= 0 {
        return 0;
    }
    let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, info.as_mut_ptr().cast(), size) };
    if n != size {
        return 0;
    }
    let info = unsafe { info.assume_init_ref() };
    let path: &[libc::c_char] = info.pvi_cdir.vip_path.as_flattened();
    let len = path.iter().position(|&c| c == 0).unwrap_or(path.len()).min(buf.len());
    for (d, &s) in buf.iter_mut().zip(path.iter()).take(len) {
        *d = s as u8;
    }
    len
}

/// The device of `pid`'s descriptor `fd` when it is a character device (a tty).
pub fn fd_char_rdev(pid: i32, fd: i32) -> Option<u32> {
    let mut info = MaybeUninit::<VnodeFdInfo>::zeroed();
    let size = size_of::<VnodeFdInfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEINFO, info.as_mut_ptr().cast(), size) };
    if n != size {
        return None;
    }
    let st = unsafe { info.assume_init_ref() }.pvi.vi_stat;
    (st.vst_mode as libc::mode_t & libc::S_IFMT == libc::S_IFCHR).then_some(st.vst_rdev)
}

/// `ri_phys_footprint` of `pid`.
pub fn footprint(pid: i32) -> io::Result<u64> {
    let mut info = MaybeUninit::<libc::rusage_info_v0>::zeroed();
    let r = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V0, info.as_mut_ptr().cast()) };
    if r != 0 {
        let code = errno();
        return Err(io::Error::from_raw_os_error(if code == 0 { libc::ESRCH } else { code }));
    }
    Ok(unsafe { info.assume_init() }.ri_phys_footprint)
}

#[repr(C)]
struct Timebase {
    numer: u32,
    denom: u32,
}

unsafe extern "C" {
    fn mach_timebase_info(info: *mut Timebase) -> i32;
}

/// CPU time `pid` has used, user and system, in ns (`proc_pid_rusage` reports mach ticks on Apple silicon).
pub fn cpu_time_ns(pid: i32) -> io::Result<u64> {
    let mut ri = MaybeUninit::<libc::rusage_info_v0>::zeroed();
    if unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V0, ri.as_mut_ptr().cast()) } != 0 {
        let code = errno();
        return Err(io::Error::from_raw_os_error(if code == 0 { libc::ESRCH } else { code }));
    }
    let ri = unsafe { ri.assume_init() };
    let mut tb = Timebase { numer: 0, denom: 0 };
    unsafe { mach_timebase_info(&mut tb) };
    Ok((ri.ri_user_time + ri.ri_system_time) * tb.numer as u64 / tb.denom.max(1) as u64)
}

/// Open descriptors of `pid` (`PROC_PIDLISTFDS`).
fn list_fds(pid: i32) -> io::Result<Vec<libc::proc_fdinfo>> {
    let need = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if need <= 0 {
        let code = errno();
        return Err(io::Error::from_raw_os_error(if code == 0 { libc::ESRCH } else { code }));
    }
    let per = size_of::<libc::proc_fdinfo>();
    // Room for descriptors opened between the two calls.
    let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(need as usize / per + 32);
    let size = (fds.capacity() * per) as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), size) };
    if n <= 0 {
        let code = errno();
        return Err(io::Error::from_raw_os_error(if code == 0 { libc::ESRCH } else { code }));
    }
    unsafe { fds.set_len((n as usize / per).min(fds.capacity())) };
    Ok(fds)
}

/// The numbers of `pid`'s open descriptors.
pub fn open_fds(pid: i32) -> io::Result<Vec<i32>> {
    Ok(list_fds(pid)?.iter().map(|f| f.proc_fd).collect())
}

// ── `kea-helper procs` ────────────────────────────────────────────────────────────────────

/// The largest `KERN_PROCARGS2` answer (`kern.argmax`).
fn arg_max() -> usize {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut max: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    let r = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut max as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) };
    if r == 0 && max > 0 { max as usize } else { 1 << 20 }
}

/// The arguments of `pid` from `KERN_PROCARGS2` into `buf`: `argc` (a native int), the path it was executed by, NUL
/// padding, then `argc` NUL-terminated arguments and the environment. `argv[0]` is what `ps -o comm` prints (relative,
/// a symlink's, or another name altogether for a multi-call binary). `None` when it cannot be read (another user's
/// process, a zombie).
fn procargs(pid: i32, buf: &mut [u8]) -> Option<Vec<Vec<u8>>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buf.len();
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    let b = buf.get(..size)?;
    let argc = i32::from_ne_bytes(b.get(..4)?.try_into().ok()?);
    let rest = &b[4..];
    let end = rest.iter().position(|&c| c == 0)?;
    let mut i = end + rest[end..].iter().take_while(|&&c| c == 0).count();
    let mut argv = Vec::new();
    for _ in 0..argc.max(0) {
        let Some(n) = rest.get(i..).and_then(|r| r.iter().position(|&c| c == 0)) else { break };
        argv.push(rest[i..i + n].to_vec());
        i += n + 1;
    }
    Some(argv)
}

/// The executable file of `pid` (`proc_pidpath`: the file the kernel runs, as Linux's `/proc/<pid>/exe` names it).
fn exe_path(pid: i32) -> Option<Vec<u8>> {
    let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| buf[..(n as usize).min(buf.len())].to_vec())
}

/// This user's processes (`kea-helper procs`): libproc for the pid, parent, uid, start time and executable,
/// `KERN_PROCARGS2` for the arguments, so a row says what `ps -o pid,ppid,lstart,comm,args` says (`comm` is
/// `argv[0]`; U-PLT-3). Every process, or only `pids`.
pub fn processes(pids: Option<&[i32]>) -> io::Result<Vec<Row>> {
    let uid = unsafe { libc::getuid() };
    let listed = match pids {
        Some(p) => p.to_vec(),
        None => {
            let mut all = all_pids()?;
            all.sort_unstable();
            all
        }
    };
    let mut buf = vec![0u8; arg_max()];
    let mut rows = Vec::new();
    for pid in listed.into_iter().filter(|&p| p > 0) {
        let Ok(info) = proc_info(pid) else { continue }; // gone
        if info.uid != uid {
            continue;
        }
        let argv = procargs(pid, &mut buf).unwrap_or_default();
        rows.push(Row { pid, ppid: info.ppid, start_us: info.start_us, start_ticks: None, exe: exe_path(pid), argv });
    }
    Ok(rows)
}

// ── listening sockets ─────────────────────────────────────────────────────────────────────

const SOCKINFO_TCP: i32 = 2;
const TSI_S_LISTEN: i32 = 1;

/// `struct in_sockinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct InSockInfo {
    insi_fport: i32,
    insi_lport: i32,
    insi_gencnt: u64,
    insi_flags: u32,
    insi_flow: u32,
    insi_vflag: u8,
    insi_ip_ttl: u8,
    rfu_1: u32,
    /// `union { in4in6_addr; in6_addr }`: for IPv4 the address is the last 4 bytes.
    insi_faddr: [u32; 4],
    insi_laddr: [u32; 4],
    insi_v4: u8,
    insi_v6: [u32; 3],
}

/// `struct tcp_sockinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct TcpSockInfo {
    tcpsi_ini: InSockInfo,
    tcpsi_state: i32,
    tcpsi_timer: [i32; 4],
    tcpsi_mss: i32,
    tcpsi_flags: u32,
    rfu_1: u32,
    tcpsi_tp: u64,
}

/// `struct sockbuf_info`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct SockbufInfo {
    sbi_cc: u32,
    sbi_hiwat: u32,
    sbi_mbcnt: u32,
    sbi_mbmax: u32,
    sbi_lowat: u32,
    sbi_flags: i16,
    sbi_timeo: i16,
}

/// `struct socket_info`; `soi_proto` is a union whose largest member (`un_sockinfo`) is 528 bytes.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct SocketInfo {
    soi_stat: libc::vinfo_stat,
    soi_so: u64,
    soi_pcb: u64,
    soi_type: i32,
    soi_protocol: i32,
    soi_family: i32,
    soi_options: i16,
    soi_linger: i16,
    soi_state: i16,
    soi_qlen: i16,
    soi_incqlen: i16,
    soi_qlimit: i16,
    soi_timeo: i16,
    soi_error: u16,
    soi_oobmark: u32,
    soi_rcv: SockbufInfo,
    soi_snd: SockbufInfo,
    soi_kind: i32,
    rfu_1: u32,
    soi_proto: [u64; 66],
}

/// `struct socket_fdinfo`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct SocketFdInfo {
    pfi: ProcFileInfo,
    psi: SocketInfo,
}


/// Each pid's listening sockets: libproc keeps nothing between pids.
pub struct Ports;

impl Ports {
    pub fn new() -> Ports {
        Ports
    }

    pub fn listening(&mut self, pid: i32) -> io::Result<Vec<Listening>> {
        listening(pid)
    }
}

/// `kea-helper ports --all` is Linux's: on macOS, core names a port's holder with `lsof`.
pub fn all_listeners() -> io::Result<Vec<(Option<i32>, Listening)>> {
    Err(super::not_available("ports --all is Linux-only: on macOS, Kea finds a port's holder with lsof"))
}

/// Every TCP socket of `pid` in `LISTEN`: `proc_pidinfo(PROC_PIDLISTFDS)` + `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)`.
fn listening(pid: i32) -> io::Result<Vec<Listening>> {
    let mut found = Vec::new();
    for fd in list_fds(pid)? {
        if fd.proc_fdtype as i32 != libc::PROX_FDTYPE_SOCKET {
            continue;
        }
        let mut info = MaybeUninit::<SocketFdInfo>::zeroed();
        let size = size_of::<SocketFdInfo>() as libc::c_int;
        let n = unsafe { libc::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, info.as_mut_ptr().cast(), size) };
        if n != size {
            continue; // closed meanwhile
        }
        let si = unsafe { info.assume_init_ref() }.psi;
        if si.soi_kind != SOCKINFO_TCP || !(si.soi_family == libc::AF_INET || si.soi_family == libc::AF_INET6) {
            continue;
        }
        let tcp: TcpSockInfo = unsafe { std::ptr::read_unaligned(si.soi_proto.as_ptr().cast()) };
        if tcp.tcpsi_state != TSI_S_LISTEN {
            continue;
        }
        let ini = tcp.tcpsi_ini;
        let port = u16::from_be(ini.insi_lport as u16);
        let raw: [u8; 16] = unsafe { std::mem::transmute(ini.insi_laddr) };
        let entry = if si.soi_family == libc::AF_INET {
            Listening { v6: false, addr: Ipv4Addr::new(raw[12], raw[13], raw[14], raw[15]).to_string(), port }
        } else {
            Listening { v6: true, addr: Ipv6Addr::from(raw).to_string(), port }
        };
        if !found.contains(&entry) {
            found.push(entry);
        }
    }
    Ok(found)
}

// ── the detached launch ───────────────────────────────────────────────────────────────────

/// The command line that would put the daemon in a systemd unit of its own, as Linux does: macOS has none,
/// and `posix_spawn` with SETSID is the whole detach.
pub fn scope_command(_home: &std::path::Path, _pty_id: &str) -> Option<Vec<CString>> {
    None
}

/// The holder's hardening as it starts (on Linux: non-dumpable, without `INVOCATION_ID`): nothing on macOS, where
/// admission checks the client's code signature.
pub fn harden_holder() -> Result<(), String> {
    Ok(())
}

const POSIX_SPAWN_SETSID: libc::c_short = 0x0400;

unsafe extern "C" {
    fn posix_spawn_file_actions_addinherit_np(actions: *mut libc::posix_spawn_file_actions_t, fd: libc::c_int) -> libc::c_int;
    fn _NSGetEnviron() -> *mut *const *mut libc::c_char;
    fn clock_gettime_nsec_np(clock_id: libc::clockid_t) -> u64;
}

/// `posix_spawn` with the detach attributes: `POSIX_SPAWN_SETSID`, stdio on `/dev/null`, `ready_wr` as the
/// daemon's fd `ready_fd`, every other fd closed (`POSIX_SPAWN_CLOEXEC_DEFAULT`), signals reset, and macOS
/// responsibility disclaimed; the daemon is reparented to launchd.
///
/// # Safety
/// `argv` is a null-terminated array of pointers to C strings that live for the call.
pub unsafe fn spawn_detached(exe: &CString, argv: &[*const libc::c_char], ready_wr: &OwnedFd, ready_fd: RawFd) -> io::Result<libc::pid_t> {
    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        cvt(libc::posix_spawnattr_init(&mut attr)).map_err(|_| io::Error::last_os_error())?;
        let mut fa: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
        libc::posix_spawn_file_actions_init(&mut fa);

        let flags = POSIX_SPAWN_SETSID
            | libc::POSIX_SPAWN_CLOEXEC_DEFAULT as libc::c_short
            | libc::POSIX_SPAWN_SETSIGDEF as libc::c_short
            | libc::POSIX_SPAWN_SETSIGMASK as libc::c_short;
        libc::posix_spawnattr_setflags(&mut attr, flags);
        let mut all: libc::sigset_t = std::mem::zeroed();
        libc::sigfillset(&mut all);
        libc::posix_spawnattr_setsigdefault(&mut attr, &all);
        let mut none: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut none);
        libc::posix_spawnattr_setsigmask(&mut attr, &none);
        disclaim_responsibility(&mut attr);

        let devnull = c"/dev/null";
        libc::posix_spawn_file_actions_addopen(&mut fa, 0, devnull.as_ptr(), libc::O_RDONLY, 0);
        libc::posix_spawn_file_actions_addopen(&mut fa, 1, devnull.as_ptr(), libc::O_WRONLY, 0);
        libc::posix_spawn_file_actions_addopen(&mut fa, 2, devnull.as_ptr(), libc::O_WRONLY, 0);
        if ready_wr.as_raw_fd() == ready_fd {
            posix_spawn_file_actions_addinherit_np(&mut fa, ready_fd);
        } else {
            libc::posix_spawn_file_actions_adddup2(&mut fa, ready_wr.as_raw_fd(), ready_fd);
        }

        let mut pid = 0;
        let r = libc::posix_spawn(&mut pid, exe.as_ptr(), &fa, &attr, argv.as_ptr() as *const *mut _, *_NSGetEnviron());
        libc::posix_spawn_file_actions_destroy(&mut fa);
        libc::posix_spawnattr_destroy(&mut attr);
        if r != 0 { Err(io::Error::from_raw_os_error(r)) } else { Ok(pid) }
    }
}

/// `responsibility_spawnattrs_setdisclaim(attr, 1)`, resolved at run time; absent → continue without.
unsafe fn disclaim_responsibility(attr: *mut libc::posix_spawnattr_t) {
    type Disclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
    unsafe {
        let sym = libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_spawnattrs_setdisclaim".as_ptr());
        if !sym.is_null() {
            let f: Disclaim = std::mem::transmute(sym);
            f(attr, 1);
        }
    }
}

// ── the libc names only Apple has ─────────────────────────────────────────────────────────

/// Where this thread's `errno` lives (async-signal-safe: a signal handler saves and restores it).
pub fn errno_ptr() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

/// A socket that never raises `SIGPIPE` for a write to a closed peer (`SO_NOSIGPIPE`).
pub fn set_nosigpipe(fd: RawFd) -> io::Result<()> {
    let one: libc::c_int = 1;
    cvt(unsafe { libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_NOSIGPIPE, (&one as *const libc::c_int).cast(), size_of::<libc::c_int>() as libc::socklen_t) }).map(drop)
}

/// Writes to a socket set up with [`set_nosigpipe`]: a plain `write`.
pub fn send(fd: RawFd, buf: &[u8]) -> isize {
    unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) }
}

/// A non-blocking `connect` to a unix socket that failed with `errno` is still under way: `EINPROGRESS`, or `EAGAIN`.
pub fn connect_pending(errno: i32) -> bool {
    errno == libc::EINPROGRESS || errno == libc::EAGAIN
}

/// The highest signal number (`NSIG` − 1): a child's dispositions are reset up to it.
pub fn last_signal() -> libc::c_int {
    31
}

/// XNU's "redrive the open" (`<sys/errno.h>`, kernel-private): meant to be retried inside the kernel, it now and then
/// reaches user space from `openpty` while other processes open terminals at the same moment, and the open is retried
/// at once.
pub const PTY_REDRIVE_ERRNO: Option<i32> = Some(-6);

/// The user's own runtime directory, for the run dir's fallback: macOS has none (`/tmp/kea-<uid>` serves).
pub fn runtime_dir() -> Option<std::path::PathBuf> {
    None
}

/// Sets the BSD `sun_len` field of a unix socket address.
pub fn set_sun_len(addr: &mut libc::sockaddr_un) {
    addr.sun_len = size_of::<libc::sockaddr_un>() as u8;
}

/// Nanoseconds of `CLOCK_UPTIME_RAW`: the hook envelope's `mono` stamp.
pub fn hook_clock_ns() -> io::Result<u64> {
    Ok(unsafe { clock_gettime_nsec_np(libc::CLOCK_UPTIME_RAW) })
}

/// Fills `buf` from the system's random generator (`arc4random_buf`, which cannot fail).
pub fn random_bytes(buf: &mut [u8]) -> io::Result<()> {
    unsafe { libc::arc4random_buf(buf.as_mut_ptr().cast(), buf.len()) };
    Ok(())
}

// ── Security.framework, loaded at run time in a forked child ───────────────────
//
// Why a child: on macOS 27 one in-process code check leaves about 1.4 MB of freed-but-dirty heap and
// framework data behind (the default allocator does not return it), which alone breaks P-MEM-4. So
// the binary links neither Security nor CoreFoundation: the holder forks, the child `dlopen`s them,
// answers on a pipe and takes all of that memory with it. Forking without `exec` is sound because the
// holder is single-threaded and has never initialised CoreFoundation, libdispatch or XPC.

type CFTypeRef = *const c_void;
type OSStatus = i32;

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_SEC_CS_DEFAULT_FLAGS: u32 = 0;
const CF_PATH: &CStr = c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SECURITY_PATH: &CStr = c"/System/Library/Frameworks/Security.framework/Security";

/// The few CoreFoundation/Security entry points the check needs.
struct Sec {
    data_create: unsafe extern "C" fn(CFTypeRef, *const u8, isize) -> CFTypeRef,
    dictionary_create:
        unsafe extern "C" fn(CFTypeRef, *const CFTypeRef, *const CFTypeRef, isize, *const c_void, *const c_void) -> CFTypeRef,
    string_create: unsafe extern "C" fn(CFTypeRef, *const u8, isize, u32, u8) -> CFTypeRef,
    release: unsafe extern "C" fn(CFTypeRef),
    key_callbacks: *const c_void,
    value_callbacks: *const c_void,
    audit_key: CFTypeRef,
    requirement_create: unsafe extern "C" fn(CFTypeRef, u32, *mut CFTypeRef) -> OSStatus,
    copy_guest: unsafe extern "C" fn(CFTypeRef, CFTypeRef, u32, *mut CFTypeRef) -> OSStatus,
    check_validity: unsafe extern "C" fn(CFTypeRef, u32, CFTypeRef) -> OSStatus,
}

fn open(path: &CStr) -> Result<*mut c_void, String> {
    let h = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
    if h.is_null() { Err(format!("cannot load {}", path.to_string_lossy())) } else { Ok(h) }
}

fn sym(lib: *mut c_void, name: &CStr) -> Result<*mut c_void, String> {
    let p = unsafe { libc::dlsym(lib, name.as_ptr()) };
    if p.is_null() { Err(format!("missing symbol {}", name.to_string_lossy())) } else { Ok(p) }
}

/// A function pointer from `dlsym`.
unsafe fn func<T: Copy>(p: *mut c_void) -> T {
    assert_eq!(size_of::<T>(), size_of::<*mut c_void>());
    unsafe { std::mem::transmute_copy(&p) }
}

impl Sec {
    fn load() -> Result<Sec, String> {
        let cf = open(CF_PATH)?;
        let sec = open(SECURITY_PATH)?;
        unsafe {
            Ok(Sec {
                data_create: func(sym(cf, c"CFDataCreate")?),
                dictionary_create: func(sym(cf, c"CFDictionaryCreate")?),
                string_create: func(sym(cf, c"CFStringCreateWithBytes")?),
                release: func(sym(cf, c"CFRelease")?),
                key_callbacks: sym(cf, c"kCFTypeDictionaryKeyCallBacks")?,
                value_callbacks: sym(cf, c"kCFTypeDictionaryValueCallBacks")?,
                audit_key: *(sym(sec, c"kSecGuestAttributeAudit")? as *const CFTypeRef),
                requirement_create: func(sym(sec, c"SecRequirementCreateWithString")?),
                copy_guest: func(sym(sec, c"SecCodeCopyGuestWithAttributes")?),
                check_validity: func(sym(sec, c"SecCodeCheckValidity")?),
            })
        }
    }
}

/// Releases a CF object on drop.
struct Cf(CFTypeRef, unsafe extern "C" fn(CFTypeRef));
impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { (self.1)(self.0) };
        }
    }
}

/// Compiles `requirement` (`SecRequirementCreateWithString`) and, given a peer's audit token, checks
/// that process against it (`SecCodeCopyGuestWithAttributes` → `SecCodeCheckValidity`). `Err` means
/// the requirement (or the framework) is unusable; a peer that cannot be checked is `Ok(false)`.
/// In-process: the holder only calls it in a forked child ([`PeerAdmission`]).
pub fn verify(requirement: &str, token: Option<&[u8]>) -> Result<bool, String> {
    let s = Sec::load().map_err(|e| format!("--client-req cannot be checked: {e}"))?;
    let null = std::ptr::null();
    let cf = |p: CFTypeRef| Cf(p, s.release);
    unsafe {
        let text = cf((s.string_create)(null, requirement.as_ptr(), requirement.len() as isize, K_CF_STRING_ENCODING_UTF8, 0));
        if text.0.is_null() {
            return Err("--client-req: cannot build a CFString".into());
        }
        let mut req = null;
        let status = (s.requirement_create)(text.0, K_SEC_CS_DEFAULT_FLAGS, &mut req);
        if status != 0 || req.is_null() {
            return Err(format!("--client-req is not a valid code requirement (OSStatus {status}): {requirement}"));
        }
        let req = cf(req);
        let Some(token) = token else { return Ok(true) };
        let data = cf((s.data_create)(null, token.as_ptr(), token.len() as isize));
        if data.0.is_null() {
            return Ok(false);
        }
        let keys = [s.audit_key];
        let values = [data.0];
        let attrs = cf((s.dictionary_create)(null, keys.as_ptr(), values.as_ptr(), 1, s.key_callbacks, s.value_callbacks));
        if attrs.0.is_null() {
            return Ok(false);
        }
        let mut code = null;
        if (s.copy_guest)(null, attrs.0, K_SEC_CS_DEFAULT_FLAGS, &mut code) != 0 || code.is_null() {
            return Ok(false);
        }
        let code = cf(code);
        Ok((s.check_validity)(code.0, K_SEC_CS_DEFAULT_FLAGS, req.0) == 0)
    }
}

/// Forks a process that runs [`verify`] and writes its verdict ([`ADMIT`], [`REFUSE`], or [`ERROR`] and a
/// message) on a pipe, then exits. Everything the child uses is prepared before the fork.
fn fork_check(requirement: &str, token: Option<&[u8]>, delay_ms: u64) -> Result<Check, String> {
    let (rd, wr) = pipe_cloexec().map_err(|e| format!("pipe: {e}"))?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(format!("fork: {}", std::io::Error::last_os_error()));
    }
    if pid == 0 {
        check_child(requirement, token, delay_ms, wr.as_raw_fd());
    }
    drop(wr);
    Ok(Check { verdict: rd, pid: Some(pid) })
}

/// The forked check process. It never returns into the holder's stack (no destructors, no unwinding).
fn check_child(requirement: &str, token: Option<&[u8]>, delay_ms: u64, wr: RawFd) -> ! {
    unsafe {
        // The holder's handlers write to its wake pipe; this process has nothing to tell the holder.
        for sig in [libc::SIGCHLD, libc::SIGTERM, libc::SIGHUP] {
            libc::signal(sig, libc::SIG_DFL);
        }
    }
    // Keep only the verdict pipe (and stdio): a client the holder closes or replaces, a refused
    // connection, the PTY's hang-up — none of them may wait for a check to end.
    let keep = |fd: RawFd| fd <= libc::STDERR_FILENO || fd == wr;
    match list_fds(unsafe { libc::getpid() }) {
        Ok(fds) => fds.iter().map(|f| f.proc_fd).filter(|&fd| !keep(fd)).for_each(|fd| unsafe {
            libc::close(fd);
        }),
        Err(_) => (0..unsafe { libc::getdtablesize() }).filter(|&fd| !keep(fd)).for_each(|fd| unsafe {
            libc::close(fd);
        }),
    }
    if delay_ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }
    let answer = match std::panic::catch_unwind(AssertUnwindSafe(|| verify(requirement, token))) {
        Ok(Ok(true)) => vec![ADMIT],
        Ok(Ok(false)) => vec![REFUSE],
        Ok(Err(e)) => [&[ERROR], e.as_bytes()].concat(),
        Err(_) => [&[ERROR][..], b"--client-req cannot be checked: the check panicked"].concat(),
    };
    let _ = write_all(wr, &answer);
    unsafe { libc::_exit(0) }
}

/// Compiles `--client-req` in a forked child and waits for the answer (at start, before the holder
/// serves anyone). A check that does not answer within `HOLDER_PEER_CHECK_TIMEOUT_MS` is killed and
/// does not fail the start: every client check runs the same compilation and fails closed.
fn compile_in_child(requirement: &str) -> Result<(), String> {
    let check = fork_check(requirement, None, 0).map_err(|e| format!("--client-req cannot be checked: {e}"))?;
    let fd = check.verdict.as_raw_fd();
    let deadline = now_ms() + HOLDER_PEER_CHECK_TIMEOUT_MS;
    let mut msg = [0u8; 1024];
    let mut len = 0;
    let finished = loop {
        let left = deadline.saturating_sub(now_ms());
        if left == 0 {
            break false;
        }
        let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut p, 1, left.min(i32::MAX as u64) as i32) } <= 0 {
            continue; // EINTR (SIGCHLD) or the deadline: the loop decides
        }
        let n = unsafe { libc::read(fd, msg[len..].as_mut_ptr().cast(), msg.len() - len) };
        if n > 0 {
            len += n as usize;
            if len == msg.len() {
                break true; // a full message: enough to report
            }
        } else if n == 0 || (errno() != libc::EINTR && errno() != libc::EAGAIN) {
            break true; // EOF: the child has exited (or is exiting)
        }
    };
    if let Some(pid) = check.pid {
        unsafe { libc::kill(pid, libc::SIGKILL) };
        while unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) } < 0 && errno() == libc::EINTR {}
    }
    if !finished {
        return Ok(());
    }
    match msg[..len].split_first() {
        Some((&ADMIT, _)) => Ok(()),
        Some((&ERROR, text)) => Err(String::from_utf8_lossy(text).into_owned()),
        _ => Err("--client-req cannot be checked: the check process ended without an answer".into()),
    }
}


/// Client admission: uid via `getpeereid`, code signature via the peer's audit token, in a forked child.
pub struct PeerAdmission {
    requirement: String,
    /// Debug builds only: `KEA_HELPER_TEST_CHECK_DELAY_MS` makes every client check wait this long
    /// before it starts, so tests can keep checks pending (I-HLD-29). Release builds ignore it.
    delay_ms: u64,
}

impl PeerAdmission {
    /// Compiles `--client-req` once at start (in a child), so a bad requirement fails the spawn clearly. An executable
    /// (`--client-exe`) is Linux's way of naming the client, refused here.
    pub fn new(client: &Client) -> Result<Self, String> {
        let Client::Requirement(requirement) = client else {
            return Err("--client-exe and --client-exe-unchecked are Linux-only: macOS admits a client by its code signature, --client-req".into());
        };
        compile_in_child(requirement)?;
        Ok(PeerAdmission { requirement: requirement.to_owned(), delay_ms: test_check_delay_ms() })
    }
}

fn test_check_delay_ms() -> u64 {
    #[cfg(debug_assertions)]
    if let Some(v) = std::env::var("KEA_HELPER_TEST_CHECK_DELAY_MS").ok().and_then(|v| v.parse().ok()) {
        return v;
    }
    0
}

impl PeerCheck for PeerAdmission {
    fn peer_uid(&self, fd: RawFd) -> Option<u32> {
        let (mut uid, mut gid) = (0, 0);
        (unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } == 0).then_some(uid)
    }

    fn start_check(&self, fd: RawFd) -> Option<Check> {
        let token = peer_token(fd)?;
        fork_check(&self.requirement, Some(&token), self.delay_ms).ok()
    }

    fn peer_exiting(&self, fd: RawFd) -> bool {
        let mut pid: libc::pid_t = 0;
        let mut len = size_of::<libc::pid_t>() as libc::socklen_t;
        let r = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut len) };
        // no peer pid: disconnected; no process: gone (the connection keeps the pid from being reused)
        r != 0 || proc_info(pid).map_or(true, |i| i.exiting)
    }
}

/// The peer's audit token (`LOCAL_PEERTOKEN`), as the bytes `kSecGuestAttributeAudit` takes.
fn peer_token(fd: RawFd) -> Option<[u8; 32]> {
    let mut token = [0u8; 32];
    let mut len = token.len() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut len) };
    (r == 0 && len as usize == token.len()).then_some(token)
}

/// Why a peer was refused, for `Refused::Identity`'s code: only Linux's check sends one; a macOS check says
/// yes or no.
pub fn refusal_reason(_code: u8) -> &'static str {
    "code signature does not satisfy the client requirement"
}

/// Can the peer still be checked? Its audit token is readable only while the connection lives (a stub check in the
/// tests asks this, as the real one does before it starts).
pub fn peer_checkable(fd: RawFd) -> bool {
    peer_token(fd).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    /// A connection as the holder sees it, and the peer's end.
    fn conn() -> (OwnedFd, UnixStream) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        (ours.into(), theirs)
    }

    /// Upper bound for any wait (the test binary runs other tests in parallel).
    const WAIT: std::time::Duration = std::time::Duration::from_secs(30);

    #[test]
    fn r_hld_8_libproc_layouts_match_the_sdk() {
        // Values printed by a C program compiled against MacOSX.sdk `sys/proc_info.h`.
        assert_eq!(size_of::<libc::proc_bsdinfo>(), 136);
        assert_eq!(size_of::<libc::proc_fdinfo>(), 8);
        assert_eq!(size_of::<ProcFileInfo>(), 24);
        assert_eq!(size_of::<libc::vinfo_stat>(), 136);
        assert_eq!(size_of::<libc::vnode_info>(), 152);
        assert_eq!(size_of::<VnodeFdInfo>(), 176);
        assert_eq!(size_of::<libc::proc_vnodepathinfo>(), 2352);
        assert_eq!(size_of::<libc::rusage_info_v0>(), 96);
    }

    #[test]
    fn r_hld_8_libproc_reads_this_process() {
        let me = unsafe { libc::getpid() };
        let info = proc_info(me).unwrap();
        assert_eq!(info.pid, me);
        assert_eq!(info.ppid, unsafe { libc::getppid() });
        assert!(info.start_us > 1_600_000_000_000_000);
        let mut buf = [0u8; 1024];
        let n = cwd_into(me, &mut buf);
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(std::path::Path::new(std::str::from_utf8(&buf[..n]).unwrap()).canonicalize().unwrap(), cwd);
        assert!(name_into(me, &mut buf) > 0);
        assert!(proc_info(-5).is_err());
    }

    #[test]
    fn r_srv_1_struct_layout_matches_the_sdk() {
        // From a C program compiled against MacOSX.sdk `sys/proc_info.h`.
        assert_eq!(size_of::<InSockInfo>(), 80);
        assert_eq!(size_of::<TcpSockInfo>(), 120);
        assert_eq!(std::mem::offset_of!(TcpSockInfo, tcpsi_state), 80);
        assert_eq!(std::mem::offset_of!(InSockInfo, insi_lport), 4);
        assert_eq!(std::mem::offset_of!(InSockInfo, insi_laddr), 48);
        assert_eq!(size_of::<SocketInfo>(), 768);
        assert_eq!(std::mem::offset_of!(SocketInfo, soi_family), 160);
        assert_eq!(std::mem::offset_of!(SocketInfo, soi_kind), 232);
        assert_eq!(std::mem::offset_of!(SocketInfo, soi_proto), 240);
        assert_eq!(size_of::<SocketFdInfo>(), 792);
    }

    /// Seconds since the epoch of `ps`'s `lstart` printed in UTC: `Mon Oct 19 14:40:29 2026`.
    fn lstart_secs(words: &[&str]) -> Option<i64> {
        const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        let [_, mon, day, hms, year] = words else { return None };
        let m = MONTHS.iter().position(|x| x == mon)? as i64 + 1;
        let (d, y): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
        let t: Vec<i64> = hms.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
        // days from the civil date (Howard Hinnant's algorithm)
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
        Some(days * 86_400 + t.first()? * 3600 + t.get(1)? * 60 + t.get(2)?)
    }

    /// `ps -o pid=,ppid=,uid=,lstart=,comm=` in UTC, and `pid=,args=` (macOS's `ps` cuts every column but the last),
    /// for `pids` or every process: pid → (ppid, uid, start second, comm, args).
    fn ps_rows(pids: Option<&[i32]>) -> std::collections::HashMap<i32, (i32, u32, i64, Vec<u8>, Vec<u8>)> {
        let sel: Vec<String> = match pids {
            Some(p) => vec!["-p".into(), p.iter().map(i32::to_string).collect::<Vec<_>>().join(",")],
            None => vec!["-ax".into()],
        };
        let run = |cols: &str| {
            let out = std::process::Command::new("/bin/ps").args(&sel).args(["-ww", "-o", cols]).env("LC_ALL", "en_US.UTF-8").env("TZ", "UTC0").output().unwrap();
            out.stdout
        };
        let table = run("pid=,ppid=,uid=,lstart=,comm=");
        let args = run("pid=,args=");
        let mut by_args = std::collections::HashMap::new();
        for l in args.split(|&b| b == b'\n') {
            let l = l.trim_ascii_start();
            let Some(sp) = l.iter().position(|&b| b == b' ') else { continue };
            if let Some(pid) = std::str::from_utf8(&l[..sp]).ok().and_then(|p| p.parse::<i32>().ok()) {
                by_args.insert(pid, l[sp..].trim_ascii().to_vec());
            }
        }
        let mut rows = std::collections::HashMap::new();
        for l in table.split(|&b| b == b'\n') {
            // pid ppid uid Www Mmm dd hh:mm:ss yyyy comm…: nine words, then the rest is comm
            let text = String::from_utf8_lossy(l);
            let words: Vec<&str> = text.split_whitespace().collect();
            if words.len() < 9 {
                continue;
            }
            let (Ok(pid), Ok(ppid), Ok(uid), Some(start)) = (words[0].parse(), words[1].parse(), words[2].parse(), lstart_secs(&words[3..8])) else { continue };
            // comm is the bytes after the eighth word, as printed
            let mut rest = l.trim_ascii_start();
            for _ in 0..8 {
                let sp = rest.iter().position(|b| b.is_ascii_whitespace()).unwrap_or(rest.len());
                rest = rest[sp..].trim_ascii_start();
            }
            let comm = rest.trim_ascii_end().to_vec();
            rows.insert(pid, (ppid, uid, start, comm, by_args.remove(&pid).unwrap_or_default()));
        }
        rows
    }

    /// Text as `ps` prints it: a control byte as `\ooo` (vis(3)), and no space at the end of the line.
    fn as_ps_prints(b: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for &c in b {
            if c < 0x20 || c == 0x7f { out.extend(format!("\\{c:03o}").bytes()) } else { out.push(c) }
        }
        out.trim_ascii_end().to_vec()
    }

    /// Does `ours` say what `ps` says of the same process? `comm` is `argv[0]`; the executable, which `ps` does not
    /// print, is an absolute path.
    fn same_row(ours: &Row, ps: &(i32, u32, i64, Vec<u8>, Vec<u8>)) -> bool {
        let (ppid, _, start, comm, args) = ps;
        let argv_ok = match ours.argv.first() {
            Some(argv0) => as_ps_prints(argv0) == *comm && as_ps_prints(&ours.argv.join(&b' ')) == *args,
            // no arguments to read (a zombie): ps prints the short name in their place
            None => !comm.contains(&b'/'),
        };
        let exe_ok = ours.exe.as_ref().is_none_or(|e| e.starts_with(b"/"));
        ours.ppid == *ppid && (ours.start_us / 1_000_000) as i64 == *start && argv_ok && exe_ok
    }

    // Every process of this user, as `kea-helper procs` and `ps` list it a moment apart: the same pid, parent, start
    // second and arguments (`argv[0]` as it was executed: relative, through a symlink or under another name, exactly
    // as `ps` prints `comm`). A process that started or ended in between is in one list only; one caught between fork
    // and exec is read again.
    #[test]
    fn u_plt_3_procs_rows_equal_ps_rows_for_every_process_of_this_user() {
        let uid = unsafe { libc::getuid() };
        let t0 = crate::sys::wall_ms() as i64 / 1000;
        let ours = processes(None).unwrap();
        let ps = ps_rows(None);
        let ps_mine: Vec<i32> = ps.iter().filter(|(_, r)| r.1 == uid).map(|(&p, _)| p).collect();
        assert!(ours.len() > 3 && ps_mine.len() > 3, "{} rows here, {} from ps", ours.len(), ps_mine.len());
        assert!(ours.iter().any(|r| r.pid == std::process::id() as i32), "this process is listed");
        let mut wrong = Vec::new();
        for r in &ours {
            match ps.get(&r.pid) {
                Some(p) if same_row(r, p) => {}
                // ended before ps ran: its pid is gone, or now another process's
                None if proc_info(r.pid).map_or(true, |i| i.start_us != r.start_us) => {}
                _ => {
                    // changed in between (an exec): both read again, until they agree
                    let agree = (0..3).any(|_| {
                        let again = processes(Some(&[r.pid])).unwrap();
                        let p = ps_rows(Some(&[r.pid]));
                        match (again.first(), p.get(&r.pid)) {
                            (Some(a), Some(b)) => same_row(a, b),
                            (None, None) => true,
                            _ => false,
                        }
                    });
                    if !agree {
                        let argv: Vec<_> = r.argv.iter().map(|a| String::from_utf8_lossy(a)).collect();
                        let exe = r.exe.as_deref().map(String::from_utf8_lossy);
                        let theirs = ps.get(&r.pid).map(|p| (p.0, p.2, String::from_utf8_lossy(&p.3), String::from_utf8_lossy(&p.4)));
                        wrong.push(format!("{} ppid {} start {} exe {exe:?} argv {argv:?}\n   ps: {theirs:?}", r.pid, r.ppid, r.start_us / 1_000_000));
                    }
                }
            }
        }
        for pid in ps_mine.iter().filter(|p| !ours.iter().any(|r| r.pid == **p)) {
            // only in ps: it started after the listing did
            if ps[pid].2 < t0 && proc_info(*pid).is_ok_and(|i| (i.start_us / 1_000_000) as i64 == ps[pid].2) {
                wrong.push(format!("pid {pid} is missing: {:?}", String::from_utf8_lossy(&ps[pid].3)));
            }
        }
        assert!(wrong.is_empty(), "{} rows differ from ps:\n{}", wrong.len(), wrong.join("\n"));
        // the pids asked for, and nothing of another user's
        let me = std::process::id() as i32;
        let asked = processes(Some(&[me, 1, -3])).unwrap();
        assert_eq!(asked.iter().map(|r| r.pid).collect::<Vec<_>>(), [me], "launchd is root's");
    }

    // The real lookup: this process is alive and not exiting; a dead child's pid is gone.
    #[test]
    fn r_hld_5_peer_exiting_reads_the_peer_process() {
        let (ours, theirs) = conn();
        let check = PeerAdmission { requirement: String::new(), delay_ms: 0 }; // `new` forks: not in this harness
        assert!(!check.peer_exiting(ours.as_raw_fd()), "our own process is the peer, alive");
        drop(theirs);
        // closed once every copy is: a process another test forks holds copies until it closes them (both fork sites
        // close what they inherit at once), so wait for the hang-up `ours` sees rather than assume it came
        let mut pfd = libc::pollfd { fd: ours.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let ready = unsafe { libc::poll(&mut pfd, 1, WAIT.as_millis() as libc::c_int) };
        assert_eq!(ready, 1, "the peer's end closed within {WAIT:?}");
        assert!(check.peer_exiting(ours.as_raw_fd()), "no peer once its end is closed");
    }

    /// This test binary's designated requirement (`cdhash H"…"` for a linker-signed binary).
    fn own_requirement() -> String {
        let exe = std::env::current_exe().unwrap();
        let out = std::process::Command::new("/usr/bin/codesign").args(["-d", "-r-"]).arg(&exe).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
        text.lines().find_map(|l| l.split_once("designated => ").map(|(_, r)| r.trim().to_string())).expect("designated requirement")
    }

    // In-process only: forking inside the multi-threaded test harness is not sound (the forked path is
    // exercised by the integration tests, which drive the single-threaded holder).
    #[test]
    fn r_hld_5_requirements_compile_and_check_an_audit_token() {
        assert_eq!(verify("anchor apple", None), Ok(true));
        assert_eq!(verify("cdhash H\"0123456789abcdef0123456789abcdef01234567\"", None), Ok(true));
        let err = verify("this is not a requirement (", None).unwrap_err();
        assert!(err.starts_with("--client-req is not a valid code requirement"), "{err}");
        // This process's own token, read from a socket peer: satisfies its designated requirement, not Apple's.
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        let token = peer_token(a.as_raw_fd()).unwrap();
        assert_eq!(verify(&own_requirement(), Some(&token)), Ok(true));
        assert_eq!(verify("anchor apple", Some(&token)), Ok(false));
        assert_eq!(verify("anchor apple", Some(&[0u8; 32])), Ok(false), "an unknown process fails closed");
        // The binary links neither framework (they are loaded in the forked child only).
        let exe = std::env::current_exe().unwrap();
        let out = std::process::Command::new("/usr/bin/otool").arg("-L").arg(&exe).output().unwrap();
        let libs = String::from_utf8_lossy(&out.stdout);
        assert!(!libs.contains("Security.framework") && !libs.contains("CoreFoundation.framework"), "{libs}");
    }
}
