//! The helper's integration tests that one system alone has (such code lives only in `os/` folders), through
//! the real binary as `tests/holder.rs` drives it. Linux: the holder's own scope and the session fallback (I-PLT-1),
//! the non-dumpable holder (I-PLT-2). macOS has none: its holders are `tests/holder.rs`'s.

#[path = "../common/mod.rs"]
mod common;

#[cfg(target_os = "linux")]
mod linux;
