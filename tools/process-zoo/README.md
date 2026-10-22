# tools/process-zoo

Small programs for PTY tests: they let the holder, ptyhost and terminal suites check loss, back-pressure,
process-tree termination, terminal queries and socket admission against something exact. Every program has `--help`,
prints machine-readable output, and exits 2 on a usage error.

| Program | Is | Run |
|---|---|---|
| `counter` | Node | `node tools/process-zoo/src/counter.ts [--count N \| --forever] [--start S] [--rate R] [--format F] [--width W]` |
| `flood` | Node | `node tools/process-zoo/src/flood.ts --bytes N [--line-length L] [--eol lf\|crlf\|none] [--chunk C] [--report]` |
| `forker` | C | `$(node tools/process-zoo/src/forker.ts) [--fork \| --double-fork] [--children N] [--setsid \| --setpgid] [--stubborn] [--listen PORT] [--sleep SEC] [--log FILE]` |
| `stubborn` | Node | `node tools/process-zoo/src/stubborn.ts [--ignore INT,TERM,HUP] [--log FILE] [--lifetime SEC]` |
| `prober` | Node | `node tools/process-zoo/src/prober.ts [--query ID]… [--send SEQ]… [--timeout-ms N] [--settle-ms N] [--no-sentinel] [--out FILE]` |
| `intruder` | Node | `node tools/process-zoo/src/intruder.ts --socket PATH [--data TEXT \| --hex HEX] [--holder] [--wait-ms N]` |
| `server` | Node | `node tools/process-zoo/src/server.ts [--port N] [--announce url\|listening\|none] [--print-host H] [--color] [--delay MS] [--exit CODE] [--exit-after MS] [--exit-code CODE] [--log FILE] [--lifetime SEC]` |
| `admission-app` | Electron app | installed root-owned at `/opt/kea-test` (`src/admission-app/README.md`); started by the tests as `/opt/kea-test/kea-app --no-sandbox --ozone-platform=headless --disable-gpu` |

The dev-server suites (`tests/integration/core-server.test.ts` and the app-level ones) run `server`, `stubborn` and
`forker` as a session's `start.sh`. The holder's Rust integration tests (`native/kea-helper/tests/holder.rs`) need no
Node: they use system tools (`awk` as the counter, `perl` for stubborn and forking children) and compile two C programs
with `cc` (`native/kea-helper/tests/common/mod.rs`): their own `tests/common/intruder.c` and this folder's `forker.c`,
used as is.

From a test (the package has no `exports` field, so import the file):

```ts
import { zooCommand, verifyCounter } from '@kea-tools/process-zoo/src/index.ts'
const { file, args } = zooCommand('flood', ['--bytes', '100M']) // spawn `file` with `args` (argv array, no shell)
```

`zooCommand(name, args, { node })` returns `{ file: node (default process.execPath), args: [script, …args] }` for the
Node programs (under Electron pass a real `node`), and `{ file: <compiled forker>, args }` for forker, building it on
first use.

## The programs

**counter** prints `--count` numbers (default 1000) from `--start` (default 1), one line each through a `--format`
template (`{n}`, default `"{n}\n"`, with `\n \r \t \e` escapes), zero-padded to `--width`; `--rate` lines per second
(default 0: as fast as stdout takes them, in 64 KiB writes with back-pressure); `--forever` counts until killed. Exits 0
after the last line. Checking it: `counterText(opts, crlf)` is the exact expected output (`crlf` for bytes read from a
PTY master, where ONLCR turns `\n` into `\r\n`); `verifyCounter(text, { start, count, format, width, final })` reports
`missing`, `duplicates`, `outOfOrder` and `badLines` and accepts `\r\n` (a trailing partial line is ignored unless
`final`).

