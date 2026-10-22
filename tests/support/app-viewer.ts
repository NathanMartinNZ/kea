// The file viewer in a running Kea, for the app-level suites: what the viewer's own probe reports
// (`__keaProbe.viewer()`, app/renderer/src/features/viewer/resources.ts), the files a test puts into a session's
// worktree, and the session's worktree itself. Files are opened the way every caller opens them (`viewer.open`,
// tests/support/app-tabs.ts).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fixtureGitEnv } from '../../tools/repo-factory/src/tiny.ts'
import type { CDPSession } from '@playwright/test'
import { until, STEP_MS, type Kea } from './app.ts'

export interface ViewerState {
  ui: {
    body: { kind: string; text?: string; actions?: string[]; url?: string; width?: number | null; height?: number | null; old?: string | null; new?: string | null }
    path: string
    mode: string
    language: string | null
    encoding: string | null
    link: string | null
    notices: string[]
    deleted: boolean
    entry: { path: string; code: string; added: number | null; removed: number | null; origPath: string | null } | null
    counts: { added: number; removed: number } | null
    size: number | null
    wrap: boolean
    canWrap: boolean
    canPreview: boolean
    preview: boolean
    canSource: boolean
    source: boolean
    layout: string
    changes: number
  }
  text: {
    lines: number
    chars: number
    selection: { from: { line: number; col: number }; to: { line: number; col: number } }
    scroll: { line: number; offset: number; left: number }
    folds: number
    tokenised: number
    wrap: boolean
    findOpen: boolean
  } | null
  git: { changed: number; head: { scope: string; base: string | null; ahead?: number | null } | null }
  resources: Record<string, number>
  highlighter: { starts: number; workers: number; pending: number; grammars: number }
}

type Probe = { viewer(): ViewerState | null; viewerText(): string | null; viewerCopy(): string | null; setScope(sessionId: string, scope: string): Promise<boolean> }
const probe = (): Probe => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe

/** The viewer on screen; null while a terminal shows. */
export async function viewer(kea: Kea): Promise<ViewerState | null> {
  return (await kea.page()).evaluate(`(${probe.toString()})().viewer()`) as Promise<ViewerState | null>
}

