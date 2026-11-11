// The change ruler: a thin column at the file view's right edge, right of its scrollbar and outside the scroller (which
// ends where the ruler starts, so no text is ever under it), with a mark for each changed region of the file at its
// place in the whole file, as tall as its share of the file; one shorter than `--size-change-ruler-min` is that tall,
// centred on the change, as VS Code draws its overview ruler. Added `--ok`, modified `--warn`, a deletion a `--danger`
// mark on its boundary; a file new as a whole fills it. One canvas per editor, drawn from a measure when the document,
// its changes, its heights or the editor's size change, never on a plain scroll; a click goes to the change nearest
// it, as Next Change does. Hidden while there is nothing to show.

import type { Extension, Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { ChangeKind } from '@kea/protocol'
import { COLOR, SIZE_PX } from '@kea/ui/tokens'
import { goTo } from './bars.ts'
import { changeRuns, type ChangeRun, type ChangeRuns } from './gutter.ts'

/** Where the ruler's marks are measured from. */
export interface RulerGeometry {
  /** The content's top padding (px): a line block's top is measured from below it. */
  pad: number
  /** The height the ruler stands for (px): the content's, padding included, or the scroller's when that is taller. */
  contentHeight: number
  /** The ruler's height in device pixels. */
  height: number
  /** A mark's least height in device pixels. */
  min: number
}

/** One mark of the ruler, in whole device pixels from its top. */
export interface RulerMark {
  kind: ChangeKind
  y: number
  h: number
}

/** A line block's top and bottom in the document's height (`EditorView.lineBlockAt`, or a stand-in). */
export type BlockAt = (pos: number) => { top: number; bottom: number }

/** A run's top and bottom in the content's height; a deletion's top is its bottom. */
function spanOf(r: ChangeRun, blockAt: BlockAt, pad: number): { top: number; bottom: number } {
  if (r.kind === 'deleted') {
    const b = blockAt(r.from)
    const y = pad + (r.above ? b.top : b.bottom)
    return { top: y, bottom: y }
  }
  return { top: pad + blockAt(r.from).top, bottom: pad + blockAt(r.to).bottom }
}

/**
 * The marks of `c` on a ruler: each run from its first line's top to its last line's bottom, scaled to the ruler; one
 * shorter than `min` (a deletion always) is `min` tall, centred on the change, and every mark is kept on the ruler. Marks
 * of a kind on the same or touching rows are one mark. Ascending by their first run. None: the ruler is hidden.
 */
export function rulerLayout(c: ChangeRuns, blockAt: BlockAt, g: RulerGeometry): RulerMark[] {
  if (c.truncated || c.runs.length === 0 || g.height <= 0 || g.contentHeight <= 0) return []
  if (c.whole) return [{ kind: 'added', y: 0, h: g.height }]
  const scale = g.height / g.contentHeight
  const min = Math.min(g.min, g.height)
  const out: RulerMark[] = []
  const last: Partial<Record<ChangeKind, RulerMark>> = {}
  for (const r of c.runs) {
    const s = spanOf(r, blockAt, g.pad)
    let y0 = Math.round(s.top * scale)
    let y1 = Math.round(s.bottom * scale)
    if (y1 - y0 < min) {
      y0 = Math.floor((y0 + y1) / 2) - Math.floor(min / 2)
      y1 = y0 + min
    }
    if (y1 > g.height) {
      y0 -= y1 - g.height
      y1 = g.height
    }
    if (y0 < 0) {
      y1 = Math.min(g.height, y1 - y0)
      y0 = 0
    }
    const prev = last[r.kind]
    if (prev && y0 <= prev.y + prev.h) {
      prev.h = Math.max(prev.y + prev.h, y1) - prev.y
      continue
    }
    const mark = { kind: r.kind, y: y0, h: y1 - y0 }
    out.push(mark)
    last[r.kind] = mark
  }
  return out
}

/** The first line of the change nearest `y` (px in the content's height); null when nothing changed. */
export function changeNear(c: ChangeRuns, doc: Text, blockAt: BlockAt, pad: number, y: number): number | null {
  if (c.truncated) return null
  let best: ChangeRun | null = null
  let distance = Infinity
  for (const r of c.runs) {
    const s = spanOf(r, blockAt, pad)
    const d = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0
    if (d < distance) {
      best = r
      distance = d
    }
    // the runs are ascending: every later one is further away
    if (s.top > y) break
  }
  return best ? doc.lineAt(best.from).number : null
}

const COLOURS: Record<ChangeKind, string> = { added: COLOR.ok, modified: COLOR.warn, deleted: COLOR.danger }

/** What a measure found: the strip's top and height in the editor (CSS px), its size in device pixels, and its marks. */
interface Measured {
  top: number
  height: number
  deviceWidth: number
  deviceHeight: number
  marks: RulerMark[]
}

class Ruler {
  private readonly view: EditorView
  private readonly canvas: HTMLCanvasElement
  private readonly measure: { key: unknown; read: (view: EditorView) => Measured; write: (m: Measured) => void }

  constructor(view: EditorView) {
    this.view = view
    const canvas = view.dom.ownerDocument.createElement('canvas')
    canvas.className = 'kea-change-ruler'
    // a pointer convenience: the keyboard has Next / Previous Change
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.display = 'none'
    canvas.addEventListener('mousedown', this.pick)
    view.dom.append(canvas)
    this.canvas = canvas
    // one key: requests made in the same frame are one measure and one draw
    this.measure = { key: this, read: (v) => this.read(v), write: (m) => this.draw(m) }
    view.requestMeasure(this.measure)
  }

  update(u: ViewUpdate): void {
    if (u.geometryChanged || changeRuns(u.startState) !== changeRuns(u.state)) u.view.requestMeasure(this.measure)
  }

  destroy(): void {
    this.canvas.remove()
  }

  private read(view: EditorView): Measured {
    // the find and go-to bars are panels above the scroller: the strip starts where it does and is as tall as its
    // client area (a horizontal scrollbar not included); it stands at the editor's right edge (viewer.css)
    const s = view.scrollDOM
    const ratio = view.dom.ownerDocument.defaultView?.devicePixelRatio ?? 1
    const height = s.clientHeight
    const deviceHeight = Math.round(height * ratio)
    const g: RulerGeometry = { pad: view.documentPadding.top, contentHeight: Math.max(view.contentHeight, height), height: deviceHeight, min: Math.round(SIZE_PX['change-ruler-min'] * ratio) }
    return { top: s.offsetTop, height, deviceWidth: Math.round(SIZE_PX['change-ruler'] * ratio), deviceHeight, marks: rulerLayout(changeRuns(view.state), (pos) => view.lineBlockAt(pos), g) }
  }

  private draw(m: Measured): void {
    const c = this.canvas
    if (m.marks.length === 0) {
      c.style.display = 'none'
      return
    }
    c.style.display = 'block'
    c.style.top = `${m.top}px`
    c.style.height = `${m.height}px`
    // setting a canvas's size clears it: only when it changes
    if (c.width !== m.deviceWidth) c.width = m.deviceWidth
    if (c.height !== m.deviceHeight) c.height = m.deviceHeight
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    // deletions last: a thin mark beside a change stays visible
    for (const deleted of [false, true]) {
      for (const mark of m.marks) {
        if ((mark.kind === 'deleted') !== deleted) continue
        ctx.fillStyle = COLOURS[mark.kind]
        ctx.fillRect(0, mark.y, c.width, mark.h)
      }
    }
  }

  /** A press on the ruler: the change nearest it, its first line centred with the cursor on it. */
  private readonly pick = (e: MouseEvent): void => {
    if (e.button !== 0) return
    // the document keeps the keyboard (the viewer's body would take it)
    e.preventDefault()
    const view = this.view
    const box = this.canvas.getBoundingClientRect()
    if (box.height <= 0) return
    const total = Math.max(view.contentHeight, view.scrollDOM.clientHeight)
    const y = ((e.clientY - box.top) / box.height) * total
    const line = changeNear(changeRuns(view.state), view.state.doc, (pos) => view.lineBlockAt(pos), view.documentPadding.top, y)
    if (line === null) return
    goTo(view, { line, col: 1 })
    view.focus()
  }
}

const plugin = ViewPlugin.fromClass(Ruler)
/** The scroller keeps a right margin of the ruler's width while it is on (viewer.css): the ruler's own column, so no text is ever under it. */
const ruled = EditorView.editorAttributes.of({ class: 'kea-ruled' })

/** The change ruler of a file's document; its marks are the change gutter's runs (`gutter.ts`). */
export function changeRuler(): Extension {
  return [plugin, ruled]
}
