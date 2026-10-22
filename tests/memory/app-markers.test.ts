// File contents and terminal output are dropped after use and never reach the database or the logs. Against the real
// app (tests/support/app.ts): a marker printed in a shell tab, another in a TypeScript file opened in the viewer and
// coloured by the highlight worker; the window is reloaded once in between, both are closed, then every place below is
// searched.
//
// Where a marker could stay, and how each place is searched:
//   JavaScript strings   a heap snapshot of the window and the highlight worker (CDP), and of core and ptyhost (the
//                        test hook's `snapshot`), read as text. A snapshot keeps each string's first 1 024 characters;
//                        both markers are at the start of what holds them (the file's first line, a new tab's first
//                        output), so no string that holds one is cut before it
//   binary memory        every ArrayBuffer and typed array's buffer alive in the same processes
//                        (tests/support/buffer-scan.cjs): PTY chunks are byte buffers and xterm keeps a line as 32-bit
//                        cells, neither of which a snapshot shows. In the window every JavaScript world is searched
//                        (the page's own, the preload's isolated one), and in each world and in the worker every
//                        WebAssembly memory too (the worker's Oniguruma heap is one)
//   the DOM              every text node, form control value and attribute value of the attached document, and of
//                        every tree that a node JavaScript holds belongs to, detached ones included (a closed tab's
//                        frame kept alive by a listener is this kind of leak), in each of the window's worlds
//   disk                 every file under the run's KEA_HOME, as bytes: `kea.db` with its WAL (the status journal is
//                        a table in it) and `logs/` hold neither marker. The file's marker may be in the file alone;
//                        the terminal's is in no file, since a closed shell tab's ring, checkpoint and state file go
//                        with the tab
//
// Every search has a control, so finding nothing afterwards means something. While both are open, each marker is found
// where Kea uses it (the view's and the mirror's cells; the editor's document and lines). A planted marker, made as a
// string, as bytes and (where there is a document) as a detached DOM tree in each of the window's worlds and in the
// worker, and as bytes in core and ptyhost (the hook's `scan` holds it while it searches), is found by every buffer and
// DOM search and in the worker's snapshot. What Kea does keep is found at the end: the session's id in core's snapshot,
// its title in the database. The marker on the note's last line, which the allowance below lets the worker keep, is
// found in its WebAssembly memory.
//
// The reload rebuilds the terminal from ptyhost's snapshot, and closing the tab serialises the screen once more for its
// last checkpoint: the serialised screen is a string in ptyhost and the window, and must not outlive its use.
//
// No marker enters a searched process through the test itself: the terminal's is typed in two halves that only the
// shell joins, the file's is written by this process, and every search takes markers as character codes. The DOM
// pass makes strings of the text nodes it reads, so it runs last, after the snapshots.
//
// The allowance: Shiki's Oniguruma engine copies each line it matches into one 10 000-byte scratch area of its
// WebAssembly heap (`OnigString._sharedPtr`) and never clears it. That area holds the last line tokenised, and behind
// it the tails of longer lines before it, until another file is coloured or the worker ends (it outlives the tab, and
// stops after L.highlightIdleMs with no file or diff tab visible). The test shows it (the last line's marker is found
// there, and where it is after the close is printed) and allows it for that marker alone; `noteText` is written so that
// the first line's marker cannot be left there.
//
// Not searched:
//   · main: no snapshot hook; terminal and file bytes do not pass through it
//   · the GPU process and the compositor: the glyphs drawn (WebGL textures, the terminal's atlas, raster tiles)
//   · the holder: its ring is where output is meant to be, and it ends with the tab
//   · memory no ArrayBuffer wraps other than the DOM's text: SQLite's page cache (the database file is read
//     instead), V8's own (compiled code, the string table's freed slots), malloc'ed memory that was freed and not
//     reused, messages in transit between processes
//   · in the window and the worker, a buffer that only a closure, a private `#field` or a WeakMap holds (the
//     inspector lists no ArrayBuffer there, so buffers are found through the objects that hold them)
//   · a detached DOM tree that no JavaScript object refers to at all (one only Blink still holds)
//   · a string longer than 1 024 characters that holds a marker past that point (a whole file as one string does
//     not: the marker is in its first line; a terminal screen serialised with the marker far down would)

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { CDPSession } from '@playwright/test'
import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { RendererProbe } from '../support/app-leak.ts'
import { addProject, agentTerminal, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'
import { fileTabs, openFile } from '../support/app-tabs.ts'
import { closeViewer, sessionWorktree, tokenClasses, viewerRows, waitBody, waitViewer, writeFiles } from '../support/app-viewer.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const sessions: CDPSession[] = []
const probes: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.detach().catch(() => undefined)
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

type Scan = { buffers: number; bytes: number; found: { as: string; size: number }[][] }
type DomScan = { nodes: number; trees: number; detached: number; chars: number; found: { where: string; in: string; node: string }[][] }
const { scanBuffers, collectBuffers, memoryBuffers, scanDom, OBJECTS, MEMORIES, NODES } = createRequire(import.meta.url)('../support/buffer-scan.cjs') as {
  scanBuffers: (...a: unknown[]) => Scan
  collectBuffers: () => unknown[]
  memoryBuffers: () => unknown[]
  scanDom: (...a: unknown[]) => DomScan
  OBJECTS: string
  MEMORIES: string
  NODES: string
}

const codes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0))

