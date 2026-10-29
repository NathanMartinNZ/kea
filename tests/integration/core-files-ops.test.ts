// The file tree's operations in core (app/core/src/files/ops.ts, through `SessionFiles`): New File and New Folder,
// Rename, Move to Trash, a move or a copy in the tree, Undo, and files dropped from another app. Real git in temp
// repositories. The Trash is a folder of the test's own: the `trash` tool core is given is a script that moves its
// arguments there, so nothing here reaches the system's Trash. Harness: core-files-support.ts.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { filesApi, gitStoreName, L, type DiscardResult, type FileOpResult } from '@kea/protocol'
import { chooseFs } from '@kea/core/src/files/fsImpl.ts'
import { holdsSubmodule } from '@kea/core/src/files/ops.ts'
import { until } from '../support/holders.ts'
import { cleanup, gitEnv, gitIn, repo, startFiles, tempDir, write, type FilesUnderTest } from './core-files-support.ts'

let t: FilesUnderTest | null = null
// folders a test made read-only, made writable again so the clean-up can remove them
const readOnly: string[] = []
afterEach(async () => {
  for (const d of readOnly.splice(0)) fs.chmodSync(d, 0o755)
  await t?.dispose()
  t = null
  cleanup()
})

/**
 * A stand-in for the system's trash tool: moves the files it is given into `dir`, taking either system's arguments
 * (macOS `trash -s <file>`, Linux `gio trash -- <file>`). With `hold`, it first makes the file `started` and waits for
 * a line on the pipe `go`, so a test can act while it runs.
 */
function fakeTrash(o: { hold?: boolean } = {}): { tool: string; dir: string; started: string; go: string } {
  const home = tempDir('kea-trash-')
  const dir = path.join(home, 'moved')
  fs.mkdirSync(dir)
  const started = path.join(home, 'started')
  const go = path.join(home, 'go')
  if (o.hold) execFileSync('mkfifo', [go])
  const tool = path.join(home, 'trash')
  const wait = o.hold ? `: > '${started}'\nread line < '${go}'\n` : ''
  fs.writeFileSync(tool, `#!/bin/sh\n${wait}[ "$1" = "-s" ] && shift\n[ "$1" = "trash" ] && shift\n[ "$1" = "--" ] && shift\nexec /bin/mv -- "$@" '${dir}/'\n`, { mode: 0o755 })
  return { tool, dir, started, go }
}

type Refusal = Extract<FileOpResult, { ok: false }>

/** The calls of the file tree's operations, for session `s1`. */
function ops(f: FilesUnderTest) {
  const sessionId = 's1'
  return {
    create: (dir: string, name: string, kind: 'file' | 'dir' = 'file') => f.call<FileOpResult>('files.create', { sessionId, dir, name, kind }),
    rename: (p: string, name: string) => f.call<FileOpResult>('files.rename', { sessionId, path: p, name }),
    move: (p: string, toDir: string, copy = false) => f.call<FileOpResult>('files.move', { sessionId, path: p, toDir, copy }),
    undo: () => f.call<FileOpResult>('files.undo', { sessionId }),
    trash: (p: string, dir: boolean) => f.call<{ ok: true; undo: string | null } | Refusal>('files.trash', { sessionId, path: p, dir }),
    measure: (sources: string[], toDir: string) => f.call<{ ok: true; entries: number; bytes: number } | Refusal>('files.measure', { sessionId, sources, toDir }),
    copyIn: (sources: string[], toDir: string) => f.call<{ ok: true; paths: string[]; undo: string | null } | (Refusal & { paths?: string[] })>('files.copyIn', { sessionId, sources, toDir }),
  }
}

const refused = (r: { ok: boolean; refused?: string }): string | undefined => (r.ok ? undefined : r.refused)
const there = (root: string, rel: string): boolean => {
  try {
    fs.lstatSync(path.join(root, rel))
    return true
  } catch {
    return false
  }
}

