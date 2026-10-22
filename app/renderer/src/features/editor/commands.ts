// The editor's commands: Open in Editor for a session (`⌘⇧O`, the split button's primary click) and for a project,
// Open in… (each detected editor), Open in Terminal App, and Create Pull Request in the header's overflow
// (`gh pr create --web`). Reveal Worktree in Finder and Copy Worktree Path, the caret menu's other two, are the
// sessions feature's. The file panel's and the viewer's own Open in Editor are theirs; every one of them goes through
// `open.ts`. `App.svelte` calls this once for the window.

import { SETTINGS, type EditorOpenRequest, type SessionView } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { call } from '../../lib/rpc.ts'
import { named } from '../commands/bindings.svelte.ts'
import { commands } from '../commands/registry.ts'
import { projectOf, sessionOf } from '../sessions/commands.ts'
import { settings } from '../settings/store.ts'
import { launchFailed, openInEditor } from './open.ts'
import { editorState, installEditorState, wantEditorMenu } from './state.svelte.ts'

/** A session whose folder can be opened: any that has one on disk, archived and detached included. */
const hasFolder = (s: SessionView | undefined): s is SessionView => !!s && !s.worktreeMissing && s.lifecycle !== 'creating' && s.lifecycle !== 'create_failed' && s.lifecycle !== 'deleted'
const NO_FOLDER = 'The session has no folder to open'

const editorArg = (a: unknown): string | undefined => {
  const e = typeof a === 'object' && a !== null ? (a as { editor?: unknown }).editor : undefined
  return typeof e === 'string' && e ? e : undefined
}

/** Why there is no terminal app to open: none was found, or the one the setting names is not installed. */
function noTerminalApp(): string {
  const chosen = settings.get<string>('general.terminalApp')
  const name = chosen === 'auto' ? null : (SETTINGS.find((d) => d.key === 'general.terminalApp')?.options?.find((o) => o.value === chosen)?.label ?? chosen)
  return name === null ? 'none was found' : `${name} was not found (Settings › General › Terminal app)`
}

/** The session's folder in the terminal app. */
async function openTerminalApp(sessionId: string): Promise<void> {
  try {
    const r = await call('editor.openTerminalApp', { target: 'session', id: sessionId })
    if (!r.ok) launchFailed(r.reason === 'unavailable' ? `Couldn't open a terminal app: ${noTerminalApp()}` : "Couldn't open the terminal app", r.message)
  } catch (e) {
    launchFailed("Couldn't open the terminal app", e instanceof Error ? e.message : String(e))
  }
}

/** `session.createPR`: the pull request page for the session's branch, through the GitHub CLI. */
async function createPR(sessionId: string): Promise<void> {
  try {
    const r = await call('editor.createPR', { sessionId })
    if (r.ok) return
    launchFailed(r.reason === 'noGh' ? "Couldn't create the pull request: the GitHub CLI (gh) is not installed" : r.reason === 'noBranch' ? "Couldn't create the pull request: the session has no branch" : "Couldn't create the pull request", r.message)
  } catch (e) {
    launchFailed("Couldn't create the pull request", e instanceof Error ? e.message : String(e))
  }
}

export function registerEditorCommands(): Disposable {
  const state = installEditorState()
  const ds: Disposable[] = [
    commands.register('session.openInEditor', {
      run: (a) => {
        const s = sessionOf(a)
        if (s) void openInEditor({ target: 'session', id: s.id })
      },
      when: (a) => hasFolder(sessionOf(a)),
      unavailableReason: () => NO_FOLDER,
    }),
    commands.register('project.openInEditor', {
      run: (a) => {
        const p = projectOf(a)
        if (p) void openInEditor({ target: 'project', id: p.id })
      },
      when: (a) => !!projectOf(a) && !projectOf(a)!.missing,
      unavailableReason: (a) => (projectOf(a) ? 'The project folder is missing' : named('project.add', 'Add a project first')),
    }),
    // one menu item per detected editor runs it with `{ id, editor }`; from the menu bar it shows the button's menu
    commands.register('view.openIn', {
      run: (a) => {
        const s = sessionOf(a)
        const editor = editorArg(a)
        if (!s) return
        if (!editor) wantEditorMenu()
        else {
          const req: EditorOpenRequest = { target: 'session', id: s.id, editor }
          void openInEditor(req)
        }
      },
      when: (a) => hasFolder(sessionOf(a)),
      unavailableReason: () => NO_FOLDER,
      // the table's title carries a note ("each detected editor"); the menu bar and the palette show it without
      title: () => 'Open in…',
      // The palette lists the detected editors in place of the button's menu
      argument: () => (editorState.list.editors.length === 0 ? undefined : { placeholder: 'Open in…', choices: () => editorState.list.editors.map((e) => ({ label: e.name, args: { editor: e.id } })) }),
    }),
    commands.register('view.openInTerminalApp', {
      run: (a) => {
        const s = sessionOf(a)
        if (s) void openTerminalApp(s.id)
      },
      when: (a) => hasFolder(sessionOf(a)) && editorState.list.terminalApp !== null,
      unavailableReason: (a) => (hasFolder(sessionOf(a)) ? `No terminal app: ${noTerminalApp()}` : NO_FOLDER),
      keepInMenus: true,
    }),
    // in the header's overflow whenever the session is there, disabled with its reason when it cannot run
    commands.register('session.createPR', {
      run: (a) => {
        const s = sessionOf(a)
        if (s) void createPR(s.id)
      },
      when: (a) => {
        const s = sessionOf(a)
        return hasFolder(s) && !!s.branch && editorState.list.gh
      },
      unavailableReason: (a) => {
        const s = sessionOf(a)
        if (!hasFolder(s)) return NO_FOLDER
        return s.branch ? 'The GitHub CLI (gh) is not installed' : 'The session has no branch (in place)'
      },
      keepInMenus: true,
    }),
  ]
  return {
    dispose() {
      disposeAll(ds)
      state.dispose()
    },
  }
}
