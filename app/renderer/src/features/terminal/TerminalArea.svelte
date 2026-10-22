<!--
The terminal area: one host per live view, all stacked in the same place. The component holds ids only; views come
from the registry (never in `$state`), which decides which live.

Switching (P-TERM-7): a warm view is shown at once. A view created for the switch is laid out but invisible
until its snapshot has painted; the previous terminal stays on screen meanwhile, so there is no blank frame. Every
step runs in effects, after the DOM is updated and before the frame is painted. A session switch replaces the whole
pane (and this area with it): the area that comes keeps the terminal the old one had on screen until its own has
painted, whichever of the two Svelte makes first. Views no area hosts wait, hidden and alive, in the window's dock
(`views.ts`: other sessions' warm terminals).
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { isTypedText } from '@kea/protocol'
  import { pathForFile } from '../../lib/bridge.ts'
  import { call } from '../../lib/rpc.ts'
  import { commands } from '../commands/registry.ts'
  import { showToast, terminalsList } from '../sessions/state.svelte.ts'
  import { dropText, mentionText, parseDraggedPath, PATH_DRAG_TYPE, takesDrop, type Dropped } from './drop.ts'
  import FindBar from './FindBar.svelte'
  import Overlays from './Overlays.svelte'
  import { NO_RESULTS } from './find.ts'
  import { terminalUi } from './ui.svelte.ts'
  import type { ActivateOptions } from './registry.ts'
  import { sendText } from './sendText.ts'
  import { dockView, enterArea, followScroll, leaveArea, terminals } from './views.ts'

  type Mode = 'shown' | 'pending' | 'hidden'

  let {
    tabs,
    active,
    sessionId = null,
    options = () => ({}),
  }: {
    tabs: readonly string[]
    active: string | null
    /** The session whose terminals these are; null for the plain shells (a drop is then typed by the view itself). */
    sessionId?: string | null
    /** How the switch judges the terminals outside `tabs` (pinned tabs, the other sessions' Agent terminals). */
    options?: (next: string | null, open: readonly string[]) => ActivateOptions
  } = $props()
  let live = $state.raw<string[]>([])
  // the terminal the area before this one had on screen stays on screen here until this one's has painted
  const token = {}
  let shown = $state<string | null>(enterArea(token))
  // focus moves once the revealed host is visible (a hidden or invisible element cannot take focus)
  let focusOnShow = false

  /** A host's view element goes in when the host mounts and leaves with it; the view itself stays in the registry. */
  const mountView =
    (id: string): Attachment<HTMLDivElement> =>
    (el) => {
      const v = terminals.get(id)
      if (!v) return
      v.mount(el)
      return () => dockView(v, el)
    }

  /** The hosts: the open tabs with a view, and the handed-over terminal while it is still on screen. */
  const hosted = (open: readonly string[]): string[] => {
    const ids = open.filter((id) => terminals.get(id))
    return shown && !ids.includes(shown) && terminals.get(shown) ? [...ids, shown] : ids
  }

  /** The switch is on screen. Find belongs to the terminal on screen: every other view's search closes. */
  function reveal(id: string | null, open: readonly string[], hadFocus: boolean): void {
    for (const view of terminals.all()) if (view.ptyId !== id) view.closeFind()
    terminals.setShown(id)
    shown = id
    live = hosted(open)
    focusOnShow = hadFocus || document.activeElement === document.body || document.activeElement === null
    const now = id ? terminals.get(id) : undefined
    terminalUi.scrolledUp(now?.state.scrolledUp ?? false)
    terminalUi.find({ open: false, results: NO_RESULTS })
    commands.changed()
  }

  /**
   * Reveal `id` once its view has painted its snapshot; the returned teardown cancels it. Its closures hold ids and
   * flags only, never a view: the switch effect keeps the teardown until it runs again, and a view it held (the one
   * left, disposed once the switch is shown) would stay reachable until then (L-TERM-9).
   */
  function revealWhenPainted(attached: Promise<void>, id: string, open: readonly string[], hadFocus: boolean): () => void {
    let cancelled = false
    void attached.then(() =>
      requestAnimationFrame(() => {
        if (!cancelled) reveal(id, open, hadFocus)
      }),
    )
    return () => {
      cancelled = true
    }
  }

  // (views are used here synchronously only; no closure made here may capture one, see revealWhenPainted)
  function switchTo(next: string | null, open: readonly string[]): (() => void) | undefined {
    const prevShown = terminals.shown()
    const v = terminals.activate(next, open, options(next, open))
    live = hosted(open)
    for (const id of open) {
      const view = terminals.get(id)
      if (view) view.onState = followScroll(id)
    }
    const hadFocus = !!prevShown?.hasFocus()
    if (!v) {
      reveal(null, open, false)
      return
    }
    if (v === prevShown) return
    if (v.isAttached) {
      reveal(v.ptyId, open, hadFocus)
      return
    }
    // keystrokes must not reach the terminal being replaced while the new one paints
    prevShown?.blur()
    return revealWhenPainted(v.attached, v.ptyId, open, hadFocus)
  }

  // the area goes (a session switch replaces the pane): the terminal on screen is handed to the next area
  $effect(() => () => leaveArea(token))

  // the switch follows the active tab and the open tabs, nothing else
  $effect(() => {
    const next = active
    const open = tabs
    return untrack(() => switchTo(next, open))
  })

  // `shown` is written by the switch effect above, so this effect can run before the hosts' classes are updated in the
  // same flush: focus once the DOM is up to date (still before the frame is painted)
  $effect(() => {
    const id = shown
    void live
    untrack(() => {
      if (!id || !focusOnShow) return
      focusOnShow = false
      void tick().then(() => {
        if (terminals.isShown(id)) terminals.get(id)?.focus()
      })
    })
  })

  // a tab closed under the shown view
  $effect(() => {
    if (shown && !live.includes(shown)) shown = null
  })

  const modeOf = (id: string): Mode => (id === shown ? 'shown' : id === active ? 'pending' : 'hidden')

  // ── Files from other apps and rows of the file tree dropped on the terminal are typed at its prompt ──

  function onDragOver(e: DragEvent): void {
    if (!shown || !e.dataTransfer || !takesDrop(e.dataTransfer.types)) return
    // taken here: the window does not read a dropped folder as a project to add
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDrop(e: DragEvent): void {
    const dt = e.dataTransfer
    const ptyId = shown
    if (!ptyId || !dt || !takesDrop(dt.types)) return
    e.preventDefault()
    const row = parseDraggedPath(dt.getData(PATH_DRAG_TYPE))
    // a mention is for the agent's terminal: on a shell or the dev server's tab `⌥` types the shell's form
    const dropped = dropText({ row, files: [...dt.files].map(pathForFile), alt: e.altKey, agent: sessionId !== null && terminalsList.get(ptyId)?.kind === 'agent' })
    if ('mention' in dropped) {
      // the form is the agent's (a name with a space is quoted its way): core's adapter says it
      const sid = sessionId
      if (sid === null) return
      void call('agents.mention', { sessionId: sid, path: dropped.mention })
        .then((r) => r.text, () => null)
        .then((answer) => typeDropped(sid, ptyId, mentionText(answer)))
      return
    }
    typeDropped(sessionId, ptyId, dropped)
  }

  function typeDropped(sid: string | null, ptyId: string, d: Dropped): void {
    if (d.refused !== null) showToast({ message: d.refused })
    if (d.text === '') return
    // Through core for a session's terminal (the one dropped on); a plain shell's view types it itself, under
    // the same rule as core's gate: nothing with a control character is typed for the person
    if (sid !== null) void sendText(sid, d.text, { ptyId })
    else if (isTypedText(d.text)) terminals.get(ptyId)?.input(d.text)
    terminals.get(ptyId)?.focus()
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (a drop target only: the terminal inside has the keyboard) -->
<div class="terminal-area" ondragover={onDragOver} ondrop={onDrop}>
  {#each live as id (id)}
    {@const mode = modeOf(id)}
    <div class="terminal-host {mode}" data-pty={id} aria-hidden={mode !== 'shown'} {@attach mountView(id)}></div>
  {/each}
  <FindBar />
  <Overlays />
</div>
