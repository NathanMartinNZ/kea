// Probes for the app-level test suites, installed with the perf probes, only when the app runs with `--kea-perf`:
// `window.__keaProbe`. Read-only views of the terminal registry and the window's state, plus the few actions a test
// cannot take through the UI (write output into a view, run a command or a core call by name). Nothing here is used by
// the app itself.
//
//   classes     prototypes for `Runtime.queryObjects` (the leak tests count live `Terminal`, search and WebGL addon
//               instances)
//   views()     every live view: on screen or not, WebGL or not, its atlas and decorations, an instance number
//               that changes when the view is recreated (warm instances are kept, others rebuilt from a snapshot)
//   glCanvas()  a view's WebGL canvas (E-TERM-4 forces a context loss on it)
//   terminal()  a view's xterm `Terminal`, to follow its renders (E-TERM-4: which frame each renderer first paints in)
//   text()      the whole buffer of the view on screen, scrollback included (E-TERM-2 checks its continuity)
//   write()     write into the view on screen as if from its PTY (L-TERM-1 writes 1 MB per cycle)
//   setTheme()  apply theme colours to every view, as a settings change would (E-PTY-1)
//   atlas()     a WebGL view's glyph atlas three ways (L-TERM-3, L-TERM-7): the pages its guard counts, the pages its
//               renderer's atlas really holds, and the pages its GPU texture units still hold a copy of
//   pane()      what the main column shows: `{ kind: 'session', id }`, `{ kind: 'composer', projectId }` or
//               `{ kind: 'shells' }`
//   layout()    the persisted layout and the widths drawn at the window's width (`sidebar`, `tree`, 0 when hidden;
//               `treeAuto` when the window is too narrow for the file panel)
//   firstShell() what the `shells` pane last decided about the first shell: `opened`, `none`, `gone` (it had
//               left first), or null before any decision (E-PTY-3 waits on it instead of on time)
//   rpcPending() the window's calls still waiting for core's answer: 0 once an overlay that asked core for something
//               as it opened has it (L-MEM-18 closes each sheet only then, so every cycle draws the same things)
//   holdAnswers() core's answers to the methods named reach the window only when each is released
//               (`releaseAnswers()`; `heldAnswers()` counts the answers waiting), as from a slow core: a test puts
//               answers in the order a slow machine gives them (E-FV-10: a file's gutter lines before the file)
//   focus()     a stand-in for the window's keyboard focus (true / false; null follows the window): a test window can
//               never take it, and whether the user is viewing a session depends on it (E-ST-2). `viewing()` is what
//               the window reports to core as viewed
//   run()       run a command with an argument, as a row or a link would (`viewer.open` with its request opens a file
//               or a diff without the file panel's UI); false when it is not available. `reason()` is why a command is
//               unavailable, as a menu or the palette says it; undefined when it is available. `menuState()` is
//               what the window reports to main for its menu bar (its commands and the keys the person changed: the
//               ground truth L-MEM-20 checks `main.menuStates` against)
//   fileTabs()  a session's file and diff tabs as the window holds them, and the one on screen
//   viewer()    the file viewer on screen: what its header shows, the document's size, selection, scroll, folds and
//               tokenised lines, and the viewer's resource rows; null with no file or diff tab on screen.
//               `viewerText()` is the document's whole text; `viewerCopy()` what `⌘C` would copy (the clipboard is
//               never touched). `classes` also holds `EditorView` and `MergeView` (L-FV-1, L-FV-2) and the palette's
//               `PaletteData` (L-PAL-1). `timeOpen()` runs `viewer.open` and times the frames that draw the document
//               and its first colours (the viewer's performance tests)
//   timeRow()   times the frame that draws a row of the file panel (the file panel's performance tests;
//               features/files/resources.ts)
//   palette     the palette's timings (P-UI-2, P-UI-3) and its usage counts (features/palette/probes.ts)
//   setScope()  the file panel's scope for a session (`files.setScope`), as the Changes header's switch sets it: the
//               viewer's suite follows a diff across it (E-DF-1) without the panel's UI
//   call()      one core call by name, without the UI
//   store()     a core store's rows as the window holds them, followed from the first call on and across core
//               restarts as any view's subscription is (`lib/rpc.ts`); null until its first snapshot. `dropStore()`
//               ends it

