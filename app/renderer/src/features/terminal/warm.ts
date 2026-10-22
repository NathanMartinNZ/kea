// The terminal instance policy: which xterm instances the renderer keeps and which of them hold a WebGL context. Pure
// data in, data out:
//
//   visible  the terminal on screen, or being switched to (WebGL)
//   leaving  the terminal still on screen while the visible one paints its snapshot (no blank frame); kept,
//            with WebGL while the cap allows, until the switch is shown
//   pinned   the active session's other tabs: alive, but no WebGL context (the `shells` pseudo-session: none)
//   warm     the most recently viewed others that may be warm (`warmable`), up to `warm` (the window passes
//            `L.warmTerminals`): the Agent terminals of the most recently viewed other sessions (the `shells`
//            pseudo-session's tabs count as such). Alive, WebGL loaded, hidden
//
// Everything else exists only in ptyhost and is recreated from a snapshot when shown. WebGL contexts never
// exceed `glMax`, however the inputs are chosen.

export interface RetentionInput {
  visible: string | null
  /** Most recently viewed first; may contain ids that are gone (they are skipped). */
  mru: readonly string[]
  /** Ids that still exist (open tabs). */
  exists: (id: string) => boolean
  /** Ids that have a live view now: only those can be kept warm (a warm terminal is never created in advance). */
  alive: (id: string) => boolean
  pinned?: readonly string[]
  /** Which ids may be kept warm (default: any). */
  warmable?: (id: string) => boolean
  /** The terminal still on screen while `visible` paints (null once the switch is shown). */
  leaving?: string | null
  warm: number
  glMax: number
}

export interface Retention {
  /** Views to keep (everything else is disposed), visible first. */
  keep: string[]
  /** Views that hold a WebGL context: the visible one, the leaving one and the warm ones, at most `glMax`. */
  webgl: string[]
}

export function retention(i: RetentionInput): Retention {
  const keep: string[] = []
  const add = (id: string | null) => {
    if (id !== null && i.exists(id) && !keep.includes(id)) keep.push(id)
  }
  add(i.visible)
  for (const id of i.pinned ?? []) add(id)
  const warm: string[] = []
  for (const id of i.mru) {
    if (warm.length >= i.warm) break
    if (id === i.visible || keep.includes(id) || !i.exists(id) || !i.alive(id) || (i.warmable && !i.warmable(id))) continue
    warm.push(id)
  }
  keep.push(...warm)
  // the terminal still on screen keeps its WebGL until the switch is shown, ahead of the warm ones (it is on screen)
  const leaving = i.leaving && i.leaving !== i.visible && i.exists(i.leaving) && i.alive(i.leaving) ? i.leaving : null
  if (leaving && !keep.includes(leaving)) keep.push(leaving)
  const leavingGl = leaving && !warm.includes(leaving) ? [leaving] : []
  const webgl = [...(i.visible !== null && i.exists(i.visible) ? [i.visible] : []), ...leavingGl, ...warm].slice(0, i.glMax)
  return { keep, webgl }
}

/** Move `id` to the front of the most-recently-viewed list, dropping ids that no longer exist. */
export function touch(mru: readonly string[], id: string, exists: (id: string) => boolean): string[] {
  return [id, ...mru.filter((x) => x !== id && exists(x))]
}
