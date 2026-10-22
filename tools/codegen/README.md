# tools/codegen

`pnpm codegen` turns `constants/` into code, so every number Kea uses is written once. It reads the three source
files and writes:

| Source | Generates |
|---|---|
| `constants/limits.toml` | `packages/protocol/src/generated/limits.ts` (`L`, `LIMIT_META`), `native/kea-helper/src/limits.rs` |
| `constants/budgets.toml` | `tools/perf/src/generated/budgets.ts` (keyed by budget ID; a `*_limit` field resolves to that limit's macOS value) |
| `constants/tokens.json` | `packages/ui/src/generated/tokens.css`, `packages/ui/src/generated/tokens.ts` (plain values for code that cannot use CSS), `packages/ui/src/generated/syntax-theme.json`, `packages/terminal/src/generated/themes.ts` (every bundled terminal theme's colours), `packages/protocol/src/generated/themes.ts` (`BUNDLED_THEMES`: each theme's id, name and scheme, from its `$extensions.kea`, which the `terminal.theme` setting offers) |

Never edit a generated file: change the source and run `pnpm codegen`. `pnpm codegen:check` (part of `pnpm verify`)
exits 1 when a generated file is stale.

## Limits entries

Every entry in `limits.toml` carries `value`, `unit` and `why`: what the number is for, in a few words.

An entry may add `linux = <n>` and/or `darwin = <n>`, with a `why_linux` saying why the value differs. Codegen then
emits one value per system: `limits.ts` chooses through protocol's OS layer (`protocolOs.system`, imported only when
some entry has an override), `limits.rs` through `os::IS_LINUX`. Any other field in an entry is refused.

## Code

`codegen.ts` (the parsers and generators, pure) · `main.ts` (the CLI, `--check`) · `paths.ts` (finds the repository
root). Tests: `codegen.test.ts`.