/** What the CDP calls made here answer with (the fields read). */
interface CdpReply {
  result?: { objectId?: string; value?: unknown }
  objects?: { objectId?: string }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}
/** One CDP call to a target: the window (its session) or a worker (through the window's). */
type Send = (method: string, params?: Record<string, unknown>) => Promise<CdpReply>
const toPage = (cdp: CDPSession): Send => (method, params) => (cdp.send as unknown as (m: string, p?: unknown) => Promise<CdpReply>)(method, params)

const GROUP = 'kea-scan'
const failed = (what: string, r: CdpReply): Error => new Error(`scan: ${what}: ${r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? 'no object'}`)

/** Every object alive in one JavaScript world whose prototype chain holds the value of `expression`, as one remote array. */
async function every(send: Send, expression: string, world?: number): Promise<string> {
  const proto = await send('Runtime.evaluate', { expression, objectGroup: GROUP, ...(world === undefined ? {} : { contextId: world }) })
  if (proto.exceptionDetails || !proto.result?.objectId) throw failed(expression, proto)
  const all = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: GROUP })
  if (!all.objects?.objectId) throw failed(`objects of ${expression}`, all)
  return all.objects.objectId
}

/** Run `fn` (as source) on a remote object. */
async function callOn(send: Send, objectId: string, fn: string, args: Record<string, unknown>[] = [], byValue = false): Promise<CdpReply> {
  const r = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args, ...(byValue ? { returnByValue: true } : { objectGroup: GROUP }) })
  if (r.exceptionDetails) throw failed(fn.slice(0, 40), r)
  return r
}

/**
 * One JavaScript world's binary memory searched for `markers` (buffer-scan.cjs): the buffers every ordinary object
 * alive holds, and every WebAssembly memory (the inspector's query collects garbage first). `world`: an execution
 * context of the window; none for a worker, which has one.
 */
async function scanWorld(send: Send, markers: readonly string[], world?: number): Promise<Scan & { objects: number }> {
  const objects = await every(send, OBJECTS, world)
  const count = await callOn(send, objects, 'function () { return this.length }', [], true)
  const held = await callOn(send, objects, collectBuffers.toString())
  const memories = await callOn(send, await every(send, MEMORIES, world), memoryBuffers.toString())
  const out = await callOn(send, held.result?.objectId as string, scanBuffers.toString(), [{ objectId: memories.result?.objectId }, { value: markers.map(codes) }], true)
  await send('Runtime.releaseObjectGroup', { objectGroup: GROUP })
  return { ...(out.result?.value as Scan), objects: count.result?.value as number }
}

