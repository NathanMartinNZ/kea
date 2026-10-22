//! Linux's `/proc`, read as text: the parsers of its files, and the readers that take `/proc`'s own root as an
//! argument, so they run on macOS too, against files recorded on Linux (`fixtures/os/linux/`; U-PLT-3, U-PLT-4).
//! `linux.rs` reads the real `/proc` through them. Nothing here needs Linux: no `cfg`, no Linux-only libc name, and the
//! parsers allocate nothing (the holder's `STAT` path runs them).

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use super::Listening;

/// The fields of `/proc/<pid>/stat` (proc(5)) that Kea reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub pid: i32,
    /// `R`, `S`, `D`, `Z`, `X`, …
    pub state: u8,
    pub ppid: i32,
    pub pgrp: i32,
    pub session: i32,
    /// The controlling terminal's device as the kernel encodes it (`new_encode_dev`); 0 when none. For the
    /// pseudo-terminals Kea opens it equals the low 32 bits of glibc's `st_rdev`.
    pub tty_nr: u32,
    /// `PF_*` flags.
    pub flags: u32,
    /// Clock ticks after boot: what tells this process from a later one with the same pid.
    pub starttime: u64,
}

/// `PF_EXITING` (`<linux/sched.h>`): the process is working its way through `exit()`.
pub const PF_EXITING: u32 = 0x4;

impl Stat {
    /// Exiting or exited: `PF_EXITING`, or the states `Z` (zombie) and `X` (dead).
    pub fn exiting(&self) -> bool {
        self.flags & PF_EXITING != 0 || self.state == b'Z' || self.state == b'X'
    }
}

fn num<T: std::str::FromStr>(field: &[u8]) -> Option<T> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

/// Parses one `/proc/<pid>/stat` line. The name in parentheses may hold spaces and parentheses itself, so the fields
/// are counted from the last `)`.
pub fn parse_stat(buf: &[u8]) -> Option<Stat> {
    let open = buf.iter().position(|&b| b == b'(')?;
    let close = buf.iter().rposition(|&b| b == b')')?;
    let pid = num(buf[..open].trim_ascii())?;
    // fields 3… (proc(5)): state ppid pgrp session tty_nr tpgid flags … starttime (22)
    let mut f = buf.get(close + 1..)?.split(|&b| b == b' ').filter(|s| !s.is_empty());
    let state = *f.next()?.first()?;
    let ppid = num(f.next()?)?;
    let pgrp = num(f.next()?)?;
    let session = num(f.next()?)?;
    let tty_nr = num::<i64>(f.next()?)? as u32;
    let flags = num(f.nth(1)?)?;
    let starttime = num(f.nth(12)?.trim_ascii())?;
    Some(Stat { pid, state, ppid, pgrp, session, tty_nr, flags, starttime })
}

/// The value of one `Key:\t…` line of a `/proc` status-like file.
fn field<'a>(buf: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    buf.split(|&b| b == b'\n').find_map(|l| l.strip_prefix(key)?.strip_prefix(b":")).map(<[u8]>::trim_ascii)
}

/// The effective uid from `/proc/<pid>/status` (`Uid:` real, effective, saved, filesystem).
pub fn status_euid(buf: &[u8]) -> Option<u32> {
    num(field(buf, b"Uid")?.split(|b| b.is_ascii_whitespace()).filter(|s| !s.is_empty()).nth(1)?)
}

/// A `… kB` line of `/proc/<pid>/status`, in bytes; a missing line (a zombie, a kernel thread) counts 0.
fn status_kb(buf: &[u8], key: &[u8]) -> Option<u64> {
    let v = field(buf, key)?;
    num::<u64>(v.strip_suffix(b"kB")?.trim_ascii()).map(|kb| kb * 1024)
}

/// The footprint on Linux: `RssAnon + VmSwap` from `/proc/<pid>/status`, in bytes. A file-backed mapping
/// (the ring) is in `RssFile` and never counted.
pub fn status_footprint(buf: &[u8]) -> u64 {
    status_kb(buf, b"RssAnon").unwrap_or(0) + status_kb(buf, b"VmSwap").unwrap_or(0)
}

/// `status_footprint` of the `status` file at `path` (`kea-helper footprint`), read whole: a long `Groups:`
/// line comes before the two fields, so a page's worth could leave them out and read as 0.
pub fn footprint_at(path: &Path) -> io::Result<u64> {
    Ok(status_footprint(&std::fs::read(path)?))
}

