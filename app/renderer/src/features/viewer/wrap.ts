// Word wrap in the file view. Markdown is prose, read in paragraphs: it wraps unless the person turns it off. Code
// keeps its lines as written: it wraps only once the person turns it on. Each kind keeps its own choice for the window
// (`⌥Z` flips the one of the file on screen), and the large-file policy has the last word: a file it forbids wrap for
// never wraps. Pure (U-FV-18).

/** What a file reads as, for wrap. */
export type WrapKind = 'prose' | 'code'

/** The window's choice for each kind. */
export interface WrapFlags {
  prose: boolean
  code: boolean
}

/** Before the person has chosen: Markdown wraps, code does not. */
export const DEFAULT_WRAP: Readonly<WrapFlags> = { prose: true, code: false }

/** A language the viewer reads as Markdown (the same test that offers the Markdown preview). */
export function isMarkdown(language: string | null | undefined): boolean {
  return language === 'markdown' || language === 'mdx'
}

export function wrapKind(language: string | null | undefined): WrapKind {
  return isMarkdown(language) ? 'prose' : 'code'
}

/** Whether a file of `language` is wrapped: its kind's choice, where the large-file policy allows wrap at all. */
export function wrapFor(language: string | null | undefined, flags: Readonly<WrapFlags>, allowed: boolean): boolean {
  return allowed && flags[wrapKind(language)]
}

/** The choices after `⌥Z` on a file of `language`: that kind's flips, the other's stays. */
export function toggledWrap(language: string | null | undefined, flags: Readonly<WrapFlags>): WrapFlags {
  const kind = wrapKind(language)
  return { ...flags, [kind]: !flags[kind] }
}