/** The DOM one of the window's worlds can reach, searched for `markers` (buffer-scan.cjs `scanDom`). */
async function scanWorldDom(send: Send, markers: readonly string[], world: number): Promise<DomScan> {
  const out = await callOn(send, await every(send, NODES, world), scanDom.toString(), [{ value: markers.map(codes) }], true)
  await send('Runtime.releaseObjectGroup', { objectGroup: GROUP })
  return out.result?.value as DomScan
}

interface World {
  id: number
  /** `page` (the window's own scripts) or the isolated world's name (the preload's; the harness's own). */
  name: string
}

/** The window's JavaScript worlds: `Runtime.enable` reports every execution context alive. */
async function worldsOf(cdp: CDPSession): Promise<World[]> {
  const seen: World[] = []
  const on = (e: { context: { id: number; name: string; auxData?: { isDefault?: boolean } } }) => void seen.push({ id: e.context.id, name: e.context.auxData?.isDefault ? 'page' : e.context.name || `world ${e.context.id}` })
  cdp.on('Runtime.executionContextCreated', on)
  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.disable')
  } finally {
    cdp.off('Runtime.executionContextCreated', on)
  }
  return seen
}

/**
 * The control's plant in one world or worker: the marker as a string, as bytes and (where there is a document) in a
 * detached tree, as a text node and as an input's value. Made from character codes there, kept on the global until
 * `unplant`.
 */
const PLANT_AT = '__keaScanPlant'
const plantSource = (marker: string): string =>
  `(() => { const s = String.fromCharCode(${codes(marker).join(',')}); const held = { text: s, bytes: Uint8Array.from(${JSON.stringify(codes(marker))}) }; if (typeof document === 'object' && document) { const d = document.createElement('div'); d.appendChild(document.createTextNode(s)); d.appendChild(document.createElement('input')).value = s; held.tree = d } globalThis.${PLANT_AT} = held; return true })()`
const plant = (send: Send, marker: string, world?: number) => send('Runtime.evaluate', { expression: plantSource(marker), returnByValue: true, ...(world === undefined ? {} : { contextId: world }) })
const unplant = (send: Send, world?: number) => send('Runtime.evaluate', { expression: `delete globalThis.${PLANT_AT}`, returnByValue: true, ...(world === undefined ? {} : { contextId: world }) })

type FromWorker = { id?: number; result?: CdpReply; error?: { message?: string }; method?: string; params?: { chunk?: string } }

/**
 * CDP to the window's dedicated workers (the highlight worker is the only one), through a session of the window that
 * attaches to them, as `WorkerProbe` does (tests/support/app-viewer.ts): a worker is another isolate, with a heap the
 * window's snapshot and searches do not reach.
 */
class Workers {
  private readonly cdp: CDPSession
  private readonly alive = new Set<string>() // bounded: the window's workers (the highlight worker: 0 or 1)
  private readonly waiting = new Map<number, { resolve: (r: CdpReply) => void; reject: (e: Error) => void }>() // bounded: calls in flight (one at a time)
  private readonly sinks = new Map<string, (chunk: string) => void>() // bounded: one per snapshot being written (one at a time)
  private seq = 1
  private constructor(cdp: CDPSession) {
    this.cdp = cdp
  }