/// `btime` from `/proc/stat`: the boot time, seconds since the epoch.
pub fn btime(buf: &[u8]) -> Option<u64> {
    buf.split(|&b| b == b'\n').find_map(|l| num(l.strip_prefix(b"btime ")?.trim_ascii()))
}

/// Microseconds since the epoch of a start time in clock ticks after boot (the state json's `pidStartTime`
/// and `kea-helper procs`'s column; identity compares the ticks themselves).
pub fn start_us(starttime: u64, btime: u64, clk_tck: u64) -> u64 {
    btime * 1_000_000 + starttime * 1_000_000 / clk_tck.max(1)
}

/// The inode of a descriptor link that names a socket: `socket:[<inode>]`.
pub fn socket_inode(link: &[u8]) -> Option<u64> {
    num(link.strip_prefix(b"socket:[")?.strip_suffix(b"]")?)
}

/// The cgroup v2 path in `/proc/<pid>/cgroup` (its `0::<path>` line).
pub fn cgroup_v2_path(buf: &[u8]) -> Option<&[u8]> {
    buf.split(|&b| b == b'\n').find_map(|l| l.strip_prefix(b"0::")).filter(|p| p.first() == Some(&b'/'))
}

/// Is the cgroup at `path` the holder's own scope (`kea-<8 hex of the home's hash>-<ptyId>.scope`)?
pub fn is_own_scope(path: &[u8], pty_id: &str) -> bool {
    let last = path.rsplit(|&b| b == b'/').next().unwrap_or(&[]);
    let Some(mid) = last.strip_prefix(b"kea-").and_then(|r| r.strip_suffix(b".scope")) else { return false };
    let Some(hash) = mid.strip_suffix(pty_id.as_bytes()).and_then(|h| h.strip_suffix(b"-")) else { return false };
    hash.len() == 8 && hash.iter().all(u8::is_ascii_hexdigit)
}

/// One 32-bit word of an address in `/proc/net/tcp{,6}`: the kernel prints it with `%08X` as the host stores it, so
/// its native-endian bytes are the address's bytes in network order (every Linux target of Kea is little-endian).
fn word(hex: &[u8]) -> Option<[u8; 4]> {
    (hex.len() == 8).then_some(())?;
    Some(u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?.to_ne_bytes())
}

/// `ADDR:PORT` of a `/proc/net/tcp` (8 hex digits) or `tcp6` (32) row.
fn local_address(f: &[u8], v6: bool) -> Option<(String, u16)> {
    let colon = f.iter().position(|&b| b == b':')?;
    let (addr, port) = (&f[..colon], &f[colon + 1..]);
    let port = u16::from_str_radix(std::str::from_utf8(port).ok()?, 16).ok()?;
    let text = if v6 {
        (addr.len() == 32).then_some(())?;
        let mut b = [0u8; 16];
        for (i, w) in addr.chunks(8).enumerate() {
            b[i * 4..i * 4 + 4].copy_from_slice(&word(w)?);
        }
        Ipv6Addr::from(b).to_string()
    } else {
        Ipv4Addr::from(word(addr)?).to_string()
    };
    Some((text, port))
}

/// `st` of a TCP socket in `LISTEN` (`TCP_LISTEN`, `<net/tcp_states.h>`).
const TCP_LISTEN: &[u8] = b"0A";

/// The listeners of one `/proc/<pid>/net/tcp` (`v6` false) or `tcp6` table whose inode is one of `inodes`,
/// added to `out` once each. Rows of other processes in the same network namespace, and sockets in other states, are
/// skipped.
pub fn listeners(table: &[u8], v6: bool, inodes: &[u64], out: &mut Vec<Listening>) {
    listening_rows(table, v6, |inode| inodes.contains(&inode), out)
}

/// The listeners of a table whose inode is none of `owned` (`kea-helper ports --all`): what no process of this
/// user holds, so another user's process does (its descriptors cannot be read), added to `out` once each.
pub fn listeners_unowned(table: &[u8], v6: bool, owned: &[u64], out: &mut Vec<Listening>) {
    listening_rows(table, v6, |inode| !owned.contains(&inode), out)
}

