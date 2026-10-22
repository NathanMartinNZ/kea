// The disposal contract: evicting or closing a terminal view releases, in this order, the WebGL context
// (`loseContext()` first: the addon never does it), the WebGL addon, the other addons, the Terminal, its
// observers and listeners, and its stream port on both ends. The registry then forgets the view. Every step runs
// even if an earlier one throws.

import type { Disposable } from '@kea/terminal'

export interface ViewParts {
  /** `WEBGL_lose_context.loseContext()` on the view's WebGL canvas; a no-op without one. */
  loseContext(): void
  webgl: Disposable | null
  /** Search, link, Unicode and fit addons. */
  addons: readonly Disposable[]
  terminal: Disposable
  /** Resize observer, media queries, parser hooks, DOM and bridge listeners. */
  observers: readonly Disposable[]
  /** The stream port: tell ptyhost to close its end, then close the renderer's. */
  port: { send(m: { k: 'close' }): void; close(): void } | null
}

export function disposeParts(p: ViewParts, onError: (step: string, e: unknown) => void = () => {}): void {
  const step = (name: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      onError(name, e)
    }
  }
  step('loseContext', () => p.loseContext())
  step('webgl', () => p.webgl?.dispose())
  for (const a of p.addons) step('addon', () => a.dispose())
  step('terminal', () => p.terminal.dispose())
  for (const o of p.observers) step('observer', () => o.dispose())
  step('port', () => p.port?.send({ k: 'close' }))
  step('port', () => p.port?.close())
}
