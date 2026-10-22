// Platform report lines that read the same on every system, used by both sides of the OS layer.

import type { PlatformLine } from '@kea/protocol'

/** Chromium's GPU feature states that mean WebGL2 runs (`enabled`, `enabled_on`, `enabled_readback`). */
const WEBGL_ON = /^enabled/

/**
 * Chromium's WebGL2 state, read from `app.getGPUFeatureStatus()`. Electron 44's Chromium names it `webgl`, WebGL2
 * included, and gives no `webgl2` key (on a Mac with its GPU, `webgl: enabled`; in a virtual machine without a GPU
 * driver, `disabled_off`): reading `webgl2` alone would make every machine's line say the DOM renderer. A Chromium that
 * names WebGL2 apart is read by that name.
 */
export function webglState(features: Readonly<Record<string, string | undefined>>): string {
  return features.webgl2 ?? features.webgl ?? ''
}

/** Chromium has WebGL2 here (`webgl2`: `webglState`'s reading), so the terminal draws with WebGL. */
export function webglOn(webgl2: string): boolean {
  return WEBGL_ON.test(webgl2)
}

/** The terminal line's fix where a GPU driver can be installed (Linux); macOS has none to offer (its lines are the full answer). */
export const GPU_DRIVER_FIX = 'Install the GPU driver your system offers (Mesa, or your GPU vendor’s), so Chromium can draw the terminal with WebGL2.'

/**
 * The terminal renderer: WebGL where Chromium has WebGL2, else xterm's DOM renderer and why. Kea never asks for
 * WebGL in software (SwiftShader): where there is no GPU driver (every virtual machine tried), the terminal draws with
 * the DOM renderer, which misses the keystroke-echo budget there (P-TERM-1), and the line carries the system's `fix`
 * (Linux: a GPU driver; macOS: none).
 */
export function terminalRendererLine(webgl2: string, fix: string | null): PlatformLine {
  if (webglOn(webgl2)) return { id: 'terminalRenderer', label: 'Terminal drawing', value: 'WebGL, on the GPU', fix: null }
  return {
    id: 'terminalRenderer',
    label: 'Terminal drawing',
    value: `xterm's DOM renderer, as Chromium has no WebGL2 here (${webgl2 || 'unknown'}): a machine without a GPU driver, or a virtual machine, so typing shows a little later`,
    fix,
  }
}