fn listening_rows(table: &[u8], v6: bool, keep: impl Fn(u64) -> bool, out: &mut Vec<Listening>) {
    for row in table.split(|&b| b == b'\n').skip(1) {
        let f: Vec<&[u8]> = row.split(|b| b.is_ascii_whitespace()).filter(|s| !s.is_empty()).collect();
        // sl local rem st tx:rx tr:when retrnsmt uid timeout inode …
        let (Some(local), Some(&st), Some(inode)) = (f.get(1), f.get(3), f.get(9).and_then(|i| num::<u64>(i))) else { continue };
        if st != TCP_LISTEN || !keep(inode) {
            continue;
        }
        let Some((addr, port)) = local_address(local, v6) else { continue };
        let entry = Listening { v6, addr, port };
        if !out.contains(&entry) {
            out.push(entry);
        }
    }
}

// ── `kea-helper procs` from a `/proc` tree ──────────────────────────────────────────────────────

/// One process as `kea-helper procs` prints it (`crate::procs`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub pid: i32,
    pub ppid: i32,
    /// Start time, µs since the epoch.
    pub start_us: u64,
    /// The raw start where the system has one a stepped wall clock cannot move (Linux: `starttime`, clock ticks after
    /// boot); `None` on macOS. Core's liveness check compares it with the state json's `pidStartTicks`.
    pub start_ticks: Option<u64>,
    /// The executable file, as the system names it (Linux: `/proc/<pid>/exe` without its ` (deleted)`); `None`
    /// when it cannot be read (another user's, a non-dumpable process, a zombie, a kernel thread).
    pub exe: Option<Vec<u8>>,
    /// The command line (`argv`), empty when there is none to read.
    pub argv: Vec<Vec<u8>>,
}

/// A process's `exe` link without the ` (deleted)` the kernel adds once the file is gone.
pub fn exe_path(link: &[u8]) -> &[u8] {
    link.strip_suffix(b" (deleted)").unwrap_or(link)
}

/// The NUL-separated arguments of `/proc/<pid>/cmdline`.
pub fn cmdline(buf: &[u8]) -> Vec<Vec<u8>> {
    let buf = buf.strip_suffix(b"\0").unwrap_or(buf);
    if buf.is_empty() { Vec::new() } else { buf.split(|&b| b == 0).map(<[u8]>::to_vec).collect() }
}

/// The processes of user `uid` under `root` (`/proc`, or a recorded tree): every numeric entry, or only `pids` when
/// given. A process that ends while it is read, or is not `uid`'s, is left out; so is one whose `stat` or `status`
/// cannot be read (`hidepid`). `clk_tck` is `sysconf(_SC_CLK_TCK)`. Errors only when `root` itself cannot be
/// read.
pub fn read_procs(root: &Path, uid: u32, pids: Option<&[i32]>, clk_tck: u64) -> io::Result<Vec<Row>> {
    let btime = btime(&std::fs::read(root.join("stat"))?).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no btime in stat"))?;
    let listed: Vec<i32> = match pids {
        Some(p) => p.to_vec(),
        None => {
            let mut all: Vec<i32> = std::fs::read_dir(root)?.filter_map(|e| num(e.ok()?.file_name().as_bytes())).collect();
            all.sort_unstable();
            all
        }
    };
    let mut rows = Vec::new();
    for pid in listed.into_iter().filter(|&p| p > 0) {
        let dir = root.join(pid.to_string());
        let (Ok(stat), Ok(status)) = (std::fs::read(dir.join("stat")), std::fs::read(dir.join("status"))) else { continue };
        let (Some(st), Some(owner)) = (parse_stat(&stat), status_euid(&status)) else { continue };
        if owner != uid || st.pid != pid {
            continue;
        }
        let exe = std::fs::read_link(dir.join("exe")).ok().map(|p| exe_path(p.as_os_str().as_bytes()).to_vec());
        let argv = std::fs::read(dir.join("cmdline")).map(|c| cmdline(&c)).unwrap_or_default();
        rows.push(Row { pid, ppid: st.ppid, start_us: start_us(st.starttime, btime, clk_tck), start_ticks: Some(st.starttime), exe, argv });
    }
    Ok(rows)
}

// ── admission's reads ───────────────────────────────────────────────────────────────────────

/// A file only root can change: owned by root, writable by neither its group nor others. A 0775 file is
/// refused, so packages install 0755.
pub fn root_only(uid: u32, mode: u32) -> bool {
    uid == 0 && mode & 0o022 == 0
}

