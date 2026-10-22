// The window title, as the system's window lists show it (`Kea — 2 need you`): the needs-you count, an account
// condition counted once; `Kea` at zero.

import { sessionRows, sessions } from '../sessions/state.svelte.ts'
import { conditions, needsYouCount } from './state.ts'

let installed = false

export function installWindowTitle(): void {
  if (installed) return
  installed = true
  const update = () => {
    const n = needsYouCount(sessionRows())
    const title = n > 0 ? `Kea — ${n} need${n === 1 ? 's' : ''} you` : 'Kea'
    if (document.title !== title) document.title = title
  }
  sessions.subscribeAny(update)
  sessions.subscribeList(update)
  conditions.subscribeAny(update)
  conditions.subscribeList(update)
  update()
}
