//! `kea-helper ports <pid…>`: every TCP socket in `LISTEN` per pid (`os::Ports`; macOS:
//! `proc_pidinfo(PROC_PIDLISTFDS)` + `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)`; Linux: `/proc/<pid>/fd` against the
//! `net/tcp{,6}` tables of the pid's network namespace, each read once per run):
//! `<pid> tcp4|tcp6 <local address> <port>`, or `<pid> error <reason>`. Always exits 0.
//!
//! `kea-helper ports --all` (Linux, who holds a port): the same lines for every process of this user, then
//! `- tcp4|tcp6 <local address> <port>` for a listener of the helper's network namespace that no process of this user
//! holds (another user's). Exit 0; 1 with the reason on stderr where the system has none (macOS keeps `lsof`).

use std::ffi::OsString;
use std::io::Write;

use crate::os::{Listening, Ports};

pub fn lines(ports: &mut Ports, arg: &str) -> Vec<String> {
    let Ok(pid) = arg.parse::<i32>() else { return vec![format!("{arg} error invalid pid")] };
    match ports.listening(pid) {
        Ok(v) => v.iter().map(|l| format!("{pid} {} {} {}", if l.v6 { "tcp6" } else { "tcp4" }, l.addr, l.port)).collect(),
        Err(e) => vec![format!("{pid} error {}", crate::footprint::reason(&e))],
    }
}

/// One `ports --all` line: the pid, or `-` for another user's listener.
pub fn all_line(pid: Option<i32>, l: &Listening) -> String {
    let who = pid.map_or_else(|| "-".to_string(), |p| p.to_string());
    format!("{who} {} {} {}", if l.v6 { "tcp6" } else { "tcp4" }, l.addr, l.port)
}

pub fn main(args: &[OsString]) -> i32 {
    let mut out = std::io::stdout().lock();
    if args.len() == 1 && args[0] == "--all" {
        return match crate::os::all_listeners() {
            Ok(v) => {
                for (pid, l) in &v {
                    let _ = writeln!(out, "{}", all_line(*pid, l));
                }
                let _ = out.flush();
                0
            }
            Err(e) => {
                eprintln!("kea-helper ports --all: {e}");
                1
            }
        };
    }
    let mut ports = Ports::new();
    for a in args {
        for l in lines(&mut ports, &a.to_string_lossy()) {
            let _ = writeln!(out, "{l}");
        }
    }
    let _ = out.flush();
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn r_srv_1_lists_v4_and_v6_listeners_only() {
        let me = std::process::id() as i32;
        let v4 = TcpListener::bind("127.0.0.1:0").unwrap();
        let v6 = TcpListener::bind("[::1]:0").unwrap();
        let (p4, p6) = (v4.local_addr().unwrap().port(), v6.local_addr().unwrap().port());
        // A connected pair on the v4 listener: neither end is listening.
        let client = TcpStream::connect(("127.0.0.1", p4)).unwrap();
        let (server_side, _) = v4.accept().unwrap();
        let client_port = client.local_addr().unwrap().port();
        // A closed listener.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);

        let got = lines(&mut Ports::new(), &me.to_string());
        assert!(got.contains(&format!("{me} tcp4 127.0.0.1 {p4}")), "{got:?}");
        assert!(got.contains(&format!("{me} tcp6 ::1 {p6}")), "{got:?}");
        assert!(!got.iter().any(|l| l.ends_with(&format!(" {client_port}"))), "{got:?}");
        assert!(!got.iter().any(|l| l.ends_with(&format!(" {closed_port}"))), "{got:?}");
        assert_eq!(got.iter().filter(|l| l.ends_with(&format!(" {p4}"))).count(), 1, "accepted socket not listed: {got:?}");
        drop((client, server_side));

        // os-ok: in /usr/bin on both systems
        let mut c = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let gone = c.id();
        c.wait().unwrap();
        assert_eq!(lines(&mut Ports::new(), &gone.to_string()), vec![format!("{gone} error no such process")]);
        assert_eq!(lines(&mut Ports::new(), "x"), vec!["x error invalid pid".to_string()]);
    }
}
