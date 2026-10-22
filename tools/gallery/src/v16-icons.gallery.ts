// V-16: the icon files of assets/icon/, as committed. Not a state of the app: the set draws the files on a page of its
// own in the run's Chromium (no Kea is launched), at their real size and enlarged, on light and dark grounds; the
// menu-bar template tinted as macOS tints one on a light and a dark menu bar; the Linux tray icon on a light and a dark
// panel. The ground colours are stand-ins for the system's, not Kea's tokens.
// `node tools/pack/src/icons.ts` writes the files.

import fs from 'node:fs'
import path from 'node:path'
import { test } from '../../../tests/e2e/fixtures.ts'
import { GALLERY_DIR, WINDOW, type Screen, type SetFile } from './shots.ts'

const ICONS = path.resolve(import.meta.dirname, '..', '..', '..', 'assets', 'icon')
const ID = 'V-16'
const TITLE = 'Icons: the app icon, the menu-bar template, the tray icon'

/** A file of assets/icon/ as a data URL. */
const url = (name: string) => `data:${name.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${fs.readFileSync(path.join(ICONS, name)).toString('base64')}`
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const png = (px: number) => url(`png/${px}x${px}.png`)

/** Stand-ins for the grounds the icons sit on. */
const GROUND = {
  light: '#f5f5f5', // a light Finder window, desktop or Dock
  dark: '#1e1e1e', // a dark one
  menuLight: '#e8e8e8', // a light menu bar (macOS draws template images in black there, at about 85 %)
  menuDark: '#2b2b2b', // a dark menu bar (white)
  panelLight: '#eff0f1', // a light panel (KDE's Breeze)
  panelDark: '#000000', // GNOME's top bar
} as const

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: #888; font: 12px/16px -apple-system, system-ui, sans-serif; }
  .screen { display: inline-flex; flex-direction: column; gap: 0; }
  .row { display: flex; align-items: flex-end; gap: 24px; padding: 16px 20px; }
  .light { background: ${GROUND.light}; color: #333; }
  .dark { background: ${GROUND.dark}; color: #ccc; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  figcaption { white-space: nowrap; }
  img { display: block; }
  .px { image-rendering: pixelated; }
  .bar { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; font: 13px/24px -apple-system, system-ui, sans-serif; }
  .item { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; border-radius: 4px; }
  .glyph { width: 16px; height: 16px; -webkit-mask-size: 16px 16px; -webkit-mask-image: url(${url('trayTemplate@2x.png')}); }
  .menu-light { background: ${GROUND.menuLight}; color: rgba(0,0,0,.85); }
  .menu-dark { background: ${GROUND.menuDark}; color: #fff; }
  .menu-light .glyph { background: rgba(0,0,0,.85); }
  .menu-dark .glyph { background: #fff; }
  .menu-light .open { background: rgba(0,0,0,.1); }
  .menu-dark .open { background: rgba(255,255,255,.2); }
  .panel-light { background: ${GROUND.panelLight}; color: #232629; }
  .panel-dark { background: ${GROUND.panelDark}; color: #fff; }
  .label { padding: 4px 20px 0; font-weight: 600; }
  .check { background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
`

/** `px` file pixels at one screen pixel each: half as many CSS pixels at the gallery's @2x. */
const real = (px: number) => px / WINDOW.scale
/** `px` file pixels at eight screen pixels each. */
const enlarged = (px: number) => (px * 8) / WINDOW.scale

/** An image at `cssPx` square with its caption; `cls` "px" enlarges it pixel for pixel, "px check" over a checkerboard. */
function figure(src: string, cssPx: number, caption: string, cls = ''): string {
  return `<figure><img src="${src}" width="${cssPx}" height="${cssPx}" class="${cls}" alt=""><figcaption>${caption}</figcaption></figure>`
}

function both(rows: (ground: 'light' | 'dark') => string): string {
  return `<div class="row light">${rows('light')}</div><div class="row dark">${rows('dark')}</div>`
}

const SCREENS: { name: string; caption: string; design: string; html: string }[] = [
  {
    name: 'app-real',
    caption: 'The app icon, the PNGs of assets/icon/png at their real size (one file pixel to one screen pixel), 16 to 512 px, on a light and a dark ground (1024 px below): the K in the accent on the terminal canvas, outlined in --line-strong',
    design: 'App icon, Colour',
    html: both(() => PNG_SIZES.filter((px) => px < 1024).map((px) => figure(png(px), real(px), `${px}`)).join('')),
  },
  {
    name: 'app-enlarged',
    caption: 'The small PNGs enlarged eight times, pixel for pixel: 16 and 24 px (the body and the K blur at 16 px, as every 16 px icon does), 32 and 48 px (the stem, the top and the bottom fall on whole pixels from 32 px)',
    design: 'App icon',
    html: both(() => [16, 24, 32, 48].map((px) => figure(png(px), enlarged(px), `${px} × 8`, 'px')).join('')),
  },
  {
    name: 'app-points',
    caption: 'As a Retina screen shows the icon: 16, 32, 64 and 128 pt from the 2× files (Finder lists, Spotlight, the Dock), and the SVG of hicolor’s scalable/apps at 128 pt beside the 256 px PNG',
    design: 'App icon, Linux packages',
    html: both(() => [16, 32, 64, 128].map((pt) => figure(png(pt * 2), pt, `${pt} pt`)).join('') + figure(url('kea.svg'), 128, 'SVG, 128 pt')),
  },
  {
    name: 'app-1024-light',
    caption: 'The 1024 px PNG at its real size beside the SVG drawn at the same size, on a light ground: the body on Apple’s 1024 grid (824 px, continuous corners), its shadow below it',
    design: 'App icon',
    html: `<div class="row light">${figure(png(1024), real(1024), '1024 PNG')}${figure(url('kea.svg'), real(1024), 'SVG')}</div>`,
  },
  {
    name: 'app-1024-dark',
    caption: 'The same on a dark ground: the --line-strong outline keeps the body’s edge where the canvas colour meets a dark Dock or desktop',
    design: 'App icon, Colour',
    html: `<div class="row dark">${figure(png(1024), real(1024), '1024 PNG')}${figure(url('kea.svg'), real(1024), 'SVG')}</div>`,
  },
  {
    name: 'menu-bar',
    caption:
      'The menu-bar template (trayTemplate.png, @2x) as macOS tints it: on a light and a dark menu bar, alone, with a count of sessions that need you after it in the menu bar’s font, and with its menu open; below, the two files enlarged eight times, pixel for pixel, on a checkerboard (black and alpha only)',
    design: 'Menu-bar item',
    html: ['menu-light', 'menu-dark']
      .map(
        (bar) =>
          `<div class="bar ${bar}"><span style="flex:1"></span><span class="item"><span class="glyph"></span></span><span class="item"><span class="glyph"></span>2</span><span class="item open"><span class="glyph"></span>2</span><span>Tue 9:41</span></div>`,
      )
      .concat(`<div class="row light">${figure(url('trayTemplate.png'), enlarged(16), 'trayTemplate.png × 8', 'px check')}${figure(url('trayTemplate@2x.png'), enlarged(32), 'trayTemplate@2x.png × 8', 'px check')}</div>`)
      .join(''),
  },
  {
    name: 'tray',
    caption: 'The Linux tray icon (trayAccent.png, @2x), drawn in the accent because a panel draws a template black: on a light panel and on GNOME’s black top bar at 16 px (the @2x file, a HiDPI panel), then the two files enlarged eight times, pixel for pixel',
    design: 'Menu-bar item, Linux tray',
    html: ['panel-light', 'panel-dark']
      .map((panel) => `<div class="bar ${panel}"><span style="flex:1"></span><span class="item"><img src="${url('trayAccent@2x.png')}" width="16" height="16" alt=""></span><span>Tue 9:41</span></div>`)
      .concat(both(() => `${figure(url('trayAccent.png'), enlarged(16), 'trayAccent.png × 8', 'px')}${figure(url('trayAccent@2x.png'), enlarged(32), 'trayAccent@2x.png × 8', 'px')}`))
      .join(''),
  },
]

test.use({ deviceScaleFactor: WINDOW.scale })

test(`${ID} · icons`, async ({ page }) => {
  fs.mkdirSync(GALLERY_DIR, { recursive: true })
  for (const f of fs.readdirSync(GALLERY_DIR)) if (f.startsWith(`${ID}-`) || f === `${ID}.json`) fs.rmSync(path.join(GALLERY_DIR, f))
  const out: SetFile = { id: ID, title: TITLE, notes: [], screens: [] }
  await page.setViewportSize({ width: WINDOW.width, height: WINDOW.height })
  const body = SCREENS.map((s, i) => `<div class="screen" id="s${i}">${s.html}</div><br>`).join('')
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`)
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  for (const [i, s] of SCREENS.entries()) {
    const part = page.locator(`#s${i}`)
    const box = await part.boundingBox()
    if (!box) throw new Error(`${ID} ${s.name}: not on the page`)
    const file = `${ID}-${String(i + 1).padStart(2, '0')}-${s.name}.png`
    await part.screenshot({ path: path.join(GALLERY_DIR, file), animations: 'disabled' })
    const shot: Screen = { file, caption: s.caption, design: s.design, width: Math.ceil(box.width), height: Math.ceil(box.height) }
    out.screens.push(shot)
  }
  fs.writeFileSync(path.join(GALLERY_DIR, `${ID}.json`), `${JSON.stringify(out, null, 2)}\n`)
})
