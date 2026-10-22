//! The run-dir rule, implemented identically in TypeScript (core, ptyhost):
//! `<home>/run` when `<home>/run/` + a ptyId + `.sock` fits `SOCKET_PATH_MAX_BYTES`, otherwise
//! `<root>/<fnv1a64(home) as 16 hex digits>`, where the root is `$XDG_RUNTIME_DIR/kea` on Linux when the OS layer
//! names a runtime directory (`os::runtime_dir`) and a socket path under it fits, else `/tmp/kea-<uid>`.
//!
//! Also the directory and socket checks, shared by the holder (before it binds) and `hook` (before it
//! connects to `core.sock`): by `lstat`, never through a symlink, nothing another user owns or can open.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use crate::limits::{PTY_ID_LENGTH, SOCKET_PATH_MAX_BYTES};

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// `/tmp/kea-<uid>`, the shared fallback root of the run dir: checked like the socket's own directory.
pub const SHARED_RUN_ROOT_PREFIX: &str = "/tmp/kea-";

/// Does a socket fit under `dir`: `<dir>/` + a ptyId + `.sock` within `SOCKET_PATH_MAX_BYTES`?
fn fits(dir: &[u8]) -> bool {
    (dir.len() + 1 + PTY_ID_LENGTH as usize + ".sock".len()) as u64 <= SOCKET_PATH_MAX_BYTES
}

/// The run dir of `home`. `runtime` is the user's own runtime directory, checked by the OS layer (Linux's
/// `$XDG_RUNTIME_DIR`; none on macOS).
pub fn run_dir(home: &Path, uid: u32, runtime: Option<&Path>) -> PathBuf {
    let home_bytes = home.as_os_str().as_bytes();
    let preferred = home.join("run");
    if fits(preferred.as_os_str().as_bytes()) {
        return preferred;
    }
    let hash = format!("{:016x}", fnv1a64(home_bytes));
    match runtime.map(|r| r.join("kea").join(&hash)) {
        Some(d) if fits(d.as_os_str().as_bytes()) => d,
        _ => PathBuf::from(format!("{SHARED_RUN_ROOT_PREFIX}{uid}/{hash}")),
    }
}

/// Is `path` short enough for `sun_path` (without its NUL)?
pub fn socket_path_fits(path: &OsStr) -> bool {
    path.as_bytes().len() as u64 <= SOCKET_PATH_MAX_BYTES
}

/// The `<prefix><digits>` directory that `dir` is or lies in, if any (TypeScript: `/^\/tmp\/kea-\d+(?=\/|$)/`).
pub fn shared_root<'a>(dir: &'a Path, prefix: &str) -> Option<&'a Path> {
    let bytes = dir.as_os_str().as_bytes();
    let rest = bytes.strip_prefix(prefix.as_bytes())?;
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    (digits > 0 && rest.get(digits).is_none_or(|&b| b == b'/'))
        .then(|| Path::new(std::ffi::OsStr::from_bytes(&bytes[..prefix.len() + digits])))
}

/// By `lstat`, a real directory (not a symlink), owned by this user, closed to everyone else.
pub fn check_private_dir(d: &Path) -> Result<(), String> {
    let m = std::fs::symlink_metadata(d).map_err(|e| format!("socket directory {}: {e}", d.display()))?;
    let uid = unsafe { libc::getuid() };
    if m.file_type().is_symlink() || !m.is_dir() {
        Err(format!("socket directory {} is not a directory (a symlink or another file); refusing to use it", d.display()))
    } else if m.uid() != uid {
        Err(format!("socket directory {} is owned by uid {}, not {uid}; refusing to use it", d.display(), m.uid()))
    } else if m.mode() & 0o077 != 0 {
        Err(format!("socket directory {} is accessible to other users (mode {:o}); refusing to use it", d.display(), m.mode() & 0o777))
    } else {
        Ok(())
    }
}

/// An existing run directory, checked without creating anything: the directory itself and, when it lies
/// under the shared root (`prefix` is that root's prefix, [`SHARED_RUN_ROOT_PREFIX`] in production), that
/// root too, both with [`check_private_dir`].
pub fn check_run_dir(dir: &Path, prefix: &str) -> Result<(), String> {
    if let Some(r) = shared_root(dir, prefix).filter(|r| *r != dir) {
        check_private_dir(r)?;
    }
    check_private_dir(dir)
}

/// Checks a socket about to be connected to: by `lstat`, a socket (not a symlink or anything
/// else), owned by this user, with a single link — so neither a symlink nor a hard link planted under
/// that name can lead the connection to a socket that lives elsewhere (`hook`, whose `--home` an agent chooses).
pub fn check_own_socket(p: &Path) -> Result<(), String> {
    let m = std::fs::symlink_metadata(p).map_err(|e| format!("socket {}: {e}", p.display()))?;
    let uid = unsafe { libc::getuid() };
    if !m.file_type().is_socket() {
        Err(format!("{} is not a socket (a symlink or another file); refusing to connect", p.display()))
    } else if m.uid() != uid {
        Err(format!("socket {} is owned by uid {}, not {uid}; refusing to connect", p.display(), m.uid()))
    } else if m.nlink() != 1 {
        Err(format!("socket {} has {} links (a hard link to a socket elsewhere); refusing to connect", p.display(), m.nlink()))
    } else {
        Ok(())
    }
}
