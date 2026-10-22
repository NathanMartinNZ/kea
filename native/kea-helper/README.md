# native/kea-helper

Kea's small native helper (Rust, no async runtime). One binary, five subcommands:

| Subcommand | Lifetime | What |
|---|---|---|
| `pty` | One PTY, detached (survives Kea) | The **holder**: owns exactly one PTY, a ring file of its output, and one Kea client |
| `hook` | Milliseconds | Agent hook → projected envelope → `core.sock` (core answers it), else the session spool |
| `footprint <pid…>` | Milliseconds | Physical footprint per pid (macOS `ri_phys_footprint`; Linux `RssAnon + VmSwap`) |
| `ports <pid…>` | Milliseconds | Listening TCP sockets per pid (macOS libproc; Linux `/proc/<pid>/net/tcp{,6}`) |
| `ports --all` | Milliseconds | Linux: every TCP listener, this user's with their pid, others' as `-` (who holds a port) |
| `procs [--args] [<pid>…]` | Milliseconds | This user's processes, one line each: what Kea reads where it would otherwise run `ps` |

Internal: `pty-daemon` (what the `pty` launcher spawns; not for direct use) and `--version` (prints
`kea-helper <version>`). Anything else prints usage on stderr and exits 2.

Holders are deliberately simple: bytes in, bytes out, a ring file and signals. Anything clever lives in code that can
be restarted and updated, and the wire protocol is frozen once shipped. The helper knows nothing about any agent: no
agent flag, path or payload field name appears in this crate.

## Layout

- `src/main.rs` calls `lib.rs`'s `run`, which dispatches the subcommands.
- `args.rs` (the `pty` argv), `launch.rs` (the launcher), `holder.rs` and `holder/` (the loop; `flow` the flow-control
  and free-run state machine, `bufs` the fixed buffers, `child` openpty, fork and exec, `signals` the self-pipe,
  `state` the state json, `tree` the `TERMINATE` snapshots, `tests` the in-process holder tests).
