# tools/fake-agent

A scriptable stand-in for an agent CLI. It reads a scenario (YAML or JSON) and behaves like a TUI on its terminal:
probes it, enters the alternate screen, draws synchronized frames, sets titles, rings bells, waits for keys, fires hooks
exactly the way the real CLI does (exec'd synchronously, JSON on stdin) and writes transcript records. It makes the e2e,
integration and chaos suites deterministic, free and offline. `--as claude` stands in for Claude Code 2.1.296 (its
status file, `--version`, `auth status` and payload defaults), and `--as commandcode` for Command Code 1.79.2 (its mod
API, events and files, as recorded in `fixtures/`).

```sh
node tools/fake-agent/src/main.ts --as claude|commandcode [fake-agent options] [agent flags…] [-- <prompt>]
```

## Options

fake-agent's own options may appear anywhere before `--`; each also has an env var, so a `claude` / `cmd` shim on
`PATH` needs no extra flags. They are removed before the agent flags are parsed and are not part of the argv hash.

| Option | Env | Meaning |
|---|---|---|
| `--as claude\|commandcode` | `FAKE_AGENT_AS` | Flavour (required) |
| `--scenario <file>` | `FAKE_AGENT_SCENARIO` | Scenario file; default: one short realistic turn, then an idle prompt |
| `--fake-home <dir>` | `FAKE_AGENT_HOME` | Stands in for `HOME` when placing transcripts (below) |
| `--log <file>` | `FAKE_AGENT_LOG` | JSONL event log for tests (below) |
| — | `FAKE_AGENT_CLI_VERSION` | The version `--version` prints (and Claude's status file carries): default `2.1.296` for claude, `1.79.2` for commandcode; an older one stands in for an outdated CLI |
| — | `FAKE_AGENT_LOGGED_IN` | `0`: `claude auth status` / `cmd status --json` says signed out (exit 1) |

**`--as claude`** reads what Kea passes: `--session-id <uuid>` (validated like the real CLI), `--model`, `--effort`,
`--permission-mode` (the real choices; `manual` is reported as `default`), `--settings <inline JSON or file>` (only
`hooks` is read), `--resume <id>`, `--help`, `--version` (`2.1.296 (Claude Code)`), `auth status` (JSON `{loggedIn}`,
exit 0 or 1); other flags are kept as extra args (variadic ones like `--add-dir a b` keep their values); the prompt is
everything after `--`, else the positionals.

**`--as commandcode`** stands in for Command Code 1.79.2 and reads the flags Kea launches it with: `-m/--model`,
`--effort` (`off`…`max`), `--permission-mode` (every spelling 1.79.2 takes: `standard` and `default`, `plan`,
`accept-edits` and `auto-accept`, `yolo` and `bypass`, `dont-ask`), `--mod <file>` and `--mod-option <name=value>` (both
repeatable), `-t/--trust`, `-n/--name`, `-r/--resume <id or name>`; the prompt is the positional argument (or follows
`--`). There is no `--session-id`: the session id is random, or the resumed session's (a name is looked up among the
project's `<id>.meta.json` titles; none found exits 1 with the CLI's own message). Detection's questions answer as
1.79.2 does: `--version` (`1.79.2` alone on a line), `--help` and `--list-models` (the recorded texts in
`fixtures/cli/commandcode/1.79.2/`), `status --json` (`{authenticated, version}`, exit 0 or 1).

From a test:

```ts
import { argvHash, argvHashLine, fakeAgentCommand, writeAgentShim } from '../../tools/fake-agent/src/index.ts'
const { file, args } = fakeAgentCommand('claude', adapterArgs, { scenario, fakeHome, log }) // spawn file + args
// the agent prints `argvHashLine(argvHash(adapterArgs))` for an `argvHash` step (E-SES-1)
writeAgentShim(binDir, 'claude', { env: { FAKE_AGENT_SCENARIO: file } }) // a `claude` on PATH that execs fake-agent (same pid)
```

`argvHash` is sha256 of `JSON.stringify(argv)` over the agent flags only (what the adapter built), hex.

## Lifecycle

1. `SessionStart` (Command Code: `session_start`) fires, unless the scenario sets `fireSessionStart: false` (an agent
   waiting for workspace trust).
2. `steps` run as the first turn.
3. Then, with `afterSteps: idle` (default), an idle prompt: each typed line (Enter) runs `onLine` as a new turn with
   `{{line}}` and `{{prompt}}` set to it. With `afterSteps: exit` the agent ends with code 0.
4. Esc or Ctrl-C during a turn interrupts it when the scenario has `onInterrupt` (which then runs); without one,
   Ctrl-C ends the agent. Ctrl-D on an empty prompt line ends it (`prompt_input_exit`).
5. **Every graceful end** — an `exit` step, SIGTERM, SIGHUP, SIGINT, Ctrl-C/Ctrl-D, EOF on stdin while a step reads,
   the PTY closing — aborts the running step, fires `SessionEnd` (`session_shutdown`) and waits for its hooks, writes
   `cost-state` when `exitCostUsd` is set, restores the terminal, then exits (E-SES-9). Command Code 1.79.2 says
   nothing to its mods when a signal or a closed terminal ends it, so `--as commandcode` fires its end only for an end
   at the prompt or an `exit` step.

## Scenarios

```yaml
version: 1                    # required
name: permission then edit    # optional, shown in the event log
flavour: claude               # optional: refuse to run under the other flavour
afterSteps: idle              # idle (default) | exit
fireSessionStart: true        # default true
fireSessionEnd: true          # default true
exitCostUsd: 0.42             # claude only: a cost-state record at every graceful end
steps:
  - probe: [decrqm-2026, kitty, osc11]
  - altScreen: enter
  - title: "✳ {{prompt}}"
  - frame: ["✻ fake-agent · {{model}}", "", "> {{prompt}}", "", "Bash(rm -rf build)  Allow? (y/n)"]
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "rm -rf build" } }
  - notify: { body: "Claude needs your permission to use Bash" }
  - choose:
      y:
        - hook: { event: PreToolUse, tool: Bash, input: { command: "rm -rf build" } }
        - file: { op: delete, path: build }
        - hook: { event: PostToolUse, tool: Bash }
      n:
        - transcript: { record: interrupt, forToolUse: true }
  - transcript: { record: assistant, text: "Done." }
  - hook: Stop
  - transcript: { record: ai-title, title: "Clean the build" }
onLine:
  - hook: UserPromptSubmit
  - print: "you said {{line}}\r\n"
onInterrupt:
  - transcript: { record: interrupt }
```

The whole file is validated before anything runs; every problem is reported with its path (`steps[3].hook.event:
expected one of …`) and fake-agent exits 2. A step is a one-key mapping (`- kind: value`); `bell`, `argvHash` and
`exit` may also be written bare.

| Step | Forms | Does |
|---|---|---|
| `probe` | `[ids]` · `{queries, timeoutMs: 1000}` | Writes the queries plus a DA1 sentinel, takes the replies out of stdin (keys typed meanwhile survive), records `{id, reply, value, ms}` in the log's `probe` event. Ids: `da1`, `da2`, `cpr`, `kitty`, `osc10`, `osc11`, `xtversion`, `decrqm-<mode>` |
| `altScreen` | `enter` · `leave` | DEC 1049 |
| `frame` | `[lines]` · `{lines, sync: true}` | Home, clear, the lines clipped to the terminal; wrapped in DEC 2026 when `sync`. The last frame is redrawn on SIGWINCH |
| `print` | `text` | Writes text as is (YAML double quotes give `\e`, `\r`, `\n`) |
| `title` | `text` · `{text, osc: 2}` | OSC 0 or 2 |
| `bell` | bare | BEL |
| `notify` | `body` · `{body, title, osc: 9}` | OSC 9 or OSC 777 `notify` |
| `wait` | `key` · `line` · `{answer: y}` · `{for, answer, timeoutMs, echo: true}` | Waits for any key, a line (echoed, Backspace works), or one specific key (others are ignored). On timeout it moves on. Sets `{{key}}` / `{{line}}` |
| `choose` | `{key: [steps], …}` | Waits for one of the keys and runs its branch. Keys: one character or `enter`, `esc`, `tab`, `space`, `backspace`, `up`, `down`, `left`, `right`, `shift-tab`, `shift-enter` |
| `hook` | `Event` · `{event, tool, input, fields}` | Fires one hook event (below). `fields` are merged over the payload; a `null` field removes it. `UserPromptSubmit` gets `prompt: {{prompt}}` unless given |
| `transcript` | `{record, text, title, costUsd, forToolUse, json, fields}` | Appends one JSONL record. Claude: `user`, `assistant` (with `usage`), `interrupt` (`[Request interrupted by user]`, or `… for tool use` with `forToolUse`), `ai-title`, `custom-title`, `cost-state`, `raw` (`json` as is). Command Code (format version 3): `user` (and its checkpoint line), `assistant`, `error` (`Error: <text>`), `title` (the meta file), `raw` |
| `file` | `{op, path, to, content, find, replace}` | `write`, `append`, `modify` (first `find` → `replace`), `delete` (recursive), `rename` (`to`), `mkdir`. Paths are relative and must stay inside the cwd |
| `argvHash` | bare | Prints `fake-agent argv sha256=<hex>` |
| `cassette` | `file` · `{file, speed: 1, maxIdleMs}` | Replays an asciicast v2 file's output events (`[t, "o", data]`) at `speed` (0 = all at once); gaps are capped at `maxIdleMs`, else the header's `idle_time_limit`. Relative to the scenario file |
| `sleep` | `ms` | Pacing (abortable) |
| `exit` | bare · `code` · `{code, reason}` | Ends the agent (SessionEnd first, its `reason` defaulting to `prompt_input_exit`) |
| `loop` | `{times: N, steps}` · `{forever: true, steps}` | `{{i}}` is the 0-based index |
| `status` | `busy` · `{status, waitingFor}` · `{torn: true}` · `{removed: true}` · `{sessionId}` | Claude only: writes the live status file (below) now, a torn half-write, removes it, or switches its `sessionId`. With `statusFile: auto` the hooks also drive it |

Template variables, usable in any text a step writes: `{{cols}}`, `{{rows}}`, `{{i}}`, `{{sessionId}}`, `{{cwd}}`,
`{{model}}` (default `claude-opus-5-5` for claude, `fake-model-1` for commandcode), `{{prompt}}`, `{{line}}`, `{{key}}`, `{{argvHash}}`, `{{flavour}}`,
`{{permissionMode}}`, `{{transcriptPath}}`. An unknown name is a validation error.

## Hooks

**Claude.** The hooks come from `--settings`. For each event, the groups whose `matcher` (an anchored regex over the
event's field: `tool_name`, `source`, `notification_type`, `trigger`, `reason`, `agent_type`; empty or `*` matches all)
fits, each `type: "command"` hook is exec'd as `command` + `args` with no shell, gets the payload on stdin, and is
waited for — killed after its `timeout` seconds (default 60) — before the next step runs. Env adds
`CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_SESSION_ID`; cwd is the agent's. Hook output and exit codes are recorded in the
log and otherwise ignored, as Kea's helper never decides anything.

Payloads use Claude's shapes, every field Kea reads included: `session_id`, `transcript_path`, `cwd`, `permission_mode`
(not on SessionStart/End), `hook_event_name`, then per event: `source` + `model` (SessionStart), `prompt`, `tool_name` /
`tool_input` / `tool_use_id` (`PreToolUse` mints `toolu_fake_NNNN`; later tool events reuse the last one with the same
tool; `PermissionRequest` has no `tool_use_id`), `tool_response`, `error`, `notification_type` + `message`,
`stop_hook_active` / `last_assistant_message` / `background_tasks` / `session_crons` (Stop), `agent_id` / `agent_type`,
`trigger`, `reason`.

**`disableAllHooks`**, for a session whose hooks never run: `"disableAllHooks": true` in the user's settings (`<config
dir>/settings.json`, the config dir as for the status file, never the real `~/.claude`) or the project's
(`<cwd>/.claude/settings.json`, `settings.local.json`) turns every hook off, the inline `--settings` ones included; an
inline `"disableAllHooks": false` wins. The `start` record says which file did it (`hooksDisabledBy`).

**Command Code** has no inline hooks; Kea loads `kea-mod.ts` with `--mod` and `--mod-option`. fake-agent imports each
`--mod` module and calls its default export with a `cmd` of the shape 1.79.2 gives a mod (`mods.ts`): `cmd.addFlag(name,
{default})` and `cmd.getFlag(name)` (the default until the session is bound, then the `--mod-option` given; an option
nobody declared never answers), `cmd.on(event, handler)`, `cmd.hooks({onSessionStart, onSessionEnd})` and
`cmd.exec({command, args, cwd, input, timeoutMs})` (no shell). The mod's `HOME` is the fake home.

A `hook` step calls the event's handlers in registration order, synchronously (a handler that blocks holds the agent,
as in the real CLI: `kea-mod.ts` runs kea-helper and waits), then waits for what they started with `cmd.exec`; a
handler that throws is recorded and never ends the agent. Events have 1.79.2's shapes
(`fixtures/hooks/commandcode/1.79.2/mod-events.*.jsonl`): `{type, …}` with the session id on `run_start` only, a tool
call as `toolCallId` / `toolName` (`tool_queued` mints `toolu_fake_NNNN` and alone carries `input`; later tool events
reuse the last call of the same tool), `run_end.result {finalText, stopReason, turnCount, usage, nextState}`,
`run_error.error {name, message, status}`. A step's `fields` are laid over the event one level deep
(`fields: { result: { stopReason: interrupted } }`). `session_start` reaches `cmd.on` bare and
`onSessionStart({source, sessionId})` with the id (`source: resume` under `--resume`; a `fields.sessionId` starts
another conversation in the same process, as `/clear` does, and the transcript follows it); `session_shutdown` calls
`onSessionEnd({reason})` (`shutdown`, or `replaced` from `fields.reason`). With `--name` the meta file is written with
`userRenamed` and `session_titled` fires as the first step.

The default scenario's turn is the recorded order: `run_start`, `turn_start`, `message_start`, `model_request_start`,
`model_request_end`, `message_end`, `tool_queued`, `tool_running`, `tool_completed`, `turn_end`, `run_end`. A
permission prompt is a `tool_queued` followed by a `wait` or `choose` step (nothing runs while it waits: that silence
is what Kea's mod reads), then `tool_running` or `tool_denied`; a failing tool is `tool_errored`.

A model step with several calls is scripted the way 1.79.2 handles one (as its bundle reads, and as recorded): every
call's `tool_queued` first; then the calls are asked about in order, with no event for a prompt and none for an
approval, so each prompt is a `wait`; a refusal is a `tool_denied` at once, after which the next call is asked about;
and once a call was refused nothing of the batch runs: the turn ends with `run_end` (`stopReason: permission_denied`)
and no `tool_running`. Only a tool name the CLI does not know, or a deny rule, is refused (`tool_denied`, no prompt)
without ending the batch. An integration test scripts one in its third turn (I-AGT-9,
`tests/integration/core-commandcode.test.ts`).

## Transcripts and the fake home

Records go where the real CLI writes them, under a stand-in home: `<home>/.claude/projects/<cwd with every
non-alphanumeric → ->/<sessionId>.jsonl` or `<home>/.commandcode/projects/<slug>/<id>.jsonl` (the slug is 1.79.2's:
camel case split, lower case, each run of other characters one `-`, none at the ends), with `<id>.checkpoints.jsonl`
(one line per prompt) and `<id>.meta.json` (the title) beside it. A Command Code file gets its `session` header with its
first record, so a session nothing was said in leaves none. The home is `--fake-home` / `FAKE_AGENT_HOME`, else `$HOME`
(tests set it to a temp dir). **fake-agent never writes under the real `~/.claude*` or `~/.commandcode`**: if the home
resolves to the account's real home (from the password database, whatever `$HOME` says) or to a `.claude*` /
`.commandcode` / `.kea*` folder inside it, it says so on stderr, skips every transcript step (logging
`transcript-skipped`) and runs the rest. Hook payloads still carry the path.

## The live status file (Claude)

Claude 2.1.296 keeps `<config dir>/sessions/<pid>.json`: the config dir is `CLAUDE_CONFIG_DIR` when set, else
`<home>/.claude`, and the pid is fake-agent's own (a `writeAgentShim` shim execs it, so it is the PTY's child as Claude
is). The file is registered at start with no `status` (with `fireSessionStart: false`, an agent awaiting workspace
trust, not until its `SessionStart` step: the trust dialog writes no file), rewritten in place on each change and
removed on a graceful end before `SessionEnd`; SIGKILL leaves it. The scenario's `statusFile` picks the mode: `auto`
(default for claude) follows the hooks the way `fixtures/status/claude/2.1.296/sequence.json` shows (busy before
`UserPromptSubmit`; waiting `permission prompt` after `PermissionRequest`, `input needed` for AskUserQuestion; idle
after `Stop`; an interrupt goes idle with no `Stop`); `manual` writes only what `status` steps say; `off` writes
nothing. A `SessionStart` with another `session_id` (`/clear`) moves later payloads and the file to it. The real-home
refusal above applies to it as to transcripts (`CLAUDE_CONFIG_DIR` set to the real `~/.claude` is refused too).

2.1.296's payload defaults: `model` `claude-opus-5-5` (SessionStart), `effort {level: medium}` on tool and `Stop`
payloads, `SessionEnd.reason` `other` (what 2.1.296 sends on SIGTERM) unless the end gives one; `cost-state` carries
`totalCostUSD`.

## Terminal

Raw mode when stdin is a TTY, restored on exit (also leaves the alternate screen and shows the cursor); SIGWINCH
redraws the last frame; output waits for the PTY to take it (back-pressure); EOF/EIO on stdin or EIO on stdout ends
the agent gracefully. Keys typed before a step reads them are kept (type-ahead). Kitty-encoded keys (`CSI 13;2u` →
`shift-enter`) and bracketed paste markers are recognised.

## Event log

`--log <file>` appends one JSON object per line, synchronously, `{t, ms, …}`: `start` (argv, argvHash, sessionId,
transcript path and whether it is writable, tty, size), `hook` (event, payload, each run's argv / exit code / timing /
output), `probe`, `argv-hash`, `transcript` / `transcript-skipped`, `file`, `input`, `wait-timeout`, `line`,
`interrupt` / `interrupted`, `resize`, `cassette`, `error`, `ending` (reason, code), `exit`.

## Exit codes

The `exit` step's code; 0 after `afterSteps: exit`, Ctrl-C/Ctrl-D at the prompt, EOF or the PTY closing; 1 for a bad
agent flag, bad `--settings`, a mod that fails to load, or a failed step (reported with its path); 2 for a bad
fake-agent option or scenario; 143 / 129 / 130 after SIGTERM / SIGHUP / SIGINT (after SessionEnd).

## Code and tests

`argv.ts` (both command lines, argv hash) · `scenario.ts` (schema, validator, default scenarios) · `keys.ts` ·
`probes.ts` (queries, reply tokenizer) · `term.ts` (sequences, input router, process terminal) · `hooks.ts` (settings,
Claude payloads, exec) · `mods.ts` (Command Code mod host) · `transcript.ts` · `status.ts` (the live status file) · `cassette.ts` · `files.ts` · `runner.ts`
(steps) · `agent.ts` (lifecycle) · `log.ts` · `main.ts` · `index.ts` (what tests import).

`npx vitest run --project unit tools/fake-agent` runs the tests: argv parsing, scenario validation, probe and key
parsing, hook exec through a stub hook that records its stdin, payload shapes, `disableAllHooks`, the mod host and
Command Code's detection answers, transcript paths and the real-home refusal, the record writer, the live status file
(against `sequence.json`, and none while trust is awaited), cassette parsing and timing, file operations, the runner and
lifecycle against an in-memory terminal, and `main.ts` as a process over pipes (signal wiring, exit codes, files under
the fake home, `--name` and resume by name). No test runs with `HOME` set to the real home.

## Limitations

- **No PTY test in this package.** TTY behaviour (raw mode, probe replies, SIGWINCH redraw, PTY close) is covered by
  the pure parts here; the app-level suites run fake-agent in real terminals.
- **Hooks:** shell-form hooks (no `args`) are exec'd as a program path, not run through a shell; matching hooks run one
  after another (Claude runs them in parallel); hook decisions (exit code 2, JSON output) are ignored; `prompt`,
  `agent` and `http` hooks are skipped; of the settings files only `disableAllHooks` is read (above).
- **Command Code:** the rest of 1.79.2's mod API (tools, commands, UI, `exec` beyond a program run) is not there; no
  workspace-trust prompt (`--trust` is read and ignored); usage numbers are constants and there is no cost; tool-call
  and tool-result messages are not written to the transcript (script them with `raw`); the slug does not
  transliterate non-ASCII paths.
- **Some details are approximate:** payload texts such as the `Notification` message, and the hash Claude appends to
  project directory names over 200 characters.
- **No agent behaviour beyond the script:** no workspace-trust dialog (script it with `choose` and
  `fireSessionStart: false`), no slash commands (`/clear` is a `hook: { event: SessionStart, fields: { source: clear }
  }`), `--resume` only reuses the id and sets `source: resume`, no model.
- **Rendering is simple:** one cell per code point when clipping frames (no wide characters); no mouse, focus or
  bracketed-paste modes are enabled and the kitty keyboard protocol is not pushed (its key encodings are still
  parsed); lines end in `\r\n`, so a PTY with ONLCR shows `\r\r\n`.
