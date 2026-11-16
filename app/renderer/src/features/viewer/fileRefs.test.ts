// File references in the viewer's text, per language: the specifier under the pointer and what core is asked about,
// what is not a reference, a position named by `#L10` or `:line`, and a slice that cuts one.

import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { refAt, refsAround, refsIn, targetText, type FoundRef, type RefScope } from './fileRefs.ts'

const whole = (text: string) => ({ text, cutStart: false, cutEnd: false })
/** The reference under the first character of `needle` (plus `i`) in `line`: its family, what core is asked, its underlined text and position. */
function at(line: string, needle: string, scope: RefScope, i = 0): Pick<FoundRef, 'family' | 'spec' | 'text' | 'line' | 'col'> | null {
  const offset = line.indexOf(needle)
  if (offset < 0) throw new Error(`${needle} is not in ${line}`)
  const r = refAt(whole(line), offset + i, scope)
  return r ? { family: r.family, spec: r.spec, text: r.text, ...(r.line !== undefined ? { line: r.line } : {}), ...(r.col !== undefined ? { col: r.col } : {}) } : null
}
const ts: RefScope = { lang: 'typescript', path: 'src/app.ts' }
const list = (line: string, scope: RefScope) => refsIn(whole(line), scope).map((r) => [r.family, r.spec])

