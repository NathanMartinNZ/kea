// The focused context's key scopes: a binding with a scope applies only while that context has the keyboard, and then
// also without the primary modifier, as the context's own keys. A context that can take the keyboard provides its scope
// while it is mounted and answers it only while the keyboard is in it: the detached overlay, the file panel
// (`shell/layoutStore.svelte.ts`), the main area's viewer mount (`shell/TerminalPane.svelte`).
//
// A context can be in several scopes at once: a diff tab is a `diff tab` and a `viewer tab`, a Markdown file in a file
// tab is a `Markdown file`, a `file tab` and a `viewer tab`. Scopes are answered most specific first, and for a chord
// bound in several of them the first one wins.

import type { KeyScope } from '@kea/protocol'

type Provider = () => KeyScope | readonly KeyScope[] | null

// bounded: one per mounted context that names a scope
const providers = new Set<Provider>()

/** Provide a scope, or several (most specific first), while mounted; returns the function that withdraws it. */
export function provideKeyScope(fn: Provider): () => void {
  providers.add(fn)
  return () => providers.delete(fn)
}

/** The scopes of the context that has the keyboard now, most specific first; none in a terminal. */
export function currentKeyScopes(): KeyScope[] {
  const out: KeyScope[] = []
  for (const p of providers) {
    const s = p()
    if (s === null) continue
    for (const x of typeof s === 'string' ? [s] : s) if (!out.includes(x)) out.push(x)
  }
  return out
}
