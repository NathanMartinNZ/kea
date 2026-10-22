# tools/scrubber

Fixture privacy: recordings of real agent sessions never reach the repo unscrubbed.

| Entry | What |
|---|---|
| `pnpm fixtures:scrub` | every `fixtures/**/.raw/**` file (gitignored) → the same path without the `.raw` segment, scrubbed; reports replacements, absolute paths outside the demo repo (`--demo-root <path>` marks expected ones) and leftovers (exit 1). `--only <dir>` limits it to `fixtures/<dir>/` (repeatable); `--dry-run`; `--check` scans the committed fixtures only |
| `pnpm fixture:from-report <dir> [--out <dir>]` | turns a status-report bundle (what Report Wrong Status saves in `<KEA_HOME>/reports/<time>-<sessionId>/`) into a replay fixture, `fixtures/status/<id>/`: `fixture.json` (the expected state as golden, the note, what Kea showed, the status the ring starts from) and `signals.ndjson` (the recent-signal ring's inputs, without their projected envelopes), both scrubbed and scanned again — private data left fails it (exit 1); absolute paths are listed for review. Core's replay tests (`app/core/src/status/replay.test.ts`) run every fixture; the rest of the bundle is never committed |
| `scrubBuffer(buf, ctx)` | the length-preserving scrubber (Buffers in, Buffers out, byte-exact length) |
| `scanForPrivateData(buf, ctx)` | the privacy gate's scan: unscrubbed secret patterns and the developer's identity (`tests/contract/fixtures/privacy.test.ts`) |
| `assertRecordable({ cwd, prompt })` | the recorder guard: throws unless `cwd` is in a git repo whose root has `.kea-fixture-repo` and the prompt is in `tools/recorder/demo-prompts.json`. Every recorder calls it first |

**Placeholders (same byte length):** identity values become a tag padded with `_` — home `/Users/alexis` → `/Users/HOME__` (prefix kept), user name → `USER__`, host → `HOST_…`, git `user.name` / macOS full name → `NAME_…`, git `user.email` → `EMAIL_…` (tag cut when the value is shorter). Identity comes from `os.userInfo()`, `os.homedir()`, `os.hostname()`, `git config user.name/user.email`, `id -F`. Names and hosts match case-insensitively on word boundaries. A generic user or host name (`root`, `runner`, `ubuntu` and the rest of `GENERIC_NAMES`: CI runners, containers, cloud images) is not searched for, since it identifies no one; the scan still reports every home folder under `/Users` or `/home` that is not a placeholder or the tests' own account.

**Secrets** keep a short prefix and become `x` runs: `sk-ant-`, `ghp_`/`gho_`/…, `github_pat_`, `AKIA`/`ASIA`, `xoxb-`/`xoxp-`/…, JWTs (`eyJ…`, dots kept), PEM blocks (line breaks kept), URL passwords, `Authorization:` values, secret-named `KEY=value` lines (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*PASSWORD*`, …; every value in a `.env*` file) and secret-named JSON string fields. A match that is already all `x` counts as scrubbed, so scrubbing is idempotent.

Tests: `src/scrub.test.ts`.
