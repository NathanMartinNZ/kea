// The sessions feature's commands (the command table's Session and Project categories): titles, bindings and menu
// placement come from the command table; this file says what each does and when it is available. A contextual menu runs
// a command with its row (`{ id }` a session, `{ projectId }` a project); a key or the menu bar acts on the active
// session or the window's project. The categories' other commands (Open in Editor, Report Wrong Status, Show Launch
// Config, Remove Build Folders, …) are registered by their own features (`features/editor`, `features/status`,
// `features/disk`, `features/settings`).

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { heldSessions, type Project, type SessionView } from '@kea/protocol'
import { watch } from '../../lib/reactive.svelte.ts'
import { named } from '../commands/bindings.svelte.ts'
import { commands } from '../commands/registry.ts'
import { addProject, archiveSession, askRemoveProject, copyText, duplicateSession, resyncFiles, revealPath, sessionCall } from './actions.ts'
import { conditions } from '../status/state.ts'
import { jumpTargets, nextNeedingYou, sidebarRows } from './model.ts'
import { activeSession, activeSessionId, contextProjectId, mru, openComposer, projects, selectSession, sessionOrder, sessionRows, sessions, ui } from './state.svelte.ts'

type Args = { id?: unknown; projectId?: unknown; index?: unknown } | undefined

function obj(a: unknown): Args {
  return typeof a === 'object' && a !== null ? (a as Args) : undefined
}

/** The session a command acts on: its row's, else the active one. */
export function sessionOf(args: unknown): SessionView | undefined {
  const id = obj(args)?.id
  return typeof id === 'string' ? sessions.get(id) : activeSession()
}

/** The project a command acts on: its row's, else the window's. */
export function projectOf(args: unknown): Project | undefined {
  const id = obj(args)?.projectId
  if (typeof id === 'string') return projects.get(id)
  const ctx = contextProjectId()
  return ctx ? projects.get(ctx) : undefined
}

/** The sidebar's visible rows now (⌘1…9 counts them). */
export function currentRows() {
  return sidebarRows({ projects: projects.values(), sessions: sessions.values(), order: sessionOrder(), filter: ui.filter ?? '', archivedOpen: ui.archivedOpen, held: heldSessions(conditions.values()) })
}

const noSession = () => 'No session is selected'
const noProject = () => named('project.add', 'Add a project first')
const has = (s: SessionView | undefined, ...lifecycles: SessionView['lifecycle'][]) => !!s && lifecycles.includes(s.lifecycle)
const worktreeThere = (s: SessionView | undefined) => !!s && !s.worktreeMissing && s.lifecycle !== 'creating' && s.lifecycle !== 'create_failed' && s.lifecycle !== 'deleted'

/** ⌃ is down: ⌃Tab keeps cycling until it is released. */
let ctrlHeld = false

