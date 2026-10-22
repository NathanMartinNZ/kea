// A small lexer for the lint rules: blanks comments (keeping offsets and line numbers) and records string-literal
// spans, for JS/TS, CSS, Rust and Svelte components. Regex literals are recognised by the usual "what came before the
// slash" heuristic.

export type StringSpan = { start: number; end: number; value: string } // contents only, quotes excluded

export type Lexed = {
  /** The source with every comment replaced by spaces (newlines kept). Strings are left as they are. */
  code: string
  strings: StringSpan[]
}

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new|throw|instanceof)$/

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ')
}

export function lexJs(src: string): Lexed {
  const out: string[] = []
  const strings: StringSpan[] = []
  let i = 0
  let lastSig = '' // last significant (non-space, non-comment) character in code
  let codeSince = 0 // start of the current code run, for keyword lookbehind
  // template nesting: each entry is the brace depth at which a `${` expression returns to its template
  const tmpl: number[] = []
  let depth = 0
  const n = src.length

  const readString = (q: string) => {
    const start = i + 1
    let j = start
    while (j < n && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
    strings.push({ start, end: j, value: src.slice(start, j) })
    out.push(src.slice(i, Math.min(j + 1, n)))
    i = Math.min(j + 1, n)
    lastSig = q
  }

  // reads template characters from i (just after ` or }) until ` or ${
  const readTemplate = () => {
    const start = i
    let j = i
    while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1
    strings.push({ start, end: j, value: src.slice(start, j) })
    if (j >= n) {
      out.push(src.slice(i))
      i = n
      return
    }
    if (src[j] === '`') {
      out.push(src.slice(i, j + 1))
      i = j + 1
      lastSig = '`'
      return
    }
    out.push(src.slice(i, j + 2))
    i = j + 2
    tmpl.push(depth)
    depth++
    lastSig = '{'
  }

  while (i < n) {
    const c = src[i]!
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const j = src.indexOf('\n', i)
      const end = j < 0 ? n : j
      out.push(blank(src.slice(i, end)))
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2)
      const end = j < 0 ? n : j + 2
      out.push(blank(src.slice(i, end)))
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      readString(c)
      continue
    }
    if (c === '`') {
      out.push('`')
      i++
      readTemplate()
      continue
    }
    if (c === '{') depth++
    if (c === '}') {
      depth--
      if (tmpl.length > 0 && tmpl[tmpl.length - 1] === depth) {
        tmpl.pop()
        out.push('}')
        i++
        readTemplate()
        continue
      }
    }
    if (c === '/') {
      const before = src.slice(codeSince, i)
      if (lastSig === '' || REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.test(before.trimEnd())) {
        // regex literal
        let j = i + 1
        let cls = false
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') {
            j += 2
            continue
          }
          if (src[j] === '[') cls = true
          else if (src[j] === ']') cls = false
          else if (src[j] === '/' && !cls) break
          j++
        }
        j++
        while (j < n && /[a-z]/.test(src[j]!)) j++
        out.push(src.slice(i, j))
        i = j
        lastSig = '/'
        continue
      }
    }
    out.push(c)
    if (!/\s/.test(c)) lastSig = c
    if (/[\n;{}]/.test(c)) codeSince = i + 1
    i++
  }
  return { code: out.join(''), strings }
}

export function lexCss(src: string): Lexed {
  const out: string[] = []
  const strings: StringSpan[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      const end = j < 0 ? n : j + 2
      out.push(blank(src.slice(i, end)))
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      const start = i + 1
      let j = start
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      strings.push({ start, end: j, value: src.slice(start, j) })
      out.push(src.slice(i, Math.min(j + 1, n)))
      i = Math.min(j + 1, n)
      continue
    }
    out.push(c)
    i++
  }
  return { code: out.join(''), strings }
}

/** 1-based line number of an offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Cheap repeated line lookups. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

export function inString(strings: StringSpan[], offset: number): StringSpan | null {
  for (const s of strings) if (offset >= s.start && offset < s.end) return s
  return null
}

const RUST_RAW_RE = new RegExp('^b?r(#*)"')
const WORD_RE = /\w/

// Rust: blank line and (nested) block comments, keeping strings ("…", r"…", r#"…"#), char literals and lifetimes.
export function lexRust(src: string): Lexed {
  const out: string[] = []
  const strings: StringSpan[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const j = src.indexOf('\n', i)
      const end = j < 0 ? n : j
      out.push(blank(src.slice(i, end)))
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++
          j += 2
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      out.push(blank(src.slice(i, j)))
      i = j
      continue
    }
    const raw = RUST_RAW_RE.exec(src.slice(i, i + 12))
    if (raw && !WORD_RE.test(src[i - 1] ?? '')) {
      const close = '"' + raw[1]
      const start = i + raw[0].length
      const j = src.indexOf(close, start)
      const end = j < 0 ? n : j
      strings.push({ start, end, value: src.slice(start, end) })
      const stop = j < 0 ? n : j + close.length
      out.push(src.slice(i, stop))
      i = stop
      continue
    }
    if (c === '"') {
      const start = i + 1
      let j = start
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      strings.push({ start, end: j, value: src.slice(start, j) })
      out.push(src.slice(i, Math.min(j + 1, n)))
      i = Math.min(j + 1, n)
      continue
    }
    if (c === "'") {
      const ch = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/.exec(src.slice(i, i + 12))
      if (ch) {
        out.push(ch[0])
        i += ch[0].length
        continue
      }
    }
    out.push(c)
    i++
  }
  return { code: out.join(''), strings }
}

/** A quoted attribute value in a Svelte component's markup: contents only, each `{…}` interpolation blanked to NULs. */
export type SvelteAttr = { name: string; start: number; value: string; dynamic: boolean }

