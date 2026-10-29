// Kea's icon set: `--size-icon` square, a `--size-icon-stroke` stroke, `currentColor`, one family. The paths are Kea's
// own, on a 16-unit grid, drawn in the style of Phosphor's "regular" weight (round caps and joins; see
// THIRD_PARTY_NOTICES.md). No Phosphor files, icon font or icon package are shipped; a new icon is one entry in
// ICON_PATHS. Icons are decoration: the control that holds one carries the name (`aria-label`), and the SVG is hidden
// from assistive technology. Drawn by `Icon.svelte`; `MoreIcon.svelte` is the one filled glyph, in the same box.

/** The gear's outline: 8 teeth around a ring, computed once (outer radius 6.5, root radius 4.75). */
function gearPath(): string {
  const teeth = 8
  const pts: string[] = []
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2
    const r = i % 4 === 1 || i % 4 === 2 ? 6.5 : 4.75
    pts.push(`${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z M10 8 A2 2 0 1 1 6 8 A2 2 0 1 1 10 8 Z`
}

export const ICON_PATHS = {
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  caretRight: 'M6 4l4 4-4 4',
  caretDown: 'M4 6l4 4 4-4',
  archive: 'M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3',
  gear: gearPath(),
  search: 'M11.5 7a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0zM10.25 10.25L13.5 13.5',
  folder: 'M2 4.5v8h12v-6.5h-6.5l-1.5-1.5z',
  /** A file (the tree's one file glyph): a page with its corner turned down. */
  file: 'M4 2.5v11h8.5v-7.5l-3.5-3.5zM9 2.5v3.5h3.5',
  /** New File: the page, a plus at its foot. */
  filePlus: 'M8.5 13.5h-4.5v-11h5l3.5 3.5v2.5M9 2.5v3.5h3.5M12 10v5M9.5 12.5h5',
  /** New Folder: the folder, a plus at its foot. */
  folderPlus: 'M8.5 12.5h-6.5v-8h4l1.5 1.5h6.5v2.5M12 9.5v5M9.5 12h5',
  /** Collapse All: a box with a minus in front of another. */
  collapseAll: 'M5 2.5h8.5v8.5M2.5 5h8.5v8.5h-8.5zM4.75 9.25h4',
  /** VS Code's mark in this family's stroke (the header's `Code` button): two bands crossing into a bar. */
  vscode: 'M11.5 2.5v11L3 6.25M11.5 2.5L3 9.75',
  /** A symbolic link: an arrow out of its place. */
  link: 'M5 11l6-6M6.5 5h4.5v4.5',
  /** The window's menu (Linux: the header's menu button): three bars. */
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
} as const

export type IconName = keyof typeof ICON_PATHS

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[]
