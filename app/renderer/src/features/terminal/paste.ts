// Paste. `⌘V` is the native paste role, so the paste event reaches the focused terminal and xterm pastes the
// text, of one line or several, bracketed when the program enabled bracketed paste. Before xterm sees it, the
// terminal checks one case: when the clipboard holds only an image, the agent's image-paste key (⌃V) goes to the
// PTY instead.

/** The image-paste key Claude Code and Command Code read the clipboard image on (⌃V). */
export const IMAGE_PASTE_KEY = '\x16'

/** Whether a paste sends the image-paste key: the clipboard holds an image and no text. */
export function sendsImageKey(o: { text: string; hasImage: boolean }): boolean {
  return o.text === '' && o.hasImage
}