- `proto.rs` (the wire protocol), `ring.rs` (the ring file), `admission.rs` (client admission).
- `os/`, the OS layer. `mod.rs` names its items. `macos.rs`: libproc, the `posix_spawn` detach, Security.framework
  admission, `__error`, `SO_NOSIGPIPE`, `sun_len`, `CLOCK_UPTIME_RAW`, `arc4random_buf`. `linux.rs`: `/proc` (process
  facts, the terminal's processes, footprint, ports, `procs`), pidfd signals, glibc's `posix_spawn`,
  `__errno_location`, `MSG_NOSIGNAL`, `CLOCK_MONOTONIC`, `getrandom`, `$XDG_RUNTIME_DIR`, the systemd user scope the
  launcher puts in front of the daemon and its session-mode fallback, admission by the client's executable, and the
  non-dumpable holder. `procfs.rs`: the `/proc` text parsers, pure and built on both systems, so their tests run on
  macOS against `fixtures/os/linux/`. `#[cfg(target_os)]` appears on the two system modules only, and `os::IS_LINUX`
  picks the per-system numbers of `limits.rs`.
- `rundir.rs`, `hook.rs` (with `hook/tests.rs`), `footprint.rs`, `ports.rs`, `procs.rs`, `sys.rs` (thin libc helpers).
- `limits.rs`, generated from `constants/limits.toml` by `pnpm codegen`.
- `golden_tests.rs` (the wire format against the shared golden file) and `test_alloc.rs` (the counting allocator the
  unit tests use to prove the loop allocates nothing).
- `tests/`: integration tests that drive the real binary. `tests/os/` is a test crate of its own for the Linux-only
  tests, so that system's code stays in an `os/` folder.

The byte layouts below are defined once in `src/proto.rs` and mirrored in `packages/protocol/src/holder.ts`; both test
against `fixtures/protocol/holder-golden.json`.

## `pty`: the holder

```
kea-helper pty --id <ptyId> --session <sessionId> --kind <agent|shell|server|script>
               --dir <stateDir> --sock <socketPath> --cwd <dir> --cols N --rows N
               (--client-req <requirement> | --client-exe <path> | --client-exe-unchecked <path>)
               [--ring-bytes N] [--kea-version V] [--no-detach]
               -- <file> <args…>
```

- **Validation** happens in the launcher, before anything is spawned; a failure prints `{"error":"…"}` and exits 1.
  - `--id` and `--session` match `[0-9A-Za-z_-]{1,64}`; `--kind` is one of the four; `--cols` and `--rows` are ≥ 1;
    `--ring-bytes` (default `RING_BYTES_DEFAULT`) is within `RING_BYTES_MIN..=RING_BYTES_MAX`; `--sock` is at most
    `SOCKET_PATH_MAX_BYTES` bytes; `--dir`, `--sock` and `--cwd` are non-empty.
  - Exactly one client option, non-empty, and the system's own: macOS `--client-req`; Linux `--client-exe`, which must
    name a regular file only root can change in folders only root can, or `--client-exe-unchecked`, any regular file.
    The other system's option is refused.
  - The requirement is compiled (`SecRequirementCreateWithString`) once by the daemon before it starts the child (in
    a forked checker, see Admission). One that does not compile is an `ERR`, so the launcher still prints
    `{"error":"…--client-req…"}` and exits 1.
  - Options come in any order before `--`, each at most once (a duplicate is an error, not "last wins"); unknown
    options are errors; `--` and a non-empty `<file>` are required. `--ready-fd N` is accepted only by `pty-daemon`.
  - A missing `--cwd` directory or an exec failure is not a launch error: the child reports it on the PTY and exits
    127.
- **Launcher (default).** The process ptyhost starts is a launcher. It creates a pipe and `posix_spawn`s itself as
  `kea-helper pty-daemon <same args> --ready-fd 3` with `POSIX_SPAWN_SETSID`, stdio on `/dev/null`, the pipe's write
  end on fd 3, every other fd closed (`POSIX_SPAWN_CLOEXEC_DEFAULT` on macOS), and on macOS responsibility disclaimed
  (`responsibility_spawnattrs_setdisclaim(attr, 1)`, resolved with `dlsym`; absent, it continues without). On Linux
  the launcher may put a systemd scope in front of the daemon (see Platform notes). The daemon writes
  `READY <daemonPid> <childPid>\n` (or `ERR <message>\n`) to fd 3 once the PTY child is running, the socket is
  listening and the state files exist. The launcher prints one JSON line to stdout, `{"pid":N,"childPid":N}` or
  `{"error":"…"}`, and exits 0 or 1. The daemon is reparented to launchd on macOS, and to init or a subreaper on Linux
  in session mode.
- **`--no-detach` (fallback).** No launcher and no daemonising: the process itself is the holder. It prints the same
  JSON line on stdout when ready (`pid` is its own pid) and treats EOF (or an error) on its stdin as "parent gone": it
  runs `TERMINATE{HOLDER_PARENT_GONE_GRACE_MS}`, and once the child has exited, the PTY is drained and the grace
  period is over (survivors `SIGKILL`ed), it unlinks the socket and exits 0 without lingering. Errors before ready
  print `{"error":"…"}` on stdout and exit 1.
- **Child.** `openpty` (one at a time in the process, and retried at once on macOS's leaked `EREDRIVEOPEN`, errno −6,
  up to `HOLDER_PTY_OPEN_ATTEMPTS` attempts); fork; in the child: `setsid`, `TIOCSCTTY`, the slave on 0/1/2, every
  other fd closed, signal dispositions and mask reset, window size set, `chdir(--cwd)`, `execvp(file, args)` with the
  helper's own environment (ptyhost sets it from the `SpawnSpec`). No shell.
  - A failing `openpty` or `fork` is a launch error that names the call before the system's words:
    `cannot start the child: openpty: Device not configured (os error 6)`. ptyhost reads a resource limit from the
    call and the errno together.
  - Everything the child needs (argv and env C strings, messages) is prepared before `fork`; after it, only
    async-signal-safe calls. A `chdir` failure writes `kea-helper: chdir <dir>: <strerror>`, an exec failure
    `kea-helper: exec <file>: <strerror>`, to the PTY, then `_exit(127)`.
  - The holder keeps its own slave fd open for the PTY's whole life, so the master never reads EIO while the child
    lives (background jobs that outlive the child keep their tty until the drain ends, see Exit).
- **State files**, mode 0600, in `--dir`:
  - `<ptyId>.json`, written atomically (`.<ptyId>.json.tmp` → fsync → rename) at spawn, at exit, and on refusals (the
    first refusal at once, later ones at most once per `HOLDER_REFUSAL_LOG_INTERVAL_MS`, coalesced). One line, keys in
    exactly this order:

    ```
    {"protocol":1,"keaVersion","helperVersion","ptyId","sessionId","kind","cwd","argv":[file,…args],"pid":<daemon>,
     "pidStartTime":<µs since epoch>,["pidStartTicks":<ticks>,]"childPid","createdAt":<ms>,"exited":bool,
     "exitCode":int|null,"exitSignal":int|null,"refusals":int,"socket":"<path>"[,"detach":"scope"|"session"|"none"]}
    ```

    `pidStartTime` comes from `proc_pidinfo(PROC_PIDTBSDINFO)` on macOS and from `btime` + `starttime` on Linux. The
    bracketed keys are Linux's: `pidStartTicks` is the raw `starttime` (clock ticks since boot), `detach` how the
    holder detached; macOS writes neither. `keaVersion` is `null` without `--kea-version`; `cwd`, `argv` and `socket`
    are converted lossily to UTF-8 (U+FFFD), while the bytes passed to `execvp` are exact. `exitCode` is set for a
    normal exit, `exitSignal` for a signal death (the other is `null`).
  - `<ptyId>.ring`: `mmap` `MAP_SHARED`, a header of `RING_HEADER_BYTES` then `capacity` data bytes. Header:
    `magic "KEAR"` · `version:u16 = 1` · `reserved:u16` · `capacity:u64` · `earliestSeq:u64` · `latestSeq:u64` ·
    zero padding. The byte with sequence number `s` lives at `RING_HEADER_BYTES + s % capacity`. `seq` is the
    cumulative count of PTY output bytes since spawn, and `earliestSeq = max(0, latestSeq − capacity)`. Data is
    written before the header's `latestSeq` and `earliestSeq` are updated, with a release fence between them. The file
    is created (truncated) with `O_NOFOLLOW` and survives the holder's exit, so ptyhost can still rebuild the
    terminal's last screen from it. PTY reads go straight into the mapping (at most `HOLDER_READ_BUFFER_BYTES` and
    never across the wrap), so there is no separate read buffer.
