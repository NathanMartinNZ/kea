//! `kea-helper footprint <pid…>`: one line per pid, `<pid> <bytes>` (macOS: `ri_phys_footprint`; Linux:
//! `RssAnon + VmSwap`) or `<pid> error <reason>`. Always exits 0.

use std::ffi::OsString;
use std::io::Write;

pub fn line(arg: &str) -> String {
    let Ok(pid) = arg.parse::<i32>() else { return format!("{arg} error invalid pid") };
    match crate::os::footprint(pid) {
        Ok(bytes) => format!("{pid} {bytes}"),
        Err(e) => format!("{pid} error {}", reason(&e)),
    }
}

/// A short, stable reason: `ESRCH` → `no such process`, `EPERM` → `permission denied`, else the OS text.
pub fn reason(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::ESRCH) => "no such process".into(),
        Some(libc::EPERM) | Some(libc::EACCES) => "permission denied".into(),
        _ => e.to_string(),
    }
}

/// One line per argument, in order.
pub fn report(args: &[OsString], out: &mut impl Write) -> std::io::Result<()> {
    for a in args {
        writeln!(out, "{}", line(&a.to_string_lossy()))?;
    }
    out.flush()
}

pub fn main(args: &[OsString]) -> i32 {
    let _ = report(args, &mut std::io::stdout().lock());
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    const MIB: u64 = 1 << 20;
    /// How much the probe process touches.
    const GROWTH: u64 = 64 * MIB;
    /// Allowed difference between the growth reported and `GROWTH`: the interpreter allocates a little
    /// around the call (frames, its read buffer) and malloc rounds large blocks up to whole pages. A value
    /// that is not the physical footprint (a virtual size, resident shared pages) would be off by far more,
    /// or not move at all.
    const TOLERANCE: u64 = 4 * MIB;

    fn bytes_of(l: &str, pid: u32) -> u64 {
        l.strip_prefix(&format!("{pid} ")).and_then(|b| b.parse().ok()).unwrap_or_else(|| panic!("{l}"))
    }

    /// A process that, on each line it reads, says so after touching `GROWTH` more bytes (the first line:
    /// none), so its footprint can be read before and after.
    struct Probe {
        child: std::process::Child,
        out: BufReader<std::process::ChildStdout>,
    }

    impl Probe {
        fn start() -> Probe {
            let script = format!(
                "import sys\nkeep = []\nfirst = True\nwhile sys.stdin.readline():\n    if not first: keep.append(b'\\x01' * {GROWTH})\n    first = False\n    print('ok', flush=True)\n"
            );
            let mut child = Command::new("/usr/bin/python3").args(["-c", &script]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap(); // os-ok: in /usr/bin on both systems
            let out = BufReader::new(child.stdout.take().unwrap());
            Probe { child, out }
        }
        /// Asks for one step and waits for its answer.
        fn step(&mut self) {
            use std::io::Write;
            writeln!(self.child.stdin.as_mut().unwrap()).unwrap();
            let mut l = String::new();
            self.out.read_line(&mut l).unwrap();
            assert_eq!(l, "ok\n");
        }
        fn footprint(&self) -> u64 {
            bytes_of(&line(&self.child.id().to_string()), self.child.id())
        }
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn r_mem_1_self_and_unknown_pids() {
        let me = std::process::id();
        let bytes = bytes_of(&line(&me.to_string()), me);
        // a test process: a few hundred KiB of its own memory on Linux (RssAnon), a few MiB on macOS
        assert!(bytes > MIB / 8, "a test process has a footprint above 128 KiB, got {bytes}");
        // A pid that just exited and was reaped.
        let mut c = Command::new("/usr/bin/true").spawn().unwrap(); // os-ok: in /usr/bin on both systems
        let gone = c.id();
        c.wait().unwrap();
        assert_eq!(line(&gone.to_string()), format!("{gone} error no such process"));
        assert_eq!(line("abc"), "abc error invalid pid");
        assert!(line("-1").starts_with("-1 error"));
    }

    // The value is the physical footprint: a process that touches GROWTH bytes grows by about that much.
    #[test]
    fn r_mem_1_tracks_the_physical_footprint() {
        let mut p = Probe::start();
        p.step();
        let before = p.footprint();
        p.step();
        let after = p.footprint();
        let grown = after.saturating_sub(before);
        assert!(grown.abs_diff(GROWTH) <= TOLERANCE, "grew by {grown} bytes after touching {GROWTH} ({before} → {after})");
        p.step();
        let again = p.footprint();
        assert!(again.saturating_sub(after).abs_diff(GROWTH) <= TOLERANCE, "{after} → {again}");
    }

    // Several pids, one gone and one not a pid: a line each, in argument order, and exit 0.
    #[test]
    fn r_mem_1_several_pids_one_line_each_in_order() {
        let a = Probe::start();
        let b = Probe::start();
        let mut c = Command::new("/usr/bin/true").spawn().unwrap(); // os-ok: in /usr/bin on both systems
        let gone = c.id();
        c.wait().unwrap();
        let args: Vec<OsString> =
            [b.child.id().to_string(), gone.to_string(), "x1".into(), a.child.id().to_string()].into_iter().map(Into::into).collect();
        let mut out = Vec::new();
        report(&args, &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4, "{text}");
        assert!(bytes_of(lines[0], b.child.id()) > 0);
        assert_eq!(lines[1], format!("{gone} error no such process"));
        assert_eq!(lines[2], "x1 error invalid pid");
        assert!(bytes_of(lines[3], a.child.id()) > 0);
        assert_eq!(main(&[]), 0, "no arguments: nothing printed, exit 0");
    }
}
