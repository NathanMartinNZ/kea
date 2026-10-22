import { describe, expect, it } from 'vitest'
import { checkAgentStrings, contractStrings, isAgentScanned, SEED } from './agent-strings.ts'
import { type BoundaryContext, checkImports, importSpecifiers, packageInfo } from './boundaries.ts'
import { lexJs, lexRust, lexSvelte } from './lexer.ts'
import { checkOsNames, isOsScanned, MAC_MENU_ROLES, PLATFORM_SYMBOLS, SYSTEM_PATHS } from './os-names.ts'
import { checkTokens, checkValue, isTokenLinted } from './tokens.ts'

const pkg = (dir: string, name: string, deps: string[] = [], extra: Record<string, unknown> = {}) =>
  packageInfo(dir, { name, dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])), ...extra })

const ctx: BoundaryContext = {
  packages: [
    pkg('app/renderer', '@kea/renderer', ['@kea/protocol', '@kea/ui', 'svelte']),
    pkg('app/core', '@kea/core', ['@kea/protocol', '@kea/kit', 'better-sqlite3']),
    pkg('app/main', '@kea/main', ['@kea/kit', 'electron']),
    pkg('packages/ui', '@kea/ui', ['svelte', '@kea/protocol']),
    pkg('packages/kit', '@kea/kit', ['@kea/protocol']),
    pkg('packages/protocol', '@kea/protocol', [], { exports: { '.': './src/index.ts', './holder': './src/holder.ts' } }),
  ],
  rootDevDeps: new Set(['vitest', 'fast-check']),
}
const byDir = (dir: string) => ctx.packages.find((p) => p.dir === dir)!
const boundaries = (path: string, src: string) => checkImports(path, src, byDir(path.split('/').slice(0, 2).join('/')), ctx).map((v) => `${v.line}: ${v.message}`)

describe('boundaries', () => {
  it('U-LINT-1 · imports resolve to own files or declared dependencies only', () => {
    expect(
      boundaries(
        'app/core/src/sessions/store.ts',
        [
          "import Database from 'better-sqlite3'",
          "import { L } from '@kea/protocol'",
          "import type { Holder } from '@kea/protocol/holder'",
          "import { scope } from '../platform/scope.ts'",
          "import { readFile } from 'node:fs/promises'",
          "import { EventEmitter } from 'events'",
          "export * from './index.ts'",
          "const lazy = () => import('./lazy.ts')",
          "// import { nope } from 'not-installed'",
          "const msg = \"copied from 'not-a-module'\"",
        ].join('\n'),
      ),
    ).toEqual([])

    expect(
      boundaries(
        'app/core/src/x.ts',
        [
          "import { a } from 'zod'", // not a dependency of core
          "import { b } from '../../ptyhost/src/mirror.ts'", // another package by relative path
          "import { c } from '../../../tools/x.ts'", // leaves the package
          "import { d } from '@kea/protocol/src/generated/limits.ts'", // internals, not in exports
          "import { e } from '@kea/main'", // another process
          "const f = require('left-pad')",
        ].join('\n'),
      ),
    ).toEqual([
      '1: "zod" is not in app/core/package.json dependencies',
      "2: relative import leaves the package (../../ptyhost/src/mirror.ts → app/ptyhost/src/mirror.ts)",
      '3: relative import leaves the package (../../../tools/x.ts → tools/x.ts)',
      "4: deep import \"@kea/protocol/src/generated/limits.ts\" reaches into @kea/protocol's internals (not in its package.json \"exports\")",
      "5: one process imports another process's package (@kea/main)",
      '6: "left-pad" is not in app/core/package.json dependencies',
    ])
  })

  it('U-LINT-1 · renderer-side packages never import Node builtins or electron; packages never import app/*', () => {
    expect(boundaries('app/renderer/src/a.ts', "import { readFileSync } from 'node:fs'\nimport { ipcRenderer } from 'electron'\nimport path from 'path'")).toEqual([
      '1: Node builtin "node:fs" in app/renderer (renderer-side code has no Node)',
      '2: "electron" imported in app/renderer (renderer-side code never imports electron)',
      '3: Node builtin "path" in app/renderer (renderer-side code has no Node)',
    ])
    expect(boundaries('packages/ui/src/a.test.ts', "import { readFileSync } from 'node:fs'\nimport { it } from 'vitest'")).toEqual([])
    expect(boundaries('packages/ui/src/a.ts', "import { it } from 'vitest'")).toEqual([
      '1: "vitest" is not in packages/ui/package.json dependencies',
    ])
    expect(boundaries('packages/kit/src/a.ts', "import { x } from '@kea/core'\nimport { spawn } from 'node:child_process'")).toEqual([
      '1: shared package imports the app package @kea/core (packages/* never import app/*)',
    ])
    expect(boundaries('app/main/src/a.ts', "import { app } from 'electron'")).toEqual([])
    // a Svelte component: its <script> blocks are checked; markup text that looks like an import is not
    const svelte = [
      '<script module lang="ts">',
      "  import { mount } from 'svelte'",
      '</script>',
      '<script lang="ts">',
      "  import { readFileSync } from 'node:fs'",
      "  import Row from './Row.svelte'",
      '</script>',
      "<p>Paste from 'zod' {\"import x from 'left-pad'\"}</p>",
    ].join('\n')
    expect(boundaries('app/renderer/src/A.svelte', svelte)).toEqual(['5: Node builtin "node:fs" in app/renderer (renderer-side code has no Node)'])
    expect(importSpecifiers("import {\n  a,\n  b,\n} from './x.ts'\nimport './side.css'\nimport w from './w.ts?worker'").map((s) => s.specifier)).toEqual([
      './x.ts',
      './side.css',
      './w.ts?worker',
    ])
  })
})

