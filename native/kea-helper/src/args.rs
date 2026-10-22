//! `kea-helper pty` arguments. Options come first, `--` ends them, and everything after it is
//! the child's argv, passed to `execvp` byte for byte.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

use crate::limits::{RING_BYTES_DEFAULT, RING_BYTES_MAX, RING_BYTES_MIN, SOCKET_PATH_MAX_BYTES};
use crate::rundir::socket_path_fits;

pub const KINDS: [&str; 4] = ["agent", "shell", "server", "script"];

/// Who the holder admits as its client. One of three options names it; which one a system takes is its OS
/// layer's (`os::PeerAdmission::new` refuses the others): macOS checks a code signature, Linux an executable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Client {
    /// `--client-req <requirement>`: a code requirement (macOS).
    Requirement(String),
    /// `--client-exe <path>` (`checked`: the file must be root's, and the peer's mappings are checked too) or
    /// `--client-exe-unchecked <path>` (only the file's identity: a user-writable install, a dev build, tests) (Linux).
    Exe { path: PathBuf, checked: bool },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtyArgs {
    pub id: String,
    pub session: String,
    pub kind: String,
    pub dir: PathBuf,
    pub sock: PathBuf,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub client: Client,
    pub ring_bytes: u64,
    pub kea_version: Option<String>,
    pub no_detach: bool,
    /// `pty-daemon` only: where to write `READY …` / `ERR …`.
    pub ready_fd: Option<i32>,
    pub file: OsString,
    pub args: Vec<OsString>,
    /// Index of the `--` separator in the raw arguments.
    pub separator: usize,
}

impl PtyArgs {
    /// `[file, args…]`, the child's argv.
    pub fn argv(&self) -> impl Iterator<Item = &OsStr> {
        std::iter::once(self.file.as_os_str()).chain(self.args.iter().map(|a| a.as_os_str()))
    }
}

/// `[0-9A-Za-z_-]{1,64}`: ids end up in file names.
pub fn valid_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn utf8(name: &str, v: &OsStr) -> Result<String, String> {
    v.to_str().map(str::to_owned).ok_or_else(|| format!("{name} must be UTF-8"))
}

fn number<T: std::str::FromStr>(name: &str, v: &OsStr) -> Result<T, String> {
    v.to_str().and_then(|s| s.parse().ok()).ok_or_else(|| format!("{name} must be a number, got {:?}", v))
}

