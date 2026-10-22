// Text that terminal output controls (titles, bell and OSC 9 / 777 notification text) reaches Kea only as data: control
// and bidi characters removed, whitespace collapsed, truncated to `L.oscTextMaxChars` characters. It is always shown
// under Kea's own label (the tab, or the session's title), never as Kea's wording.

import { L } from '@kea/protocol'

// C0, DEL, C1, zero-width and bidi formatting characters
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g

export function terminalText(raw: string | null | undefined, max: number = L.oscTextMaxChars): string {
  if (!raw) return ''
  const clean = raw.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...clean]
  if (chars.length <= max) return clean
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`
}