- **Socket.** `--sock` (ptyhost picks it by the run-dir rule below), mode 0600 in a 0700 directory.
  - `--dir` is created 0700 (recursively) if missing. The socket's directory is created 0700 (with missing parents)
    if missing and then checked with `lstat`, together with `/tmp/kea-<uid>` when the socket lies under it (an
    existing `/tmp/kea-<uid>` is checked before anything is created under it). Each must be a real directory (not a
    symlink), owned by the holder's uid, with no group or other permission bits; ptyhost's `ensurePrivateDir`
    (`packages/kit/src/privateDir.ts`) applies the same rule. Anything else fails the launch (`ERR`, so the launcher
    prints `{"error":"socket directory … refusing to use it"}`) before anything is created, is logged, and is never
    repaired.
  - A stale socket file is unlinked before `bind`; anything else at that path (a regular file, a directory) is a
    launch error, never deleted. The mode is set with `chmod` after `bind` (not `umask`, which is process-wide). At
    exit the socket is unlinked only if its device and inode are still the ones the holder bound.
  - Accepted connections are non-blocking and close-on-exec, never raise `SIGPIPE` (`SO_NOSIGPIPE` on macOS,
    `MSG_NOSIGNAL` on every send on Linux), and have `SO_SNDBUF`/`SO_RCVBUF` = `HOLDER_READ_BUFFER_BYTES`.
- **Logging.** Rare events (refusals, an unsafe socket directory, state-file write failures) go to syslog
  (`LOG_USER`, notice, prefixed `kea-helper:`) and stderr (`/dev/null` for a detached daemon). Nothing is logged per
  byte or per frame.

### Admission

On `accept` (one connection per loop turn): (1) the `getpeereid` uid must equal the holder's uid, checked at once (a
wrong uid never reaches Security); (2) the peer's code signature must satisfy `--client-req`:
`getsockopt(LOCAL_PEERTOKEN)` → audit token → `SecCodeCopyGuestWithAttributes(NULL, {kSecGuestAttributeAudit: token})`
→ `SecRequirementCreateWithString(--client-req)` → `SecCodeCheckValidity`, run by a forked check process (below).

**Linux.** (1) is `SO_PEERCRED`; (2) is `os::linux::check_identity`, run in the holder at accept with no child (about
0.6 ms measured):

- the peer's `/proc/<pid>/exe` is `--client-exe`'s file: its inode now, or the old inode shown `<path> (deleted)` after
  an upgrade, at any link count;
- with `--client-exe` (not `-unchecked`) that file is also root's alone, the peer's `cmdline` names a Node service
  utility process, its parent runs the same file, and every executable mapping of both is root's alone (a deleted or
  replaced one is judged by its folder) with no executable `memfd:`;
- the peer is held still by its `SO_PEERPIDFD` pidfd where the kernel has one, else by its start time read before and
  after.

The verdict is written to a fresh pipe at once (`N` is followed by the code of the check that failed,
`os::refusal_reason`), so the slots below only ever hold a decided check for a moment. Before it binds, the holder
makes itself non-dumpable and drops `INVOCATION_ID` (`os::harden_holder`).

**The check never blocks the loop.** The connection waits in one of `HOLDER_PENDING_CHECKS_MAX` slots (nothing is read
from it or written to it) while the holder keeps serving the attached client; the check's verdict pipe joins the
`poll` set, and the verdict admits or refuses the connection. A check with no verdict after
`HOLDER_PEER_CHECK_TIMEOUT_MS` is killed and its connection refused. With every slot taken, a new connection is refused
at once, without a check. So a flood of connections costs at most `HOLDER_PENDING_CHECKS_MAX` check processes and one
`accept` per loop turn, and never stalls the attached client's I/O.

- **Refused** (wrong uid, every slot taken, signature not satisfied, the check could not run or died without a
  verdict, the deadline): closed at once and counted (`refusals` in the json). It is logged at most once per
  `HOLDER_REFUSAL_LOG_INTERVAL_MS`; the next log line carries the count suppressed meanwhile and the latest reason. The
  attached client is never disturbed.
- **Left** (the peer went before its verdict: its end shows `POLLHUP`, seen without reading the connection, or its
  process is exiting or a zombie, from `LOCAL_PEERPID` + `PROC_PIDTBSDINFO`; checked at the verdict, and in `begin`
  when no check can start or every slot is taken): closed, not counted, and never admitted, so it does not replace the
  attached client. A SIGKILLed ptyhost fails its check a moment before macOS closes its sockets, and one that died
  before its check started has no audit token left.
- **Admitted**: the previous client (if any) is closed and replaced. Pending connections are decided in the order
  their verdicts arrive.
- **Check processes** are `SIGKILL`ed once decided (a verdict is final; a late check is cut off) and reaped without
  blocking when their `SIGCHLD` wakes the loop. A slot stays taken until its process is reaped, so at most
  `HOLDER_PENDING_CHECKS_MAX` exist at any time and none is left a zombie.

