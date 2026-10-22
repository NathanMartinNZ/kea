// The window's copy of core's `banners` store, frame-coalesced like the sessions stores. `Banners.svelte` lays it out
// with `banners.ts`.

import { BANNERS_STORE, type Banner } from '@kea/protocol'
import { FrameStore, nextFrame } from '../lib/frameStore.ts'
import { subscribe } from '../lib/rpc.ts'

export const banners = new FrameStore<Banner>({ schedule: nextFrame, structure: (b) => JSON.stringify(b) })
let installed = false

export function installBanners(): void {
  if (installed) return
  installed = true
  subscribe<Banner>(BANNERS_STORE, (d, c) => banners.push(d, c))
}

/** The banners store's copy in this window (the resource report). */
export function bannerStore(): { rows: number; listeners: number } {
  return { rows: banners.size, listeners: banners.subscribers }
}
