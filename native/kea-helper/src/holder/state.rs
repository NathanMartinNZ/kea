//! `<ptyId>.json`: enough to rebuild Kea's records without its database. Written atomically
//! (temp → fsync → rename), mode 0600, at spawn, at exit, and when the refusal count changes.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use crate::args::PtyArgs;
use crate::limits::HOLDER_PROTOCOL_VERSION;

/// How the child ended: `code` for a normal exit, `signal` for a signal death (README: `code = -1`
/// on the wire, `exitCode: null` in the json).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitInfo {
    Code(i32),
    Signal(i32),
}

impl ExitInfo {
    pub fn from_wait_status(status: libc::c_int) -> Self {
        if libc::WIFSIGNALED(status) { ExitInfo::Signal(libc::WTERMSIG(status)) } else { ExitInfo::Code(libc::WEXITSTATUS(status)) }
    }
    /// `(code, signal)` as the wire carries them.
    pub fn wire(self) -> (i32, u8) {
        match self {
            ExitInfo::Code(c) => (c, 0),
            ExitInfo::Signal(s) => (-1, s as u8),
        }
    }
}

pub struct StateFile {
    path: PathBuf,
    tmp: PathBuf,
    /// Every field that never changes, already serialised, ending with a comma.
    head: String,
    /// The fields after `exitCode`'s group that never change: `socket`, and `detach` where the OS records it.
    tail: String,
}

/// The holder's own process, as its state file records it.
#[derive(Clone, Copy, Debug)]
pub struct Started {
    pub pid: i32,
    /// µs since the epoch (`pidStartTime`).
    pub start_us: u64,
    /// The raw start time where the OS has one that a wall-clock step cannot move (`pidStartTicks`: Linux's clock
    /// ticks after boot); `None` writes no field (macOS).
    pub start_ticks: Option<u64>,
    /// How the holder left Kea (`detach`: "scope" or "session"; "none" for `--no-detach`); `None` writes
    /// no field (macOS).
    pub detach: Option<&'static str>,
}

