# packages/adapters

The only place in Kea that knows anything about a particular coding agent. Each agent CLI Kea runs (Claude Code and
Command Code today) has an adapter here: how to find and check the CLI, the argv and environment that start or resume
a conversation, the hooks or mod that report what the agent is doing, how those reports become Kea's status events,
and what its transcript says. Core uses adapters only through the registry, so nothing outside this package names an
agent's flags, paths or payload fields.

## What an adapter provides

`AgentAdapter` (`src/types.ts`) is the interface. In short:

- **Identity:** `id` (the registry key, also the `agents.<id>` settings key), `displayName`, `commands` (every name the
  CLI is installed under), the install and sign-in commands to show the user, and a settings extension.
- **Detection and options:** `detect()` finds the CLI on the login shell's `PATH` (or the user's override), reads its
  version and whether it is signed in, and never throws; `options()` turns that into what the composer offers
  (models, effort levels, permission modes) for that version.
- **Launch and resume:** `buildLaunch()` and `buildResume()` return a `SpawnSpec`: an argv that goes straight to
  `execve` (never through a shell), the complete environment, the environment keys removed, and the working
  directory. `launchFiles()` names files a launch needs on disk, which core writes into a folder of Kea's own.
- **Trust:** `trustGated` says whether the agent holds its events back until the user trusts the folder, and whether
  that answer is kept per repository (Claude Code) or asked at every launch (Command Code).
- **Signals:** `signals()` gives the per-session state that turns a hook or mod payload into events, and reads the
  agent's own status file where it has one. `watchTranscript()` and `reconcile()` read the transcript: live, for what
  hooks cannot give, and after a restart, to recover the session's status, title and cost.
- **Housekeeping:** `identify()` recognises an argv the adapter started, `helperPaths()` names the `kea-helper` a
  running command calls, `watchRoots()` and `ownsTranscript()` keep file watching and transcript reads inside the
  agent's own config folder, and `fileMention()` says how to mention a file at the agent's prompt.

The agent is untrusted input: payloads are projected by `kea-helper` before Kea sees them, a transcript path is read
only when it lies in the agent's own config folder, and a file is read only when it is a regular file.

## Layout

- `src/types.ts`: the interface and the types core and adapters share.
- `src/registry.ts`: `AdapterRegistry` and `ADAPTERS`, the shipped adapters in the composer's order. The registry
  also answers for every adapter at once: the settings extensions, the helpers a command names, and every command name
  an agent CLI is installed under (the test harnesses hide or shadow each, so a test never runs a real CLI).
- `src/kit/`: code every adapter shares. `jsonl.ts` reads transcripts incrementally and never whole; `heuristics.ts`
  derives status from terminal activity, the fallback under every agent's own reports; `env.ts` finds the CLI and
  edits the environment; `projection.ts` mirrors `kea-helper`'s payload projection so tests see what core receives;
  `version.ts` compares versions; `mention.ts` builds a file mention.
- `src/claude/` and `src/commandcode/`: one folder per agent, with the same parts:

  | File | What |
  |---|---|
  | `contract.ts` | Every flag, environment variable, path, event and payload field the adapter relies on, and nothing else |
  | `detect.ts` | Detection and the composer's options |
  | `launch.ts` | The argv and environment for a new conversation and for a resume |
  | `mapping.ts` | Payload → events, one row per event, and the per-session signal state |
  | `transcript.ts` | The transcript watcher (Claude Code) and reconcile |
  | `settings.ts` | The agent's own settings (`agents.<id>.*`) |
  | `mention.ts` | How a file is mentioned at this agent's prompt |
  | `adapter.ts` | The adapter, assembled from the parts above |

  Claude Code reports through hooks injected with `--settings`, and its status file (`payloads.ts` holds the hook
  payload schemas the fixture tests check). Command Code reports through a session mod, `commandcode/kea-mod.ts`:
  Command Code loads that file itself, in its own process, so it imports nothing from Kea and only Node's own
  modules. The build copies it beside core, and core writes it into a folder under `KEA_HOME` that the launch names.
  `commandcode/mod-harness.ts` drives the mod the way Command Code does, for tests only.

## Adding an agent

1. Make a folder `src/<id>/` with the parts above. Put every agent-specific string in its `contract.ts`.
2. Add the adapter to `ADAPTERS` in `src/registry.ts`. Core, the composer, the Settings window and the test
   harnesses pick it up from there.
3. Add a `contract.test.ts` beside it, like the two existing ones: it checks that the adapter's code uses no
   agent string that `contract.ts` does not declare.
4. Record fixtures for its hooks or events and its transcripts under `fixtures/` (scrubbed, see
   [CONTRIBUTING.md](../../CONTRIBUTING.md#tests)), and add contract tests for them in `tests/contract/`.

## The agent-strings lint

`pnpm lint` fails when an agent-specific string (a CLI flag, an environment variable, a payload field or a config
path) appears outside this package, in `app/` or `native/kea-helper/src`. Its list is a small seed plus every such
string literal in `src/*/contract.ts`, so a new contract's strings are covered at once. Fixtures, `tools/fake-agent`,
`tools/mock-model` and tests may use them. Anything else must carry `kea-lint-allow U-AGT-11: <reason>` on the same or
the previous line.

## Tests

Unit tests sit beside the code (`*.test.ts`):

```sh
pnpm exec vitest run --project unit packages/adapters
```

The contract tests in `tests/contract/` check the adapters against recorded fixtures (`fixtures/hooks/`,
`fixtures/transcripts/`, `fixtures/status/`, `fixtures/cli/`) and against the installed CLIs' own help text, cached
per version. No unit test runs a real agent CLI.
