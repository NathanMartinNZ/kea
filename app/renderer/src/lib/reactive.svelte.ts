// The bridge between the window's framework-neutral stores and Svelte's runes.
//
//   External   a value of a store that has `subscribe(cb) → off` (FrameStore, the settings mirror, the Reconnecting
//              state, the sidebar clock), read as `.current`: inside a component or `$derived` the read subscribes, and
//              the subscription ends when the last reader goes (Svelte's `createSubscriber`), so each mounted reader
//              is one subscription, as with React's useSyncExternalStore. Outside a reactive context it is a plain read.
//   watch      framework-neutral code reacting to rune state (command availability follows the window's state): `cb`
//              runs after a change to what `read` reads, coalesced to one call per update, never at start.
//
// Neither holds heavy objects: stores keep plain data and ids; terminals, ports and registries stay outside.

import { untrack } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'

export class External<T> {
  readonly #track: () => void
  readonly #get: () => T

  constructor(subscribe: (onChange: () => void) => () => void, get: () => T) {
    this.#track = createSubscriber((update) => subscribe(update))
    this.#get = get
  }

  get current(): T {
    this.#track()
    return this.#get()
  }
}

/** Run `cb` after each change to what `read` reads (not at start). Returns the function that stops watching. */
export function watch(read: () => unknown, cb: () => void): () => void {
  return $effect.root(() => {
    let first = true
    $effect(() => {
      read()
      if (first) {
        first = false
        return
      }
      untrack(cb)
    })
  })
}