describe('tokens', () => {
  const tokens = (path: string, src: string) => checkTokens(path, src).map((v) => `${v.line}: ${v.message}`)

  it('DS-2 · CSS uses tokens only: no raw colours, font-size ≤ 15px, allowed radii and spacings', () => {
    const css = [
      '.row { color: var(--text-2); background: var(--surface-2); padding: var(--space-1) var(--space-3); }', // ok
      '.a { color: #fff; }',
      '.b { background: rgba(0, 0, 0, .5); }',
      '.c { font-size: 16px; }',
      '.d { font-size: 15px; border-radius: var(--radius-md); gap: 8px; margin: 0 auto; }', // ok
      '.e { border-radius: 8px; }',
      '.f { padding: 10px 12px; }',
      '/* #abcdef in a comment, font-size: 40px */',
      '#fade:hover { outline: 1px solid var(--accent); margin-top: -1px; }', // id selector is not a colour; -1px ok
      '.g { font: 600 18px/22px var(--font-ui); }',
      '.h { border-radius: 50%; padding: calc(var(--space-2) + 1px); }', // ok
      '.i { margin: 3px; gap: var(--line); }',
      '.j { color: rgb(var(--accent-rgb) / 50%); }', // ok: built from a token
    ].join('\n')
    expect(tokens('app/renderer/src/a.css', css)).toEqual([
      '2: raw colour "#fff" — use a colour token, var(--…)',
      '3: raw colour "rgba(0, 0, 0, .5)" — use a colour token, var(--…)',
      '4: font-size 16px exceeds 15px, the largest type size',
      '6: border-radius "8px" — use var(--radius-sm|md|lg), 0 or 50%',
      '7: spacing "10px 12px" — use 0, 1px, 2px, 4/8/12/16/24/32px, var(--space-*) or var(--size-*)',
      '10: font-size 18px exceeds 15px, the largest type size',
      '12: spacing "3px" — use 0, 1px, 2px, 4/8/12/16/24/32px, var(--space-*) or var(--size-*)',
      '12: spacing "var(--line)" — use 0, 1px, 2px, 4/8/12/16/24/32px, var(--space-*) or var(--size-*)',
    ])
  })

  it('DS-2 · TS style objects and CSS in strings are checked; generated and test files are not', () => {
    const ts = [
      'export function row(el: HTMLElement) {',
      "  Object.assign(el.style, { fontSize: 13, padding: '4px 8px', borderRadius: 'var(--radius-sm)' })", // ok
      '}',
      "const bad = { fontSize: 16, padding: 10, borderRadius: 6, color: '#F5793A' }",
      'const css = `.x { font-size: 20px; }`',
      "const id = '#main' // not a colour",
      '// const old = "#ffffff"',
    ].join('\n')
    expect(tokens('packages/ui/src/row.ts', ts)).toEqual([
      '4: font-size 16px exceeds 15px, the largest type size',
      '4: spacing "10px" — use 0, 1px, 2px, 4/8/12/16/24/32px, var(--space-*) or var(--size-*)',
      '4: border-radius 6 — use var(--radius-sm|md|lg), 0 or 50%',
      '4: raw colour "#F5793A" — use a colour token, var(--…)',
      '5: font-size 20px exceeds 15px, the largest type size',
    ])
    expect(isTokenLinted('packages/ui/src/generated/tokens.css')).toBe(false)
    expect(isTokenLinted('packages/ui/src/tokens.test.ts')).toBe(false)
    expect(isTokenLinted('app/renderer/src/features/terminal/view.ts')).toBe(true)
    expect(isTokenLinted('app/renderer/src/shell/App.svelte')).toBe(true)
    expect(isTokenLinted('app/renderer/src/shell/layoutStore.svelte.ts')).toBe(true)
    expect(isTokenLinted('packages/ui/src/Menu.svelte')).toBe(true)
    expect(isTokenLinted('app/renderer/src/lib/reactive.svelte.test.ts')).toBe(false)
    expect(isTokenLinted('app/core/src/x.ts')).toBe(false)
    // main sets the window's colour before the renderer paints: that must be a token too
    expect(isTokenLinted('app/main/src/main.ts')).toBe(true)
    expect(checkTokens('app/main/src/main.ts', "new BrowserWindow({ backgroundColor: '#0C0D0B' })").map((v) => v.message)).toEqual([
      expect.stringContaining('raw colour "#0C0D0B"'),
    ])
    expect(checkValue('spacing', '-4px 0 var(--size-row)')).toEqual([])
    expect(checkValue('font-size', '1rem')).toHaveLength(1)
    // the Window Controls Overlay's rectangle is the system's geometry; a raw length beside it is not
    expect(checkValue('spacing', 'calc(env(titlebar-area-x, 0px) + var(--space-2))')).toEqual([])
    expect(checkValue('spacing', 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + var(--space-2))')).toEqual([])
    expect(checkValue('spacing', 'calc(env(titlebar-area-x, 0px) + 5px)')).toHaveLength(1)
    expect(checkValue('spacing', '100vw')).toHaveLength(1)
  })

  it('DS-2 · Svelte components: style blocks, style attributes and directives, script blocks and markup are checked', () => {
    const svelte = [
      '<script lang="ts">',
      "  const accent = '#F5793A'",
      '  let { x }: { x: number } = $props()',
      '</script>',
      '<!-- <div style="font-size: 30px"> in a comment -->',
      '<div class="row" style="padding: var(--space-2); font-size: 16px" style:left="{x}px" style:gap="10px"></div>',
      '<svg viewBox="0 0 16 16"><path fill="#fff" d="M0 0" /></svg>',
      '<p style="margin: {x}px; color: #000">{x > 1 ? \'#abc\' : \'\'} #fade text</p>',
      '<style>',
      '  .row { color: var(--text-2); border-radius: 8px; }',
      '  /* .old { color: #123456; } */',
      '</style>',
    ].join('\n')
    expect(tokens('app/renderer/src/shell/Row.svelte', svelte)).toEqual([
      '2: raw colour "#F5793A" — use a colour token, var(--…)',
      '6: font-size 16px exceeds 15px, the largest type size',
      '6: spacing "10px" — use 0, 1px, 2px, 4/8/12/16/24/32px, var(--space-*) or var(--size-*)',
      '7: raw colour "#fff" — use a colour token, var(--…)',
      '8: raw colour "#000" — use a colour token, var(--…)',
      '8: raw colour "#abc" — use a colour token, var(--…)',
      '10: border-radius "8px" — use var(--radius-sm|md|lg), 0 or 50%',
    ])
  })
})

describe('agent strings', () => {
  const scan = (path: string, src: string, list = SEED) => checkAgentStrings(path, src, list).map((v) => `${v.line}: ${v.message}`)

  it('U-AGT-11 · agent flags, env vars, payload fields and paths are refused outside packages/adapters', () => {
    const src = [
      "const argv = ['--resume', id]",
      "if (process.env.CLAUDE_CODE_ENTRYPOINT) {}",
      'const f = payload.tool_name',
      "const dir = join(home, '.claude/projects')",
      "const mode = '--mode' // a different flag",
      '// mentions --settings in a comment only',
      "const s = 'session_ids'",
      "const t = '--settings' // kea-lint-allow U-AGT-11: test of the allow marker",
    ].join('\n')
    expect(scan('app/core/src/agents/x.ts', src)).toEqual([
      '1: agent-specific "--resume" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
      '2: agent-specific "CLAUDE_CODE_ENTRYPOINT" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
      '3: agent-specific "tool_name" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
      '4: agent-specific ".claude/", "claude/projects" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
    ])
  })

  it('U-AGT-11 · Kea\'s own SQL columns, Rust test modules and non-scanned paths are allowed', () => {
    expect(scan('app/core/src/db/schema.ts', "const ddl = `CREATE TABLE ptys (\n  session_id TEXT NOT NULL\n)`\nconst q = 'SELECT session_id FROM ptys WHERE id = ?'")).toEqual([])
    expect(scan('app/core/src/db/schema.sql', 'CREATE TABLE x (transcript_path TEXT);')).toEqual([])
    expect(scan('app/core/src/db/rows.ts', 'const id = row.session_id')).toEqual(['1: agent-specific "session_id" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)'])
    const rust = 'pub fn hook() {\n    let s = "ok"; // not --resume\n}\n#[cfg(test)]\nmod tests {\n    const P: &str = "--permission-mode";\n}\n'
    expect(scan('native/kea-helper/src/hook.rs', rust)).toEqual([])
    expect(scan('native/kea-helper/src/hook.rs', 'const P: &str = "tool_input.command";')).toEqual([
      '1: agent-specific "tool_input" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
    ])
    expect(isAgentScanned('app/core/src/x.ts')).toBe(true)
    expect(isAgentScanned('app/core/src/x.test.ts')).toBe(false)
    expect(isAgentScanned('app/core/README.md')).toBe(false)
    expect(isAgentScanned('packages/adapters/src/claude/launch.ts')).toBe(false)
    expect(isAgentScanned('tools/fake-agent/src/main.ts')).toBe(false)
    expect(isAgentScanned('native/kea-helper/src/pty.rs')).toBe(true)
    expect(isAgentScanned('native/kea-helper/tests/hook.rs')).toBe(false)
    // a Svelte component: script, markup text and attributes are scanned; HTML, JS and CSS comments are not
    const svelte = [
      '<script lang="ts">',
      "  // the agent's --resume flag",
      "  const f = 'hook_event_name'",
      '</script>',
      '<!-- launched with --permission-mode -->',
      '<p title="--trust">Run with --effort</p>',
      '<style>/* .claude/ */</style>',
    ].join('\n')
    expect(scan('app/renderer/src/A.svelte', svelte)).toEqual([
      '3: agent-specific "hook_event_name" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
      '6: agent-specific "--trust", "--effort" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
    ])
  })

  it('U-AGT-11 · the list grows from the adapters\' contract.ts string literals', () => {
    const contract = [
      'export const contract = {',
      "  flags: ['--model', '--dangerously-skip-permissions', '--help', '--plugin-dir'],",
      "  env: ['DISABLE_AUTOUPDATER', 'TERM_PROGRAM', 'KEA_SESSION_ID'],",
      "  fields: ['stop_hook_active', 'cwd', 'default'],",
      "  paths: ['~/.claude/sessions', '.commandcode/settings.local.json', './relative'],",
      "  events: ['PermissionRequest', 'Stop'],",
      '}',
    ].join('\n')
    const list = contractStrings(contract, 'packages/adapters/src/claude/contract.ts')
    expect(list.map((a) => `${a.kind}:${a.text}`)).toEqual([
      'flag:--model',
      'flag:--dangerously-skip-permissions',
      'flag:--plugin-dir',
      'env:DISABLE_AUTOUPDATER',
      'field:stop_hook_active',
      'path:~/.claude/sessions',
      'path:.commandcode/settings.local.json',
    ])
    expect(scan('app/main/src/x.ts', "spawn(bin, ['--plugin-dir', dir])", [...SEED, ...list])).toEqual([
      '1: agent-specific "--plugin-dir" outside packages/adapters (move it there, or mark the line `// kea-lint-allow U-AGT-11: <reason>`)',
    ])
  })
})

describe('lexer', () => {
  it('U-LINT-2 · comments are blanked with offsets kept; strings, templates and regex literals are recognised', () => {
    const src = "const a = 'x // not a comment' // comment\nconst r = /['\"]/g; /* block\n */ const t = `a${b + '}'}c`"
    const { code, strings } = lexJs(src)
    expect(code.length).toBe(src.length)
    expect(code).not.toContain('comment\n')
    expect(code).toContain("'x // not a comment'")
    expect(code.split('\n')).toHaveLength(3)
    expect(strings.map((s) => s.value)).toEqual(['x // not a comment', 'a', '}', 'c'])
    const rust = lexRust("let s = \"// in string\"; // gone\nlet c = '\"'; let l: &'static str = r#\"raw \"// x\"#; /* a /* nested */ b */")
    expect(rust.code).toContain('"// in string"')
    expect(rust.code).not.toContain('gone')
    expect(rust.code).not.toContain('nested')
    expect(rust.strings.map((s) => s.value)).toEqual(['// in string', 'raw "// x'])
    // a Svelte component: projections keep offsets; block keywords leave the JS; attribute values keep their place
    const sv = "<script>\nconst a = 1 // c\n</script>\n{#if a > 0}<b title='t {a}' onclick={() => f('{')}>x</b>{/if}<style>\n.x { }</style>"
    const s = lexSvelte(sv)
    expect([s.code.length, s.scripts.length, s.js.code.length, s.css.code.length]).toEqual([sv.length, sv.length, sv.length, sv.length])
    expect(s.scripts.trim()).toBe('const a = 1 // c')
    expect(s.js.code.replace(/\s+/g, ' ').trim()).toBe("const a = 1 a > 0 a () => f('{')")
    expect(s.css.code.trim()).toBe('.x { }')
    expect(s.attrs.map((a) => [a.name, a.value, a.dynamic])).toEqual([['title', 't \0\0\0', true]])
    expect(s.code).not.toContain('// c')
  })
})

describe('os names', () => {
  const lines = (path: string, src: string) => checkOsNames(path, src).violations.map((v) => v.line)

  it('U-PLT-1 · each refused name is refused outside os/ folders and allowed inside; os-ok lines are let through and counted', () => {
    const js = [
      'const a = process.platform',
      "const b = os.platform() + os.type()",
      'const c = navigator.platform',
      "import { platform, type as osType } from 'node:os'",
      ...SYSTEM_PATHS.map((p) => `run('${p.startsWith('/') ? p : `/x/${p}`}tool')`),
    ]
    const src = js.join('\n')
    expect(lines('app/core/src/a.ts', src)).toEqual(js.map((_, i) => i + 1))
    expect(lines('tools/x/a.test.ts', src), 'tools/ and tests/ are under the rule').toHaveLength(js.length)
    for (const inside of ['app/core/src/os/darwin.ts', 'packages/kit/src/os/linux.test.ts', 'native/kea-helper/src/os/macos.rs']) expect(isOsScanned(inside), inside).toBe(false)
    for (const outside of ['app/core/src/a.ts', 'tests/chaos/a.test.ts', 'tools/pack/src/a.ts', 'native/kea-helper/src/holder.rs', 'app/renderer/src/A.svelte']) expect(isOsScanned(outside), outside).toBe(true)
    for (const exempt of ['fixtures/x/a.ts', 'tools/lint/src/os-names.ts', 'packages/protocol/src/generated/limits.ts', 'a.d.ts', 'README.md']) expect(isOsScanned(exempt), exempt).toBe(false)
    // allowed everywhere: every system has them there; comments document and are not scanned
    expect(lines('app/a.ts', "spawn('/bin/sh', ['-c', 'x'], { stdio: '/dev/null' }); spawn('/usr/bin/env', ['-0'])\n// reads /usr/bin/ps and process.platform")).toEqual([])
    expect(lines('app/a.ts', "spawn('/usr/bin/envoy')")).toEqual([1])
    // `os-ok: <reason>` on the line, or alone on the line above; a bare `os-ok` is not a reason
    const ok = checkOsNames('app/a.ts', "a('/usr/bin/xattr') // os-ok: macOS only\n// os-ok: test data\nb('/etc/hosts')\nc(process.platform) // os-ok:\nd('/sbin/mount') /* os-ok: why */")
    expect(ok.allowed).toBe(3)
    expect(ok.violations.map((v) => v.line)).toEqual([4])
  })

  it('U-PLT-1 · a system path right after a string escape (`\\t`, `\\n`) is still a system path; a word or a path before it is not', () => {
    expect(lines('native/kea-helper/src/a.rs', 'let s = "7\\t/Applications/X.app";')).toEqual([1])
    expect(lines('app/core/src/a.ts', "const s = 'a\\n/usr/bin/x'")).toEqual([1])
    expect(lines('app/core/src/a.ts', "const s = 'my/usr/bin/x' + 'a-/etc/x' + 'v1./sys/x'")).toEqual([])
  })

  it('U-PLT-1 · Electron APIs one system has are refused in files that import electron', () => {
    const src = [
      "import { app, Notification, systemPreferences } from 'electron'",
      'app.dock?.hide()',
      'app.hide()',
      "app.on('did-become-active', f)",
      'systemPreferences.getUserDefault("x", "string")',
      'tray.setTitle("3")',
      'new BrowserWindow({ trafficLightPosition: p })',
      "new BrowserWindow({ titleBarStyle: 'hiddenInset' })",
      "new BrowserWindow({ vibrancy: 'sidebar' })",
      ...MAC_MENU_ROLES.map((r) => `({ role: '${r}' })`),
      'new Notification({ title, subtitle: s })',
    ]
    // naming `systemPreferences` in the import is a use already
    expect(lines('app/main/src/a.ts', src.join('\n'))).toEqual(src.map((_, i) => i + 1))
    expect(lines('app/main/src/a.ts', src.slice(1).join('\n')), 'no electron import: not an Electron object').toEqual([])
    expect(lines('app/main/src/a.ts', "import { app } from 'electron'\n({ role: 'quit' }); ({ role: 'minimize' }); app.quit()")).toEqual([])
  })

  it('U-PLT-1 · Rust: target_os and the platform-only libc symbols are refused; a message that names one is not, a C string for dlsym is', () => {
    const rs = [
      '#[cfg(target_os = "macos")]',
      'let s = std::env::consts::OS;',
      ...PLATFORM_SYMBOLS.map((s) => `let _ = libc::${s.replace('*', 'X')};`),
      'let p = libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_spawnattrs_setdisclaim".as_ptr());',
      'Command::new("/usr/bin/codesign");',
    ]
    expect(lines('native/kea-helper/src/a.rs', rs.join('\n'))).toEqual(rs.map((_, i) => i + 1))
    expect(lines('native/kea-helper/src/a.rs', 'panic!("mono is CLOCK_UPTIME_RAW ns, see proc_pidinfo");\n// SO_NOSIGPIPE in a comment')).toEqual([])
    const ok = checkOsNames('native/kea-helper/tests/a.rs', 'let x = libc::proc_pid_rusage(p); // os-ok: CPU time, macOS only')
    expect([ok.violations.length, ok.allowed]).toEqual([0, 1])
  })
})
