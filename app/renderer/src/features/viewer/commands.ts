// The viewer's commands (the command table's Viewer category): Switch File / Diff, Go to Line…, Find in File, the wrap,
// preview and layout toggles, Next / Previous Change and Changed File, Send / Copy Reference, Open in Editor. They act
// on the viewer that has the screen (`controller.svelte.ts`); with none, they are unavailable with their reason. Two
// Viewer rows are the tab strip's and are registered by it (`shell/TerminalPane.svelte`): `viewer.open` and
// `viewer.pinTab`. `App.svelte` calls this once for the window.
//
// The viewer's keys without `⌘` (`⌃G`, `⌥Z`, `⌥↓`, `⌥↑`, `]`, `[`) are passed to it by the key router; it finds
// their command with `scopedBinding` and runs it (`Viewer.svelte`).

import { disposeAll, type Disposable } from '@kea/terminal'
import { reveal } from '../../lib/bridge.ts'
import { watch } from '../../lib/reactive.svelte.ts'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { openInEditor } from '../editor/open.ts'
import { copyText } from '../sessions/actions.ts'
import { activeSessionId, sessions, showToast } from '../sessions/state.svelte.ts'
import { wantAgentTab } from '../status/viewing.svelte.ts'
import { sendText } from '../terminal/sendText.ts'
import { currentViewer, forgetClosedTabs, forgetDocuments, setTabOracle, type NoteAction, type ViewerController } from './controller.svelte.ts'
import { NOT_REFERABLE, referable } from './reference.ts'

const NO_TAB = 'No file tab is showing'
const NO_TEXT = 'This tab shows no text'

const viewer = (): ViewerController | null => currentViewer()
const hasText = (): boolean => viewer()?.textView() != null
const whyNoText = (): string => (viewer() ? NO_TEXT : NO_TAB)

/** `File · Diff` on the tab: the same tab, the other view, at the same line. */
export function switchMode(c: ViewerController, to?: 'file' | 'diff'): void {
  const mode = to ?? (c.ui.mode === 'file' ? 'diff' : 'file')
  if (mode === c.ui.mode) return
  const pos = c.position()
  commands.run('viewer.open', { sessionId: c.session, path: c.ui.path, mode, ...(pos ? { line: pos.line, col: pos.col } : {}) })
}

/** The next or previous file of the Changes list, around the ends. */
function stepFile(c: ViewerController, dir: 1 | -1): void {
  const list = c.changedFiles()
  if (list.length === 0) return
  const i = list.findIndex((e) => e.path === c.ui.path)
  const next = list[i < 0 ? (dir === 1 ? 0 : list.length - 1) : (i + dir + list.length) % list.length]
  if (next && next.path !== c.ui.path) commands.run('viewer.open', { sessionId: c.session, path: next.path, mode: 'diff' })
}

const canStepFile = (): boolean => {
  const c = viewer()
  if (!c) return false
  const list = c.changedFiles()
  return list.length > 1 || (list.length === 1 && list[0]?.path !== c.ui.path)
}

/** Is there a reference to this tab's file? A name with a control character has none, and the person is told why. */
function canRefer(c: ViewerController): boolean {
  if (referable(c.ui.path)) return true
  showToast({ message: NOT_REFERABLE })
  return false
}

/** The reference at the agent's prompt, not submitted, and the Agent tab on screen. */
async function sendReference(c: ViewerController): Promise<void> {
  if (!canRefer(c)) return
  const ref = c.reference()
  if (!ref) return
  const sessionId = c.session
  if (await sendText(sessionId, ref)) wantAgentTab(sessionId)
  else showToast({ message: 'No agent is running in this session' })
}

export function openTabInEditor(c: ViewerController): void {
  const pos = c.position()
  void openInEditor({ target: 'session', id: c.session, path: c.ui.path, ...(pos ? { line: pos.line, col: pos.col } : {}) })
}

/** What a one-line body offers: Open in editor, Open with default app, Reveal in the file manager (Finder on macOS). */
export async function noteAction(c: ViewerController, action: NoteAction): Promise<void> {
  const sessionId = c.session
  const path = c.ui.path
  if (action === 'editor') openTabInEditor(c)
  else if (action === 'reveal') {
    const cwd = sessions.get(sessionId)?.cwd
    if (cwd) reveal(`${cwd.replace(/\/+$/, '')}/${path}`)
  } else {
    const r = await call('viewer.openDefault', { sessionId, path }).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
    if (!r.ok) showToast({ message: r.message ?? 'The file could not be opened' })
  }
}

