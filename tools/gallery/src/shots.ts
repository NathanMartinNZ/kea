// The gallery's camera: one Kea window at 1440×900 @2x, a screenshot of the whole window or of one part of it, and each
// set's list of screens written beside its pictures in dist/gallery/. Kea is started only through the e2e fixtures
// (tests/e2e/fixtures.ts → `KeaRun.launch` → `launchKea`): unfocused, a temporary KEA_HOME, repo-factory repos and
// tools/fake-agent, so nothing a screen shows names a person, a home folder or a host.
//
// "Fonts pinned": the run's settings.json says the terminal's font and size outright (the schema's defaults, written
// down so a later default cannot move the pictures), no Ghostty config is followed, and the chrome's font is the
// system's, as in the app.

import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../../perf/src/launch.ts'
import { STEP_MS, until, type Kea, type KeaRun } from '../../../tests/support/app.ts'

type Page = Awaited<ReturnType<Kea['page']>>
type Locator = ReturnType<Page['locator']>

/** The window every screen is taken in, and its scale. */
export const WINDOW = { width: 1440, height: 900, scale: 2 } as const
export const GALLERY_DIR = path.join(repoRoot, 'dist', 'gallery')
/** Chromium's switch for the scale, whatever display the run happens on. */
export const SCALE_ARG = `--force-device-scale-factor=${WINDOW.scale}`

export interface Screen {
  /** The file beside the set's JSON. */
  file: string
  /** What the screen shows, in the design system's words. */
  caption: string
  /** The parts of the design system to hold it against (`Sidebar`, `File viewer, Colour`). */
  design: string
  /** CSS pixels. */
  width: number
  height: number
}

export interface SetFile {
  id: string
  title: string
  /** What a screenshot cannot show, as text (the menu-bar item's native menu). */
  notes: string[]
  screens: Screen[]
}

/** The run's settings: `extra` over the pinned terminal font (see the header). */
export function pinSettings(run: KeaRun, extra: Record<string, Record<string, unknown>> = {}): void {
  const base: Record<string, Record<string, unknown>> = { terminal: { fontFamily: 'SF Mono', fontSize: 13 } }
  for (const [section, values] of Object.entries(extra)) base[section] = { ...base[section], ...values }
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify(base, null, 2)}\n`)
}

/** Give the window the gallery's size (WINDOW); resolves once the page is laid out at it. */
export async function sizeWindow(kea: Kea, size: { width: number; height: number } = WINDOW): Promise<void> {
  await kea.app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) throw new Error('no window')
    w.setContentSize(s.width, s.height)
  }, size)
  const page = await kea.page()
  await until(`the window at ${size.width}×${size.height}`, () => page.evaluate((s) => window.innerWidth === s.width && window.innerHeight === s.height, size).then((ok) => ok || undefined)).catch(async (e: Error) => {
    const got = await page.evaluate(() => `${window.innerWidth}×${window.innerHeight}`)
    throw new Error(`${e.message} (the window is ${got}: is the display smaller than the gallery's window?)`)
  })
  await kea.assertUnfocused()
}

/** Two frames: what was just changed is laid out and painted. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/** One set of screens: `shot` adds a screen, `note` a line, `write` saves the list. */
export class GallerySet {
  readonly id: string
  readonly title: string
  private readonly screens: Screen[] = [] // bounded: the screens of one set (a dozen)
  private readonly notes: string[] = [] // bounded: a line per screen that could not be shown

  constructor(id: string, title: string) {
    this.id = id
    this.title = title
    fs.mkdirSync(GALLERY_DIR, { recursive: true })
    for (const f of fs.readdirSync(GALLERY_DIR)) if (f.startsWith(`${id}-`) || f === `${id}.json`) fs.rmSync(path.join(GALLERY_DIR, f))
  }

  note(text: string): void {
    this.notes.push(text)
    this.write()
  }

  /**
   * A screenshot of the window, or of `part` with `pad` CSS pixels around it (clipped to the window). Finite animations
   * are run to their end and the spinner stands still, so two runs give the same picture.
   */
  async shot(kea: Kea, name: string, caption: string, design: string, o: { part?: Locator; pad?: number; rect?: { x: number; y: number; width: number; height: number } } = {}): Promise<void> {
    const page = await kea.page()
    await settle(page)
    let clip = o.rect
    if (o.part) {
      const box = await o.part.boundingBox({ timeout: STEP_MS })
      if (!box) throw new Error(`${this.id} ${name}: the part to shoot is not on screen`)
      const pad = o.pad ?? 12
      const x = Math.max(0, Math.floor(box.x - pad))
      const y = Math.max(0, Math.floor(box.y - pad))
      clip = { x, y, width: Math.min(WINDOW.width, Math.ceil(box.x + box.width + pad)) - x, height: Math.min(WINDOW.height, Math.ceil(box.y + box.height + pad)) - y }
    }
    const file = `${this.id}-${String(this.screens.length + 1).padStart(2, '0')}-${name}.png`
    await page.screenshot({ path: path.join(GALLERY_DIR, file), animations: 'disabled', caret: 'hide', ...(clip ? { clip } : {}) })
    this.screens.push({ file, caption, design, width: clip?.width ?? WINDOW.width, height: clip?.height ?? WINDOW.height })
    this.write()
    await kea.assertUnfocused()
  }

  write(): void {
    const out: SetFile = { id: this.id, title: this.title, notes: this.notes, screens: this.screens }
    fs.writeFileSync(path.join(GALLERY_DIR, `${this.id}.json`), `${JSON.stringify(out, null, 2)}\n`)
  }
}
