// The composer's selector keys: ⌘1 Agent, ⌘2 Model, ⌘3 Effort, ⌘4 Permission mode while the keyboard is in the composer
// (Ctrl+Shift+1…4 on Linux). They belong to the composer, not to the command registry; outside it they stay the
// session-jump shortcuts. The command router is a capture-phase listener on the window installed by main.ts after the
// app's modules load; this module's own capture listener is added when it loads (main.ts imports the app, and with it
// this module, before it calls installCommands()), so it runs first and keeps a claimed key from the router.

import type { KeyLabels } from '@kea/protocol'
import { primaryHeld, type KeyLike } from '../commands/keys.ts'

export type Selector = 'agent' | 'model' | 'effort' | 'mode'
const ORDER: readonly Selector[] = ['agent', 'model', 'effort', 'mode']

/** ⌘1…⌘4 (no other modifier; Ctrl+Shift+1…4 on Linux) → the selector it opens; null for anything else. */
export function selectorFor(e: KeyLike, keys?: KeyLabels): Selector | null {
  if (!primaryHeld(e, keys) || e.altKey) return null
  const m = /^Digit([1-4])$/.exec(e.code)
  return m ? (ORDER[Number(m[1]) - 1] ?? null) : null
}

interface Claim {
  /** The keyboard is in the composer now. */
  active(): boolean
  /** Open this selector (a hidden one is skipped by the composer). */
  open(s: Selector): void
}

let claim: Claim | null = null // bounded: the one mounted composer

/** The mounted composer claims the keys; returns the function that gives them back. */
export function claimSelectorKeys(c: Claim): () => void {
  claim = c
  return () => {
    if (claim === c) claim = null
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing || !claim?.active()) return
      const s = selectorFor(e)
      if (!s) return
      e.preventDefault()
      e.stopImmediatePropagation()
      claim.open(s)
    },
    true,
  )
}
