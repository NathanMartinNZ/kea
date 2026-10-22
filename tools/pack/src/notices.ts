// The notices the licences file carries besides the bundled packages' own licence files: Kea's licence first, then
// Electron's, then the licences inside the file viewer's syntax highlighter that its packages do not quote. Shiki's
// packages quote only Shiki's MIT licence, but @shikijs/engine-oniguruma inlines vscode-oniguruma's WebAssembly build
// of Oniguruma, and @shikijs/langs bundles TextMate grammars from tm-grammars, each under its grammar's own licence.
// The texts and the grammar table are pinned to the versions named below, and a unit test fails when Shiki moves past
// them (U-PACK-46).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Notice } from './licences.ts'

/** The versions this file's notices are taken from. */
export const PINNED = {
  /** @shikijs/engine-oniguruma's devDependency, whose `onig.wasm` it inlines. */
  vscodeOniguruma: '1.7.0',
  /** @shikijs/langs, which bundles the grammars. */
  langs: '4.5.0',
  /** The tm-grammars release @shikijs/langs 4.5.0 is built from (Shiki's lockfile at its v4.5.0 tag). */
  tmGrammars: '1.32.22',
} as const

/** Oniguruma's COPYING at the commit vscode-oniguruma 1.7.0 builds (kkos/oniguruma 08d36110, "setup 6.9.8"). */
const ONIGURUMA_COPYING = `Oniguruma LICENSE
-----------------

Copyright (c) 2002-2021  K.Kosako  <kkosako0@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS \`\`AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.`

