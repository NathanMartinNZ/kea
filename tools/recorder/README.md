# tools/recorder

`pnpm record:cassette` records byte-exact PTY sessions with timing (asciicast v2 `.cast`) of real agent CLIs for
`fixtures/cassettes/`. It records Claude Code only.

```sh
pnpm record:cassette <name|file.json>… | --all  [--agent-bin <path>] [--helper <path>] [--out <dir>] [--repo <dir>]
pnpm fixtures:scrub --only cassettes          # .raw/ → fixtures/cassettes/, then review and commit
```

**How a recording runs** (`src/record.ts`). The agent runs in a real `kea-helper` holder, as Kea hosts it, and the
recorder attaches the way ptyhost does: `HolderConnection`, ptyhost's own headless `Mirror` (which answers the agent's
terminal queries), acks after parsing. Every output byte goes to the cassette with its time; the scenario's steps wait
on the mirror's screen and type into the PTY. The environment is Kea's terminal environment (`terminalEnv` in
`app/core/src/terminal/shellEnv.ts`) over a minimal base.

**Safety.** Nothing is recorded outside these rules:
- the recorder guard (`tools/scrubber` `assertRecordable`) runs first: the cwd must be a repo-factory repo (a fresh
  `tiny` repo under `/tmp` unless `--repo` names another) and the prompt must be in `demo-prompts.json`; `send` steps
  are at most 8 characters, so text reaches the agent only as the demo prompt;
- the model is always `tools/mock-model` (`ANTHROPIC_BASE_URL`, a dummy key): a recording costs nothing and sends
  nothing anywhere. Real-model recordings belong to the live contract suite, run only when asked;
- the CLI runs under `sandbox-exec` (`src/world.ts`): network only to the mock model's and the sinkhole's ports (no
  other local listener, so a forwarding proxy or tunnel cannot carry a request out) and to unix sockets inside the
  world, writes under the real home denied, the agent's real config (`~/.claude*`, `~/.config/claude`, `~/.commandcode`)
  unreadable, `security`/`open`/`osascript` denied; HTTP(S) proxies point at a sinkhole that refuses and counts every
  attempt (reported after each recording);
- HOME and `CLAUDE_CONFIG_DIR` are a throwaway world, seeded so the TUI skips onboarding and key approval, and the repo
  is pre-trusted unless the scenario says `"trusted": false`;
- afterwards every process naming the world is killed, the world and the repo are deleted, and so is the
  `/tmp/claude-<uid>/<repo slug>/` folder Claude writes regardless of `TMPDIR`.

**Scenarios** (`scenarios/*.json`, `validateScenario`): `name`, `agent: "claude"`, `prompt` (a demo prompt), `cols`,
`rows`, optional `args`, `env` (e.g. `CLAUDE_CODE_NO_FLICKER: "1"` for the fullscreen renderer; it may not set any key
the world sets, proxies, `ANTHROPIC_*`, backend selectors or code loaders such as `NODE_OPTIONS`), `trusted`, `mock`
(a mock-model script: `default`, `replies`; `{{repo}}` becomes the repo's absolute path, since file tools take absolute
paths) and `steps`:

| Step | Does |
|---|---|
| `{ "wait": "<regex>", "timeoutMs"? }` | until the mirror's screen (whitespace collapsed) matches; a timeout prints the screen |
| `{ "type": "prompt", "keyDelayMs"? }` | types the demo prompt one key at a time |
| `{ "send": "<≤ 8 chars>" }` | keys: `\r`, `1`, `/exit`, `\u0003` … |
| `{ "resize": [cols, rows] }` · `{ "pause": ms }` · `{ "mark": "<label>" }` · `{ "exit": ms }` | resize the PTY · idle · marker event · wait for the agent to exit |

**Cassettes** (`src/cast.ts`): a JSON header (`width`, `height`, `env.TERM`, `kea: {scenario, agent, agentVersion,
prompt, model: "mock-model", bytes, altScreen, recorder}`), then `[seconds, code, data]` events: `o` output, `i` bytes
written to the PTY (keys and the mirror's query replies), `r` resize (`COLSxROWS`), `m` marker. Output is decoded as
one UTF-8 stream (a code point split across reads moves whole into the next event) and invalid UTF-8 is refused, so
concatenating the `o` data gives back the PTY's exact bytes; `kea.bytes` is checked on read. `tools/fake-agent`'s
`cassette` step replays them; `tests/contract/fixtures/cassettes.test.ts` replays each through ptyhost's mirror
against its reference screen `<name>.screen.json`.

**Current cassettes** (Claude Code 2.1.233): `claude-classic-explain` (long spinner, short answer), `-list-files`
(auto-allowed Bash, long markdown that scrolls), `-fix-typo` (Read, Edit permission prompt with a diff),
`-run-tests-resize` (Bash permission prompt, command output, three resizes mid-turn), `claude-fullscreen-changelog`
(alternate screen, Write permission prompt).

**Command Code.** The world can hold it: `agentEnv(…, { agent: 'commandcode' })` gives `cmd` the throwaway HOME,
local-only mode with a dummy key (signed out, it exits before a mod loads), telemetry and auto-update off, and
`seedCommandCode` writes a `providers.json` that makes `tools/mock-model` a provider of its own (`-m mock/mock-model`);
`sandboxProfile` blocks the real `~/.commandcode` like Claude's folders. The static contract capture uses it
(`tests/contract/static/commandcode-cli.ts`), and the sessions behind `fixtures/{hooks,transcripts}/commandcode/1.79.2/`
were recorded in this world. This CLI does not record Command Code: a scenario takes `agent: "claude"` only, so there is
no Command Code cassette.

**Tier-3 timeline** (`src/timeline.ts`). The raw hook recordings under `fixtures/hooks/claude/<version>/.raw/s2/` are
never committed (`.raw/` is gitignored). The contract test of Kea's terminal heuristics
(`tests/contract/fixtures/tier3.test.ts`) runs on a content-free reduction of them: per case, the hook event names and
times, every PTY read's size and time, the driver's keystrokes, and the times of bells and OSC 9/777 notifications
(ConEmu's `9;<n>` commands excluded, as ptyhost does). No bytes, paths or text.

```sh
node tools/recorder/src/timeline.ts 2.1.233                                     # → .raw/tier3-timeline.json
pnpm fixtures:scrub --only hooks/claude/2.1.233/.raw/tier3-timeline.json        # → fixtures/hooks/claude/2.1.233/tier3-timeline.json
```

(`--only hooks/claude/<version>` alone would also scrub the raw recordings into the committed tree: name the file.)

Tests: `src/cast.test.ts` (the cassette format) and `src/world.test.ts` (the sandbox and the scenario environment);
the timeline through `tests/contract/fixtures/tier3.test.ts`.
