//! The child's process tree: who belongs to this terminal, signals and termination.

use crate::os::{self, ProcInfo, ProcScan};

/// A process recorded at snapshot time; the start time guards against pid reuse before `SIGKILL`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Member {
    pub pid: i32,
    pub pgid: i32,
    /// `ProcInfo::start`: the system's own measure, compared, never converted.
    pub start: u64,
    pub in_session: bool,
}

/// Every process of this user's that belongs to the child's terminal: descendants of the child, members of its
/// session (the child is the session leader), and processes whose controlling terminal or stdio is
/// this PTY — which catches double-forked `setsid` daemons that were reparented (to launchd on macOS;
/// to init or a subreaper on Linux).
///
/// After the child is reaped its pid may be reused, so: no descendant tree (its orphans have been
/// reparented anyway); session membership only while no process holds that pid (neither XNU nor Linux
/// reuses a pid that is still a live session id, so the session's members are the child's); and `tty_rdev` is
/// `None` once the holder closed the PTY, because tty devices are reused.
///
/// The candidates are `scan`'s: every process, or on Linux in a scope of its own the scope's members.
pub fn snapshot(scan: &ProcScan, child: i32, child_reaped: bool, tty_rdev: Option<u32>, exclude: i32) -> Vec<Member> {
    let uid = unsafe { libc::getuid() };
    let infos: Vec<ProcInfo> = scan
        .candidates()
        .unwrap_or_default()
        .into_iter()
        .filter(|&p| p > 1 && p != exclude)
        .filter_map(|p| os::proc_info(p).ok())
        .filter(|i| i.uid == uid)
        .collect();
    let session_is_ours = !child_reaped || !infos.iter().any(|i| i.pid == child) && os::proc_info(child).is_err();
    let mut tree = if child_reaped { vec![] } else { vec![child] };
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        let kids: Vec<i32> = infos.iter().filter(|c| c.ppid == parent && !tree.contains(&c.pid)).map(|c| c.pid).collect();
        tree.extend(kids);
        i += 1;
    }
    infos
        .iter()
        .filter_map(|p| {
            let in_session = session_is_ours && unsafe { libc::getsid(p.pid) } == child;
            let on_tty = tty_rdev.is_some_and(|t| p.tdev == t || (0..3).any(|fd| os::fd_char_rdev(p.pid, fd) == Some(t)));
            (in_session || on_tty || tree.contains(&p.pid)).then_some(Member { pid: p.pid, pgid: p.pgid, start: p.start, in_session })
        })
        .collect()
}

/// Sends `sig` to every process group of the child's session (`SIGNAL` target 2).
pub fn signal_session(members: &[Member], sig: i32) {
    let mut groups: Vec<i32> = members.iter().filter(|m| m.in_session && m.pgid > 1).map(|m| m.pgid).collect();
    groups.sort_unstable();
    groups.dedup();
    for g in groups {
        unsafe { libc::killpg(g, sig) };
    }
}

/// First phase of `TERMINATE`: `SIGTERM` the session's groups and every other member, then `SIGCONT`
/// so stopped processes can act on it. A member is signalled by `os::kill_member` (Linux: through a pidfd, never a
/// reused pid).
pub fn term(members: &[Member]) {
    for sig in [libc::SIGTERM, libc::SIGCONT] {
        signal_session(members, sig);
        for m in members.iter().filter(|m| !m.in_session) {
            os::kill_member(m.pid, m.start, sig);
        }
    }
}

/// The member is still that process: its pid runs, with the start time recorded (pids are reused).
fn alive(m: &Member) -> bool {
    os::proc_info(m.pid).is_ok_and(|i| i.start == m.start)
}

/// Second phase: `SIGKILL` every member still alive with the same start time.
pub fn kill(members: &[Member]) {
    for m in members.iter().filter(|m| alive(m)) {
        os::kill_member(m.pid, m.start, libc::SIGKILL);
    }
}

/// A `TERMINATE` that arrives during another's grace period: its snapshot joins the members the
/// pending `SIGKILL` will reach. Members that have exited since are dropped and a process already listed
/// (same pid and start time) is not added again, so the list holds at most the terminal's live processes
/// however many `TERMINATE`s arrive.
pub fn merge(members: &mut Vec<Member>, snapshot: Vec<Member>) {
    members.retain(alive);
    for m in snapshot {
        if !members.iter().any(|o| o.pid == m.pid && o.start == m.start) {
            members.push(m);
        }
    }
}
