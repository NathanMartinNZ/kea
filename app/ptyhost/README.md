# app/ptyhost

Kea's terminal process, an Electron utility process that main starts and restarts. It is the only process that
talks to the terminal holders (`native/kea-helper`, one detached process per terminal): it launches and adopts them,
keeps a headless mirror of each awake terminal, streams output to the window, and writes the checkpoints a terminal is
rebuilt from. It runs no database, git or file-watching work, so nothing outside the terminals can delay keystroke
echo. Core drives it over a control port (`ptyhostApi` in `packages/protocol/src/terminal.ts`); each terminal the
window shows gets a stream port of its own, brokered by main.

## How output flows

A holder's output arrives as numbered bytes. The coalescer batches it (the first chunk after a quiet spell goes at
once, so keystroke echo is never delayed) and hands each batch to every attached renderer stream first, then to the
mirror. The mirror acknowledges the bytes to the holder only once it has parsed them, so a program flooding its
terminal runs at the mirror's parse speed. Each renderer stream gets a snapshot first, then live batches under a
credit window: a stream out of credit is not buffered for, and when credit returns it catches up from the holder's
ring file, or gets a fresh snapshot when it has fallen too far behind.

Checkpoints (`<ptyId>.ckpt`: the serialized screen plus `packages/terminal`'s mode trailer) are cut only at a
ground-state seq, where no escape sequence is in progress and no synchronized-output block is open. They are rare by
design, because the ring holds everything after the last one: they are written once enough output has accumulated or
enough time has passed, and when a mirror is parked, its program exits or ptyhost shuts down. A mirror with no window
attached and no recent output is parked: checkpointed and freed, then rebuilt from checkpoint and ring when it is
needed again. After a restart, ptyhost adopts every holder it finds and rebuilds the visible terminals first, the rest
in idle time.

## Files

| Path | What |
|---|---|
| `main.ts` | The entry point: takes `<KEA_HOME>/run/ptyhost.lock` (one ptyhost per home), answers main's heartbeat and resource-report requests, serves `ptyhostApi` to core and hands stream ports to the manager |
| `manager.ts` | `PtyManager`: every PTY, launching and the startup adoption, the control API, each window's stream ports (closed together when the window goes), the idle-time rebuild queue |
| `pty.ts` | `Pty`: one terminal's holder connection, mirror, coalescer and renderer streams in one scope; parking, rebuilds, re-adoption after a dropped connection, resize debounce, the stall watch |
| `holder/` | `connection.ts`, the client side of the holder wire protocol (`packages/protocol/src/holder.ts`), with gap detection and an input cap; `launch.ts`, which runs `kea-helper pty`, installs the helper copy holders start from (`<KEA_HOME>/bin/current/kea-helper`) and classifies launch failures |
| `backend/` | How holders start: detached, or as ptyhost's own children when the system will not let them detach (`held.ts`); the banners for a helper that cannot run and for a Linux holder without a systemd scope |
| `mirror/` | `Mirror`: `@xterm/headless` with `packages/terminal`'s `MirrorKit`, tracking how far it has parsed and whether a snapshot may be cut there |
| `checkpoint/` | `scheduler.ts` (when to checkpoint), `store.ts` (on disk, or in memory when "Keep scrollback on disk" is off), `cold.ts` (an ended or parked terminal's last screen from checkpoint and ring), `diskFull.ts` (the disk-full banner) |
| `stream/` | `coalescer.ts` (output batching), `flow.ts` (the credit window, catch-up and skip-ahead, as a pure policy), `ring.ts` (reads from a holder's ring file), `attachment.ts` (one renderer stream) |
| `activity.ts` | Per-terminal output and keystroke notes, from which core estimates an agent's status when the agent reports nothing itself |
| `guard.ts` | The `uncaughtException` handler: rebuild the mirrors an exception came from, otherwise exit so that main restarts ptyhost |
| `os/` | The OS layer: how holders recognise ptyhost as their only client (macOS: a code requirement read with `codesign`; Linux: ptyhost's executable) |
| `test-support.ts` | `FakeHolder`, a holder written in TypeScript that speaks the wire protocol and keeps a real ring file, and `ManualClock`, for the unit tests |

Main starts ptyhost with V8 flags inside `--js-flags` (the one form a utility process honours): a small young
generation (`L.ptyhostSemiSpaceMb`), which limits how far its footprint grows under a sustained flood, and an
old-space limit at the memory watchdog's hard limit. `tools/build.ts` bundles it as `ptyhost.cjs`.

## Tests

Unit tests sit beside the modules (`*.test.ts`) and use `FakeHolder` where they need a holder:

```sh
pnpm exec vitest run --project unit app/ptyhost
```

`tests/integration/ptyhost-*` runs ptyhost against the real debug `kea-helper` (`tests/support/holders.ts`); the
chaos, memory and perf suites of the same names cover crashes, leaks and budgets.