pub fn json_str(out: &mut String, bytes: &[u8]) {
    out.push('"');
    for c in String::from_utf8_lossy(bytes).chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

impl StateFile {
    pub fn new(a: &PtyArgs, me: Started, child_pid: i32, created_at_ms: u64) -> Self {
        let mut h = String::new();
        h.push_str(&format!("{{\"protocol\":{HOLDER_PROTOCOL_VERSION},\"keaVersion\":"));
        match &a.kea_version {
            Some(v) => json_str(&mut h, v.as_bytes()),
            None => h.push_str("null"),
        }
        h.push_str(",\"helperVersion\":");
        json_str(&mut h, env!("CARGO_PKG_VERSION").as_bytes());
        for (k, v) in [("ptyId", &a.id), ("sessionId", &a.session), ("kind", &a.kind)] {
            h.push_str(&format!(",\"{k}\":"));
            json_str(&mut h, v.as_bytes());
        }
        h.push_str(",\"cwd\":");
        json_str(&mut h, a.cwd.as_os_str().as_bytes());
        h.push_str(",\"argv\":[");
        for (i, arg) in a.argv().enumerate() {
            if i > 0 {
                h.push(',');
            }
            json_str(&mut h, arg.as_bytes());
        }
        h.push_str(&format!("],\"pid\":{},\"pidStartTime\":{},", me.pid, me.start_us));
        if let Some(t) = me.start_ticks {
            h.push_str(&format!("\"pidStartTicks\":{t},"));
        }
        h.push_str(&format!("\"childPid\":{child_pid},\"createdAt\":{created_at_ms},"));
        let mut tail = String::from("\"socket\":");
        json_str(&mut tail, a.sock.as_os_str().as_bytes());
        if let Some(d) = me.detach {
            tail.push_str(",\"detach\":");
            json_str(&mut tail, d.as_bytes());
        }
        StateFile {
            path: a.dir.join(format!("{}.json", a.id)),
            tmp: a.dir.join(format!(".{}.json.tmp", a.id)),
            head: h,
            tail,
        }
    }

    pub fn render(&self, exit: Option<ExitInfo>, refusals: u64) -> String {
        let (code, signal) = match exit {
            None => ("null".to_string(), "null".to_string()),
            Some(ExitInfo::Code(c)) => (c.to_string(), "null".to_string()),
            Some(ExitInfo::Signal(s)) => ("null".to_string(), s.to_string()),
        };
        format!(
            "{}\"exited\":{},\"exitCode\":{code},\"exitSignal\":{signal},\"refusals\":{refusals},{}}}\n",
            self.head,
            exit.is_some(),
            self.tail
        )
    }

    pub fn write(&self, exit: Option<ExitInfo>, refusals: u64) -> io::Result<()> {
        let text = self.render(exit, refusals);
        let mut f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&self.tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&self.tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r_hld_7_state_json_is_valid_and_escaped() {
        let raw: Vec<std::ffi::OsString> = [
            "--id", "abcdefghij", "--session", "s1", "--kind", "shell", "--dir", "/tmp/d", "--sock", "/tmp/r/x.sock", "--cwd",
            "/tmp/w \"q\"", "--cols", "80", "--rows", "24", "--client-req", "anchor apple", "--kea-version", "1.2.3", "--", "sh",
            "-c", "echo \"hi\"\n\u{1}",
        ]
        .iter()
        .map(Into::into)
        .collect();
        let a = crate::args::parse_pty(&raw, false).unwrap();
        let s = StateFile::new(&a, Started { pid: 10, start_us: 20, start_ticks: None, detach: None }, 30, 40);
        let v: serde_json::Value = serde_json::from_str(&s.render(None, 0)).unwrap();
        assert_eq!(v["argv"], serde_json::json!(["sh", "-c", "echo \"hi\"\n\u{1}"]));
        assert_eq!(v["cwd"], "/tmp/w \"q\"");
        assert_eq!((v["exited"].as_bool(), v["exitCode"].is_null(), v["keaVersion"].as_str()), (Some(false), true, Some("1.2.3")));
        let v: serde_json::Value = serde_json::from_str(&s.render(Some(ExitInfo::Signal(9)), 4)).unwrap();
        assert_eq!((v["exitCode"].is_null(), v["exitSignal"].as_i64(), v["refusals"].as_i64()), (true, Some(9), Some(4)));
        let v: serde_json::Value = serde_json::from_str(&s.render(Some(ExitInfo::Code(3)), 0)).unwrap();
        assert_eq!((v["exitCode"].as_i64(), v["exitSignal"].is_null()), (Some(3), true));
        // macOS's keys, in their order: nothing added where the OS gives no raw start and no detach mode
        let mac = "protocol keaVersion helperVersion ptyId sessionId kind cwd argv pid pidStartTime childPid createdAt exited exitCode exitSignal refusals socket";
        assert_keys(&s.render(None, 0), mac);
        assert!(s.render(None, 0).ends_with("\"socket\":\"/tmp/r/x.sock\"}\n"));
    }

    /// The object's keys are exactly `keys` (space-separated), in that order in the text.
    fn assert_keys(text: &str, keys: &str) {
        let v: serde_json::Map<String, serde_json::Value> = serde_json::from_str(text).unwrap();
        let want: Vec<&str> = keys.split(' ').collect();
        assert_eq!(v.len(), want.len(), "{text}");
        let at: Vec<usize> = want.iter().map(|k| text.find(&format!("\"{k}\":")).unwrap_or_else(|| panic!("no {k}: {text}"))).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "keys out of order: {text}");
    }

    // Linux records the holder's raw start (clock ticks after boot) beside `pidStartTime`, and how it
    // detached: two keys added where they belong, every other key as on macOS.
    #[test]
    fn r_hld_7_the_raw_start_ticks_and_the_detach_mode_where_the_os_records_them() {
        let raw: Vec<std::ffi::OsString> =
            ["--id", "abcdefghij", "--session", "s1", "--kind", "agent", "--dir", "/tmp/d", "--sock", "/tmp/r/x.sock", "--cwd", "/tmp", "--cols", "80", "--rows", "24", "--client-exe-unchecked", "/x/kea-app", "--", "sh"]
                .iter()
                .map(Into::into)
                .collect();
        let a = crate::args::parse_pty(&raw, false).unwrap();
        let s = StateFile::new(&a, Started { pid: 10, start_us: 1_792_438_474_355_430, start_ticks: Some(123_456), detach: Some("scope") }, 30, 40);
        let text = s.render(Some(ExitInfo::Code(0)), 2);
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let linux = "protocol keaVersion helperVersion ptyId sessionId kind cwd argv pid pidStartTime pidStartTicks childPid createdAt exited exitCode exitSignal refusals socket detach";
        assert_keys(&text, linux);
        assert_eq!((v["pidStartTime"].as_u64(), v["pidStartTicks"].as_u64(), v["detach"].as_str()), (Some(1_792_438_474_355_430), Some(123_456), Some("scope")));
        assert_eq!((v["exited"].as_bool(), v["exitCode"].as_i64(), v["refusals"].as_u64()), (Some(true), Some(0), Some(2)));
        assert!(text.ends_with("\"socket\":\"/tmp/r/x.sock\",\"detach\":\"scope\"}\n"), "{text}");
    }
}
