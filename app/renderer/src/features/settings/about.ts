// Settings › About: what the build says of itself (the version, the commit and the build date) and the pieces of
// the platform report's text the page draws. The page reads the report from core (`diagnostics.platform`, which
// main sends it) when it opens: AboutPage.svelte; AboutView.svelte draws it.

// the commit and the day the renderer was built (vite.config.ts `define`); not defined under the unit tests
declare const __KEA_BUILD_COMMIT__: string | undefined
declare const __KEA_BUILD_DATE__: string | undefined

/** Kea's version (main's, through the preload), this system's architecture, and the commit and day it was built from. */
export interface BuildFacts {
  version: string
  arch: string
  /** `git describe` of the build (`57e6b69`, `-dirty` with changes not committed); null when built outside a checkout. */
  commit: string | null
  /** The day it was built, `YYYY-MM-DD` (UTC). */
  date: string | null
}

export function buildFacts(platform: { version: string; arch: string }): BuildFacts {
  const commit = typeof __KEA_BUILD_COMMIT__ === 'string' && __KEA_BUILD_COMMIT__ !== '' ? __KEA_BUILD_COMMIT__ : null
  const date = typeof __KEA_BUILD_DATE__ === 'string' && __KEA_BUILD_DATE__ !== '' ? __KEA_BUILD_DATE__ : null
  return { version: platform.version, arch: platform.arch, commit, date }
}

/** A sentence in parts: what stands between backticks is a command to type (`sudo sysctl …`), drawn as code. */
export function textParts(text: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = []
  text.split('`').forEach((t, i, all) => {
    // an odd count of backticks leaves the last one unpaired: it stays in the text as written
    const code = i % 2 === 1 && i < all.length - 1
    if (i % 2 === 1 && !code) parts.push({ text: `\`${t}`, code: false })
    else if (t !== '') parts.push({ text: t, code })
  })
  return parts
}