**flood** writes exactly `--bytes` bytes (suffixes `K`/`M`/`G` are 1024-based, `KB`/`MB`/`GB` 1000-based: `100M` =
104 857 600) of printable ASCII as fast as stdout takes them, then exits 0. The stream is periodic: line k of a 94-line
period holds `--line-length` − 1 characters of `!`…`~` starting k characters in, then the line ending (`--eol`), so
`floodExpected(offset, length, opts)` rebuilds any slice (a ring's tail, say). Writes are whole periods of about
`--chunk` bytes (default 64K). `--report` prints `{"bytes","ms","mbPerSec"}` on stderr when done. A PTY's ONLCR adds a
`\r` per `\n` on the way to the master; use `--eol none` for byte-exact throughput through a PTY.

**forker** builds a process tree, prints every pid, then sleeps. `--fork`: the parent forks `--children` (default 1,
≤ 16) children. `--double-fork`: each child ("middle") forks a grandchild and exits at once, so the grandchild is
orphaned (reparented to init). `--setsid` / `--setpgid`: the child (or middle, so the grandchild inherits it) starts
a new session / a new process group in the same session. SIGINT, SIGTERM and SIGHUP end a process by that signal
(`--stubborn`: reported and ignored, so only SIGKILL works); SIGUSR1/2 are only reported; each process exits 0 after
`--sleep` seconds (default 600, a guard against leaks; 0 = never). Output, one JSON line each, on stdout and appended
to `--log` (written to the log first, so a test that saw a line on stdout can SIGKILL at once). `--listen PORT`: every process
that stays alive also listens on TCP 127.0.0.1, the parent on PORT and child or grandchild i on PORT + 1 + i, before
the ready line (so a test can check those ports are free after Stop):

```
{"forker":"proc","role":"parent|child|middle|grandchild","index":0,"pid":…,"ppid":…,"pgid":…,"sid":…}   parent prints all, sorted
{"forker":"ready","pids":[…]}                                    all set up; the pids still running (not middles)
{"forker":"signal","role":…,"index":…,"pid":…,"signal":"TERM","action":"exit|ignore|report"}
{"forker":"reaped","pid":…,"by":…,"code":0|null,"signal":"TERM"|null}   a process reaped a child
{"forker":"lifetime","pid":…}
```

`parseForkerOutput(text)` turns them into `{ procs, ready, signals, reaped, lifetime }`. Readiness uses a pipe: every
descendant writes its line into it and closes its end, so the parent's EOF means the whole tree is set up.

*Why C:* Node cannot `fork`, `setsid` or `setpgid` (`spawn({detached: true})` gives only setsid-with-exec, and a Node
runtime per process would make every tree slow and heavy). `forker.c` is compiled on demand by `forker.ts` with `$CC`,
else `/usr/bin/cc` (`-std=c11 -O2 -Wall -Wextra`), into `tools/process-zoo/build/forker-<hash of source and flags>`
(gitignored); the build goes to a temp name and is renamed, so parallel test workers never run a half-written binary,
and an edited source gets a new name (older binaries are deleted). On macOS it first checks `xcode-select -p`,
so a machine without the Command Line Tools gets a clear error instead of the installer pop-up.

**stubborn** prints `{"stubborn":"ready","pid","ppid","ignoring"}`, then reports each signal in `--ignore` (default
`INT,TERM,HUP`; also `QUIT`, `USR1`, `USR2`) as `{"stubborn":"signal","signal","pid","ms"}` and keeps running, also
after its terminal is gone. Only SIGKILL (or a signal not in the list) ends it; `--lifetime` (default 600 s, 0 = never)
is a leak guard. `--log FILE` gets the same lines.

**server** is a stand-in dev server. It prints `PORT=<$PORT>`, then listens on 127.0.0.1 only, on `--port` (0: one the
system picks) or `$PORT`, prints `{"server":"ready","pid","port"}` and the line a dev server prints (`--announce url`:
`  ➜  Local:   http://localhost:N/`, with Vite's colours and bold port under `--color`, the host from `--print-host`;
`listening`: `Server listening on port N`; `none`: nothing), and answers every request `ok <pid> <port> PORT=<$PORT> FORCE_COLOR=<$FORCE_COLOR>`.
SIGINT or SIGTERM: `{"server":"signal",…}`, then exit 0. A port in use prints Node's own
`Error: listen EADDRINUSE: address already in use 127.0.0.1:N` and exits with `--exit-code` (default 1). `--exit CODE`
never listens: it prints `exiting CODE` and exits with it (the server that exits 1 at once); `--exit-after MS` exits
with `--exit-code` MS after listening. `--lifetime` (default 600 s) is a leak guard. `announceLine(opts, port)` is
the exact line printed.

**prober** sends terminal queries one at a time — by default every entry of `packages/terminal`'s `QUERY_TABLE`, or
the `--query` ids, plus `--send` sequences (`\e`, `\a`, `\xHH` escapes) — each followed by a DA1 sentinel
(`--no-sentinel`: each window lasts `--timeout-ms`). Stdin is put in raw mode when it is a terminal. Everything that
arrives before the sentinel's reply is that query's reply; anything after a window closed is a stray. A query's `ok`
is: exactly one reply matching the table's `reply` pattern (none for `answeredBy: nobody`), and the sentinel came;
`null` for `--send`. Output, JSON lines (to `--out FILE` as each window closes, else to stdout all at the end, after a
newline, so they never interleave with the queries):

```
{"t":"reply","id":"OSC11","query":"\u001b]11;?\u001b\\","answeredBy":"kea","replies":[{"seq":"…","ms":0.7}],"sentinelMs":0.8,"timedOut":false,"ok":true}
{"t":"stray","seq":"…","ms":120.5,"after":"OSC11"}
{"t":"done","queries":21,"ok":21,"notOk":[],"strays":0,"ms":140.2}
```

**intruder** connects to `--socket` as an ordinary same-user process, writes `--data` (default `y\r`; escapes) or
`--hex` bytes — with `--holder`, wrapped as a holder client's HELLO, ATTACH(latest) and INPUT frames
(`packages/protocol`) — then waits up to `--wait-ms` (default 1000) for the other side to close, and prints
`{"connected","connectError","wrote","writeError","received","receivedHex","frames","closedBy":"peer|timeout|error",
"closeError","ms"}` (`frames`: holder frames received, with `--holder`). Exits 0 if it connected, 1 if it could not.
macOS limits unix socket paths to 104 bytes: keep test sockets in `os.tmpdir()`.

## Code and tests

`cli.ts` (flags, `--help`, exit codes) · `counter.ts` · `flood.ts` · `stubborn.ts` · `server.ts` · `prober.ts` (imports
`QUERY_TABLE` from `packages/terminal/src/queries.ts` and the reply tokenizer from `tools/fake-agent/src/probes.ts`) ·
`intruder.ts` (imports the frame codec from `packages/protocol/src/holder.ts`) · `forker.c` + `forker.ts` (build,
output parser) · `index.ts` (`zooCommand`, helpers) · `test-support.ts` (the tests' process helpers). Each Node program
is a module whose `main` runs only when it is the entry point (`import.meta.main`). No dependencies.

`npx vitest run --project unit tools/process-zoo` covers counter's format and verifier, counter and flood output
byte-exact over pipes, size parsing and flood's stream, the prober's windows and judgements (pure, and as a process with
the test playing the terminal), forker's trees on a pipe (fork + setpgid, double fork + setsid + stubborn, signals,
reaping, orphaning), stubborn ignoring INT/TERM/HUP until SIGKILL, intruder against test socket servers (raw, holder
frames, silence, nothing listening), `zooCommand` plus every `--help`, and `server` (its URL line, a taken port,
`--exit`) with `forker --listen`. Every process and temp dir a test starts is removed in `afterAll`. None of it needs a
PTY; the PTY behaviour is exercised by the suites that use the zoo.