export function registerSessionCommands(): Disposable {
  const step = (dir: 1 | -1) => {
    const target = mru.step(dir, ctrlHeld, activeSessionId())
    if (target) selectSession(target, { cycling: ctrlHeld })
  }
  const ds: Disposable[] = [
    // ── Session ──
    commands.register('session.new', {
      run: (a) => {
        const p = projectOf(a)
        if (p) openComposer(p.id)
      },
      when: (a) => !!projectOf(a),
      unavailableReason: noProject,
    }),
    commands.register('session.newInProject', {
      // with a project (the palette's pick) the composer opens for it; without one, on its project picker
      run: (a) => {
        const picked = typeof obj(a)?.projectId === 'string' ? projectOf(a) : undefined
        const p = picked ?? projectOf(undefined)
        if (p) openComposer(p.id, picked ? {} : { pickProject: true })
      },
      when: () => projects.size > 0,
      unavailableReason: noProject,
      // The palette lists the projects in place of the picker
      argument: () => ({
        placeholder: 'New session in project…',
        choices: () => [...projects.values()].sort((x, y) => x.sortOrder - y.sortOrder).map((p) => ({ label: p.name, detail: p.rootPath, args: { projectId: p.id } })),
      }),
    }),
    commands.register('session.rename', {
      run: (a) => {
        const s = sessionOf(a)
        if (!s) return
        if (activeSessionId() !== s.id) selectSession(s.id)
        ui.renaming = s.id
      },
      when: (a) => !!sessionOf(a) && sessionOf(a)!.lifecycle !== 'deleted',
      unavailableReason: noSession,
    }),
    commands.register('session.reveal', { run: (a) => revealPath(sessionOf(a)!.cwd), when: (a) => worktreeThere(sessionOf(a)), unavailableReason: () => 'The session has no folder to reveal' }),
    commands.register('session.copyBranch', { run: (a) => void copyText(sessionOf(a)!.branch!), when: (a) => !!sessionOf(a)?.branch, unavailableReason: () => 'The session has no branch (in place)' }),
    commands.register('session.copyWorktreePath', { run: (a) => void copyText(sessionOf(a)!.cwd), when: (a) => !!sessionOf(a), unavailableReason: noSession }),
    commands.register('session.duplicate', {
      run: (a) => void duplicateSession(sessionOf(a)!.id),
      when: (a) => has(sessionOf(a), 'live', 'detached', 'archived'),
      unavailableReason: noSession,
    }),
    commands.register('session.stop', { run: (a) => void sessionCall('sessions.stop', sessionOf(a)!.id, 'stop the agent'), when: (a) => has(sessionOf(a), 'live'), unavailableReason: () => 'The agent is not running' }),
    commands.register('session.resume', { run: (a) => void sessionCall('sessions.resume', sessionOf(a)!.id, 'resume the session'), when: (a) => has(sessionOf(a), 'detached'), unavailableReason: () => 'The agent is running' }),
    commands.register('session.restart', { run: (a) => void sessionCall('sessions.restart', sessionOf(a)!.id, 'restart the agent'), when: (a) => has(sessionOf(a), 'detached'), unavailableReason: () => 'The agent is running' }),
    commands.register('session.archive', { run: (a) => void archiveSession(sessionOf(a)!.id), when: (a) => has(sessionOf(a), 'live', 'detached'), unavailableReason: noSession }),
    commands.register('session.unarchive', { run: (a) => void sessionCall('sessions.unarchive', sessionOf(a)!.id, 'unarchive the session'), when: (a) => has(sessionOf(a), 'archived'), unavailableReason: () => 'The session is not archived' }),
    commands.register('session.delete', {
      run: (a) => {
        ui.sheet = { kind: 'delete', sessionId: sessionOf(a)!.id }
      },
      when: (a) => has(sessionOf(a), 'live', 'detached', 'archived'),
      unavailableReason: noSession,
    }),
    // In the project's menu even when nothing is restorable, disabled with that reason
    commands.register('session.restoreDeleted', {
      run: (a) => {
        ui.sheet = { kind: 'restoreDeleted', projectId: projectOf(a)!.id }
      },
      when: (a) => (projectOf(a)?.restorable ?? 0) > 0,
      unavailableReason: (a) => {
        const p = projectOf(a)
        return p ? `No session of ${p.name} was deleted recently` : noProject()
      },
      keepInMenus: true,
    }),
    commands.register('session.next', { run: () => step(1), when: () => mru.size > 0, unavailableReason: () => 'No other session' }),
    commands.register('session.previous', { run: () => step(-1), when: () => mru.size > 0, unavailableReason: () => 'No other session' }),
    // The next session that needs you, in the attention order (an account condition's sessions left out)
    commands.register('session.jumpNeedsYou', {
      run: () => {
        const id = nextNeedingYou(sessionRows(), activeSessionId(), heldSessions(conditions.values()))
        if (id) selectSession(id)
      },
      when: () => nextNeedingYou(sessionRows(), activeSessionId(), heldSessions(conditions.values())) !== null,
      unavailableReason: () => 'No other session needs you',
    }),
    commands.register('session.jumpTo', {
      // without an index (the menu bar's item) the first row
      run: (a) => {
        const i = obj(a)?.index
        const id = jumpTargets(currentRows())[(typeof i === 'number' ? i : 1) - 1]
        if (id) selectSession(id)
      },
      when: (a) => {
        const i = obj(a)?.index
        return jumpTargets(currentRows()).length >= (typeof i === 'number' ? i : 1)
      },
      unavailableReason: () => 'No session in that place',
      // The palette lists the nine with their numbers
      argument: () => ({
        placeholder: 'Jump to session…',
        choices: () => jumpTargets(currentRows()).map((id, i) => ({ label: `${i + 1}  ${sessions.get(id)?.title ?? ''}`, args: { index: i + 1 } })),
      }),
    }),
    commands.register('session.resyncFiles', {
      run: (a) => void resyncFiles(sessionOf(a)!.id),
      when: (a) => sessionOf(a)?.isolation === 'worktree' && worktreeThere(sessionOf(a)) && has(sessionOf(a), 'live', 'detached'),
      unavailableReason: () => 'Only for a session with its own worktree',
    }),
    commands.register('session.retryTeardown', {
      run: (a) => void sessionCall('sessions.retryTeardown', sessionOf(a)!.id, 'run the teardown again'),
      when: (a) => !!sessionOf(a)?.teardownFailed,
      unavailableReason: () => 'No teardown failed',
    }),
    // ── Project ──
    commands.register('project.add', { run: () => void addProject() }),
    commands.register('project.reveal', { run: (a) => revealPath(projectOf(a)!.rootPath), when: (a) => !!projectOf(a) && !projectOf(a)!.missing, unavailableReason: () => 'The project folder is missing' }),
    // `project.settings` is the settings feature's (features/settings/commands.ts): it opens Settings › Projects
    commands.register('project.remove', { run: (a) => askRemoveProject(projectOf(a)!.id), when: (a) => !!projectOf(a), unavailableReason: noProject }),
  ]

  // ⌃Tab cycles while ⌃ is held; releasing it makes the session reached the most recent
  const onKey = (e: KeyboardEvent) => {
    const was = ctrlHeld
    ctrlHeld = e.ctrlKey && !(e.type === 'keyup' && e.key === 'Control')
    if (was && !ctrlHeld) mru.release()
  }
  const onBlur = () => {
    ctrlHeld = false
    mru.release()
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)
  window.addEventListener('blur', onBlur)

  // availability follows the stores and what the window shows
  const offs = [
    sessions.subscribeAny(() => commands.changed()),
    projects.subscribeAny(() => commands.changed()),
    watch(
      () => [ui.pane, ui.filter, ui.archivedOpen],
      () => commands.changed(),
    ),
  ]
  return {
    dispose: () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
      for (const off of offs) off()
      disposeAll(ds)
    },
  }
}

