//! `kea-helper procs [--args] [<pid>…]`: this user's processes but its own, one line each, which Kea reads
//! where it would otherwise run `ps`: core's holder liveness check, the pruning of old helper copies, and the
//! install tool's process list. macOS reads libproc, Linux `/proc` (`os::processes`); one format and one parser
//! (`@kea/protocol`'s `parseProcs`) serve both.
//!
//! A line is tab-separated: `<pid>`, `<ppid>`, the start time in µs since the epoch (on Linux followed by `/` and the
//! raw start, clock ticks after boot, which a stepped wall clock does not move), the executable file (`-` when
//! it cannot be read), then `argv[0]` (what `ps -o comm` printed: the path it was started by), and with `--args` every
//! further argument. Text is escaped so a line is one line of UTF-8:
//! `\\`, `\t`, `\n`, and `\xHH` for any other control byte and any byte that is not UTF-8. With pids, only those that
//! run as this user are listed (a pid that does not prints nothing). Its own process is never listed: nobody asks about
//! it, and a bundle's own helper would otherwise count as a process running from the bundle, which the install tool
//! waits to see exit. Exit 0; 1 when the processes cannot be read (`kea-helper procs: <reason>` on stderr); 2 for an
//! argument that is neither `--args` nor a pid.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::io::Write;

use crate::os::procfs::Row;

/// Appends `bytes`, escaped as the module comment says.
fn escape(out: &mut String, bytes: &[u8]) {
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '\t' => out.push_str("\\t"),
                '\n' => out.push_str("\\n"),
                c if (c as u32) < 0x20 || c == '\x7f' => {
                    let _ = write!(out, "\\x{:02x}", c as u32);
                }
                c => out.push(c),
            }
        }
        for b in chunk.invalid() {
            let _ = write!(out, "\\x{b:02x}");
        }
    }
}

/// One process's line, with its newline; `args`: every argument, else `argv[0]` only.
pub fn line(r: &Row, args: bool) -> String {
    let mut s = format!("{}\t{}\t{}", r.pid, r.ppid, r.start_us);
    if let Some(t) = r.start_ticks {
        let _ = write!(s, "/{t}");
    }
    s.push('\t');
    match r.exe.as_deref() {
        None => s.push('-'),
        Some(b"-") => s.push_str("\\x2d"), // never the "unknown" mark
        Some(exe) => escape(&mut s, exe),
    }
    for a in r.argv.iter().take(if args { usize::MAX } else { 1 }) {
        s.push('\t');
        escape(&mut s, a);
    }
    s.push('\n');
    s
}

pub fn main(raw: &[OsString]) -> i32 {
    let mut args = false;
    let mut pids = Vec::new();
    for a in raw {
        if a == "--args" {
            args = true;
            continue;
        }
        match a.to_str().and_then(|p| p.parse::<i32>().ok()).filter(|&p| p > 0) {
            Some(pid) => pids.push(pid),
            None => {
                eprintln!("{}", crate::USAGE);
                return 2;
            }
        }
    }
    match crate::os::processes(if pids.is_empty() { None } else { Some(&pids) }) {
        Ok(rows) => {
            let mut out = std::io::stdout().lock();
            let me = std::process::id() as i32; // never listed (module comment)
            for r in rows.iter().filter(|r| r.pid != me) {
                if out.write_all(line(r, args).as_bytes()).is_err() {
                    return 1;
                }
            }
            if out.flush().is_err() { 1 } else { 0 }
        }
        Err(e) => {
            eprintln!("kea-helper procs: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u_plt_3_a_line_is_tab_separated_and_escaped() {
        let row = |exe: Option<&[u8]>, argv: &[&[u8]]| Row { pid: 7, ppid: 1, start_us: 1_792_438_474_355_430, start_ticks: None, exe: exe.map(<[u8]>::to_vec), argv: argv.iter().map(|a| a.to_vec()).collect() };
        let r = row(Some(b"/Applications/My App.app/Contents/MacOS/kea-helper"), &[b"/x/kea-helper", b"pty-daemon", b"--id", b"a b"]); // os-ok: test data
        assert_eq!(line(&r, false), "7\t1\t1792438474355430\t/Applications/My App.app/Contents/MacOS/kea-helper\t/x/kea-helper\n"); // os-ok: test data
        assert_eq!(line(&r, true), "7\t1\t1792438474355430\t/Applications/My App.app/Contents/MacOS/kea-helper\t/x/kea-helper\tpty-daemon\t--id\ta b\n"); // os-ok: test data
        assert_eq!(line(&row(None, &[]), true), "7\t1\t1792438474355430\t-\n", "a zombie: no executable, no arguments");
        assert_eq!(line(&row(Some(b"-"), &[b"-"]), true), "7\t1\t1792438474355430\t\\x2d\t-\n");
        let linux = Row { start_ticks: Some(35_543), ..row(Some(b"/usr/bin/sleep"), &[b"sleep", b"300"]) }; // os-ok: test data
        assert_eq!(line(&linux, true), "7\t1\t1792438474355430/35543\t/usr/bin/sleep\tsleep\t300\n", "Linux: the raw start after the µs"); // os-ok: test data
        let odd = row(Some("/h/é\\x\ty\nz\x01\x7f".as_bytes()), &[b"\xff\xfeok"]);
        assert_eq!(line(&odd, true), "7\t1\t1792438474355430\t/h/é\\\\x\\ty\\nz\\x01\\x7f\t\\xff\\xfeok\n");
    }
}
