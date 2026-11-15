// Link policy: a link opens in the default browser only when its scheme is http, https or mailto and its address,
// percent-encoded, is no longer than L.linkOpenMaxChars. Any other target is not opened: hovering shows the full target
// and the click offers "Copy link". Main checks both again before opening.

import { L } from '@kea/protocol'

export const OPENABLE_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:']

export type LinkAction = { open: true; url: string } | { open: false; target: string; reason: 'scheme' | 'malformed' | 'long' }

/** C0, DEL, C1 and the bidi controls that can make a target read as something else. */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/

export function linkAction(target: string): LinkAction {
  if (CONTROL.test(target) || /\s/.test(target.trim()) || target.trim() !== target) return { open: false, target, reason: 'malformed' }
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return { open: false, target, reason: 'malformed' }
  }
  if (!OPENABLE_SCHEMES.includes(u.protocol)) return { open: false, target, reason: 'scheme' }
  if (u.protocol !== 'mailto:' && !u.hostname) return { open: false, target, reason: 'malformed' }
  // the address main is sent, as main measures it: an underlined link is never refused there for its length
  if (u.href.length > L.linkOpenMaxChars) return { open: false, target, reason: 'long' }
  return { open: true, url: u.href }
}

/** The target as hover text: the full string, control characters made visible, so nothing can hide in it. */
export function linkHoverText(target: string): string {
  return target.replace(new RegExp(CONTROL.source, 'g'), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