import { Terminal, type ITheme } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { commands } from '../features/commands/registry.ts'
import { call, heldAnswers, holdAnswers, releaseAnswers, rpcStats, subscribe } from './rpc.ts'
import { activeView, terminals } from '../features/terminal/views.ts'
import type { TerminalView } from '../features/terminal/view.ts'
import { ui } from '../features/sessions/state.svelte.ts'
import { fileTabsOf, fileTabsState } from '../shell/fileTabs.svelte.ts'
import { drawn } from '../shell/layout.ts'
import { firstShell } from '../shell/terminalPane.ts'
import { layoutState } from '../shell/layoutStore.svelte.ts'
import { setFocusOverride, viewedSession } from '../features/status/viewing.svelte.ts'
import { timeRow } from '../features/files/resources.ts'
import { paletteProbe } from '../features/palette/probes.ts'
import { PaletteData } from '../features/palette/data.ts'
import { timeOpen, VIEWER_CLASSES, viewerCopy, viewerProbe, viewerText } from '../features/viewer/resources.ts'

export interface ViewProbe {
  ptyId: string
  /** On screen (painted), or the one being switched to. */
  shown: boolean
  visible: boolean
  attached: boolean
  webgl: boolean
  /** Changes whenever the view (and its `Terminal`) is created anew. */
  instance: number
  atlas: { bytes: number; pages: number; clears: Record<string, number> }
  /** Decorations registered on its `Terminal` (find highlights). */
  decorations: number
  findOpen: boolean
  cols: number
  rows: number
}

type Internals = {
  atlas: { clears: Record<string, number> }
  glCanvas: HTMLCanvasElement | null
  webgl: WebglAddon | null
}

/** A view's atlas: page canvases as numbers (the same canvas, the same number, in every view of the window). */
export interface AtlasProbe {
  /** The atlas object the view's renderer uses (views with the same font and colours share one). */
  atlas: number
  /** Pages the view's guard counts, and their bytes. */
  guard: number[]
  guardBytes: number
  /** Pages the atlas holds (`_charAtlas.pages`), and their bytes (width × height × 4, as the guard counts). */
  real: number[]
  realBytes: number
  /** Pages whose texture this view's WebGL context still holds (the patch's `pageCanvas`). */
  textures: number[]
}
type AtlasInternals = {
  _renderer?: {
    _charAtlas?: { pages: { canvas: HTMLCanvasElement }[] }
    _glyphRenderer?: { value?: { _atlasTextures: { pageCanvas?: HTMLCanvasElement }[] } }
  }
}

const objectIds = new WeakMap<object, number>() // weak: never keeps a released canvas or atlas alive
let nextObjectId = 1
function idOf(o: object): number {
  let n = objectIds.get(o)
  if (n === undefined) {
    n = nextObjectId++
    objectIds.set(o, n)
  }
  return n
}

function atlasProbe(v: TerminalView): AtlasProbe | null {
  const gl = (v as unknown as Internals).webgl as unknown as AtlasInternals | null
  const atlas = gl?._renderer?._charAtlas
  if (!atlas) return null
  const sorted = (xs: number[]) => xs.sort((a, b) => a - b)
  let guardBytes = 0
  const guard: number[] = []
  for (const [c, bytes] of v.atlasPages()) {
    guard.push(idOf(c))
    guardBytes += bytes
  }
  const realBytes = atlas.pages.reduce((n, p) => n + p.canvas.width * p.canvas.height * 4, 0)
  const units = gl?._renderer?._glyphRenderer?.value?._atlasTextures ?? []
  return {
    atlas: idOf(atlas),
    guard: sorted(guard),
    guardBytes,
    real: sorted(atlas.pages.map((p) => idOf(p.canvas))),
    realBytes,
    textures: sorted(units.flatMap((u) => (u.pageCanvas ? [idOf(u.pageCanvas)] : []))),
  }
}
type XtermInternals = { _core: { _decorationService: { decorations: IterableIterator<unknown> } } }

const instances = new WeakMap<Terminal, number>() // weak: never keeps a disposed terminal alive
let nextInstance = 1

function instanceOf(t: Terminal): number {
  let n = instances.get(t)
  if (n === undefined) {
    n = nextInstance++
    instances.set(t, n)
  }
  return n
}