The check is behind a trait (`PeerCheck`) so unit tests stub it, answering at once or holding verdicts back.
Requirements used in practice: installed builds use ptyhost's own designated requirement,
`identifier "dev.kea.app.helper" and certificate leaf = H"<sha1>"` (never the leaf alone: this binary is signed with
the same leaf, as `dev.kea.helper`, and any agent can run it); dev builds the Electron Helper's designated requirement
(`cdhash H"…"` for npm's ad hoc signed Electron); tests the test runner's (`codesign -d -r- $(node)`).

**Where the Security calls run.** The binary links neither Security nor CoreFoundation. For each check the
(single-threaded) holder `fork`s. The child resets the holder's signal handlers and closes every descriptor except its
verdict pipe and stdio, so a refused, replaced or closed connection, or the PTY's hang-up, never waits for a check to
end. It then `dlopen`s the two frameworks, runs the calls above on the token the holder read, writes one verdict byte
(`Y` admit, `N` refuse, `E` and a message: could not check) and exits; EOF without a byte refuses. About 10 ms in
practice. The requirement is compiled the same way once at start, waiting for the answer before anything is served, so
a bad `--client-req` fails the spawn (`ERR`); a start-up compile that does not answer within the deadline does not
fail the spawn (every client check compiles it again and fails closed). Debug builds read
`KEA_HELPER_TEST_CHECK_DELAY_MS`: each client check waits that long before it starts, so tests can keep checks
pending; release builds ignore it.

Why a child: on macOS 27 one in-process check leaves ~1.4 MB of freed-but-dirty heap and framework data behind (the
default allocator does not give it back; `malloc_zone_pressure_relief` returns 0), so a holder grew from 2.1 MB to
3.5–4.4 MB after a few attaches, far over its footprint budget (`HOLDER_FOOTPRINT_MAX_BYTES`); with the check in a
child it stays at ~1.4 MB. Forking without `exec` is sound because the holder is single-threaded and has never
initialised CoreFoundation, libdispatch or XPC. `exec`ing the helper binary instead was rejected: a running holder
would then trust whatever file sits at its path later (an update, or a same-uid process replacing it).

### Wire protocol v1 (frozen once shipped)

Frame: `type:u8 | len:u32le | payload`. Little-endian fixed structs; variable parts `u16`-length-prefixed. A client
frame with `len` > `HOLDER_MAX_FRAME_BYTES` or a malformed payload closes that connection only.

| Dir | Type | Code | Payload |
|---|---|---|---|
| C→H | HELLO | `0x01` | `proto:u16` |
| C→H | ATTACH | `0x02` | `mode:u8` (0 from seq · 1 earliest · 2 latest), `seq:u64` |
| C→H | INPUT | `0x03` | bytes |
| C→H | RESIZE | `0x04` | `cols:u16, rows:u16, xpx:u16, ypx:u16` |
| C→H | ACK | `0x05` | `seq:u64` — the client has processed every byte below `seq` |
| C→H | SIGNAL | `0x06` | `signo:u8, target:u8` (0 child · 1 foreground group · 2 session) |
| C→H | TERMINATE | `0x07` | `graceMs:u32` |
| C→H | STAT | `0x08` | — |
| C→H | DETACH | `0x09` | — |
| C→H | RELEASE | `0x0A` | — |
| H→C | HELLO | `0x81` | `proto:u16, childPid:u32, cols:u16, rows:u16, earliestSeq:u64, latestSeq:u64, exited:u8, code:i32, signal:u8, ptyId:(u16 len + bytes)` |
| H→C | OUTPUT | `0x82` | `seq:u64` + bytes (seq of the first byte) |
| H→C | EXIT | `0x83` | `code:i32, signal:u8` (signal death: `code = -1`) |
| H→C | STAT | `0x84` | `childPid:u32, fgPid:u32, fgName:(u16+bytes), cwd:(u16+bytes), n:u16, n × pid:u32` |
| H→C | ERROR | `0x85` | `code:u16, message:(u16+bytes)` — codes: 1 unknown type · 2 bad length · 3 bad proto · 4 not hello · 5 internal · 6 child alive · 7 not attached |

Semantics:

- The first frame must be `HELLO`; any other frame (including `INPUT` or an unknown type) gets `ERROR{4}` and a close.
  An unsupported `proto` gets `ERROR{3}`; the connection stays open and the client may send another `HELLO`. The
  holder answers `HELLO` and sends no output until `ATTACH`. A repeated `HELLO` is answered again (fresh
  `earliestSeq`/`latestSeq`); it does not detach.
- **Errors that close** (the holder sends the `ERROR`, then closes that connection only): `len` >
  `HOLDER_MAX_FRAME_BYTES`, a fixed-size frame with the wrong `len`, an out-of-range `mode` or `target` get
  `ERROR{2}`; a first frame other than `HELLO` gets `ERROR{4}`. **Errors that keep the connection:** an unknown frame
  type after `HELLO` gets `ERROR{1}` (the payload is skipped, so new frame types can be added); `ERROR{3}`; `ACK`
  while not attached gets `ERROR{7}`; `RELEASE` while the child lives gets `ERROR{6}`. After closing, the holder is in
  the "no client" state (it keeps reading).
- `ATTACH` starts streaming at the chosen seq: mode 0 clamps `seq` into `[earliestSeq, latestSeq]` (below →
  `earliestSeq`, and the client sees the jump as a gap; above → `latestSeq`). `acked` starts at that seq. `ATTACH`
  while attached restarts streaming from the new seq (a new attachment: `EXIT` will be sent again). `DETACH` when not
  attached is a no-op.
- `OUTPUT` frames carry at most `HOLDER_READ_BUFFER_BYTES` and are contiguous: each frame's `seq` equals the previous
  frame's `seq + len` except after an `ATTACH` or a free-run (the only gaps).
- **Flow control.** While a client is attached and not in free-run, the holder stops reading the PTY when
  `latestSeq − acked > HOLDER_FLOW_HIGH_BYTES` and resumes below `HOLDER_FLOW_LOW_BYTES` (so unsent bytes are never
  overwritten). `ACK{seq}` is clamped to `[acked, next unsent seq]`: acks never move backwards and never past what was
  sent. With no client (or after `DETACH`) the holder keeps reading, overwriting the oldest bytes.
- **Free-run.** Attached, paused at the high watermark and no `ACK` for `HOLDER_STALE_CLIENT_MS` (measured from the
  later of the last `ACK` and the start of the pause): the holder reads the PTY again into the ring and stops sending.
  Any `ACK` ends free-run (and restarts the stale timer): sending resumes at the next unsent seq if it is still ≥
  `earliestSeq`, else at `earliestSeq`, with exactly one gap. Debug builds read `KEA_HELPER_TEST_STALE_MS`
  (milliseconds) to shorten this timeout for tests; release builds ignore it.
- **Input** is written to the PTY as soon as it is writable, with partial writes, never queued behind output. Pending
  input is a fixed `HOLDER_INPUT_CAP_BYTES` queue; `INPUT` payloads are streamed into it as they arrive (a frame
  larger than the free space is consumed piecewise), and when it is full the holder stops reading its socket until the
  child drains. `INPUT` after the PTY is closed is discarded.
- `RESIZE` → `TIOCSWINSZ`; the size is remembered and reported in later `HELLO`s.
- `SIGNAL`: target 0 → `kill(childPid)`, ignored once the child is reaped (its pid may be reused); 1 →
  `killpg(tcgetpgrp(master))`, ignored once the PTY is closed; 2 → `killpg` for every process group of the child's
  session.
- `TERMINATE{graceMs}` snapshots every process of the holder's uid that belongs to the terminal, each recorded with
  its start time: the child's descendants, members of the child's session, and processes whose controlling tty or fd
  0–2 is this PTY (which catches double-forked `setsid` daemons that were reparented). It sends `SIGTERM` then
  `SIGCONT` (so stopped jobs act on it) to each session group and every other member; after `graceMs`, `SIGKILL` to
  every snapshotted pid still alive with the same start time, plus a fresh snapshot (whatever appeared meanwhile).
  `graceMs = 0` kills immediately.
  - A second `TERMINATE` sends its own signals and merges its snapshot into the pending one (`tree::merge`: members
    that have exited are dropped and a process already listed, by pid and start time, is not added again, so the list
    never grows with the number of `TERMINATE`s); the earlier deadline wins.
  - After the child is reaped: no descendant walk, session matching only while no process holds the child's pid (a
    pid that is still a live session id is not reused), and tty matching stops once the holder has closed the PTY
    (tty devices are reused).