export function copyPath(c: ViewerController): void {
  void copyText(c.ui.path)
}

/**
 * What the viewer is told of the tab strip, which owns the tabs: whether a file still has one, and when the tabs
 * change. The shell gives it (`App.svelte`); a feature does not import `shell/`.
 */
export interface TabStrip {
  has(sessionId: string, path: string): boolean
  /** Runs `fn` after every change to the tabs; the result stops it. */
  onChange(fn: () => void): () => void
}

export function registerViewerCommands(strip: TabStrip): Disposable {
  const ds = [
    commands.register('viewer.switchFileDiff', {
      run: () => {
        const c = viewer()
        if (c) switchMode(c)
      },
      when: () => {
        const c = viewer()
        return !!c && (c.ui.mode === 'diff' || c.ui.entry !== null)
      },
      unavailableReason: () => (viewer() ? 'This file has no changes' : NO_TAB),
    }),
    commands.register('viewer.goToLine', { run: () => viewer()?.goToLine(), when: hasText, unavailableReason: whyNoText }),
    commands.register('viewer.find', { run: () => viewer()?.find(), when: hasText, unavailableReason: whyNoText }),
    commands.register('viewer.toggleWrap', {
      run: () => viewer()?.toggleWrap(),
      when: () => {
        const c = viewer()
        return !!c && c.ui.body.kind === 'text' && c.ui.canWrap
      },
      unavailableReason: () => {
        const c = viewer()
        return !c ? NO_TAB : c.ui.body.kind !== 'text' ? 'Word wrap is for the file view' : 'This file has lines too long to wrap'
      },
    }),
    commands.register('viewer.toggleMarkdownPreview', {
      run: () => viewer()?.toggleOther(),
      when: () => viewer()?.ui.canPreview === true,
      unavailableReason: () => (viewer() ? 'Not a Markdown file that can be previewed' : NO_TAB),
    }),
    commands.register('viewer.toggleDiffLayout', {
      run: () => viewer()?.toggleLayout(),
      when: () => viewer()?.ui.body.kind === 'diff',
      unavailableReason: () => (viewer() ? 'No diff is showing' : NO_TAB),
    }),
    commands.register('viewer.nextChange', { run: () => viewer()?.stepChange(1), when: () => hasText() && (viewer()?.ui.changes ?? 0) > 0, unavailableReason: () => (hasText() ? 'No changes in this file' : whyNoText()) }),
    commands.register('viewer.previousChange', { run: () => viewer()?.stepChange(-1), when: () => hasText() && (viewer()?.ui.changes ?? 0) > 0, unavailableReason: () => (hasText() ? 'No changes in this file' : whyNoText()) }),
    commands.register('viewer.nextFile', {
      run: () => {
        const c = viewer()
        if (c) stepFile(c, 1)
      },
      when: canStepFile,
      unavailableReason: () => (viewer() ? 'No other changed file' : NO_TAB),
    }),
    commands.register('viewer.previousFile', {
      run: () => {
        const c = viewer()
        if (c) stepFile(c, -1)
      },
      when: canStepFile,
      unavailableReason: () => (viewer() ? 'No other changed file' : NO_TAB),
    }),
    commands.register('viewer.sendReference', {
      run: () => {
        const c = viewer()
        if (c) void sendReference(c)
      },
      when: hasText,
      unavailableReason: whyNoText,
    }),
    commands.register('viewer.copyReference', {
      run: () => {
        const c = viewer()
        if (!c || !canRefer(c)) return
        const ref = c.reference()
        if (ref) void copyText(ref)
      },
      when: hasText,
      unavailableReason: whyNoText,
    }),
    commands.register('viewer.openInEditor', {
      run: () => {
        const c = viewer()
        if (c) openTabInEditor(c)
      },
      when: () => viewer() !== null,
      unavailableReason: () => NO_TAB,
    }),
  ]
  // No document of a session that left the screen is kept, and none of a tab that is gone (the strip
  // says which files have one)
  const off = watch(activeSessionId, () => forgetDocuments(activeSessionId()))
  setTabOracle((sessionId, path) => strip.has(sessionId, path))
  const offTabs = strip.onChange(forgetClosedTabs)
  return {
    dispose() {
      off()
      offTabs()
      setTabOracle(null)
      disposeAll(ds)
    },
  }
}