function probe(v: TerminalView): ViewProbe {
  const inner = v as unknown as Internals
  const t = v.xterm
  const a = v.atlasStats()
  return {
    ptyId: v.ptyId,
    shown: terminals.isShown(v.ptyId),
    visible: terminals.visible() === v,
    attached: v.isAttached,
    webgl: v.hasWebgl,
    instance: instanceOf(t),
    atlas: { bytes: a.bytes, pages: a.pages, clears: { ...inner.atlas.clears } },
    decorations: [...(t as unknown as XtermInternals)._core._decorationService.decorations].length,
    findOpen: v.findOpen,
    cols: t.cols,
    rows: t.rows,
  }
}

// bounded: the stores a test asked to follow (a handful), each removed by `dropStore`; test builds only
const followed = new Map<string, { rows: Record<string, unknown> | null; snapshots: number; off: () => void }>()

function storeProbe(name: string): { rows: Record<string, unknown> | null; snapshots: number } {
  let f = followed.get(name)
  if (!f) {
    const entry = { rows: null as Record<string, unknown> | null, snapshots: 0, off: () => undefined as void }
    entry.off = subscribe<unknown>(name, (data, changed) => {
      entry.rows = Object.fromEntries(data)
      if (changed === null) entry.snapshots++
    })
    followed.set(name, (f = entry))
  }
  return { rows: f.rows, snapshots: f.snapshots }
}

export function installTestProbes(): void {
  ;(window as unknown as { __keaProbe: unknown }).__keaProbe = {
    classes: { Terminal, SearchAddon, WebglAddon, ...VIEWER_CLASSES, PaletteData },
    views: (): ViewProbe[] => terminals.liveIds().flatMap((id) => (terminals.get(id) ? [probe(terminals.get(id)!)] : [])),
    glCanvas: (ptyId: string): HTMLCanvasElement | null => (terminals.get(ptyId) as unknown as Internals | undefined)?.glCanvas ?? null,
    terminal: (ptyId: string): Terminal | undefined => terminals.get(ptyId)?.xterm,
    text(): string {
      const v = activeView()
      if (!v) throw new Error('no active terminal')
      const b = v.xterm.buffer.active
      const out: string[] = []
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
      return out.join('\n')
    },
    write(data: string): Promise<void> {
      const v = activeView()
      if (!v) return Promise.reject(new Error('no active terminal'))
      return new Promise<void>((resolve) => v.xterm.write(data, resolve))
    },
    setTheme(theme: ITheme): void {
      for (const v of terminals.all()) v.xterm.options.theme = theme
    },
    atlas: (ptyId: string): AtlasProbe | null => {
      const v = terminals.get(ptyId)
      return v ? atlasProbe(v) : null
    },
    pane: () => ui.pane,
    firstShell: () => firstShell.decision,
    focus: (v: boolean | null) => setFocusOverride(v),
    viewing: () => viewedSession(),
    layout: () => {
      const { layout, width } = layoutState
      return { ...layout, drawn: drawn(layout, width) }
    },
    run: (id: string, args?: unknown): boolean => commands.run(id, args),
    reason: (id: string, args?: unknown): string | undefined => commands.reason(id, args),
    menuState: () => commands.menuState(),
    fileTabs: (sessionId: string) => ({ tabs: fileTabsOf(sessionId).tabs, shown: fileTabsState.shown }),
    viewer: () => viewerProbe(),
    viewerText: () => viewerText(),
    viewerCopy: () => viewerCopy(),
    timeOpen: (req: { path: string }, colours: boolean) => timeOpen(() => void commands.run('viewer.open', req), { path: req.path, colours }),
    timeRow: (o: { selector: string; from: 'key' | 'now'; timeoutMs?: number }) => timeRow(o),
    palette: paletteProbe(),
    setScope: (sessionId: string, scope: 'branch' | 'uncommitted') => call('files.setScope', { sessionId, scope }).then((r) => r.ok),
    call: (method: string, args: unknown): Promise<unknown> => call(method as never, args as never),
    /** The window's calls still waiting for core's answer (a sheet's preview, the composer's bases): 0 at rest. */
    rpcPending: (): number => rpcStats().pendingCalls,
    holdAnswers: (methods: string[]): void => holdAnswers(methods),
    heldAnswers: (): Record<string, number> => heldAnswers(),
    releaseAnswers: (method?: string): void => releaseAnswers(method),
    store: (name: string) => storeProbe(name),
    dropStore(name: string): void {
      followed.get(name)?.off()
      followed.delete(name)
    },
  }
}
