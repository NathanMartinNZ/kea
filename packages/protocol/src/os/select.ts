// Picks protocol's OS implementation once, at start. Node's `process.platform` where there is one; the renderer
// has no `process`, so there it is Chromium's `navigator.platform` (`MacIntel`, `Linux x86_64`).
import { systemOf } from '../platform.ts'
import { darwin } from './darwin.ts'
import type { ProtocolOs } from './index.ts'
import { linux } from './linux.ts'

function platformName(): string {
  const node = (globalThis as { process?: { platform?: string } }).process?.platform
  if (node) return node
  const nav = (globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? ''
  return nav.startsWith('Mac') ? 'darwin' : nav.startsWith('Linux') ? 'linux' : nav
}

export const protocolOs: ProtocolOs = systemOf(platformName()) === 'linux' ? linux : darwin
