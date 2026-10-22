//! kea-helper: the PTY holder, the agent hook relay, and the footprint, port and process probes.
//! The contract is `README.md` next to this crate. The helper knows nothing about any agent.

use std::ffi::OsString;

pub mod admission;
pub mod args;
pub mod footprint;
pub mod holder;
pub mod hook;
pub mod launch;
pub mod limits;
pub mod os;
pub mod ports;
pub mod procs;
pub mod proto;
pub mod ring;
pub mod rundir;
pub mod sys;

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod test_alloc;

pub const USAGE: &str = "usage: kea-helper pty --id <ptyId> --session <sessionId> --kind <agent|shell|server|script> \
--dir <stateDir> --sock <socketPath> --cwd <dir> --cols N --rows N \
(--client-req <requirement> | --client-exe <path> | --client-exe-unchecked <path>) \
[--ring-bytes N] [--kea-version V] [--no-detach] -- <file> <args…>
       kea-helper hook <adapter> --session <keaSessionId> --home <KEA_HOME> --project <projection JSON>
       kea-helper footprint <pid…>
       kea-helper ports <pid…>
       kea-helper procs [--args] [<pid>…]";

/// Subcommand dispatch; returns the process exit code.
pub fn run(args: &[OsString]) -> i32 {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().and_then(|a| a.to_str()) {
        Some("pty") => launch::pty_main(rest),
        Some(launch::DAEMON_SUBCOMMAND) => holder::daemon_main(rest),
        Some("hook") => hook::main(rest),
        Some("footprint") => footprint::main(rest),
        Some("ports") => ports::main(rest),
        Some("procs") => procs::main(rest),
        Some("--version") => {
            println!("kea-helper {}", env!("CARGO_PKG_VERSION"));
            0
        }
        _ => {
            eprintln!("{USAGE}");
            2
        }
    }
}