/** A session on the tiny demo repository, shown and read. */
async function demo(o: { trashTool?: string | null } = {}): Promise<{ root: string; op: ReturnType<typeof ops> }> {
  const r = repo()
  t = await startFiles({ files: { trashTool: o.trashTool ?? null } })
  t.session('s1', r.root)
  t.show('s1')
  await t.ready('s1')
  return { root: r.root, op: ops(t) }
}

describe('New File, New Folder, Rename and Move to Trash in core', () => {
  it('I-FT-30 · a new file or folder is made where asked, with the folders on the way; its row is in the tree before the answer, while another folder keeps changing', async () => {
    const { root, op } = await demo()
    expect(await t!.call('files.expand', { sessionId: 's1', path: 'src' })).toEqual({ ok: true })
    // another folder changes all the while
    let churning = true
    const churn = (async () => {
      for (let i = 0; churning && i < 5000; i++) {
        write(root, `churn/f${i}.txt`)
        await new Promise((r) => setImmediate(r))
      }
    })()
    try {
      expect(await op.create('src', 'new.js')).toEqual({ ok: true, path: 'src/new.js', ignored: false, paged: false, undo: null })
      expect(t!.names('s1', 'src')).toContain('new.js')
      expect(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8')).toBe('')
      // a folder that is not open is read for the answer too
      expect(await op.create('test', 'unit', 'dir')).toMatchObject({ ok: true, path: 'test/unit' })
      expect(t!.names('s1', 'test')).toContain('unit')
      expect(fs.statSync(path.join(root, 'test/unit')).isDirectory()).toBe(true)
      // nested: the folders on the way are made; those that are there are walked
      expect(await op.create('', 'src/lib/deep/a.js')).toMatchObject({ ok: true, path: 'src/lib/deep/a.js' })
      expect(fs.existsSync(path.join(root, 'src/lib/deep/a.js'))).toBe(true)
      expect(t!.names('s1', 'src')).toContain('lib')
    } finally {
      churning = false
      await churn
    }
  })

  it('I-FT-30 · Rename gives a new name in the same folder; a case-only rename works where case is not told apart; Undo Rename is offered', async () => {
    const { root, op } = await demo()
    expect(await op.rename('src/math.js', 'maths.js')).toEqual({ ok: true, path: 'src/maths.js', from: 'src/math.js', ignored: false, paged: false, undo: 'rename' })
    expect(there(root, 'src/math.js')).toBe(false)
    expect(t!.s('s1').undoKind).toBe('rename')
    // the same name: nothing done, nothing to answer for
    expect(await op.rename('src/maths.js', 'maths.js')).toMatchObject({ ok: true, path: 'src/maths.js' })
    // case only
    expect(await op.rename('README.md', 'Readme.md')).toMatchObject({ ok: true, path: 'Readme.md', from: 'README.md' })
    expect(fs.readdirSync(root)).toContain('Readme.md')
    expect(fs.readdirSync(root)).not.toContain('README.md')
    // a new entry clears what Undo would take back
    await op.create('', 'x.txt')
    expect(t!.s('s1').undoKind).toBeNull()
  })

  it('I-FT-30 · a link is renamed and trashed as a link, never followed; a folder reached through a link is refused, a nested New through one too', async () => {
    const trash = fakeTrash()
    const { root, op } = await demo({ trashTool: trash.tool })
    fs.symlinkSync('src', path.join(root, 'linked'))
    expect(refused(await op.create('linked', 'x.js'))).toBe('outside')
    expect(refused(await op.create('', 'linked/x.js'))).toBe('outside')
    expect(refused(await op.rename('linked/math.js', 'm.js'))).toBe('outside')
    expect(there(root, 'src/x.js')).toBe(false)
    expect(await op.rename('linked', 'alias')).toMatchObject({ ok: true, path: 'alias' })
    expect(fs.lstatSync(path.join(root, 'alias')).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(root, 'alias'))).toBe('src')
    expect(await op.trash('alias', false)).toEqual({ ok: true, undo: null })
    expect(fs.readdirSync(trash.dir)).toEqual(['alias'])
    expect(fs.readdirSync(path.join(root, 'src')).sort()).toEqual(['counter.js', 'hello.js', 'index.js', 'math.js'])
  })

  it('I-FT-30 · a typed folder in another case is taken in the volume’s spelling where case is not told apart, and is not there where it is', async () => {
    const { root, op } = await demo()
    const caseBlind = fs.existsSync(path.join(root, 'readme.md'))
    if (caseBlind) {
      expect(await op.create('SRC', 'made.js')).toMatchObject({ ok: true, path: 'src/made.js' })
      expect(await op.create('', 'Src/Lib/b.js')).toMatchObject({ ok: true, path: 'src/Lib/b.js' })
    } else {
      expect(refused(await op.create('SRC', 'made.js'))).toBe('missing')
      // a nested New makes `Src` beside `src`, as the volume tells them apart
      expect(await op.create('', 'Src/b.js')).toMatchObject({ ok: true, path: 'Src/b.js' })
    }
  })

  it('I-FT-30 · refused, and nothing is touched: git’s folder in any spelling, the session’s folder, a submodule (streamed check), a taken name, what is not there, a file that became a folder', async () => {
    const trash = fakeTrash()
    const { root, op } = await demo({ trashTool: trash.tool })
    // `.git` as git reads it
    for (const name of ['.git', '.GIT', '.g‌it']) {
      expect(refused(await op.create('', name, 'dir')), name).toBe('name')
      expect(refused(await op.rename('README.md', name)), name).toBe('name')
    }
    expect(refused(await op.create('.git', 'x'))).toBe('gitDir')
    expect(refused(await op.rename('.git', 'git'))).toBe('gitDir')
    expect(refused(await op.rename('.git/config', 'c'))).toBe('gitDir')
    expect(refused(await op.trash('.git', true))).toBe('gitDir')
    expect(refused(await op.move('README.md', '.git'))).toBe('gitDir')
    // the session's folder itself
    expect(refused(await op.rename('', 'x'))).toBe('root')
    expect(refused(await op.trash('', true))).toBe('root')
    expect(refused(await op.move('', 'src'))).toBe('root')
    // a submodule, and a folder that holds one
    const head = gitIn(root, 'rev-parse', 'HEAD')
    fs.mkdirSync(path.join(root, 'vendor/sub'), { recursive: true })
    for (let i = 0; i < 50; i++) write(root, `vendor/a${String(i).padStart(2, '0')}.js`)
    gitIn(root, 'add', 'vendor')
    gitIn(root, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`)
    expect(await holdsSubmodule(root, 'vendor', gitEnv())).toBe(true)
    expect(await holdsSubmodule(root, 'vendor/sub', gitEnv())).toBe(true)
    expect(await holdsSubmodule(root, 'src', gitEnv())).toBe(false)
    expect(refused(await op.rename('vendor/sub', 'lib'))).toBe('submodule')
    expect(refused(await op.rename('vendor', 'third'))).toBe('submodule')
    expect(refused(await op.trash('vendor', true))).toBe('submodule')
    expect(refused(await op.move('vendor', 'src'))).toBe('submodule')
    expect(there(root, 'vendor/sub')).toBe(true)
    // taken
    expect(refused(await op.create('', 'README.md'))).toBe('exists')
    expect(refused(await op.create('', 'src', 'dir'))).toBe('exists')
    expect(refused(await op.create('', 'README.md/x.js'))).toBe('exists')
    expect(refused(await op.rename('src/math.js', 'hello.js'))).toBe('exists')
    expect(fs.readFileSync(path.join(root, 'src/hello.js'), 'utf8')).toContain('greet')
    // not there
    expect(refused(await op.rename('nope.js', 'x.js'))).toBe('missing')
    expect(refused(await op.trash('nope.js', false))).toBe('missing')
    // the sheet named a folder; it is a file now
    expect(refused(await op.trash('README.md', true))).toBe('changed')
    expect(fs.readdirSync(trash.dir)).toEqual([])
  })

  it('I-FT-30 · Move to Trash moves a file or a folder with the system’s tool; with none it is refused and nothing is deleted', async () => {
    const trash = fakeTrash()
    const { root, op } = await demo({ trashTool: trash.tool })
    expect(t!.s('s1').trashAvailable).toBe(true)
    await t!.call('files.expand', { sessionId: 's1', path: 'src' })
    expect(await op.trash('src/hello.js', false)).toEqual({ ok: true, undo: null })
    expect(t!.names('s1', 'src')).not.toContain('hello.js')
    expect(await op.trash('src', true)).toEqual({ ok: true, undo: null })
    expect(t!.names('s1')).not.toContain('src')
    expect(t!.dir('s1', 'src')).toBeUndefined()
    expect(fs.readdirSync(trash.dir).sort()).toEqual(['hello.js', 'src'])
    expect(there(root, 'src')).toBe(false)
    await t!.dispose()
    cleanup()

    const none = await demo({ trashTool: null })
    expect(t!.s('s1').trashAvailable).toBe(false)
    expect(refused(await none.op.trash('README.md', false))).toBe('noTrash')
    expect(there(none.root, 'README.md')).toBe(true)
    await t!.dispose()
    cleanup()
    const gone = await demo({ trashTool: path.join(tempDir(), 'no-such-tool') })
    expect(t!.s('s1').trashAvailable).toBe(false)
    expect(refused(await gone.op.trash('README.md', false))).toBe('noTrash')
    expect(there(gone.root, 'README.md')).toBe(true)
  })

  it('I-FT-30 · one change to the files at a time: an operation or a Discard asked while another runs is refused as busy', async () => {
    const trash = fakeTrash({ hold: true })
    const { root, op } = await demo({ trashTool: trash.tool })
    write(root, 'src/math.js', 'changed\n')
    await until('the change in the status', () => t!.codes('s1')['src/math.js'] === 'M')
    const running = op.trash('src/hello.js', false)
    await until('the trash tool to start', () => fs.existsSync(trash.started))
    expect(refused(await op.create('', 'x.js'))).toBe('busy')
    expect(refused(await op.rename('README.md', 'r.md'))).toBe('busy')
    const h = t!.stores.get(gitStoreName('s1')) ? t!.head('s1') : undefined
    const discard = await t!.call<DiscardResult>('files.discard', { sessionId: 's1', path: 'src/math.js', expect: 'restore', scope: h?.scope ?? 'branch', base: h?.base ?? null })
    expect(discard).toEqual({ ok: false, refused: 'busy' })
    fs.writeFileSync(trash.go, 'go\n')
    expect(await running).toEqual({ ok: true, undo: null })
    expect(await op.create('', 'x.js')).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(root, 'src/math.js'), 'utf8')).toBe('changed\n')
  })

  it('I-FT-30 · the answer says when the result is ignored, past its folder’s first page, and where a renamed folder’s open folders are now', async () => {
    const { root, op } = await demo()
    expect(await op.create('', 'node_modules', 'dir')).toMatchObject({ ok: true, ignored: true })
    expect(await op.create('', 'kept', 'dir')).toMatchObject({ ok: true, ignored: false })
    // a big folder: the new entry sorts past the first page
    fs.mkdirSync(path.join(root, 'big'))
    for (let i = 0; i <= L.dirBigThreshold; i++) fs.writeFileSync(path.join(root, 'big', `f${i}.txt`), '')
    expect(await op.create('big', 'zz.txt')).toMatchObject({ ok: true, path: 'big/zz.txt', paged: true })
    expect(await op.create('big', '0-first', 'dir')).toMatchObject({ ok: true, paged: false })
    // a renamed folder takes its open folders along; their rows are read before the answer
    write(root, 'src/lib/util.js')
    await t!.call('files.expand', { sessionId: 's1', path: 'src' })
    await t!.call('files.expand', { sessionId: 's1', path: 'src/lib' })
    const r = await op.rename('src', 'source')
    expect(r).toMatchObject({ ok: true, path: 'source', from: 'src', undo: 'rename' })
    expect(r.ok && [...(r.expanded ?? [])].sort()).toEqual(expect.arrayContaining(['source', 'source/lib']))
    expect(r.ok && r.expanded?.some((p) => p === 'src' || p.startsWith('src/'))).toBe(false)
    expect(t!.names('s1', 'source/lib')).toEqual(['util.js'])
    expect(t!.dir('s1', 'src')).toBeUndefined()
  })

  it('I-FT-30 · core’s file system: `original-fs` under Electron, `node:fs` elsewhere or when it cannot be loaded', async () => {
    const plain = { promises: { lstat: async () => null } }
    expect(chooseFs({ electron: '1.0.0' }, () => plain)).toBe(plain)
    expect(chooseFs({}, () => plain)).toBe(fs)
    expect(chooseFs({ electron: '1.0.0' }, () => {
      throw new Error('no such module')
    })).toBe(fs)
    expect(chooseFs({ electron: '1.0.0' }, () => ({}))).toBe(fs)
  })
})

describe('moves, copies and Undo in core', () => {
  it('I-FT-31 · a move keeps its name in its new folder; Undo Move takes it back; into the folder it is in does nothing', async () => {
    const { root, op } = await demo()
    expect(await op.move('README.md', 'src')).toEqual({ ok: true, path: 'src/README.md', from: 'README.md', ignored: false, paged: false, undo: 'move' })
    expect(there(root, 'README.md')).toBe(false)
    expect(t!.names('s1', 'src')).toContain('README.md')
    expect(await op.undo()).toMatchObject({ ok: true, path: 'README.md', from: 'src/README.md', undo: null })
    expect(there(root, 'README.md')).toBe(true)
    expect(refused(await op.undo())).toBe('changed')
    expect(await op.move('src/math.js', 'src')).toMatchObject({ ok: true, path: 'src/math.js' })
    // a folder, with what it holds
    expect(await op.move('test', 'src')).toMatchObject({ ok: true, path: 'src/test', from: 'test' })
    expect(there(root, 'src/test/math.test.js')).toBe(true)
  })

  it('I-FT-31 · refused: a folder into itself or below it, a path through a link, a taken name', async () => {
    const { root, op } = await demo()
    fs.mkdirSync(path.join(root, 'src/sub'))
    for (const copy of [false, true]) {
      expect(refused(await op.move('src', 'src', copy))).toBe('intoItself')
      expect(refused(await op.move('src', 'src/sub', copy))).toBe('intoItself')
    }
    fs.symlinkSync('src', path.join(root, 'linked'))
    expect(refused(await op.move('README.md', 'linked'))).toBe('outside')
    expect(refused(await op.move('linked/math.js', ''))).toBe('outside')
    write(root, 'math.js', 'mine\n')
    expect(refused(await op.move('src/math.js', ''))).toBe('exists')
    expect(fs.readFileSync(path.join(root, 'math.js'), 'utf8')).toBe('mine\n')
    expect(there(root, 'src/math.js')).toBe(true)
  })

  it('I-FT-31 · a copy keeps its name in another folder and takes a “copy” name where it is taken; a copy clears what Undo would take back', async () => {
    const { root, op } = await demo()
    await op.move('src/index.js', 'test')
    expect(t!.s('s1').undoKind).toBe('move')
    expect(await op.move('README.md', '', true)).toMatchObject({ ok: true, path: 'README copy.md', undo: null })
    expect(await op.move('README.md', '', true)).toMatchObject({ ok: true, path: 'README copy 2.md' })
    expect(await op.move('README.md', 'src', true)).toMatchObject({ ok: true, path: 'src/README.md' })
    expect(await op.move('README.md', 'src', true)).toMatchObject({ ok: true, path: 'src/README copy.md' })
    expect(fs.readFileSync(path.join(root, 'src/README copy.md'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'README.md'), 'utf8'))
    expect(await op.move('src', '', true)).toMatchObject({ ok: true, path: 'src copy' })
    expect(fs.readdirSync(path.join(root, 'src copy')).sort()).toEqual(fs.readdirSync(path.join(root, 'src')).sort())
  })

  it('I-FT-31 · the copier keeps links as links and files’ modes, and copies a read-only folder whole', async () => {
    const { root, op } = await demo()
    write(root, 'kit/run.sh', '#!/bin/sh\n')
    fs.chmodSync(path.join(root, 'kit/run.sh'), 0o755)
    fs.symlinkSync('run.sh', path.join(root, 'kit/link'))
    write(root, 'kit/ro/f.txt', 'kept\n')
    fs.chmodSync(path.join(root, 'kit/ro/f.txt'), 0o444)
    fs.chmodSync(path.join(root, 'kit/ro'), 0o555)
    readOnly.push(path.join(root, 'kit/ro'))
    expect(await op.move('kit', 'src', true)).toMatchObject({ ok: true, path: 'src/kit' })
    readOnly.push(path.join(root, 'src/kit/ro'))
    const at = (rel: string) => fs.lstatSync(path.join(root, 'src/kit', rel))
    expect(at('run.sh').mode & 0o777).toBe(0o755)
    expect(at('link').isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(root, 'src/kit/link'))).toBe('run.sh')
    expect(at('ro').mode & 0o777).toBe(0o555)
    expect(at('ro/f.txt').mode & 0o777).toBe(0o444)
    expect(fs.readFileSync(path.join(root, 'src/kit/ro/f.txt'), 'utf8')).toBe('kept\n')
  })

  it('I-FT-31 · a copy is refused before anything is written: git’s folder inside, something that is not a file, folder or link, past the caps', async () => {
    const { root, op } = await demo()
    write(root, 'nested/.git/HEAD', 'ref: refs/heads/main\n')
    write(root, 'nested/a.js')
    expect(refused(await op.move('nested', 'src', true))).toBe('gitDir')
    fs.mkdirSync(path.join(root, 'pipes'))
    execFileSync('mkfifo', [path.join(root, 'pipes/p')])
    expect(refused(await op.move('pipes', 'src', true))).toBe('unsupported')
    // a sparse file past the bytes cap
    fs.mkdirSync(path.join(root, 'huge'))
    fs.closeSync(fs.openSync(path.join(root, 'huge/big.bin'), 'w'))
    fs.truncateSync(path.join(root, 'huge/big.bin'), L.fileCopyBytesMax + 1)
    expect(refused(await op.move('huge', 'src', true))).toBe('tooLarge')
    expect(fs.readdirSync(path.join(root, 'src')).sort()).toEqual(['counter.js', 'hello.js', 'index.js', 'math.js'])
  })

  it('I-FT-31 · Undo is refused when the entry was replaced, its old place is taken, or its old folder is gone; then nothing is left to undo', async () => {
    const { root, op } = await demo()
    // replaced: another file now stands at the new path
    await op.move('src/hello.js', 'test')
    write(root, 'test/other.js', 'other\n')
    fs.renameSync(path.join(root, 'test/other.js'), path.join(root, 'test/hello.js'))
    expect(refused(await op.undo())).toBe('changed')
    expect(t!.s('s1').undoKind).toBeNull()
    // taken: a new file at the old path
    await op.move('src/counter.js', 'test')
    write(root, 'src/counter.js', 'new\n')
    expect(refused(await op.undo())).toBe('changed')
    expect(fs.readFileSync(path.join(root, 'src/counter.js'), 'utf8')).toBe('new\n')
    // gone: the old folder is no more
    write(root, 'tmp/a.js')
    await op.move('tmp/a.js', '')
    fs.rmdirSync(path.join(root, 'tmp'))
    expect(refused(await op.undo())).toBe('missing')
    expect(t!.s('s1').undoKind).toBeNull()
    expect(there(root, 'a.js')).toBe(true)
  })
})

describe('files dropped from another app, in core', () => {
  /** Files outside the session: `one.txt` and a folder `folder` holding `a.txt` and `b/c.txt`. */
  function outside(): { dir: string; one: string; folder: string } {
    const dir = tempDir('kea-drop-')
    write(dir, 'one.txt', 'hello')
    write(dir, 'folder/a.txt', 'aa')
    write(dir, 'folder/b/c.txt', 'ccc')
    return { dir, one: path.join(dir, 'one.txt'), folder: path.join(dir, 'folder') }
  }

  it('I-FT-32 · what was dropped is measured, then copied under its own names, a taken one getting a “copy” name', async () => {
    const { root, op } = await demo()
    const o = outside()
    expect(await op.measure([o.one, o.folder], 'src')).toEqual({ ok: true, entries: 5, bytes: 10 })
    expect(there(root, 'src/one.txt')).toBe(false) // measuring writes nothing
    expect(await op.copyIn([o.one, o.folder], 'src')).toEqual({ ok: true, paths: ['src/one.txt', 'src/folder'], undo: null })
    expect(fs.readFileSync(path.join(root, 'src/folder/b/c.txt'), 'utf8')).toBe('ccc')
    expect(t!.names('s1', 'src')).toEqual(expect.arrayContaining(['one.txt', 'folder']))
    expect(await op.copyIn([o.one, o.folder], 'src')).toMatchObject({ ok: true, paths: ['src/one copy.txt', 'src/folder copy'] })
    expect(await op.copyIn([o.one], '')).toMatchObject({ ok: true, paths: ['one.txt'] })
    // the sources stay where they were
    expect(fs.readFileSync(o.one, 'utf8')).toBe('hello')
  })

  it('I-FT-32 · refused before anything is written: past the caps, git’s folder inside, a folder dropped into itself, a source that is gone, a target folder that is not there', async () => {
    const { root, op } = await demo()
    const o = outside()
    fs.closeSync(fs.openSync(path.join(o.dir, 'big.bin'), 'w'))
    fs.truncateSync(path.join(o.dir, 'big.bin'), L.fileCopyBytesMax + 1)
    expect(refused(await op.measure([o.one, path.join(o.dir, 'big.bin')], ''))).toBe('tooLarge')
    expect(refused(await op.copyIn([o.one, path.join(o.dir, 'big.bin')], ''))).toBe('tooLarge')
    expect(there(root, 'one.txt')).toBe(false)
    write(o.dir, 'repo/.git/HEAD', 'ref: refs/heads/main\n')
    expect(refused(await op.copyIn([path.join(o.dir, 'repo')], ''))).toBe('gitDir')
    expect(refused(await op.measure([path.join(root, 'src')], 'src'))).toBe('intoItself')
    expect(refused(await op.copyIn([root], 'src'))).toBe('intoItself')
    expect(refused(await op.copyIn([path.join(o.dir, 'gone.txt')], ''))).toBe('missing')
    expect(refused(await op.copyIn([o.one], 'nowhere'))).toBe('missing')
    expect(refused(await op.copyIn([o.one], '.git'))).toBe('gitDir')
    expect(there(root, 'one.txt')).toBe(false)
  })

  it('I-FT-32 · the sources a window may send: absolute paths, none repeated, without NUL, not too long, not too many', () => {
    const args = filesApi['files.copyIn'].args
    const ok = { sessionId: 's1', toDir: '' }
    expect(args.safeParse({ ...ok, sources: ['/a/b.txt'] }).success).toBe(true)
    for (const sources of [[], ['b.txt'], ['./b'], ['/'], ['/a\0b'], ['/a', '/a'], [`/${'x'.repeat(L.fileDropPathMaxBytes)}`], Array.from({ length: L.fileDropMax + 1 }, (_, i) => `/f${i}`)]) {
      expect(args.safeParse({ ...ok, sources }).success, JSON.stringify(sources).slice(0, 40)).toBe(false)
    }
    expect(filesApi['files.measure'].args.safeParse({ ...ok, sources: ['rel'] }).success).toBe(false)
  })
})