describe('file references in the viewer’s text', () => {
  it('U-FV-39 · imports: the string of every import form, a wrapped list’s last line, import type, export * as, import(), require() and a triple-slash reference; nothing outside the string', () => {
    expect(at("import { a } from './util'", 'util', ts)).toEqual({ family: 'import', spec: './util', text: './util' })
    expect(at("import type { T } from '../types/index.js'", 'types', ts)).toEqual({ family: 'import', spec: '../types/index.js', text: '../types/index.js' })
    expect(at("export * as x from './x'", './x', ts)?.spec).toBe('./x')
    expect(at("export { a, b } from '$lib/user'", 'lib', ts)?.spec).toBe('$lib/user')
    expect(at("} from './util'", './util', ts)?.spec).toBe('./util')
    expect(at("import './side.css'", 'side', ts)?.spec).toBe('./side.css')
    expect(at("const m = await import('./lazy')", 'lazy', ts)?.spec).toBe('./lazy')
    expect(at('const c = require("./cjs")', 'cjs', { lang: 'javascript', path: 'a.js' })?.spec).toBe('./cjs')
    expect(at('/// <reference path="global.d.ts" />', 'global', ts)).toEqual({ family: 'import', spec: './global.d.ts', text: 'global.d.ts' })
    // a bare package is asked about too: whether it is an alias is core's to say
    expect(at("import React from 'react'", 'react', ts)?.spec).toBe('react')
    // nothing outside the string: the keyword, the quote, the space
    const line = "import { a } from './util'"
    expect(refAt(whole(line), 0, ts)).toBeNull()
    expect(refAt(whole(line), line.indexOf("'"), ts)).toBeNull()
    expect(refAt(whole(line), line.indexOf('from') - 1, ts)).toBeNull()
    // a template literal with an expression is no import
    expect(at('import(`./pages/${name}`)', 'pages', ts)?.family).not.toBe('import')
  })

  it('U-FV-39 · stylesheets: @import, @use, @forward and url(), Sass and Less alike; ~pkg, a scheme and an anchor are none', () => {
    const css: RefScope = { lang: 'scss', path: 'src/app.scss' }
    expect(at("@use '../tokens' as t;", 'tokens', css)).toEqual({ family: 'style', spec: '../tokens', text: '../tokens' })
    expect(list("@import 'base', \"theme\";", css)).toEqual([
      ['style', 'base'],
      ['style', 'theme'],
    ])
    expect(at("@forward 'src/list';", 'src', css)?.spec).toBe('src/list')
    expect(at('  background: url(./img/a.png) no-repeat;', 'img', { lang: 'css', path: 'a.css' })?.spec).toBe('./img/a.png')
    expect(at('  mask: url("icons/x.svg");', 'icons', { lang: 'less', path: 'a.less' })?.spec).toBe('icons/x.svg')
    expect(at("@import url('print.css') print;", 'print', { lang: 'css', path: 'a.css' })?.spec).toBe('print.css')
    expect(list("@import '~bootstrap/scss/x';", css)).toEqual([])
    expect(list("@use 'sass:math';", css)).toEqual([])
    expect(list('fill: url(#gradient);', css)).toEqual([])
  })

  it('U-FV-39 · markup: src= and href= in either quote, #L10 as a line, a query dropped; an address, an anchor or an expression is none; Svelte, Vue and Astro lines of both kinds', () => {
    const html: RefScope = { lang: 'html', path: 'site/index.html' }
    expect(at('<img src="./logo.png" alt="">', 'logo', html)).toEqual({ family: 'markup', spec: './logo.png', text: './logo.png' })
    expect(at("<a href='/docs/a.html?v=2#L10'>", 'docs', html)).toEqual({ family: 'markup', spec: '/docs/a.html', text: '/docs/a.html?v=2#L10', line: 10 })
    expect(at('<a href="b.html#intro">', 'b.html', html)?.spec).toBe('b.html')
    expect(list('<a href="https://x.dev/a">', html)).toEqual([])
    expect(list('<a href="#top">top</a>', html)).toEqual([])
    expect(list('<a href="mailto:me@x.dev">', html)).toEqual([])
    for (const lang of ['svelte', 'vue', 'astro']) {
      const scope = { lang, path: `src/C.${lang}` }
      expect(at("  import Button from './Button.svelte'", 'Button.', scope)?.spec, lang).toBe('./Button.svelte')
      expect(at('<img src="./a.png" />', 'a.png', scope)?.spec, lang).toBe('./a.png')
    }
    // an expression (Svelte's braces, Vue's bound attribute) is no path
    expect(list('<img src={logo} />', { lang: 'svelte', path: 'C.svelte' })).toEqual([])
    expect(list('<img :src="logo" />', { lang: 'vue', path: 'C.vue' })).toEqual([])
  })

  it('U-FV-39 · Markdown: links, images, a definition and raw HTML as the preview resolves them, #L10 and #L10-L20 as a line; [t][id] and an address are not followed; a bare notes.md is a path', () => {
    const md: RefScope = { lang: 'markdown', path: 'docs/README.md' }
    expect(at('see [the notes](./notes.md) here', './notes', md)).toEqual({ family: 'markdown', spec: 'docs/notes.md', text: './notes.md' })
    expect(at('![logo](../img/logo.png "Logo")', 'img', md)?.spec).toBe('img/logo.png')
    expect(at('[ref]: ../src/a.ts', 'src', md)?.spec).toBe('src/a.ts')
    expect(at('[ref]: <../src/b c.ts>', 'src', md)?.spec).toBe('src/b c.ts')
    expect(at('[t](./a.md#L10)', 'a.md', md)).toEqual({ family: 'markdown', spec: 'docs/a.md', text: './a.md#L10', line: 10 })
    expect(at('[t](./a.md#L10-L20)', 'a.md', md)?.line).toBe(10)
    expect(at('[t](./a.md#usage)', 'a.md', md)).toEqual({ family: 'markdown', spec: 'docs/a.md', text: './a.md#usage' })
    expect(at('<a href="guide.md">guide</a>', 'guide', md)?.spec).toBe('docs/guide.md')
    expect(at('/root.md is [x](/root.md)', '(/root', md, 1)?.spec).toBe('root.md')
    expect(list('[t][id] and [docs](https://x.dev/a)', md)).toEqual([])
    expect(list('[up](../../../out.md)', md)).toEqual([])
    expect(at('read notes.md first', 'notes', md)).toEqual({ family: 'path', spec: 'notes.md', text: 'notes.md' })
    // a definition only at a line's start, which a slice cut there does not hold
    expect(refsIn({ text: '[ref]: ../src/a.ts', cutStart: true, cutEnd: false }, md).map((r) => r.family)).toEqual(['path'])
  })

  it('U-FV-39 · JSON: a string starting ./ or ../; in tsconfig*.json and jsconfig*.json, recognised by name, extends (a string or a list) and references’ paths', () => {
    expect(at('  "main": "./dist/index.js",', 'dist', { lang: 'json', path: 'package.json' })).toEqual({ family: 'json', spec: './dist/index.js', text: './dist/index.js' })
    expect(list('  "name": "kea", "x": "src/a.ts"', { lang: 'json', path: 'package.json' })).toEqual([['path', 'src/a.ts']])
    // Vite's tsconfig.app.json is `json` by its extension and a config by its name
    const app: RefScope = { lang: 'json', path: 'tsconfig.app.json' }
    expect(at('  "extends": "@tsconfig/node20",', 'tsconfig/', app)).toEqual({ family: 'extends', spec: '@tsconfig/node20', text: '@tsconfig/node20' })
    expect(list('  "extends": ["./tsconfig.base.json", "@vue/tsconfig"],', app)).toEqual([
      ['extends', './tsconfig.base.json'],
      ['extends', '@vue/tsconfig'],
    ])
    expect(at('    { "path": "./tsconfig.node.json" }', 'tsconfig.node', { lang: 'jsonc', path: 'tsconfig.json' })?.family).toBe('reference')
    expect(at('  "extends": "./base",', 'base', { lang: 'jsonc', path: 'jsconfig.json' })?.family).toBe('extends')
    // in any other JSON file, "extends" is a key like any other (its value is a path like any other string)
    expect(list('  "extends": "@tsconfig/node20",', { lang: 'json', path: 'data.json' }).map((r) => r[0])).not.toContain('extends')
    expect(at("  'a': '../b.json5',", 'b.json5', { lang: 'json5', path: 'c.json5' })?.spec).toBe('../b.json5')
  })

  it('U-FV-39 · Python, Rust, C and Ruby: a line’s import or from module, mod name;, #include "…" or #import "…" and require_relative; <…>, an inline mod, a comment, an interpolation and a cut statement are none', () => {
    const py: RefScope = { lang: 'python', path: 'app/views.py' }
    expect(at('from .models import User', 'models', py)).toEqual({ family: 'python', spec: '.models', text: '.models' })
    expect(at('    from ..core.db import (', 'core', py)?.spec).toBe('..core.db')
    expect(at('from . import utils', '.', py)?.spec).toBe('.')
    expect(list('import os.path as p, app.models, sys  # stdlib', py)).toEqual([
      ['python', 'os.path'],
      ['python', 'app.models'],
      ['python', 'sys'],
    ])
    expect(list('import a; import b', py), 'only the statement at the line’s start').toEqual([['python', 'a']])
    expect(list('# from app import models', py)).toEqual([])
    expect(list('x = "from app import models"', py)).toEqual([])
    const rs: RefScope = { lang: 'rust', path: 'src/lib.rs' }
    expect(at('pub(crate) mod parser;', 'parser', rs)).toEqual({ family: 'rust', spec: 'parser', text: 'parser' })
    expect(at('#[cfg(test)] mod tests;', 'tests', rs)?.spec).toBe('tests')
    expect(at('mod r#type;', 'type', rs)?.spec).toBe('type')
    expect(list('mod inline { fn f() {} }', rs)).toEqual([])
    const c: RefScope = { lang: 'cpp', path: 'src/main.cpp' }
    expect(at('#include "util/strings.h"', 'util', c)).toEqual({ family: 'include', spec: 'util/strings.h', text: 'util/strings.h' })
    expect(at('#  include "a.h" // why', 'a.h', { lang: 'c', path: 'a.c' })?.spec).toBe('a.h')
    expect(at('#import "AppDelegate.h"', 'App', { lang: 'objective-c', path: 'main.m' })?.spec).toBe('AppDelegate.h')
    expect(list('#include <vector>', c)).toEqual([])
    const rb: RefScope = { lang: 'ruby', path: 'lib/app.rb' }
    expect(at("require_relative '../config/boot'", 'config', rb)).toEqual({ family: 'ruby', spec: '../config/boot', text: '../config/boot' })
    expect(at('require_relative("helpers")', 'helpers', rb)?.spec).toBe('helpers')
    expect(list('require_relative "#{dir}/x"', rb).filter(([f]) => f === 'ruby')).toEqual([])
    // a statement at the line's start is not known in a slice cut there
    expect(refsIn({ text: 'mod parser;', cutStart: true, cutEnd: false }, rs)).toEqual([])
    // none in another language
    expect(list('#include "a.h"', ts)).toEqual([])
  })

  it('U-FV-39 · paths: in code a path needs a folder or a position, never name(line,col): console.log, this.doc and foo.bar(1, 2) are none, README.md:3 in a comment is one; in prose a bare name.ext is one', () => {
    expect(list('console.log(this.doc, foo.bar(1, 2))', ts)).toEqual([])
    expect(at('// see README.md:3 for more', 'README', ts)).toEqual({ family: 'path', spec: 'README.md', text: 'README.md:3', line: 3 })
    expect(at('# from src/lib/user.ts:40:2', 'src', { lang: 'python', path: 'a.py' })).toEqual({ family: 'path', spec: 'src/lib/user.ts', text: 'src/lib/user.ts:40:2', line: 40, col: 2 })
    expect(at("open('./data/x.csv')", 'data', { lang: 'python', path: 'a.py' })?.spec).toBe('./data/x.csv')
    expect(at('// file:///w/a.ts', 'file', ts)?.spec).toBe('file:///w/a.ts')
    // an address is the URL finder's, not a path
    expect(list('// https://x.dev/src/a.ts:3', ts)).toEqual([])
    // prose: Markdown and plain text
    expect(list('see notes.md and foo.bar(1, 2)', { lang: null, path: 'NOTES' })).toEqual([
      ['path', 'notes.md'],
      ['path', 'foo.bar'],
    ])
  })

  it('U-FV-39 · a slice that cuts a reference at either end gives none; the question takes the one under the pointer first, then its nearest, at most L.viewerLinkRefsMax', () => {
    expect(refsIn({ text: "x from './very/long/pa", cutStart: false, cutEnd: true }, ts)).toEqual([])
    expect(refsIn({ text: 'rc/a.ts:3 and more', cutStart: true, cutEnd: false }, ts)).toEqual([])
    expect(refsIn({ text: 'x src/a.ts:3 and more', cutStart: true, cutEnd: true }, ts).map((r) => r.spec)).toEqual(['src/a.ts'])
    const many = Array.from({ length: L.viewerLinkRefsMax + 4 }, (_, i) => `src/f${i}.ts`).join(' ')
    const refs = refsIn(whole(many), ts)
    expect(refs).toHaveLength(L.viewerLinkRefsMax + 4)
    const hit = refs[6] as FoundRef
    const asked = refsAround(refs, hit)
    expect(asked).toHaveLength(L.viewerLinkRefsMax)
    expect(asked[0]).toBe(hit)
    expect(asked.slice(1, 3).map((r) => r.spec)).toEqual(['src/f5.ts', 'src/f7.ts'])
    expect(targetText({ path: 'src/a.ts' })).toBe('src/a.ts')
    expect(targetText({ path: 'src/a.ts', line: 40 })).toBe('src/a.ts:40')
    expect(targetText({ path: 'src/a.ts', line: 40, col: 2 })).toBe('src/a.ts:40:2')
  })
})