/** vscode-oniguruma 1.7.0's LICENSE.txt. */
const VSCODE_ONIGURUMA_LICENSE = `VS Code Oniguruma Bindings

MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

export const ONIGURUMA: readonly Notice[] = [
  { title: `Oniguruma (the syntax highlighter's regular expressions, in vscode-oniguruma ${PINNED.vscodeOniguruma}'s WebAssembly build) — BSD-2-Clause`, text: ONIGURUMA_COPYING },
  { title: `vscode-oniguruma ${PINNED.vscodeOniguruma} (the WebAssembly build of Oniguruma that @shikijs/engine-oniguruma inlines) — MIT`, text: VSCODE_ONIGURUMA_LICENSE },
]

/**
 * Every grammar the file viewer can load, and every grammar those embed, by licence as tm-grammars' metadata states
 * it. "not stated": the metadata gives the grammar no licence, or only NOASSERTION.
 */
const GRAMMARS_BY_LICENCE: readonly (readonly [licence: string, grammars: readonly string[]])[] = [
  [
    'MIT',
    [
      'asm', 'astro', 'bat', 'bibtex', 'c', 'clojure', 'cmake', 'codeowners', 'cpp', 'cpp-macro', 'csharp', 'css', 'csv', 'dart', 'diff', 'docker',
      'dotenv', 'fish', 'fsharp', 'git-commit', 'git-rebase', 'go', 'graphql', 'groovy', 'haml', 'handlebars', 'html', 'html-derivative', 'http',
      'ini', 'java', 'javascript', 'jinja', 'jinja-html', 'json', 'json5', 'jsonc', 'jsonl', 'jsx', 'julia', 'kotlin', 'latex', 'less', 'liquid',
      'log', 'lua', 'make', 'markdown', 'markdown-nix', 'markdown-vue', 'mdx', 'nix', 'objective-c', 'objective-cpp', 'perl', 'php', 'postcss',
      'powershell', 'proto', 'pug', 'python', 'r', 'regexp', 'ruby', 'rust', 'scala', 'scss', 'shellscript', 'solidity', 'sql', 'svelte', 'swift',
      'systemd', 'tex', 'tsv', 'tsx', 'typescript', 'viml', 'vue', 'vue-directives', 'vue-interpolations', 'vue-sfc-style-variable-injection',
      'wasm', 'wgsl', 'xml', 'zig',
    ],
  ],
  ['Apache-2.0', ['erlang', 'ocaml', 'prisma']],
  ['BSD-3-Clause', ['haskell']],
  ['GPL-3.0', ['nginx']],
  ['MPL-2.0', ['hcl', 'terraform']],
  ['not stated', ['applescript', 'elixir', 'glsl', 'sass', 'ssh-config', 'toml', 'yaml']],
]

/** Every grammar this file has a licence for. */
export const KNOWN_GRAMMARS: readonly string[] = GRAMMARS_BY_LICENCE.flatMap(([, g]) => g).sort()

const LANGS_MODULE = /(?:^|[\\/])node_modules[\\/]@shikijs[\\/]langs[\\/]dist[\\/]([^\\/]+)\.mjs$/

/**
 * The grammars a build holds, from the paths of the modules it is made of (as its source maps list them: Vite writes a
 * worker's relative to the renderer's root, not to the map). Throws when there is none.
 */
export function shippedGrammars(modules: Iterable<string>): string[] {
  const names = new Set<string>()
  for (const m of modules) {
    const r = LANGS_MODULE.exec(m)
    if (r) names.add(r[1] as string)
  }
  if (!names.size) throw new Error("the build holds no grammar of @shikijs/langs (are the renderer's source maps there?)")
  return [...names].sort()
}

/** The installed Shiki that the notices depend on, resolved as the renderer resolves it. */
export function installedShiki(root: string): { langsDir: string; langs: string; vscodeOniguruma: string | null } {
  const shiki = createRequire(path.join(root, 'app/renderer/package.json')).resolve('shiki')
  const dir = (name: string) => path.dirname(path.dirname(createRequire(shiki).resolve(name)))
  const manifest = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) as { version: string; devDependencies?: Record<string, string> }
  const langsDir = dir('@shikijs/langs')
  return { langsDir, langs: manifest(langsDir).version, vscodeOniguruma: manifest(dir('@shikijs/engine-oniguruma')).devDependencies?.['vscode-oniguruma'] ?? null }
}

/** `words` joined by ", " in lines of at most `width` characters, after `lead` on the first line. */
function wrapList(lead: string, words: readonly string[], width = 78): string {
  const lines = [lead]
  for (const [i, w] of words.entries()) {
    const word = i < words.length - 1 ? `${w},` : w
    const last = lines.length - 1
    if (`${lines[last]} ${word}`.length > width) lines.push(`  ${word}`)
    else lines[last] = `${lines[last]} ${word}`
  }
  return lines.join('\n')
}

/**
 * The grammars' notice: each grammar that ships under its licence, and where their licence texts are. Throws for a
 * @shikijs/langs of another version than the table's, or for a grammar the table does not have.
 */
export function grammarNotice(o: { version: string; names: readonly string[] }): Notice {
  if (o.version !== PINNED.langs) throw new Error(`@shikijs/langs is ${o.version}, but tools/pack/src/notices.ts has the grammars' licences of ${PINNED.langs}: update them from the tm-grammars release it is built from`)
  const unknown = o.names.filter((n) => !KNOWN_GRAMMARS.includes(n))
  if (unknown.length) throw new Error(`no licence for the grammar(s) ${unknown.join(', ')} in tools/pack/src/notices.ts: add them from tm-grammars ${PINNED.tmGrammars}'s metadata`)
  const groups = GRAMMARS_BY_LICENCE.map(([licence, grammars]) => [licence, grammars.filter((g) => o.names.includes(g))] as const).filter(([, g]) => g.length)
  const tm = `https://cdn.jsdelivr.net/npm/tm-grammars@${PINNED.tmGrammars}`
  return {
    title: `TextMate grammars (the file viewer's syntax highlighting, tm-grammars ${PINNED.tmGrammars} through @shikijs/langs ${PINNED.langs}) — each grammar's own licence`,
    text: [
      "Each grammar keeps its own licence. tm-grammars' NOTICE quotes each one in",
      "full, with its copyright notice; its README names each grammar's source.",
      `  ${tm}/NOTICE`,
      `  ${tm}/README.md`,
      '',
      ...groups.map(([licence, grammars]) => wrapList(`${licence}:`, grammars)),
    ].join('\n'),
  }
}

/**
 * Every notice of the licences file, in its order: Kea's, Electron's, the highlighter's, then `more` (a font's).
 * Throws when the installed Shiki is not the one the highlighter's notices are pinned to.
 */
export function releaseNotices(o: { licence: string; electron: Notice; shiki: { langs: string; vscodeOniguruma: string | null }; grammars: readonly string[]; more: readonly Notice[] }): Notice[] {
  if (o.shiki.vscodeOniguruma !== PINNED.vscodeOniguruma) throw new Error(`@shikijs/engine-oniguruma inlines vscode-oniguruma ${o.shiki.vscodeOniguruma ?? '(unknown)'}, but tools/pack/src/notices.ts quotes ${PINNED.vscodeOniguruma}'s licences: update them`)
  return [{ title: 'Kea — MIT', text: o.licence }, o.electron, ...ONIGURUMA, grammarNotice({ version: o.shiki.langs, names: o.grammars }), ...o.more]
}