/// Parses `pty` (launcher, `daemon = false`) or `pty-daemon` (`daemon = true`) arguments.
pub fn parse_pty(raw: &[OsString], daemon: bool) -> Result<PtyArgs, String> {
    let mut id = None;
    let mut session = None;
    let mut kind = None;
    let mut dir = None;
    let mut sock = None;
    let mut cwd = None;
    let mut cols = None;
    let mut rows = None;
    let mut client_req = None;
    let mut client_exe = None;
    let mut client_exe_unchecked = None;
    let mut ring_bytes = None;
    let mut kea_version = None;
    let mut no_detach = false;
    let mut ready_fd = None;

    let mut i = 0;
    let separator = loop {
        let Some(arg) = raw.get(i) else {
            return Err("missing `--` before the command".into());
        };
        let name = arg.to_str().unwrap_or("");
        if name == "--" {
            break i;
        }
        if name == "--no-detach" {
            if no_detach {
                return Err("--no-detach given twice".into());
            }
            no_detach = true;
            i += 1;
            continue;
        }
        let slot: &mut Option<OsString> = match name {
            "--id" => &mut id,
            "--session" => &mut session,
            "--kind" => &mut kind,
            "--dir" => &mut dir,
            "--sock" => &mut sock,
            "--cwd" => &mut cwd,
            "--cols" => &mut cols,
            "--rows" => &mut rows,
            "--client-req" => &mut client_req,
            "--client-exe" => &mut client_exe,
            "--client-exe-unchecked" => &mut client_exe_unchecked,
            "--ring-bytes" => &mut ring_bytes,
            "--kea-version" => &mut kea_version,
            "--ready-fd" if daemon => &mut ready_fd,
            _ => return Err(format!("unknown option {:?}", arg)),
        };
        let value = raw.get(i + 1).ok_or_else(|| format!("{name} needs a value"))?;
        if slot.replace(value.clone()).is_some() {
            return Err(format!("{name} given twice"));
        }
        i += 2;
    };

    let need = |v: Option<OsString>, name: &str| v.ok_or_else(|| format!("{name} is required"));
    let id = utf8("--id", &need(id, "--id")?)?;
    if !valid_id(&id) {
        return Err(format!("--id must match [0-9A-Za-z_-]{{1,64}}, got {id:?}"));
    }
    let session = utf8("--session", &need(session, "--session")?)?;
    if !valid_id(&session) {
        return Err(format!("--session must match [0-9A-Za-z_-]{{1,64}}, got {session:?}"));
    }
    let kind = utf8("--kind", &need(kind, "--kind")?)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("--kind must be one of {}, got {kind:?}", KINDS.join("|")));
    }
    let path = |v: OsString, name: &str| if v.is_empty() { Err(format!("{name} is empty")) } else { Ok(PathBuf::from(v)) };
    // the client's file is judged together with every folder above it, so it is named by its absolute path
    let client_path = |v: OsString, name: &str| path(v, name).and_then(|p| if p.is_absolute() { Ok(p) } else { Err(format!("{name} must be an absolute path")) });
    let dir = path(need(dir, "--dir")?, "--dir")?;
    let sock = path(need(sock, "--sock")?, "--sock")?;
    if !socket_path_fits(sock.as_os_str()) {
        return Err(format!(
            "socket path is {} bytes; the limit is {SOCKET_PATH_MAX_BYTES} (macOS sun_path): {}",
            sock.as_os_str().as_bytes().len(),
            sock.display()
        ));
    }
    let cwd = path(need(cwd, "--cwd")?, "--cwd")?;
    let cols: u16 = number("--cols", &need(cols, "--cols")?)?;
    let rows: u16 = number("--rows", &need(rows, "--rows")?)?;
    if cols == 0 || rows == 0 {
        return Err("--cols and --rows must be at least 1".into());
    }
    let client = match (client_req, client_exe, client_exe_unchecked) {
        (Some(req), None, None) => {
            let req = utf8("--client-req", &req)?;
            if req.trim().is_empty() {
                return Err("--client-req is empty".into());
            }
            Client::Requirement(req)
        }
        (None, Some(p), None) => Client::Exe { path: client_path(p, "--client-exe")?, checked: true },
        (None, None, Some(p)) => Client::Exe { path: client_path(p, "--client-exe-unchecked")?, checked: false },
        (None, None, None) => return Err("--client-req, --client-exe or --client-exe-unchecked is required".into()),
        _ => return Err("give only one of --client-req, --client-exe and --client-exe-unchecked".into()),
    };
    let ring_bytes = match ring_bytes {
        Some(v) => number("--ring-bytes", &v)?,
        None => RING_BYTES_DEFAULT,
    };
    if !(RING_BYTES_MIN..=RING_BYTES_MAX).contains(&ring_bytes) {
        return Err(format!("--ring-bytes must be within {RING_BYTES_MIN}..={RING_BYTES_MAX}, got {ring_bytes}"));
    }
    let kea_version = kea_version.map(|v| utf8("--kea-version", &v)).transpose()?;
    let ready_fd = ready_fd.map(|v| number::<i32>("--ready-fd", &v)).transpose()?;
    if daemon && ready_fd.is_none() && !no_detach {
        return Err("--ready-fd is required".into());
    }

    let mut rest = raw[separator + 1..].iter().cloned();
    let file = rest.next().filter(|f| !f.is_empty()).ok_or("missing command after `--`")?;
    Ok(PtyArgs {
        id,
        session,
        kind,
        dir,
        sock,
        cwd,
        cols,
        rows,
        client,
        ring_bytes,
        kea_version,
        no_detach,
        ready_fd,
        file,
        args: rest.collect(),
        separator,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn os(v: &[&[u8]]) -> Vec<OsString> {
        v.iter().map(|b| OsString::from_vec(b.to_vec())).collect()
    }

    fn base() -> Vec<&'static [u8]> {
        vec![
            b"--id", b"a1b2c3d4e5", b"--session", b"s_1-x", b"--kind", b"agent", b"--dir", b"/tmp/st", b"--sock",
            b"/tmp/r/a1b2c3d4e5.sock", b"--cwd", b"/tmp/w t", b"--cols", b"120", b"--rows", b"40", b"--client-req",
            b"cdhash H\"00\"",
        ]
    }

    // The holder's parse of its own argv. That an agent's launch never passes through a shell also rests on the
    // adapters' launch code; this case is only the holder's part of it.
    #[test]
    fn r_hld_4_argv_after_separator_is_byte_exact() {
        let mut a = base();
        let odd: Vec<&[u8]> = vec![b"--", b"/bin/echo", b"--", b"-n", b"a b", b"\"q'\"", b"line\nbreak", b"", b"\xff\xfe", b"--id"];
        a.extend(odd.iter().copied());
        let p = parse_pty(&os(&a), false).unwrap();
        assert_eq!(p.separator, base().len());
        assert_eq!(p.file, OsString::from("/bin/echo"));
        assert_eq!(p.args, os(&odd[2..]));
        assert_eq!(p.argv().count(), odd.len() - 1);
        assert_eq!((p.cols, p.rows, p.ring_bytes), (120, 40, RING_BYTES_DEFAULT));
        assert_eq!(p.cwd, PathBuf::from("/tmp/w t"));
        assert_eq!(p.client, Client::Requirement("cdhash H\"00\"".into()));
        assert!(!p.no_detach && p.kea_version.is_none() && p.ready_fd.is_none());
    }

    #[test]
    fn r_hld_4_options_and_errors() {
        let mut a = base();
        let ring = RING_BYTES_MIN.to_string();
        a.extend([b"--ring-bytes" as &[u8], ring.as_bytes(), b"--kea-version", b"0.3.0", b"--no-detach", b"--", b"sh"]);
        let p = parse_pty(&os(&a), false).unwrap();
        assert_eq!((p.ring_bytes, p.kea_version.as_deref(), p.no_detach), (RING_BYTES_MIN, Some("0.3.0"), true));
        assert!(p.args.is_empty());

        let err = |extra: &[&[u8]], daemon: bool| {
            let mut a = base();
            a.extend(extra.iter().copied());
            parse_pty(&os(&a), daemon).unwrap_err()
        };
        assert!(err(&[], false).contains("missing `--`"));
        assert!(err(&[b"sh"], false).contains("unknown option"), "a command needs the `--` before it");
        assert!(err(&[b"--"], false).contains("missing command"));
        assert!(err(&[b"--bogus", b"1", b"--", b"sh"], false).contains("unknown option"));
        assert!(err(&[b"--cols", b"9", b"--", b"sh"], false).contains("given twice"));
        let below = (RING_BYTES_MIN - 1).to_string();
        assert!(err(&[b"--ring-bytes", below.as_bytes(), b"--", b"sh"], false).contains("--ring-bytes"));
        assert!(err(&[b"--ready-fd", b"3", b"--", b"sh"], false).contains("unknown option"), "only the daemon takes --ready-fd");
        assert!(err(&[b"--", b"sh"], true).contains("--ready-fd is required"));
        let mut d = base();
        d.extend([b"--ready-fd" as &[u8], b"3", b"--", b"sh"]);
        assert_eq!(parse_pty(&os(&d), true).unwrap().ready_fd, Some(3));

        let mut bad_id = base();
        bad_id[1] = b"../x";
        bad_id.extend([b"--" as &[u8], b"sh"]);
        assert!(parse_pty(&os(&bad_id), false).unwrap_err().contains("--id"));
        let mut bad_kind = base();
        bad_kind[5] = b"robot";
        bad_kind.extend([b"--" as &[u8], b"sh"]);
        assert!(parse_pty(&os(&bad_kind), false).unwrap_err().contains("--kind"));
        let mut zero = base();
        zero[13] = b"0";
        zero.extend([b"--" as &[u8], b"sh"]);
        assert!(parse_pty(&os(&zero), false).is_err());

        // the client: exactly one of three options; which one a system takes is its OS layer's
        let client = |opts: &[&[u8]]| {
            let mut a = base();
            a.truncate(a.len() - 2); // without --client-req
            a.extend(opts.iter().copied());
            a.extend([b"--" as &[u8], b"sh"]);
            parse_pty(&os(&a), false).map(|p| p.client)
        };
        assert_eq!(client(&[b"--client-exe", b"/opt/Kea/kea-app"]), Ok(Client::Exe { path: "/opt/Kea/kea-app".into(), checked: true }));
        assert_eq!(client(&[b"--client-exe-unchecked", b"/x/kea-app"]), Ok(Client::Exe { path: "/x/kea-app".into(), checked: false }));
        assert!(client(&[]).unwrap_err().contains("is required"));
        assert!(client(&[b"--client-exe", b"/a", b"--client-req", b"r"]).unwrap_err().contains("only one of"));
        assert!(client(&[b"--client-exe", b""]).unwrap_err().contains("--client-exe is empty"));
        // the client's file is named by its absolute path: it is judged together with every folder above it
        assert!(client(&[b"--client-exe", b"kea-app"]).unwrap_err().contains("--client-exe must be an absolute path"));
        assert!(client(&[b"--client-exe-unchecked", b"./x/kea-app"]).unwrap_err().contains("--client-exe-unchecked must be an absolute path"));
        assert!(client(&[b"--client-req", b" "]).unwrap_err().contains("--client-req is empty"));
    }

    #[test]
    fn r_hld_4_socket_path_limit() {
        let limit = SOCKET_PATH_MAX_BYTES as usize;
        let at = format!("/tmp/{}", "s".repeat(limit - "/tmp/".len()));
        let over = format!("{at}x");
        let with_sock = |s: &str| {
            let mut a: Vec<OsString> = os(&base());
            a[9] = OsString::from(s);
            a.extend(os(&[b"--", b"sh"]));
            parse_pty(&a, false)
        };
        assert_eq!(with_sock(&at).unwrap().sock.as_os_str().len(), limit);
        assert!(with_sock(&over).unwrap_err().contains("socket path"));
    }
}