  static async open(kea: Kea): Promise<Workers> {
    const page = await kea.page()
    const w = new Workers(await page.context().newCDPSession(page))
    w.cdp.on('Target.attachedToTarget', (e) => {
      if (e.targetInfo.type === 'worker') w.alive.add(e.sessionId)
    })
    w.cdp.on('Target.detachedFromTarget', (e) => void w.alive.delete(e.sessionId))
    w.cdp.on('Target.receivedMessageFromTarget', (e) => {
      const m = JSON.parse(e.message) as FromWorker
      if (m.id === undefined) {
        if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && typeof m.params?.chunk === 'string') w.sinks.get(e.sessionId)?.(m.params.chunk)
        return
      }
      const call = w.waiting.get(m.id)
      w.waiting.delete(m.id)
      if (m.error) call?.reject(new Error(`worker: ${m.error.message ?? 'CDP error'}`))
      else call?.resolve(m.result ?? {})
    })
    await w.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false })
    return w
  }

  /** The workers alive now, each by its session. */
  get sessions(): string[] {
    return [...this.alive]
  }

  /** CDP calls to one worker. */
  to(sessionId: string): Send {
    return (method, params = {}) =>
      new Promise<CdpReply>((resolve, reject) => {
        const id = this.seq++
        this.waiting.set(id, { resolve, reject })
        this.cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch((e: unknown) => {
          this.waiting.delete(id)
          reject(e instanceof Error ? e : new Error(String(e)))
        })
      })
  }

  /** A heap snapshot of one worker, written to `file` (the chunks arrive before the call's answer). */
  async snapshot(sessionId: string, file: string): Promise<void> {
    const fd = fs.openSync(file, 'w')
    this.sinks.set(sessionId, (chunk) => void fs.writeSync(fd, chunk))
    try {
      await this.to(sessionId)('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    } finally {
      this.sinks.delete(sessionId)
      fs.closeSync(fd)
    }
  }

  async close(): Promise<void> {
    await this.cdp.detach().catch(() => undefined)
  }
}

/**
 * Core's or ptyhost's binary memory searched for `markers` (the test hook's `scan`). With `planted`, the hook holds
 * that marker as bytes while it searches, and it is searched for last: the control.
 */
const scanChild = (kea: Kea, proc: 'core' | 'ptyhost', markers: readonly string[], planted?: string): Promise<Scan> =>
  kea.debug<Scan>(proc, 'scan', JSON.stringify(planted === undefined ? markers.map(codes) : { needles: [...markers, planted].map(codes), plant: codes(planted) }))

/** Which of `markers` the file at `file` holds, as bytes (none, if the file went away meanwhile). */
function inFile(file: string, markers: readonly string[]): boolean[] {
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return markers.map(() => false)
    throw e
  }
  return markers.map((m) => bytes.includes(m))
}