- `STAT`: `childPid`; `fgPid` = `tcgetpgrp(master)` (a process group id, which is the group leader's pid; 0 if none or
  once the PTY is closed); `fgName` and `cwd` are that process's name and working directory (each empty when unknown
  or not permitted); then the child's descendants, breadth-first, capped at `HOLDER_STAT_PIDS_MAX` (empty once the
  child exited). The reply buffers are allocated at start.
- **Exit.** On `SIGCHLD`: `waitpid`, record `{exitCode, exitSignal}` in the json at once, then keep reading the PTY
  until it is empty (first `EAGAIN`) or one ring capacity has been read since the exit (a background job that keeps
  writing cannot hold the PTY open forever), then close the PTY; processes still on the tty get `EIO`/`SIGHUP` from
  then on. Drain reads obey flow control.
  - `EXIT` is sent only to an attached client, once per attachment, after every byte up to `latestSeq` was sent and
    the PTY is closed, and never during free-run.
  - The holder lingers until `RELEASE` (or `HOLDER_LINGER_MS`), then unlinks the socket and exits; ring and json stay.
    Debug builds read `KEA_HELPER_TEST_LINGER_MS` to shorten the linger for tests; release builds ignore it.
    `RELEASE` while the child lives gets `ERROR{6}`.
  - On macOS a session leader's exit waits for its tty output to drain, so the holder keeps reading until the child
    is reaped.
- **Stability.** No panics on socket input (property-tested). `SIGTERM` and `SIGHUP` are ignored while the child
  lives; once it has exited they end the holder (unlink the socket, exit 0). `SIGPIPE` is ignored as well.