export type SvelteLexed = {
  /**
   * The source with every comment blanked (HTML, and JS / CSS inside the blocks and expressions): what the
   * agent-strings rule scans.
   */
  code: string
  /** `<script>` blocks only, everything else blanked (offsets kept): where imports live. */
  scripts: string
  /** `<script>` blocks plus the markup's `{…}` expressions (block keywords dropped), lexed as JS. */
  js: Lexed
  /** `<style>` blocks, lexed as CSS. */
  css: Lexed
  attrs: SvelteAttr[]
}

/** Index of the `}` that closes a JS expression starting at `i` (quotes, templates, comments and nested braces skipped). */
function closeBrace(src: string, i: number): number {
  const n = src.length
  let depth = 0
  for (let j = i; j < n; j++) {
    const c = src[j]!
    if (c === '"' || c === "'") {
      j++
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
    } else if (c === '`') {
      j++
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') j += 2
        else if (src[j] === '$' && src[j + 1] === '{') j = closeBrace(src, j + 2) + 1
        else j++
      }
    } else if (c === '/' && src[j + 1] === '/') {
      while (j < n && src[j] !== '\n') j++
    } else if (c === '/' && src[j + 1] === '*') {
      const e = src.indexOf('*/', j + 2)
      j = e < 0 ? n : e + 1
    } else if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) return j
      depth--
    }
  }
  return n
}

const SVELTE_BLOCK_RE = /^\s*(?:[#:]else\s+if|[#:/@][a-z]+)/

/**
 * Svelte components: the `<script>` and `<style>` blocks and the markup's expressions and quoted attribute values,
 * each as a same-length projection of the source (everything else blanked), so offsets and line numbers carry over.
 */
export function lexSvelte(src: string): SvelteLexed {
  const n = src.length
  const blanked = blank(src)
  const scripts = blanked.split('')
  const js = blanked.split('')
  const css = blanked.split('')
  const code = src.split('')
  const attrs: SvelteAttr[] = []
  const copy = (to: string[], start: number, end: number) => {
    for (let k = start; k < end; k++) to[k] = src[k]!
  }
  /** `{` at i: its contents go to the JS projection; returns the index after the closing `}`. */
  const expression = (i: number, block: boolean) => {
    const end = closeBrace(src, i + 1)
    let start = i + 1
    if (block) {
      const kw = SVELTE_BLOCK_RE.exec(src.slice(start, end))
      if (kw) start += kw[0].length
    }
    copy(js, start, end)
    return Math.min(end + 1, n)
  }
  let i = 0
  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4)
      const end = e < 0 ? n : e + 3
      for (let k = i; k < end; k++) if (src[k] !== '\n') code[k] = ' '
      i = end
      continue
    }
    if (src[i] === '{') {
      i = expression(i, true)
      continue
    }
    const tag = /^<([a-zA-Z][\w:.-]*)/.exec(src.slice(i, i + 64))
    if (!tag) {
      i++
      continue
    }
    const name = tag[1]!
    let j = i + tag[0].length
    let selfClosing = false
    while (j < n && src[j] !== '>') {
      const c = src[j]!
      if (c === '/' && src[j + 1] === '>') {
        selfClosing = true
        j++
        continue
      }
      if (c === '{') {
        j = expression(j, true) // `{name}`, `{...props}`, `{@attach fn}`
        continue
      }
      const attr = /^[^\s=>/{]+/.exec(src.slice(j, j + 256))
      if (!attr) {
        j++
        continue
      }
      const attrName = attr[0]
      j += attrName.length
      if (src[j] !== '=') continue
      j++
      const q = src[j]
      if (q === '{') {
        j = expression(j, false)
      } else if (q === '"' || q === "'") {
        const start = j + 1
        let k = start
        const value: string[] = []
        let dynamic = false
        while (k < n && src[k] !== q) {
          if (src[k] === '{') {
            const after = expression(k, false)
            for (let m = k; m < after; m++) value.push('\0')
            dynamic = true
            k = after
          } else value.push(src[k++]!)
        }
        attrs.push({ name: attrName, start, value: value.join(''), dynamic })
        j = Math.min(k + 1, n)
      } else {
        const v = /^[^\s>]*/.exec(src.slice(j))![0]
        attrs.push({ name: attrName, start: j, value: v, dynamic: false })
        j += v.length
      }
    }
    i = Math.min(j + 1, n)
    if (selfClosing || (name !== 'script' && name !== 'style')) continue
    const close = src.indexOf(`</${name}`, i)
    const end = close < 0 ? n : close
    if (name === 'script') {
      copy(scripts, i, end)
      copy(js, i, end)
    } else copy(css, i, end)
    i = end
  }
  const lexedJs = lexJs(js.join(''))
  const lexedCss = lexCss(css.join(''))
  // comments inside the JS and CSS parts: their lexers blanked them in the projections
  for (let k = 0; k < n; k++) if (lexedJs.code[k] !== js[k] || lexedCss.code[k] !== css[k]) code[k] = ' '
  return { code: code.join(''), scripts: scripts.join(''), js: lexedJs, css: lexedCss, attrs }
}