/** Every regular file under `dir` but those under `skip`. */
function filesUnder(dir: string, skip: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (p === skip) continue
    if (e.isDirectory()) out.push(...filesUnder(p, skip))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/**
 * The note: a TypeScript file whose first line is a comment holding the file's marker, and whose last line holds
 * another (`last`). Every later line is longer than the first: the worker's Oniguruma engine copies each line it
 * matches to one scratch area of its WebAssembly heap and leaves it there, so a shorter line would leave the tail of
 * the first, the marker with it, behind the lines after it. Written this way the scratch area ends up holding the
 * last line alone (`last`: the allowance), and the first line's marker found anywhere in the worker after the close
 * is a copy something kept.
 */
function noteText(marker: string, last: string): string {
  const first = `// ${marker} first line of a note`
  const pad = (line: string) => `${line} // ${'-'.repeat(Math.max(0, first.length + 8 - line.length))}`
  return [first, pad(`export const second: string = 'the second line'`), pad('export function third(n: number): number {'), pad('  return n + 3'), pad(`} // ${last}`), ''].join('\n')
}

describe('markers after close (app)', () => {
  it('L-MEM-4 · a marker printed in a shell tab and another in a TypeScript file opened in the viewer and coloured by the highlight worker, the window reloaded once in between; after the file tab and the shell tab are closed neither is in a heap snapshot or the binary memory of the window, the highlight worker, core or ptyhost, nor in the text of the window’s DOM, attached or detached, nor in the database or a log (and every one of those searches found a marker where one was: the open tab’s and file’s, or a planted one)', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const repo = demoRepo(run)
    await addProject(kea, repo.root)

    // the markers: random, upper-case and digits, found nowhere else
    const half = () => randomBytes(8).toString('hex').toUpperCase()
    const [t1, t2] = [`KEATERM${half()}`, half()]
    const TERM = `${t1}${t2}`
    const FILE = `KEAFILE${half()}${half()}`
    const markers = [TERM, FILE] as const
    // the controls': one planted where each search must see it, one that core keeps (the session's title)
    const PLANT = `KEAPLANT${half()}${half()}`
    const TITLE = `KEATITLE${half()}`
    // … and one in the note's last line, which the worker's Oniguruma heap is allowed to keep (see the header)
    const LAST = `KEALAST${half()}${half()}`
    const NOTE = 'marker-note.ts'

    const id = await startSession(kea, TITLE)
    await waitLive(kea, id)
    await agentTerminal(kea, id)
    const worktree = sessionWorktree(repo.root)
    const snapshots = path.join(run.home, 'l-mem-4')
    fs.mkdirSync(snapshots)

    // the terminal's: in a new shell tab, typed in two halves that only the shell joins, so the whole marker is output
    const shell = await kea.newTab()
    await kea.enter(`printf '%s%s\\n' ${t1} ${t2}`)
    await until('the marker in the shell tab’s ring', () => run.ring(shell).text.includes(TERM) || undefined)
    // the window reloaded: every view is rebuilt from ptyhost's snapshot, the marker's screen among them
    await kea.reloadWindow()
    if ((await kea.shown()) !== shell) await kea.clickTab(shell)
    await until('the shell tab’s view attached again', async () => (await kea.views()).some((v) => v.ptyId === shell && v.attached) || undefined)

    // the file's: its first line, in a new file of the session's worktree, opened as every caller opens a file; a
    // `.ts` file, so its lines go to the highlight worker and come back as tokens
    const workers = await Workers.open(kea)
    probes.push(workers)
    writeFiles(worktree, { [NOTE]: noteText(FILE, LAST) })
    expect(await openFile(kea, { sessionId: id, path: NOTE, mode: 'file' }), `viewer.open ${NOTE}`).toBe(true)
    await waitBody(kea, NOTE, 'text')
    const coloured = await waitViewer(kea, 'every line of the note coloured', (v) => v.ui.path === NOTE && v.text !== null && v.text.tokenised >= v.text.lines - 1 && v.highlighter.pending === 0)
    expect(coloured.highlighter.workers, 'the highlight worker runs').toBe(1)
    expect(await tokenClasses(kea), 'the note’s tokens are drawn').toEqual(expect.arrayContaining(['kea-tok-comment', 'kea-tok-keyword']))
    await until('the highlight worker attached to', () => workers.sessions.length === 1 || undefined)
    const worker = workers.sessions[0] as string

    const renderer = await RendererProbe.open(kea, { classes: ['EditorView'] })
    probes.push(renderer)
    const cdp = await (await kea.page()).context().newCDPSession(await kea.page())
    sessions.push(cdp)
    const page = toPage(cdp)
    const worlds = await worldsOf(cdp)
    expect(worlds.map((w) => w.name), 'the window’s JavaScript worlds: the page’s own and the preload’s isolated one at least').toContain('page')
    expect(worlds.length, 'the window’s JavaScript worlds').toBeGreaterThanOrEqual(2)
    /** The window searched, every world of it: its binary memory and the DOM each world can reach. */
    const scanWindow = async (needles: readonly string[]) => {
      const out: Record<string, { memory: Scan & { objects: number }; dom: DomScan }> = {}
      for (const w of worlds) out[`${w.name}#${w.id}`] = { memory: await scanWorld(page, needles, w.id), dom: await scanWorldDom(page, needles, w.id) }
      return out
    }
    const asFound = (hits: { as: string }[] | undefined) => (hits ?? []).map((f) => f.as)
    const inDom = (hits: { where: string; in: string }[] | undefined) => [...new Set((hits ?? []).map((f) => `${f.where} ${f.in}`))].sort()

    // ── the controls: while both are open, and with the plant in place, every search sees what is there ──
    const withPlant = [TERM, FILE, PLANT] as const
    for (const w of worlds) await plant(page, PLANT, w.id)
    await plant(workers.to(worker), PLANT)
    const openSnapshot = path.join(snapshots, 'renderer-open.heapsnapshot')
    await renderer.snapshot(openSnapshot)
    const workerOpenSnapshot = path.join(snapshots, 'worker-open.heapsnapshot')
    await workers.snapshot(worker, workerOpenSnapshot)
    const open = {
      rendererSnapshot: inFile(openSnapshot, withPlant),
      workerSnapshot: inFile(workerOpenSnapshot, withPlant),
      window: await scanWindow(withPlant),
      worker: await scanWorld(workers.to(worker), [...withPlant, LAST]),
      core: await scanChild(kea, 'core', markers, PLANT),
      ptyhost: await scanChild(kea, 'ptyhost', markers, PLANT),
    }
    for (const w of worlds) await unplant(page, w.id)
    await unplant(workers.to(worker))
    const pageWorld = Object.entries(open.window).find(([k]) => k.startsWith('page#'))?.[1]
    expect(open.rendererSnapshot[1], 'control: the open file’s marker is in the window’s heap snapshot (the editor’s document)').toBe(true)
    expect(asFound(pageWorld?.memory.found[0]), 'control: the terminal’s marker is in the window’s binary memory (the view’s cells)').toContain('cells')
    expect(asFound(open.ptyhost.found[0]), 'control: the terminal’s marker is in ptyhost’s binary memory (the mirror’s cells)').toContain('cells')
    expect(inDom(pageWorld?.dom.found[1]), 'control: the open file’s marker is in the attached document’s text (the editor’s lines)').toContain('document text')
    for (const [world, seen] of Object.entries(open.window)) {
      expect(asFound(seen.memory.found[2]), `control: the plant’s bytes are found in the window’s world ${world}`).toContain('bytes')
      expect(inDom(seen.dom.found[2]), `control: the plant’s detached tree is found from the window’s world ${world}, as text and as an input’s value`).toEqual(['detached text', 'detached value'])
    }
    expect(open.workerSnapshot[2], 'control: the plant’s string is in the highlight worker’s heap snapshot').toBe(true)
    expect(asFound(open.worker.found[2]), 'control: the plant’s bytes are found in the highlight worker’s binary memory').toContain('bytes')
    expect(asFound(open.worker.found[3]), 'control: the note’s last line is found in the highlight worker’s WebAssembly memory (Oniguruma’s scratch area)').toContain('bytes')
    expect(asFound(open.core.found[2]), 'control: the plant’s bytes are found in core’s binary memory').toContain('bytes')
    expect(asFound(open.ptyhost.found[2]), 'control: the plant’s bytes are found in ptyhost’s binary memory').toContain('bytes')

    // ── close both ──
    await closeViewer(kea)
    await until('the file tab closed', async () => (await fileTabs(kea)).length === 0 || undefined)
    // a file tab that closes leaves the pane on the Agent terminal: the shell tab is shown, then closed
    await kea.clickTab(shell)
    const holder = run.holder(shell)
    await (await kea.page()).keyboard.press(sysKey('Meta+w'))
    await until('the shell tab closed', async () => !(await kea.tabIds()).includes(shell) || undefined)
    await until('its holder gone', () => !run.holderAlive(holder) || undefined)

    // ── settle ──
    await until('ptyhost to let the closed terminal go', async () => {
      const k = await kea.debug<Record<string, unknown>>('ptyhost', 'kit')
      const c = (k['ptyhost.checkpoints'] ?? {}) as Record<string, number>
      const r = (k['ptyhost.pendingRebuilds'] ?? {}) as Record<string, number>
      return (k['ptyhost.holderSockets'] === run.holders().filter((h) => run.holderAlive(h)).length && c.pending === 0 && r.queued === 0 && r.running === 0) || undefined
    })
    // CodeMirror can keep an editor it has destroyed for about a second: only the viewer's own may be alive
    await until('only the viewer’s own editors alive', async () => (await renderer.liveObjects('__keaProbe.classes.EditorView')) === (await viewerRows(kea)).viewerEditors || undefined)
    await renderer.settle()
    for (const proc of ['core', 'ptyhost'] as const) await kea.debug(proc, 'gc')
    await kea.gcMain()
    // the worker outlives the tab: it is searched as it stands
    expect(workers.sessions, 'the highlight worker is still the one that coloured the note').toEqual([worker])

    // ── search ──
    // snapshots first: nothing of the search has touched the processes yet
    // (with them, what must be found: the title in the database, the session's id in core; and the last line's marker)
    const withTitle = [TERM, FILE, TITLE, id, LAST] as const
    const heap: Record<string, boolean[]> = {}
    const sizes: Record<string, number> = {}
    for (const proc of ['renderer', 'worker', 'core', 'ptyhost'] as const) {
      const file = path.join(snapshots, `${proc}-closed.heapsnapshot`)
      if (proc === 'renderer') await renderer.snapshot(file)
      else if (proc === 'worker') await workers.snapshot(worker, file)
      else await kea.debug(proc, 'snapshot', file)
      heap[proc] = inFile(file, withTitle)
      sizes[proc] = fs.statSync(file).size
    }
    const workerClosed = await scanWorld(workers.to(worker), [...markers, LAST])
    const memory = { worker: { ...workerClosed, found: workerClosed.found.slice(0, 2) }, core: await scanChild(kea, 'core', markers), ptyhost: await scanChild(kea, 'ptyhost', markers) }
    // the window last, and in it the DOM pass after the buffers: reading a text node makes a string of it
    const closed = await scanWindow(markers)
    const disk: Record<string, string[]> = { [TERM]: [], [FILE]: [], [TITLE]: [], [id]: [], [LAST]: [] }
    const files = filesUnder(run.home, snapshots)
    for (const f of files) {
      const has = inFile(f, withTitle)
      withTitle.forEach((m, i) => {
        if (has[i]) (disk[m] as string[]).push(path.relative(run.home, f))
      })
    }
    const kept = (m: string) => (disk[m] as string[]).filter((f) => /^kea\.db/.test(f) || f.startsWith(`logs${path.sep}`))
    const mb = (n: number) => (n / 2 ** 20).toFixed(1)
    const dom = Object.values(closed).map((w) => w.dom)
    console.info(
      `L-MEM-4 · snapshots ${Object.entries(sizes).map(([k, v]) => `${k} ${mb(v)} MB`).join(', ')}; binary memory searched: ${Object.entries(memory).map(([k, v]) => `${k} ${v.buffers} buffers, ${mb(v.bytes)} MB`).join('; ')}; the window’s worlds: ${Object.entries(closed).map(([k, v]) => `${k} ${v.memory.buffers} buffers, ${mb(v.memory.bytes)} MB from ${v.memory.objects} objects, DOM ${v.dom.nodes} nodes held, ${v.dom.trees} trees (${v.dom.detached} detached), ${v.dom.chars} characters`).join('; ')}; ${files.length} files under KEA_HOME\n  while open: window snapshot [terminal, file, plant] ${JSON.stringify(open.rendererSnapshot)}, worker snapshot ${JSON.stringify(open.workerSnapshot)}, worker memory ${JSON.stringify(open.worker.found)}, core memory ${JSON.stringify(open.core.found)}, ptyhost memory ${JSON.stringify(open.ptyhost.found)}\n  the window while open: ${Object.entries(open.window).map(([k, v]) => `${k} memory ${JSON.stringify(v.memory.found)} DOM ${JSON.stringify(v.dom.found.map(inDom))}`).join('; ')}\n  after close: heap snapshots [terminal, file, title, session id, last line] ${JSON.stringify(heap)}; memory ${JSON.stringify({ worker: memory.worker.found, core: memory.core.found, ptyhost: memory.ptyhost.found })}; the window ${Object.entries(closed).map(([k, v]) => `${k} memory ${JSON.stringify(v.memory.found)} DOM ${JSON.stringify(v.dom.found)}`).join('; ')}\n  the allowance: the note’s last line in the worker’s WebAssembly memory after the close: ${JSON.stringify(workerClosed.found[2])}\n  on disk after close: terminal marker in ${JSON.stringify(disk[TERM])}, file marker in ${JSON.stringify(disk[FILE])}, the title in ${JSON.stringify(disk[TITLE])}`,
    )

    // the search looked at something: every snapshot is a real one, every process had buffers to look through, and
    // the DOM pass read the document
    for (const [proc, size] of Object.entries(sizes)) expect(size, `${proc}'s heap snapshot (bytes)`).toBeGreaterThan(2 ** 20)
    for (const [proc, m] of Object.entries(memory)) expect(m.buffers, `${proc}'s buffers searched`).toBeGreaterThan(0)
    expect(Object.entries(closed).find(([k]) => k.startsWith('page#'))?.[1].memory.buffers, 'the window’s buffers searched (the page’s world)').toBeGreaterThan(0)
    expect(Math.max(...dom.map((d) => d.chars)), 'characters of DOM text read').toBeGreaterThan(0)
    expect(Math.max(...dom.map((d) => d.nodes)), 'DOM nodes JavaScript holds, handed to the DOM pass').toBeGreaterThan(0)
    // controls: what core and the database do keep is found where the markers must not be
    expect(heap.core?.[3], 'control: the session’s id is in core’s heap snapshot').toBe(true)
    expect(kept(TITLE).length, 'control: the session’s title is in the database (the file or its WAL)').toBeGreaterThan(0)
    // the last line's marker is nowhere as a string either: its one allowed place is the worker's scratch area
    expect(Object.fromEntries(Object.entries(heap).map(([k, v]) => [k, v[4]])), 'heap snapshots holding the note’s last line').toEqual({ renderer: false, worker: false, core: false, ptyhost: false })
    // neither marker in a heap snapshot …
    expect(Object.fromEntries(Object.entries(heap).map(([k, v]) => [k, v.slice(0, 2)])), 'heap snapshots holding [the terminal’s marker, the file’s]').toEqual({ renderer: [false, false], worker: [false, false], core: [false, false], ptyhost: [false, false] })
    // … nor in binary memory …
    expect(
      { ...Object.fromEntries(Object.entries(closed).map(([k, v]) => [`window ${k}`, v.memory.found])), worker: memory.worker.found, core: memory.core.found, ptyhost: memory.ptyhost.found },
      'binary memory holding [the terminal’s marker, the file’s]',
    ).toEqual({ ...Object.fromEntries(Object.keys(closed).map((k) => [`window ${k}`, [[], []]])), worker: [[], []], core: [[], []], ptyhost: [[], []] })
    // … nor in the window's DOM, in the document or in a tree taken out of it …
    expect(Object.fromEntries(Object.entries(closed).map(([k, v]) => [k, v.dom.found])), 'DOM text holding [the terminal’s marker, the file’s]').toEqual(Object.fromEntries(Object.keys(closed).map((k) => [k, [[], []]])))
    // … nor in the database (its WAL and the status journal with it) or a log
    expect({ terminal: kept(TERM), file: kept(FILE) }, 'the database and the logs').toEqual({ terminal: [], file: [] })
    expect(files.some((f) => path.relative(run.home, f) === 'kea.db'), 'the database was among the files searched').toBe(true)
    expect(files.some((f) => path.relative(run.home, f).startsWith(`logs${path.sep}`)), 'the logs were among the files searched').toBe(true)
    // the terminal's marker is in no file: the closed tab's ring and last checkpoint, where output is kept while a
    // tab lives, went with the tab, and so did its state file
    expect(disk[TERM], 'files holding the terminal’s marker').toEqual([])
    expect(fs.readdirSync(path.join(run.home, 'sessions', holder.sessionId)).filter((f) => f.startsWith(`${shell}.`)), 'files of the closed shell tab in its session’s state directory').toEqual([])
    // the file's marker is where the test wrote it, and nowhere else
    const note = path.relative(run.home, path.join(fs.realpathSync(worktree), NOTE))
    expect(disk[FILE], 'files holding the file’s marker').toEqual(note.startsWith('..') ? [] : [note])
    await kea.assertUnfocused()
  })
})
