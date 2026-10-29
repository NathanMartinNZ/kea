// The gallery's page: one static HTML file listing every set's screens with their captions, written from the sets' JSON
// files. Plain HTML and a little CSS, no script; the pictures are beside it. The page is a reviewer's tool, not part of
// the app: its colours are its own.

import type { SetFile } from './shots.ts'

/** The order of the V sets on the page; every other set comes after them (`orderSets`). */
export const SET_ORDER = ['V-1', 'V-2', 'V-5', 'V-6', 'V-7', 'V-10', 'V-13', 'V-14', 'V-15', 'V-17'] as const

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The sets in SET_ORDER's order; any other set (the review sets) after them, by id. */
export function orderSets(sets: readonly SetFile[]): SetFile[] {
  // a set in two launches (`V-5b`) sits with its first part (`V-5`)
  const rank = (id: string) => {
    const i = (SET_ORDER as readonly string[]).indexOf(id.replace(/[a-z]$/, ''))
    return i < 0 ? SET_ORDER.length : i
  }
  return [...sets].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id, 'en', { numeric: true }))
}

export function galleryHtml(sets: readonly SetFile[], o: { taken: string; missing: readonly string[] }): string {
  const ordered = orderSets(sets)
  const nav = ordered.map((s) => `<a href="#${esc(s.id)}">${esc(s.id)}</a>`).join(' ')
  const body = ordered
    .map((s) => {
      const notes = s.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('\n')
      const screens = s.screens
        .map(
          (x) => `<figure>
  <img src="${esc(x.file)}" width="${x.width}" height="${x.height}" alt="${esc(x.caption)}" loading="lazy">
  <figcaption><b>${esc(x.design)}</b> ${esc(x.caption)}</figcaption>
</figure>`,
        )
        .join('\n')
      return `<section id="${esc(s.id)}">
<h2>${esc(s.id)} · ${esc(s.title)}</h2>
${notes}
${screens}
</section>`
    })
    .join('\n')
  const missing = o.missing.length ? `<p class="note">Not in this run: ${esc(o.missing.join(', '))}.</p>` : ''
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Kea · screenshot gallery</title>
<style>
  body { margin: 24px; background: #1c1c1c; color: #ddd; font: 13px/20px -apple-system, system-ui, sans-serif; }
  h1 { font-size: 15px; }
  h2 { font-size: 15px; margin: 32px 0 8px; }
  nav a { color: #9bbce6; margin-right: 12px; }
  figure { margin: 0 0 24px; }
  img { display: block; max-width: 100%; height: auto; border: 1px solid #444; }
  figcaption { margin-top: 4px; color: #bbb; }
  .note { color: #d9b45b; }
</style>
<h1>Kea · screenshot gallery</h1>
<p>Screens for a person to check against Kea's design system whenever a component changes. Taken ${esc(o.taken)} at 1440×900 @2x by <code>pnpm gallery</code>; each caption begins with the parts of the design system the screen shows.</p>
${missing}
<nav>${nav}</nav>
${body}
</html>
`
}
