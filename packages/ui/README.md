# packages/ui

Kea's design system in code: the generated design tokens, the renderer's Svelte 5 primitives, its icons and the Kea
mark. The primitives are Kea's own, with no component library under them, and everything they draw takes its colours,
sizes, spacing and motion from the tokens.

| Path | What |
|---|---|
| `src/generated/tokens.css` | CSS custom properties from `constants/tokens.json` (colours, type, space, radii, sizes, motion). Generated: run `pnpm codegen`, never edit |
| `src/generated/tokens.ts` | The same tokens for code: `COLOR`, `SIZE_PX`, `SPACE_PX`, `TYPE_SIZE_PX` |
| `src/generated/syntax-theme.json` | The "Kea Dark" Shiki/TextMate theme of the file viewer, generated from the same tokens |
| `src/icons.ts`, `src/Icon.svelte`, `src/MoreIcon.svelte` | The icon set as path data and its component: `--size-icon` square, a `--size-icon-stroke` stroke in `currentColor`, hidden from assistive technology; and the filled `⋯` |
| `src/glyphs.ts`, `src/StatusGlyph.svelte` | The sidebar's status glyphs: one SVG shape per session state, `role="img"` with its label; the spinner stands still under reduced motion |
| `src/Menu.svelte`, `src/menuNav.ts` | Floating menus: `role="menu"`, keyboard first (the focused item is shown by its highlight), focus given back on close. A disabled item says why in its tooltip and accessible description (`reason`); a `muted` item is greyed and says why the same way, but can still be chosen. `align: 'end'` opens leftward from its anchor; the menu always stays inside the window |
| `src/Tooltip.svelte`, `src/tooltip.ts` | The window's one tooltip (below) and its pure logic |
| `src/mark.ts` | The Kea mark: the K's polygons on a 16-unit grid, and `markCoverage`, each pixel's share of it. Main draws the menu-bar and tray icon from it at run time (`app/main/src/trayIcon.ts`), and `tools/pack/src/icons.ts` the files of `assets/icon/`. No Node, DOM or Electron API |
| `src/ui.css` | The styles of the above, tokens only |
| `src/*.test.ts` | The tokens' contrast (text on the surfaces, syntax colours, every bundled terminal theme), the icons and glyphs rendered with `svelte/server`, the menu keyboard, the tooltip's timing |

Imported as `@kea/ui` (the components), `@kea/ui/tokens.css`, `@kea/ui/ui.css`, `@kea/ui/tokens`, `@kea/ui/mark` and
`@kea/ui/syntax-theme.json`.

## Rules for components

- Draw with tokens only: `pnpm lint` fails on raw colours, radii and spacing in the renderer and in this package.
- Status is never colour alone: each status glyph has its own shape, and a changed file's colour comes with its letter.
- The accent colour means "needs you" or the primary action, never decoration.
- Every control works from the keyboard and shows its focus; in a menu the highlight is the focus indicator.
- Animations stop under reduced motion.

## The tooltip

`src/Tooltip.svelte` is mounted once for the window. It listens on the document for controls that carry `data-tip` or,
on buttons, `data-command`, and asks its `resolve(command)` prop for the command's title and key when it shows, so no
control has a listener of its own and the text is never stale. `src/tooltip.ts` is its pure part: `TooltipDelay` (one
timer for the window, waiting `--motion-tooltip-delay`), `tipOf`, `tipPlace` and `cssDurationMs`. The tooltip is
hidden from assistive technology: the control's accessible name carries the same words.
