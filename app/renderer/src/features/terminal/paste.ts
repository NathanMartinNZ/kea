// Paste. `⌘V` is the native paste role, so the paste event reaches the focused terminal and xterm pastes the
// text, bracketed when the program enabled bracketed paste. Before xterm sees it, the terminal decides:
//   · the clipboard holds only an image → the agent's image-paste key (⌃V) goes to the PTY instead
//   · multi-line text into a plain shell → ask first (`terminal.confirmMultilinePaste`)

/** The image-paste key Claude Code and Command Code read the clipboard image on (⌃V). */
export const IMAGE_PASTE_KEY = '\x16'

export type PasteDecision = { do: 'default' } | { do: 'imageKey' } | { do: 'confirm'; lines: number }

export function lineCount(text: string): number {
  return text.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length
}

export function pasteDecision(o: { text: string; hasImage: boolean; plainShell: boolean; confirmMultiline: boolean }): PasteDecision {
  if (o.text === '' && o.hasImage) return { do: 'imageKey' }
  if (o.plainShell && o.confirmMultiline && /[\r\n]/.test(o.text)) return { do: 'confirm', lines: lineCount(o.text) }
  return { do: 'default' }
}
