// The terminal instance policy: which xterm instances the renderer keeps and which of them hold a WebGL context. Pure
// data in, data out. A window shows at most one terminal per pane (the work pane, and the agent pane beside it):
//
//   visible  the terminals on screen, or being switched to, one per pane (WebGL)
//   leaving  the terminals still on screen while a visible one paints its snapshot (no blank frame); kept, with
//            WebGL ahead of the warm ones, until the switch is shown
//   pinned   the active session's other tabs: alive, but no WebGL context (the `shells` pseudo-session: none)
//   warm     the most recently viewed others that may be warm (`warmable`), up to `warm` (the window passes
//            `L.warmTerminals`): the Agent terminals of the most recently viewed other sessions (the `shells`
//            pseudo-session's tabs count as such). Alive and hidden; WebGL for those the cap leaves room for, by recency
//
// Everything else exists only in ptyhost and is recreated from a snapshot when shown. WebGL contexts never exceed
// `glMax`, however the inputs are chosen: the terminals on screen and arriving come first, then the leaving ones, so
// a terminal on screen never changes renderer during a switch, and the warm ones take what is left.

export interface RetentionInput {
  /** The terminals on screen or being switched to, one per pane (a pane showing no terminal has none). */
  visible: readonly string[]
  /** Most recently viewed first; may contain ids that are gone (they are skipped). */
  mru: readonly string[]
  /** Ids that still exist (open tabs). */
  exists: (id: string) => boolean
  /** Ids that have a live view now: only those can be kept warm (a warm terminal is never created in advance). */
  alive: (id: string) => boolean
  pinned?: readonly string[]
  /** Which ids may be kept warm (default: any). */
  warmable?: (id: string) => boolean
  /** The terminals still on screen while a visible one paints (none once the switch is shown). */
  leaving?: readonly string[]
  warm: number
  glMax: number
}

export interface Retention {
  /** Views to keep (everything else is disposed), visible first. */
  keep: string[]
  /** Views that hold a WebGL context, in the order they are owed one: visible, leaving, warm; at most `glMax`. */
  webgl: string[]
}

export function retention(i: RetentionInput): Retention {
  const keep: string[] = []
  const add = (id: string | null) => {
    if (id !== null && i.exists(id) && !keep.includes(id)) keep.push(id)
  }
  const visible = i.visible.filter((id, n) => i.exists(id) && i.visible.indexOf(id) === n)
  for (const id of visible) add(id)
  for (const id of i.pinned ?? []) add(id)
  const warm: string[] = []
  for (const id of i.mru) {
    if (warm.length >= i.warm) break
    if (keep.includes(id) || !i.exists(id) || !i.alive(id) || (i.warmable && !i.warmable(id))) continue
    warm.push(id)
  }
  keep.push(...warm)
  // the terminals still on screen keep their WebGL until the switch is shown, ahead of the warm ones (they are on screen)
  const leaving = (i.leaving ?? []).filter((id) => !visible.includes(id) && i.exists(id) && i.alive(id))
  for (const id of leaving) if (!keep.includes(id)) keep.push(id)
  const owed = [...visible, ...leaving, ...warm]
  const webgl = owed.filter((id, n) => owed.indexOf(id) === n).slice(0, i.glMax)
  return { keep, webgl }
}

/** Move `id` to the front of the most-recently-viewed list, dropping ids that no longer exist. */
export function touch(mru: readonly string[], id: string, exists: (id: string) => boolean): string[] {
  return [id, ...mru.filter((x) => x !== id && exists(x))]
}