/// Does a command line name an Electron utility process running Node's service, as ptyhost is? Looked for
/// within its text, not as arguments of their own: Chromium rewrites a child's process title, so the whole command
/// line reads as one string.
pub fn names_node_service(cmdline: &[u8]) -> bool {
    let has = |needle: &[u8]| cmdline.windows(needle.len()).any(|w| w == needle);
    has(b"--type=utility") && has(b"--utility-sub-type=node.mojom.NodeService")
}

/// What an executable mapping of `/proc/<pid>/maps` is backed by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecMapping<'a> {
    /// Anonymous memory (JIT code), or one of the kernel's own (`[vdso]`, `[vsyscall]`, a named `[anon:…]`).
    Anonymous,
    /// A file: its path as the kernel prints it, without ` (deleted)`; its inode; whether the kernel marks it deleted.
    File { path: &'a [u8], ino: u64, deleted: bool },
    /// A `memfd:` file: code from memory, which no file on disk vouches for.
    Memfd,
    /// Anything else (an `anon_inode:…`): not known, so not trusted.
    Other,
}

/// The executable mappings of a `/proc/<pid>/maps` text, in order (`perms` with `x`); others are skipped. A line is
/// `start-end perms offset dev inode` and, after spaces, the path to the end of the line (it may hold spaces). A line
/// that does not read so, and could be code, is `Other`: admission refuses what it cannot read.
pub fn exec_mappings(maps: &[u8]) -> impl Iterator<Item = ExecMapping<'_>> {
    maps.split(|&b| b == b'\n').filter(|line| !line.is_empty()).filter_map(|line| {
        let mut rest = line;
        let mut field = || {
            let start = rest.iter().position(|&b| b != b' ')?;
            let len = rest[start..].iter().position(|&b| b == b' ').unwrap_or(rest.len() - start);
            let f = &rest[start..start + len];
            rest = &rest[start + len..];
            Some(f)
        };
        let (Some(_range), Some(perms)) = (field(), field()) else { return Some(ExecMapping::Other) };
        if perms.get(2) != Some(&b'x') {
            return None;
        }
        let (Some(_offset), Some(_dev), Some(ino)) = (field(), field(), field()) else { return Some(ExecMapping::Other) };
        let Some(ino) = num::<u64>(ino) else { return Some(ExecMapping::Other) };
        let path = &rest[rest.iter().position(|&b| b != b' ').unwrap_or(rest.len())..];
        Some(match path {
            [] | [b'[', ..] => ExecMapping::Anonymous,
            p if p.starts_with(b"/memfd:") => ExecMapping::Memfd,
            [b'/', ..] => match path.strip_suffix(b" (deleted)") {
                Some(p) => ExecMapping::File { path: p, ino, deleted: true },
                None => ExecMapping::File { path, ino, deleted: false },
            },
            _ => ExecMapping::Other,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `fixtures/os/linux/`: files recorded on Ubuntu 24.04 (arm64), scrubbed.
    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/os/linux")
    }

    fn read(rel: &str) -> Vec<u8> {
        std::fs::read(fixtures().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    // The files `procs` and the holder read, as recorded.
    #[test]
    fn u_plt_3_stat_status_and_btime_parse_as_recorded() {
        let st = parse_stat(&read("proc/2472/stat")).unwrap();
        assert_eq!(st, Stat { pid: 2472, state: b'S', ppid: 2468, pgrp: 2467, session: 2467, tty_nr: 0, flags: 4194304, starttime: 35543 });
        assert!(!st.exiting());
        let zombie = parse_stat(&read("proc/2516/stat")).unwrap();
        assert!(zombie.exiting(), "state Z");
        assert_eq!(parse_stat(&read("proc/2/stat")).unwrap().ppid, 0, "kthreadd");
        // a name with spaces and parentheses, and a controlling terminal (/dev/pts/3: major 136, minor 3)
        let odd = parse_stat(b"77 (a) b (c)) R 1 77 77 34819 77 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1234 0 0").unwrap();
        assert_eq!((odd.pid, odd.state, odd.ppid, odd.tty_nr, odd.starttime), (77, b'R', 1, 34819, 1234));
        assert_eq!(odd.tty_nr, (3 & 0xff) | (136 << 8), "new_encode_dev(136, 3)");
        assert!(parse_stat(b"77 (cut").is_none());
        assert!(parse_stat(b"").is_none());
        assert!(parse_stat(&[0xff; 40]).is_none());
        assert!(odd.flags & PF_EXITING == 0);
        let status = read("proc/2472/status");
        assert_eq!(status_euid(&status), Some(1001));
        assert_eq!(status_footprint(&status), 4836 * 1024, "RssAnon + VmSwap");
        assert_eq!(status_footprint(&read("proc/2516/status")), 0, "a zombie has no memory lines");
        assert_eq!(status_euid(b"Name:\tx\nUid:\t1\t2\t3\t4\n"), Some(2), "the effective uid");
        assert_eq!(btime(&read("proc/stat")), Some(1_792_438_474));
        assert_eq!(start_us(35543, 1_792_438_474, 100), 1_792_438_474_000_000 + 355_430_000);
        assert_eq!(socket_inode(b"socket:[13167]"), Some(13167));
        assert_eq!(socket_inode(b"pipe:[15679]"), None);
        assert_eq!(exe_path(b"/home/user/.kea/bin/x/kea-helper (deleted)"), b"/home/user/.kea/bin/x/kea-helper");
        assert_eq!(cmdline(b"python3\0/tmp/listen.py\0"), vec![b"python3".to_vec(), b"/tmp/listen.py".to_vec()]);
        assert!(cmdline(b"").is_empty());
    }

    #[test]
    fn r_plt_1_the_holders_own_scope_is_found_by_its_unit_name() {
        let cg = b"0::/user.slice/user-1001.slice/user@1001.service/app.slice/kea-0a1b2c3d-abcdefghij.scope\n";
        let path = cgroup_v2_path(cg).unwrap();
        assert!(is_own_scope(path, "abcdefghij"));
        assert!(!is_own_scope(path, "bcdefghijk"), "another terminal's scope");
        assert!(!is_own_scope(cgroup_v2_path(&read("self-cgroup")).unwrap(), "abcdefghij"), "a login session's scope");
        assert!(!is_own_scope(b"/a/kea-0a1b2c3-abcdefghij.scope", "abcdefghij"), "7 hex digits");
        assert!(!is_own_scope(b"/a/kea-0a1b2c3g-abcdefghij.scope", "abcdefghij"));
        assert!(!is_own_scope(b"/a/kea-0a1b2c3d-abcdefghij.service", "abcdefghij"));
        assert_eq!(cgroup_v2_path(b"12:pids:/x\n"), None, "cgroup v1 only");
    }

    // A long `Groups:` line (a directory-service user in hundreds of groups) comes before `RssAnon` and `VmSwap`: the
    // footprint is read from the whole file, never from its first page alone (which would read 0 with no error).
    #[test]
    fn r_plt_3_the_footprint_is_read_from_the_whole_status_file() {
        let groups: String = (10_000..10_900).map(|g| format!("{g} ")).collect();
        let text = format!("Name:\tbash\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t1001\t1001\t1001\t1001\nGroups:\t{groups}\nVmRSS:\t   4096 kB\nRssAnon:\t   1024 kB\nRssFile:\t   3072 kB\nVmSwap:\t    256 kB\n");
        assert!(text.len() > 4096 + 64, "past a page: {}", text.len());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("status");
        std::fs::write(&file, &text).unwrap();
        assert_eq!(footprint_at(&file).unwrap(), (1024 + 256) * 1024);
        assert_eq!(footprint_at(&dir.path().join("gone")).unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    // The recorded tables: one process's listeners on 127.0.0.1, 0.0.0.0, ::1, a dual-stack :: and a v4-mapped
    // ::ffff:127.0.0.1, beside another user's (sshd, resolved) and a connected pair; and the same program in a
    // network namespace of its own, whose table holds only its own sockets.
    #[test]
    fn u_plt_4_tcp_tables_give_each_process_its_listeners_v4_mapped_and_any_addresses_per_namespace() {
        let fd_inodes = |rel: &str| -> Vec<u64> {
            String::from_utf8(read(rel)).unwrap().lines().filter_map(|l| socket_inode(l.split_once(' ')?.1.as_bytes())).collect()
        };
        let host = fd_inodes("net/host/fd.links");
        assert_eq!(host.len(), 7, "five listeners, a client and the connection it was accepted as");
        let mut out = Vec::new();
        listeners(&read("net/host/tcp"), false, &host, &mut out);
        listeners(&read("net/host/tcp6"), true, &host, &mut out);
        let got: Vec<(bool, &str, u16)> = out.iter().map(|l| (l.v6, l.addr.as_str(), l.port)).collect();
        assert_eq!(
            got,
            [(false, "0.0.0.0", 51429), (false, "127.0.0.1", 53455), (true, "::ffff:127.0.0.1", 36167), (true, "::1", 35429), (true, "::", 53533)],
            "LISTEN rows with this process's inodes only: not sshd's or resolved's, not the connected pair"
        );
        // a dual-stack `::` listener is in tcp6 only, so it prints once, as tcp6 (as on macOS)
        assert_eq!(out.iter().filter(|l| l.port == 53533).count(), 1);

        let ns = fd_inodes("net/ns/fd.links");
        let mut in_ns = Vec::new();
        listeners(&read("net/ns/tcp"), false, &ns, &mut in_ns);
        listeners(&read("net/ns/tcp6"), true, &ns, &mut in_ns);
        assert_eq!(in_ns.len(), 5, "{in_ns:?}");
        assert!(in_ns.contains(&Listening { v6: true, addr: "::ffff:127.0.0.1".into(), port: 40295 }));
        // the namespace's sockets are not in the host's tables, and the host's are not in its
        let mut crossed = Vec::new();
        listeners(&read("net/host/tcp"), false, &ns, &mut crossed);
        listeners(&read("net/ns/tcp6"), true, &host, &mut crossed);
        assert_eq!(crossed, []);
        // rows that are not well formed are skipped, not misread
        let mut bad = Vec::new();
        listeners(b"head\n 0: 0100007F:ZZZZ 00000000:0000 0A 0 0 0 0 0 7\n 1: 01007F:0016 00000000:0000 0A 0 0 0 0 0 7\n 2: short\n", false, &[7], &mut bad);
        assert_eq!(bad, []);
    }

    // The recorded host tables again, read for `ports --all`: the LISTEN rows whose inode no process of this user
    // holds (sshd's, systemd-resolved's two, cups'), each once; this user's listeners and every non-LISTEN row are not.
    #[test]
    fn r_plt_6_ports_all_lists_what_no_process_of_this_user_holds_as_another_users() {
        let owned: Vec<u64> =
            String::from_utf8(read("net/host/fd.links")).unwrap().lines().filter_map(|l| socket_inode(l.split_once(' ')?.1.as_bytes())).collect();
        let mut out = Vec::new();
        listeners_unowned(&read("net/host/tcp"), false, &owned, &mut out);
        listeners_unowned(&read("net/host/tcp6"), true, &owned, &mut out);
        let v4: Vec<(&str, u16)> = out.iter().filter(|l| !l.v6).map(|l| (l.addr.as_str(), l.port)).collect();
        assert_eq!(v4, [("127.0.0.53", 53), ("0.0.0.0", 22), ("127.0.0.54", 53), ("127.0.0.1", 631)]);
        let v6: Vec<(&str, u16)> = out.iter().filter(|l| l.v6).map(|l| (l.addr.as_str(), l.port)).collect();
        assert_eq!(v6, [("::", 22), ("::1", 631)]);
        for mine in [51429, 53455, 36167, 35429, 53533] {
            assert!(!out.iter().any(|l| l.port == mine), "this user's listener {mine} is not another user's: {out:?}");
        }
        // with every listener's inode owned, nothing is another user's
        let all = [13171, 5891, 7442, 13167, 5893, 8825];
        let mut none = Vec::new();
        listeners_unowned(&read("net/host/tcp"), false, &all, &mut none);
        assert_eq!(none, []);
    }

    #[test]
    fn u_plt_3_procs_from_a_recorded_proc_tree_this_users_processes_only() {
        let root = fixtures().join("proc");
        let rows = read_procs(&root, 1001, None, 100).unwrap();
        let shown = rows.iter().map(|r| crate::procs::line(r, true)).collect::<Vec<_>>().join("");
        assert_eq!(shown, String::from_utf8(read("procs.txt")).unwrap(), "`kea-helper procs --args` of the recorded tree");
        // kthreadd and init are root's; another user's processes are never listed
        assert!(rows.iter().all(|r| r.pid != 1 && r.pid != 2));
        assert_eq!(read_procs(&root, 0, None, 100).unwrap().iter().map(|r| r.pid).collect::<Vec<_>>(), [1, 2]);
        // only the pids asked for; a pid that is not there is left out
        let some = read_procs(&root, 1001, Some(&[2516, 99999, 2472]), 100).unwrap();
        assert_eq!(some.iter().map(|r| r.pid).collect::<Vec<_>>(), [2516, 2472]);
        assert!(read_procs(&fixtures().join("nowhere"), 1001, None, 100).is_err(), "no /proc: cannot tell");
    }

    // Admission's reads: which executable mappings name a file, and the deleted, memfd and anonymous ones; the
    // utility process's title found within its text; a file only root can change. Recorded from an Electron utility
    // process (Node's service) on Ubuntu 24.04 arm64, scrubbed.
    #[test]
    fn u_plt_12_admissions_reads_exec_mappings_the_utility_title_and_root_only_files() {
        let maps = read("admission/maps");
        let all: Vec<ExecMapping> = exec_mappings(&maps).collect();
        let files: Vec<&[u8]> = all.iter().filter_map(|m| if let ExecMapping::File { path, .. } = m { Some(*path) } else { None }).collect();
        assert!(files.contains(&b"/opt/kea-test/kea-app".as_slice()), "{:?}", files.iter().map(|f| String::from_utf8_lossy(f)).collect::<Vec<_>>());
        assert!(files.iter().all(|f| f.starts_with(b"/")), "only files, by path");
        assert!(all.contains(&ExecMapping::Anonymous), "JIT code and [vdso]");
        assert!(all.iter().all(|m| !matches!(m, ExecMapping::Memfd | ExecMapping::Other)), "Electron maps no memfd and nothing unknown as code");
        let lines = b"aaaa-bbbb r-xp 00000000 fd:02 1354936                    /opt/Kea/kea-app (deleted)\n\
cccc-dddd r--p 00000000 fd:02 77                         /usr/lib/locale/C.utf8/LC_CTYPE\n\
eeee-ffff r-xp 00000000 00:01 4100                       /memfd:jit (deleted)\n\
1111-2222 rwxp 00000000 00:00 0 \n\
3333-4444 r-xp 00000000 00:00 0                          [vdso]\n\
5555-6666 r-xs 00000000 00:0f 12                         anon_inode:[perf_event]\n\
7777-8888 r-xp 00001000 fd:02 999                        /home/u/My Lib/libx.so\n";
        let got: Vec<ExecMapping> = exec_mappings(lines).collect();
        assert_eq!(
            got,
            [
                ExecMapping::File { path: b"/opt/Kea/kea-app", ino: 1354936, deleted: true },
                ExecMapping::Memfd,
                ExecMapping::Anonymous,
                ExecMapping::Anonymous,
                ExecMapping::Other,
                ExecMapping::File { path: b"/home/u/My Lib/libx.so", ino: 999, deleted: false },
            ],
            "the read-only mapping is skipped; a path keeps its spaces"
        );
        // a line that does not parse is refused, never passed over: admission fails closed
        let torn = b"aaaa-bbbb r-xp 00000000 fd:02 12x                        /opt/Kea/kea-app\n\
cccc-dddd r-xp\n\
eeee-ffff\n\
1111-2222 r--p 00000000\n\n";
        assert_eq!(exec_mappings(torn).collect::<Vec<_>>(), [ExecMapping::Other, ExecMapping::Other, ExecMapping::Other], "a bad inode, a cut code line, no permissions; a cut read-only line and an empty one are not code");
        // Chromium's rewritten title is one string; separate arguments read the same
        assert!(names_node_service(&read("admission/cmdline")));
        assert!(names_node_service(b"/opt/Kea/kea-app\0--type=utility\0--utility-sub-type=node.mojom.NodeService\0--lang=en-US\0"));
        assert!(!names_node_service(b"/opt/Kea/kea-app --type=renderer --utility-sub-type=node.mojom.NodeService"), "a renderer");
        assert!(!names_node_service(b"/opt/Kea/kea-app\0--type=utility\0--utility-sub-type=network.mojom.NetworkService\0"), "another utility");
        assert!(!names_node_service(b"/opt/Kea/kea-app\0"), "Kea's main");
        assert!(!names_node_service(b"--type=util\0ity --utility-sub-type=node.mojom.NodeService"), "never across a NUL");
        // root's and closed to others: 0755 and 0555 yes; 0775, 0757 and another owner's no
        assert!(root_only(0, 0o100755) && root_only(0, 0o040555) && root_only(0, 0o104755));
        assert!(!root_only(0, 0o100775) && !root_only(0, 0o100757) && !root_only(1000, 0o100755) && !root_only(0, 0o041777));
    }
}