- **Fixed memory.** The ring mapping, the outgoing frame buffer (`2 × (13 + HOLDER_READ_BUFFER_BYTES)` plus room for
  one `STAT` reply), the socket read buffer (`HOLDER_READ_BUFFER_BYTES`), the input queue, the `STAT` pid buffers and
  the `HOLDER_PENDING_CHECKS_MAX` check slots are allocated once at start; the steady-state loop (PTY → ring → socket,
  socket → PTY, `ACK`, `STAT`) allocates nothing, and a unit test counts allocations to prove it. Allocation happens
  only on rare paths (accept and refusal logging, `TERMINATE` snapshots, json writes). The byte buffers are anonymous
  mappings rather than `calloc`ed heap, so only pages actually used count in the footprint.
- **Footprint.** An idle release holder is ≈ 1.4 MB `ri_phys_footprint` on macOS (debug ≈ 1.45 MB), unchanged by
  attaches, and uses 0 % CPU when idle (no timer is armed without a paused client, a pending check, a pending refusal
  json write, a `TERMINATE` grace or the post-exit linger). The budget is `HOLDER_FOOTPRINT_MAX_BYTES`. Launch
  (launcher → `READY`) ≈ 17 ms warm; connect → `HELLO` ≈ 9 ms (the forked code check).
- A single-threaded `poll(2)` loop (measured against `kqueue` on PTY masters: the same wake-up latency, and throughput
  far above what the renderer can draw) watches the wake pipe, the `--no-detach` parent, the listener, the PTY
  master, the client and the pending checks' verdict pipes. `SIGCHLD`, `SIGTERM` and `SIGHUP` arrive through a
  self-pipe. Each round writes pending input to the PTY before framing output, so output never starves input.

### Run-dir rule

`runDir(home)` is `<home>/run` when `<home>/run/` + 10 chars + `.sock` fits `SOCKET_PATH_MAX_BYTES`. Otherwise it is
`<runtime>/kea/<fnv1a64(home) as 16 hex digits>` when the OS layer gives the user's own runtime folder (Linux:
`$XDG_RUNTIME_DIR`, absolute, a real directory owned by the user, mode closed to others; macOS: none) and that fits,
else `/tmp/kea-<uid>/<fnv1a64(home)>`. It is implemented identically in Rust (`hook`) and TypeScript (core and
ptyhost: kit's `runDir` and `runtimeDir`), with golden cases in `fixtures/protocol/holder-golden.json`.

## `hook`

```
kea-helper hook <adapter> --session <keaSessionId> --home <KEA_HOME> --project '<projection JSON>'
```

Reads the agent's JSON payload on stdin, keeps only what the projection names, stamps it, and delivers it. Always
exits 0 and prints nothing, not even on a panic (a silent panic hook plus `catch_unwind`). Every field name arrives in
`--project`, so the helper itself knows no agent.

- **Projection** `{"keep":[path…],"count":[path…],"summarise":[path…],"critical":{"field":path,"values":[…]}}`.
  - Paths are dotted (`tool_input.command`); an empty path or empty segment makes the projection invalid, and the
    event is dropped. Absent lists are empty; `critical` may be absent or `null`; other keys are ignored. A path
    missing from the payload is skipped.
  - `keep`: strings (capped at `HOOK_SUMMARY_MAX_CHARS` characters), numbers, booleans and `null` are copied; objects
    and arrays are skipped. `count`: an array becomes its length, an object its key count, a number stays a number;
    anything else is skipped. `summarise`: a string is cut to `HOOK_SUMMARY_MAX_CHARS` characters on a char boundary;
    any other non-null value becomes its compact JSON text, cut the same way (serialisation stops early for huge
    values).
  - Output keeps the nesting (`{"tool_input":{"command":"…"}}`), in the order keeps, counts, summaries; if two paths
    collide (`a` and `a.b`), the first one written wins. Nothing not named survives. Whether an event is critical is
    decided on the raw payload (JSON equality with one of `values`), so the field need not be kept.
- **Envelope** (one line), in exactly this key order:
  `{"keaSessionId","adapter","id":<16 hex digits>,"mono":<ns>,"receivedAt":<unix ms>,"payload":{…}}`.
  - `id` is random per run (`arc4random_buf` on macOS, `getrandom` on Linux). `mono` is a clock that stops while the
    machine sleeps (`CLOCK_UPTIME_RAW` on macOS, `CLOCK_MONOTONIC` on Linux). `mono` and `receivedAt` are taken when
    the hook starts, before reading stdin.
  - At most `HOOK_ENVELOPE_MAX_BYTES` including the trailing newline. If larger, the summary length is halved
    repeatedly (down to 0), then items are dropped last-first (summaries, then keeps other than `critical.field`, then
    counts), and finally everything: an envelope with `payload:{}` always fits, since ids are ≤ 64 characters.
- **Bad stdin.** Not JSON (or not UTF-8) gives `payload:{}` plus a top-level `"malformed":true`. More than
  `HOOK_STDIN_MAX_BYTES` is still drained to EOF (the agent never sees a broken pipe) and dropped: `payload:{}` plus
  `"oversize":true`. stdin is always read to EOF, even when the arguments are invalid.
- **Delivery.**
  - First the run-dir checks, by `lstat` (`rundir::check_run_dir`, `check_own_socket`): the run dir (and
    `/tmp/kea-<uid>` above a fallback one) must be a real directory of this user's, mode `0700`, and `core.sock` a
    real socket of this user's with a single link. An agent chooses `--home`, so without them a symlink or hard link
    named `core.sock` could make this signed binary a client of a holder's socket. The checks and the `connect` are
    not atomic, so a socket swapped in between them gets through; they narrow that path and are not what closes it.
    Holders refusing `kea-helper` (see Admission) is what closes it.
  - Then a non-blocking connect to `runDir(--home)/core.sock`, write the line and read core's answer, one `ACK` byte
    (`0x06`, `hook::ACK`; `HOOK_ACK_BYTE` in `@kea/protocol`), all within `HOOK_BOUND_MS` in total, with `SIGPIPE`
    suppressed. Only the answer counts as delivered: a hung core's listening socket still completes the connection
    and takes the line into its backlog, and a line in a dead core's backlog is lost.
  - Any failure (a check, `ENOENT`, `ECONNREFUSED`, timeout, a short write, no answer, end of stream or another byte)
    appends the line to `<home>/sessions/<id>/spool.ndjson` with one `write` on an `O_APPEND | O_NOFOLLOW` fd, mode
    0600.
  - After a short write the core may hold a partial line from that connection: **the core must discard an
    unterminated line when a hook connection closes** (the spooled copy is the one that counts). A core that was only
    slow reads the line later anyway, after it was spooled: **the core applies each envelope `id` once**, whichever
    copy, socket or spool, comes first.
  - Spool caps: at `SPOOL_SOFT_BYTES` or more only critical events are appended; at `SPOOL_HARD_BYTES` nothing.
- **Validation.** `<adapter>` and `--session` must match `[0-9A-Za-z_-]{1,64}`; `--home` must be absolute;
  `--session`, `--home` and `--project` each exactly once, no other options; `runDir(--home)` must exist as a
  directory (`<home>/run`, or the `/tmp/kea-<uid>/…` fallback); the session directory `<home>/sessions/<id>` must
  already exist for spooling (the hook never creates directories). Anything else is dropped silently. Environment
  variables are never read for identification.

## `footprint <pid…>`

One line per argument, in order: `<pid> <bytes>` or `<pid> error <reason>` (`no such process`, `permission denied`,
another OS error text, or `<arg> error invalid pid` for a non-numeric argument). The bytes are
`proc_pid_rusage(RUSAGE_INFO_V0)`'s `ri_phys_footprint` on macOS and `RssAnon + VmSwap` on Linux. Exit 0 (also with
no arguments).

