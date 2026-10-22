import { describe, expect, it } from 'vitest'
import { LANGUAGE_NAMES, languageIds, languageOf, shebangInterpreter } from './language.ts'
import { GRAMMARS } from './worker/grammars.ts'

describe('language detection', () => {
  it('U-FV-3 · a file is named by its file name, then its extension, then its shebang; anything else is plain text; every language named has a grammar', () => {
    const id = (path: string, first?: string) => languageOf(path, first)?.id ?? null
    // extensions, whatever the case and the folders
    expect(languageOf('src/auth/login.ts')).toEqual({ id: 'typescript', name: 'TypeScript' })
    expect(id('a/b/App.TSX')).toBe('tsx')
    expect(id('x.d.ts')).toBe('typescript')
    expect(id('index.mjs')).toBe('javascript')
    expect(id('main.rs')).toBe('rust')
    expect(id('main.go')).toBe('go')
    expect(id('script.py')).toBe('python')
    expect(id('style.module.css')).toBe('css')
    expect(id('README.md')).toBe('markdown')
    expect(id('pnpm-lock.yaml')).toBe('yaml')
    expect(id('limits.toml')).toBe('toml')
    expect(id('Component.svelte')).toBe('svelte')
    expect(id('schema.graphql')).toBe('graphql')
    expect(id('header.h')).toBe('c')
    expect(id('view.mm')).toBe('objective-cpp')
    expect(id('fix.patch')).toBe('diff')
    expect(id('logo.svg')).toBe('xml')
    // special file names
    expect(languageOf('Dockerfile')).toEqual({ id: 'docker', name: 'Dockerfile' })
    expect(id('docker/Dockerfile.dev')).toBe('docker')
    expect(id('Makefile')).toBe('make')
    expect(id('GNUmakefile')).toBe('make')
    expect(id('CMakeLists.txt')).toBe('cmake')
    expect(id('Gemfile')).toBe('ruby')
    expect(id('Jenkinsfile')).toBe('groovy')
    expect(id('.github/CODEOWNERS')).toBe('codeowners')
    expect(id('tsconfig.json')).toBe('jsonc')
    expect(id('package.json')).toBe('json')
    expect(id('Cargo.lock')).toBe('toml')
    // dotfiles
    expect(id('.zshrc')).toBe('shellscript')
    expect(id('home/.bash_profile')).toBe('shellscript')
    expect(id('.gitconfig')).toBe('ini')
    expect(id('.editorconfig')).toBe('ini')
    expect(id('.env')).toBe('dotenv')
    expect(id('.env.local')).toBe('dotenv')
    expect(id('.prettierrc')).toBe('json')
    expect(id('.eslintrc.json')).toBe('json')
    // a dotfile's leading dot is not an extension
    expect(id('.ts')).toBeNull()
    expect(id('.gitignore')).toBeNull()
    // shebangs, only when the name says nothing
    expect(id('bin/run', '#!/bin/sh')).toBe('shellscript')
    expect(id('bin/run', '#!/usr/bin/env bash')).toBe('shellscript')
    expect(id('bin/run', '#!/usr/bin/env -S node --no-warnings')).toBe('javascript')
    expect(id('bin/run', '#!/usr/bin/env FOO=1 python3')).toBe('python')
    expect(id('bin/run', '#! /usr/bin/python3.12 -u')).toBe('python') // os-ok: test data
    expect(id('tool', '#!/usr/bin/env deno run')).toBe('typescript')
    expect(id('tool', '#!/usr/local/bin/ruby2.7')).toBe('ruby')
    expect(id('tool', '#!/usr/bin/perl -w')).toBe('perl') // os-ok: test data
    expect(id('tool.py', '#!/bin/sh')).toBe('python')
    expect(shebangInterpreter('#!/usr/bin/env')).toBeNull()
    expect(shebangInterpreter('no shebang')).toBeNull()
    expect(shebangInterpreter('#!')).toBeNull()
    // unknown → plain text
    for (const p of ['LICENSE', 'notes.txt', 'data.bin', 'archive.tar.gz', 'weird.xyz', 'noext', 'a.', 'constructor', 'toString', '__proto__']) expect(id(p), p).toBeNull()
    expect(id('run', 'plain first line')).toBeNull()
    expect(id('run', '#!/usr/bin/unknown-interpreter')).toBeNull() // os-ok: test data

    // every id the table answers has a display name and a grammar in the worker, and the worker bundles no grammar the
    // table cannot name
    for (const lang of languageIds()) {
      expect(Object.hasOwn(LANGUAGE_NAMES, lang), `${lang} has a name`).toBe(true)
      expect(Object.hasOwn(GRAMMARS, lang), `${lang} has a grammar`).toBe(true)
    }
    expect(Object.keys(GRAMMARS).sort()).toEqual(Object.keys(LANGUAGE_NAMES).sort())
    expect(new Set(languageIds())).toEqual(new Set(Object.keys(GRAMMARS)))
  })
})
