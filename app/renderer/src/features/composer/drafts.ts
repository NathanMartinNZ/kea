// The window's composer drafts, one per project: kept by the composer (`Composer.svelte`), pruned with the projects
// list (`shell/forget.ts`), counted by the resource report. A window main rebuilds in place of a minimized one (on
// Wayland, where a minimized window cannot be raised) hands them to the new one, which starts with them.

import { handedOver, setHandoffSource } from '../../lib/bridge.ts'
import { Drafts } from './state.ts'

export const drafts = new Drafts()
drafts.adopt(handedOver()?.drafts ?? [])
setHandoffSource(() => ({ drafts: drafts.entries() }))
