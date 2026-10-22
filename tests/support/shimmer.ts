// A truecolor "shimmer" for the glyph-atlas tests, run in a test shell as
// `node tests/support/shimmer.ts <fps> [colours]`: one line of text redrawn `fps` times a second, every character in
// its own 24-bit colour from a gradient that keeps moving, as Claude Code's spinner does, but with colours that never
// repeat, so every frame adds glyphs to the WebGL atlas (each glyph is rasterised once per colour). That is the worst
// case for @xterm/addon-webgl, whose atlas grows with per-cell truecolor (xtermjs/xterm.js#6074); the recorded
// cassettes hold only a few shimmer colours. With `colours`, the gradient has that many fixed colours instead (the
// cassette's case: the atlas stops growing once each glyph has been drawn in each), for measuring what animating costs
// apart from the atlas (P-GPU-2). It runs until its terminal ends it.

const TEXT = 'Shimmering through the glyph atlas while the guard watches'
const fps = Number(process.argv[2])
const colours = process.argv[3] === undefined ? null : Number(process.argv[3])
if (!Number.isFinite(fps) || fps <= 0 || (colours !== null && !(Number.isInteger(colours) && colours > 0))) {
  process.stderr.write('usage: shimmer.ts <fps> [colours]\n')
  process.exit(2)
}

/** HSL (h in turns) to RGB bytes. */
function rgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

/** `colours` evenly spaced hues, when the palette is fixed. */
const palette = colours === null ? null : Array.from({ length: colours }, (_, k) => rgb(k / colours, 0.7, 0.55))

let frame = 0
process.stdout.write('\x1b[?25l')
setInterval(() => {
  // the hue drifts by a fraction of a step per frame and the lightness wanders slowly, so (glyph, colour) pairs stay new
  const t = frame++
  let line = '\r'
  for (let i = 0; i < TEXT.length; i++) {
    const [r, g, b] = palette ? (palette[(i + t) % palette.length] as [number, number, number]) : rgb((t * 0.0037 + i * 0.013) % 1, 0.7, 0.45 + 0.2 * Math.sin(t * 0.00071 + i * 0.05))
    line += `\x1b[38;2;${r};${g};${b}m${TEXT[i]}`
  }
  process.stdout.write(`${line}\x1b[0m`)
}, 1000 / fps)