/** Wait until the viewer is in the state `pred` accepts; fails with `what` and the last state seen. */
export async function waitViewer(kea: Kea, what: string, pred: (v: ViewerState) => boolean, ms = STEP_MS): Promise<ViewerState> {
  let last: ViewerState | null = null
  try {
    return await until(
      what,
      async () => {
        last = await viewer(kea)
        return last && pred(last) ? last : undefined
      },
      ms,
    )
  } catch (e) {
    const v = last as ViewerState | null
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nviewer: ${JSON.stringify(v ? { ui: v.ui, text: v.text, git: v.git } : null)}`)
  }
}

/** The viewer shows `p` with a body of `kind` (`text`, `diff`, `preview`, `image`, `images`, `note`). */
export function waitBody(kea: Kea, p: string, kind: string, ms = STEP_MS): Promise<ViewerState> {
  return waitViewer(kea, `the viewer to show ${p} as ${kind}`, (v) => v.ui.path === p && v.ui.body.kind === kind, ms)
}

/** The whole text of the document on screen. */
export async function viewerText(kea: Kea): Promise<string> {
  return ((await (await kea.page()).evaluate(`(${probe.toString()})().viewerText()`)) as string | null) ?? ''
}

/** What `⌘C` would copy from the document on screen; the clipboard is not touched. */
export async function viewerCopy(kea: Kea): Promise<string | null> {
  return (await kea.page()).evaluate(`(${probe.toString()})().viewerCopy()`) as Promise<string | null>
}

/** The file panel's scope for a session, as the Changes header's switch sets it. */
export async function setScope(kea: Kea, sessionId: string, scope: 'branch' | 'uncommitted'): Promise<boolean> {
  return (await kea.page()).evaluate(`(${probe.toString()})().setScope(${JSON.stringify(sessionId)}, ${JSON.stringify(scope)})`) as Promise<boolean>
}

/** The line numbers the gutter shows now, top to bottom (the lines on screen and a few around them). */
export async function gutterLines(kea: Kea): Promise<number[]> {
  return (await kea.page()).evaluate(() =>
    [...document.querySelectorAll('.viewer .cm-editor:not(.cm-merge-a) .cm-lineNumbers .cm-gutterElement')]
      .filter((e) => (e as HTMLElement).style.visibility !== 'hidden')
      .map((e) => Number(e.textContent))
      .filter((n) => n > 0),
  )
}

/** The git change marker beside line `n` of the file view (`added`, `modified`, `deleted`, `deleted-top`), or null. */
export async function changeMarker(kea: Kea, n: number): Promise<string | null> {
  return (await kea.page()).evaluate((line) => {
    const number = [...document.querySelectorAll('.viewer .cm-lineNumbers .cm-gutterElement')].find((e) => (e as HTMLElement).style.visibility !== 'hidden' && e.textContent === String(line))
    if (!number) return null
    const top = number.getBoundingClientRect().top
    const marker = [...document.querySelectorAll('.viewer .kea-change-gutter .cm-gutterElement')].find((e) => Math.abs(e.getBoundingClientRect().top - top) < 1 && /kea-change-/.test(e.className))
    return marker ? (/kea-change-([a-z-]+)/.exec(marker.className)?.[1] ?? null) : null
  }, n)
}

/** Token classes drawn in the document on screen (`kea-tok-keyword`, …), each once. */
export async function tokenClasses(kea: Kea): Promise<string[]> {
  return (await kea.page()).evaluate(() => [...new Set([...document.querySelectorAll('.viewer .cm-content [class*="kea-tok-"]')].flatMap((e) => [...e.classList].filter((c) => c.startsWith('kea-tok-'))))].sort())
}

/** The renderer's rows for the viewer (`viewerEditors`, `highlightWorkers`, …), also while no file tab is on screen. */
export async function viewerRows(kea: Kea): Promise<Record<string, number>> {
  const rows = (await (await kea.page()).evaluate('__keaPerf.resources()')) as Record<string, number>
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(rows)) {
    const name = k.replace(/^renderer\./, '')
    if (/^(viewer|highlight)/.test(name)) out[name] = v
  }
  return out
}

/** Close the file or diff tab on screen with `Esc`; resolves once the terminal it covered shows. */
export async function closeViewer(kea: Kea): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('.viewer-mount') === null, undefined, { polling: 'raf', timeout: STEP_MS })
}

type WorkerReply = { id?: number; result?: { usedSize?: number } }

/**
 * The window's dedicated workers over CDP (the highlight worker is the only one): a worker has its own heap, which the
 * page's `HeapProfiler.collectGarbage` does not reach, so a footprint read without collecting it too is tens of MB
 * high. Opened before the worker starts or after: workers already running are attached too.
 */
export class WorkerProbe {
  private readonly cdp: CDPSession
  private readonly workers = new Set<string>() // bounded: the window's workers (the highlight worker: 0 or 1)
  private readonly waiting = new Map<number, (r: WorkerReply) => void>() // bounded: requests in flight (one at a time)
  private seq = 1
  private constructor(cdp: CDPSession) {
    this.cdp = cdp
  }

  static async open(kea: Kea): Promise<WorkerProbe> {
    const page = await kea.page()
    const p = new WorkerProbe(await page.context().newCDPSession(page))
    p.cdp.on('Target.attachedToTarget', (e) => {
      if (e.targetInfo.type === 'worker') p.workers.add(e.sessionId)
    })
    p.cdp.on('Target.detachedFromTarget', (e) => void p.workers.delete(e.sessionId))
    p.cdp.on('Target.receivedMessageFromTarget', (e) => {
      const m = JSON.parse(e.message) as WorkerReply
      if (m.id === undefined) return
      p.waiting.get(m.id)?.(m)
      p.waiting.delete(m.id)
    })
    await p.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false })
    return p
  }

  /** Workers alive now. */
  get count(): number {
    return this.workers.size
  }

  private ask(sessionId: string, method: string): Promise<WorkerReply> {
    return new Promise((resolve) => {
      const id = this.seq++
      this.waiting.set(id, resolve)
      // a worker that ends before it answers answers nothing: the request ends with it
      this.cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params: {} }) }).catch(() => {
        this.waiting.delete(id)
        resolve({})
      })
    })
  }

  /** Collect garbage in every worker; resolves with their JS heaps' used bytes, summed (0 with no worker). */
  async settle(): Promise<number> {
    let used = 0
    for (const w of [...this.workers]) {
      await this.ask(w, 'HeapProfiler.collectGarbage')
      await this.ask(w, 'HeapProfiler.collectGarbage')
      used += (await this.ask(w, 'Runtime.getHeapUsage')).result?.usedSize ?? 0
    }
    return used
  }

  async close(): Promise<void> {
    await this.cdp.detach().catch(() => undefined)
  }
}

// ── the session's worktree and what a test puts in it ──────────────────────────────────────────────

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: fixtureGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Commit everything in `root` (a repo-factory repository), with the fixture identity and no hooks. */
export function commitAll(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', message)
}

/** The worktree of the one session started in the project at `repoRoot` (the worktree that is not the repository itself). */
export function sessionWorktree(repoRoot: string): string {
  const real = fs.realpathSync(repoRoot)
  const dirs = git(repoRoot, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((b) => /^worktree (.+)$/m.exec(b)?.[1] ?? '')
    .filter((d) => d !== '' && fs.realpathSync(d) !== real)
  if (dirs.length !== 1) throw new Error(`expected one session worktree of ${repoRoot}, found ${dirs.length}`)
  return dirs[0] as string
}

/** Write files (relative paths → contents) under `dir`. */
export function writeFiles(dir: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

/** One block of the TypeScript the viewer's suites read: nine lines, a function with a nested block. */
function block(i: number): string[] {
  return [
    `export async function login${i}(req: Request): Promise<Response> {`,
    `  const session = await getSession(req, ${i})`,
    '  if (!session) {',
    `    return redirect("/signin?n=${i}")`,
    '  }',
    `  // step ${i}`,
    `  return ok(session, ${i})`,
    '}',
    '',
  ]
}

/** A TypeScript source of `blocks` nine-line blocks: block `i` (0-based) starts at line `9 * i + 1`. */
export function loginSource(blocks: number): string {
  return Array.from({ length: blocks }, (_, i) => block(i).join('\n')).join('\n')
}

/** `lines` lines of source that reads as code in any language (a comment, a function, a string, a number), different for every `i`. */
export function sampleSource(i: number, lines = 60): string {
  const out: string[] = []
  for (let n = 0; n < lines; n++) {
    const k = n % 6
    out.push(k === 0 ? `// file ${i}, block ${n / 6}` : k === 1 ? `function work${i}_${n}(input) {` : k === 2 ? `  const text = "value ${i}:${n}"` : k === 3 ? `  return input + ${n} * 2` : k === 4 ? '}' : '')
  }
  return `${out.join('\n')}\n`
}

/** Plain text of about `bytes` bytes in 100-character lines, different for every `i`. */
export function plainText(i: number, bytes: number): string {
  const line = (n: number) => `${String(i).padStart(6, '0')} ${String(n).padStart(8, '0')} ${'lorem ipsum dolor sit amet '.repeat(4)}`.slice(0, 99)
  const out: string[] = []
  for (let n = 0; n * 100 < bytes; n++) out.push(line(n))
  return `${out.join('\n')}\n`
}

/** A `w` × `h` PNG (an RGB gradient). */
export function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head[8] = 8
  head[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = (x * 255) / w
      raw[o + 1] = (y * 255) / h
      raw[o + 2] = 120
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export { git as gitIn }
