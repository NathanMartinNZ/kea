# Contributing to Kea

Kea is maintained by one person in their own time. Bug reports, small fixes and focused pull requests are welcome.
For anything larger (a new agent, a new panel, a change to how sessions or terminals work), open an issue first to
agree on the approach before you spend time on it.

## Setting up

The requirements and the first build are in [docs/building.md](docs/building.md). In short:

```sh
pnpm install
pnpm dev
```

`pnpm dev` keeps its data in `~/.kea-dev`. Nothing in the repository's tools or tests touches `~/.kea`, the installed
app's data.

## Before you open a pull request

```sh
pnpm helper:build   # once in a fresh clone, unless you have run pnpm dev: some unit tests use the built helper
pnpm verify
```

`pnpm verify` on your machine is the gate. It checks that generated files are up to date, then runs lint, typecheck,
unit tests, the Rust tests and the first tier of the integration, contract, chaos and memory suites. It takes about
five minutes and ends with a table of what passed. `pnpm hooks:install` runs it before every `git push`.

CI (`.github/workflows/ci.yml`) runs `pnpm verify` on macOS and on Linux (x64 and arm64) for every push and pull
request, and the e2e suite on Linux. The pre-push hook stays: it is the same gate, before the push rather than after.

The chaos and memory suites start Kea with a window that never takes the keyboard; on Linux they run it on an Xvfb
display of their own (install `xvfb` and `zsh`; on Ubuntu 23.10 and later they also need Electron's `chrome-sandbox`
set-uid root, and print the two commands that do it). A test that needs something your system lacks is skipped by
name, with the reason.

| Command | What it runs |
|---|---|
| `pnpm test:unit -t '<ID>'` | Unit tests whose name starts with that ID |
| `pnpm test` | Unit and integration tests |
| `pnpm test:e2e -g '<ID> '` | A window test (Playwright) |
| `pnpm test:rust` | `cargo test` for `kea-helper` |
| `pnpm lint` · `pnpm typecheck` | Package boundaries, design tokens, agent and OS names · `tsc` and `svelte-check` |
| `pnpm codegen` | Regenerate the files derived from `constants/` |
| `pnpm gallery` | Screenshots of every UI state in `dist/gallery/index.html`, for reviewing a visual change |

The regular suites never run a real agent CLI: they use `tools/fake-agent` and a temporary `KEA_HOME`. Only the
contract tests that launch the real Claude Code and Command Code (`pnpm test:contract:live` and the
`pnpm test:contract:capture` scripts) do; they use your account and can cost money, and a pull request does not need
them.

## Finding your way around

| Path | What |
|---|---|
| `app/main` | Electron main: windows, menus, notifications; supervises core and ptyhost |
| `app/core` | Sessions, git and worktrees, files, agents and their status, settings, the database (SQLite) |
| `app/ptyhost` | Connects to terminal holders, keeps headless mirrors, streams output to the window |
| `app/renderer`, `app/preload` | The window (Svelte 5, xterm.js) and its only bridge to the other processes |
| `native/kea-helper` | Rust: the holder each terminal lives in, plus small helper subcommands |
| `packages/protocol` | Everything that crosses a process boundary |
| `packages/kit` | Shared runtime pieces: cleanup scopes, bounded caches, `runProcess`, git, the supervisor |
| `packages/terminal` | The terminal contract between ptyhost's mirror and the window |
| `packages/adapters` | The only place agent-specific flags, paths and payloads live |
| `packages/ui` | Design tokens, Svelte primitives, icons |
| `constants/` | Every limit, budget and token; `pnpm codegen` turns them into code |
| `tests/`, `tools/`, `fixtures/` | Cross-process suites, test and build tools, recorded test data |

Each package's `README.md` says what it owns.

## Conventions

The lint and the tests enforce most of these.

- **TypeScript is erasable.** Node runs the `.ts` files directly, so no `enum`, `namespace` or parameter properties,
  and imports name the `.ts` extension. The same holds in `.svelte` files and `.svelte.ts` modules.
- **Numbers come from `constants/`.** Limits, timeouts, budgets and design tokens live in `constants/*.toml` and
  `constants/tokens.json`; `pnpm codegen` writes the TypeScript, Rust and CSS that the code imports. Never write such
  a number inline. A new entry needs a `value`, a `unit` and a `why`: what the number is for, in a few words.
- **Long-lived collections are bounded.** A map, set, cache or queue that lives as long as a process carries a
  `// bounded:` comment naming its cap.
- **Child processes take argv arrays, never shell strings**, and start through `runProcess` in `packages/kit` or a
  terminal holder.
- **OS-specific code lives in `os/` folders.** No `process.platform`, macOS tool path or `cfg(target_os)` elsewhere;
  a line that must name one carries `// os-ok: <reason>`.
- **Agent-specific flags, paths and payload fields live in `packages/adapters`.**
- **Package boundaries:** the renderer never imports `app/core` or `app/ptyhost`, and nothing in `packages/` has an
  entry point.
- **Svelte:** heavy objects (xterm terminals, addons, canvases, ports) never sit in `$state` or `$derived`; see
  `app/renderer/README.md`.
- **Kea never writes into a user's repository configuration or into `~/.claude` or `~/.commandcode`.**

## Comments

Comments say why, in the present tense, and make sense on their own: an invariant, an ordering rule, a platform
quirk, an upstream bug and what the upstream code does. No requirement tags, section citations, milestones or change
history. Some comments are read by tools and keep their exact form: `// bounded:` on a long-lived collection,
`// os-ok:` and `kea-lint-allow` for the lints, `// SAFETY:` above Rust `unsafe` blocks, and `// test:` above a Rust
test whose function name does not give its ID.

## Tests

- A test's name starts with its ID, then ` · ` and the behaviour it checks:

  ```ts
  it('U-FT-6 · entry cap: the least recently used entry is evicted first; get refreshes, peek does not', () => {
    …
  })
  ```

  (from `packages/kit/src/lru.test.ts`). In Rust the function is named after the ID (`fn r_hld_1_ring_wraps`).

- A bug fix comes with a test that fails without the fix.
- No sleeps: use fake timers or wait for an event.
- Fixtures are recorded only in throwaway demo repositories and committed only after `pnpm fixtures:scrub`. No real
  names, home paths, host names or secrets in any committed file.

## Test IDs

Test IDs are stable: an ID is never renumbered or reused. For a new test, use the prefix of the tests around it and
the next free number.

The maintainer keeps a design specification outside this repository and records there what each test covers and
which requirement each constant serves. You do not need it to contribute. A few things read it and are skipped
without it: `pnpm test:trace`, the "constants owners" and "private references" steps of `pnpm verify`, and the few
tests that compare code with a table in the specification.

## Licence

By contributing, you agree that your contribution is released under the project's [MIT licence](LICENSE).