## `ports <pid…>`

For each pid, every TCP socket in `LISTEN`: `<pid> tcp4|tcp6 <local address> <port>`, from
`proc_pidinfo(PROC_PIDLISTFDS)` + `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)` on macOS. Connected, accepted and closed
sockets are not listed; duplicates (the same socket on several fds) are listed once. The family is the socket's: a
dual-stack `AF_INET6` listener on `::` is `tcp6 ::`. Addresses use Rust's standard text form (`127.0.0.1`, `::1`). A
pid with no listeners prints nothing. An unknown pid prints `<pid> error <reason>` (the same reasons as `footprint`).
Exit 0.

## `ports --all`

Linux only: every TCP socket in `LISTEN`, one line each in `ports`' form. First `<pid> tcp4|tcp6 <address> <port>`
for each process of this user (effective uid), its sockets from `/proc/<pid>/fd` against its network namespace's
tables, as `ports` does; then `- tcp4|tcp6 <address> <port>` for each `LISTEN` row of `/proc/self/net/tcp{,6}` whose
socket no process of this user holds (another user's: it cannot be named). Exit 0; 1 with `kea-helper ports: <reason>`
on stderr when it cannot scan, and always on macOS, where core names a port's holder with `lsof`. Reader: core's
`portOwner` (`app/core/src/os/linux.ts`).

## `procs [--args] [<pid>…]`

This user's processes (effective uid) but its own, or only the named pids among them, one tab-separated line each:
`<pid>`, `<ppid>`, start time in µs since the epoch, the executable file (`-` when it cannot be read), `argv[0]` (what
`ps -o comm` printed: the path the process was started by), and with `--args` every further argument. `\\`, `\t`,
`\n` and `\xHH` (any other control byte, any byte that is not UTF-8) are escapes. Exit 0; 1 when the processes cannot
be read (`kea-helper procs: <reason>` on stderr); 2 for an argument that is neither `--args` nor a pid. macOS reads
`proc_listallpids`, `PROC_PIDTBSDINFO`, `proc_pidpath` and `KERN_PROCARGS2`; Linux reads
`/proc/<pid>/{stat,status,exe,cmdline}` with `btime` and `CLK_TCK`. Readers: core's holder liveness check and helper-copy pruning, and the install tool
(`@kea/protocol`'s `parseProcs`).

## Platform notes (macOS)

- A session leader's exit blocks in the kernel until its tty output drains, so the holder must keep reading (and
  closes the PTY before any blocking `waitpid` in its own teardown).
- macOS reuses `/dev/ttysNNN` devices, which is why tty matching in `TERMINATE` stops once the PTY is closed.
- Under a heavy flood the tty's `ONLCR` output processing occasionally emits `\r\r\n` for one `\n` (a kernel quirk,
  reproducible with Python's `pty` too). Byte-exact tests switch it off with `stty -opost`.
- `posix_spawn` with `POSIX_SPAWN_SETSID` (0x0400) makes the daemon a session leader with no controlling tty;
  responsibility is disclaimed so TCC attributes the child to itself, not to Kea.

## Platform notes (Linux)

- Process facts come from `/proc`. A process is identified by its raw `starttime` (clock ticks after boot); the state
  json's `pidStartTime` is derived with `btime`, as `procs` derives its start, and both also carry the raw ticks
  (`pidStartTicks`; `procs` prints `<µs>/<ticks>`), which core compares, so a wall-clock step does not matter.
- `STAT`'s descendants are the members of the holder's own scope when `/proc/self/cgroup` names
  `kea-<8 hex>-<ptyId>.scope` (double forks included), otherwise one pass over `/proc/*/stat` into a ppid map of
  `HOLDER_PROC_MAP_MAX` pairs reserved at start. A signal reaches a member through a pidfd opened while its start time
  matched.
- The footprint is `RssAnon + VmSwap`. Ports come from socket inodes against each network namespace's
  `net/tcp{,6}`, read once per run; `ports --all` adds the listeners no process of this user holds, from the helper's
  own namespace's tables.
- The launcher puts `systemd-run --user --scope --collect --quiet --unit=kea-<8 hex>-<ptyId> --` in front of the
  daemon when a user manager answers (`os::scope_command`). When `systemd-run` ends without the daemon's `READY`, or
  has written none within `SCOPE_START_TIMEOUT_MS` (it is then killed and reaped), the launcher spawns the daemon
  directly (session mode), as it does without a user manager. A scope whose `cgroup.procs` cannot be opened at the
  holder's start still records `detach: "scope"` and is scanned as in session mode.
- A holder is non-dumpable: its own user cannot read its `maps`, `fd/`, `environ` or `exe`, only `stat`, `status` and
  `cmdline` (so the test that counts a daemon's descriptors does so on macOS only).

## Tests

`cargo test` (or `pnpm test:rust`) runs the unit tests in `src/`, including property tests of the socket input, the
`/proc` parsers against `fixtures/os/linux/` and the golden test against `fixtures/protocol/holder-golden.json`, and
the integration tests in `tests/`, which drive the real binary. The Linux-only tests (`tests/os/` and those in
`src/os/linux.rs`) are built only on Linux; the admission test that needs Kea's own root-owned Electron
(`tools/process-zoo/src/admission-app`) skips when it is not installed, and the cases that need a second uid run only
when the test binary runs as root.

- Integration tests use private (0700) `/tmp/khT<random>` directories, short enough for socket paths. They admit the
  test binary as the client: on macOS by its designated requirement (`--client-req`), on Linux with
  `--client-exe-unchecked` (`common::test_client`).
- They never sleep to synchronise: they wait on conditions with a deadline (the idle-holder test's 10 s window is a
  measurement). Every bound comes from a generated limit or a named constant, and every holder a test starts is
  cleaned up (`TERMINATE`, `RELEASE`, then `SIGKILL` as a last resort).
- Two C programs are built with `/usr/bin/cc` into a test's temp dir: `tests/common/intruder.c`, a same-user client
  that is not Kea (on macOS not Apple-signed, and the arm64 linker's ad hoc signature has its own cdhash, which does
  not satisfy the test requirement; on Linux an executable other than the test binary), and the process zoo's
  `tools/process-zoo/src/forker.c`, used as is (the `setsid` and double-fork trees).
- Debug-only knobs, read only by debug builds: `KEA_HELPER_TEST_STALE_MS` shortens `HOLDER_STALE_CLIENT_MS`,
  `KEA_HELPER_TEST_LINGER_MS` shortens `HOLDER_LINGER_MS`, and `KEA_HELPER_TEST_CHECK_DELAY_MS` delays every client
  check.
- The refusal of a connection from another uid runs in-process (`src/holder/tests.rs`): a real socket with the peer
  uid stubbed, since a second uid needs root. A second Kea launch on the same `KEA_HOME` is an app-level test
  (`tests/chaos/`), not this crate's.

Notes:

- The responsibility-disclaim test uses the private `responsibility_get_pid_responsible_for_pid`; if a macOS drops
  that symbol the test fails, saying so, rather than passing unchecked (it is present on macOS 27).
- The hook's delivery timeout test drives the delivery step with a line larger than a unix socket's send buffer: a
  real envelope (at most `HOOK_ENVELOPE_MAX_BYTES`) always fits that buffer, so a core that accepts and never reads
  cannot make `run` time out.
- The idle-holder test fills each holder's ring (the default size, twice `HOLDER_FOOTPRINT_MAX_BYTES`) twice over
  before measuring, so the mapped ring's exclusion from the footprint is exercised. It fills from `/dev/zero`, because
  a tty hands an eager reader only a few bytes per read of `yes | head` (≈ 2 MB/s).
- The suite takes about 13 s, most of it the idle-holder test's window.
