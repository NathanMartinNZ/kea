// The Markdown preview in the page. `markdown.ts` turns the source into HTML that is already inert; this puts it in the
// page through a second filter that does not trust the first: the HTML is parsed into a detached document (where
// nothing runs and nothing loads) and rebuilt element by element, keeping only the tags the renderer makes and, on
// each, only the attributes listed here — a link's target only when it is a web or mail address, an image's source
// only when it is a `kea-file://` URL. Nothing else can reach the page, whatever the first step let by.
//
// Links never navigate the window: a web or mail link opens in the system browser, a link to a file of the worktree
// opens it in the viewer. Code fences are coloured by the highlight worker, one at a time, after the text is shown.

import { KEA_FILE_HOST, KEA_FILE_SCHEME } from '@kea/protocol'
import { openExternal } from '../../lib/bridge.ts'
import { highlighter } from './highlighter.ts'
import { renderMarkdown, type MarkdownContext } from './markdown.ts'
import { STYLE_PLAIN, tokenClass } from './syntax.ts'
import { tokenStart, tokenStyle, TokenStore } from './tokens.ts'

const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 's', 'a', 'img', 'span', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])
const EXTERNAL = /^(https?:\/\/|mailto:)/i
const IMAGE_PREFIX = `${KEA_FILE_SCHEME}://${KEA_FILE_HOST}/`
const ALIGN = /^text-align:\s*(left|center|right)$/

/** Copy what is allowed of `from`'s children into `to`. Exported for the tests that feed it hostile HTML. */
export function copyAllowed(from: Node, to: Node, doc: Document): void {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      to.appendChild(doc.createTextNode(node.nodeValue ?? ''))
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const src = node as Element
    const tag = src.localName
    if (!TAGS.has(tag)) {
      // an element the renderer never makes: its text is kept, the element is not
      to.appendChild(doc.createTextNode(src.textContent ?? ''))
      continue
    }
    const el = doc.createElement(tag)
    const title = src.getAttribute('title')
    if (tag === 'a') {
      const href = src.getAttribute('href')
      const path = src.getAttribute('data-path')
      if (href !== null && EXTERNAL.test(href)) el.setAttribute('href', href)
      else if (path !== null) el.setAttribute('data-path', path)
      if (title !== null) el.setAttribute('title', title)
    } else if (tag === 'img') {
      const url = src.getAttribute('src') ?? ''
      if (!url.startsWith(IMAGE_PREFIX)) {
        // not a file of the worktree: its alt text, and no request
        const alt = doc.createElement('span')
        alt.className = 'md-no-image'
        alt.textContent = src.getAttribute('alt') || 'image'
        to.appendChild(alt)
        continue
      }
      el.setAttribute('src', url)
      el.setAttribute('alt', src.getAttribute('alt') ?? '')
      el.setAttribute('loading', 'lazy')
      el.setAttribute('draggable', 'false')
      if (title !== null) el.setAttribute('title', title)
    } else if (tag === 'code') {
      const lang = src.getAttribute('data-lang')
      if (lang !== null && /^[a-z0-9+#._-]+$/.test(lang)) el.setAttribute('data-lang', lang)
    } else if (tag === 'span') {
      if (src.getAttribute('class') === 'md-no-image') el.className = 'md-no-image'
    } else if (tag === 'th' || tag === 'td') {
      const m = ALIGN.exec(src.getAttribute('style') ?? '')
      if (m) el.className = `md-align-${m[1]}`
    } else if (tag === 'ol') {
      const start = src.getAttribute('start')
      if (start !== null && /^\d{1,9}$/.test(start)) el.setAttribute('start', start)
    }
    copyAllowed(src, el, doc)
    to.appendChild(el)
  }
}

/** A code block's lines as coloured spans. */
function paint(code: HTMLElement, text: string, store: TokenStore): void {
  const lines = text.split('\n')
  const out = document.createDocumentFragment()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const t = store.line(i)
    if (!t) out.append(line)
    else {
      for (let k = t.from; k < t.to; k++) {
        const v = t.data[k] as number
        const start = tokenStart(v)
        if (start >= line.length) break
        const end = k + 1 < t.to ? Math.min(tokenStart(t.data[k + 1] as number), line.length) : line.length
        if (end <= start) continue
        const style = tokenStyle(v)
        if (style === STYLE_PLAIN) out.append(line.slice(start, end))
        else {
          const span = document.createElement('span')
          span.className = tokenClass(style)
          span.textContent = line.slice(start, end)
          out.append(span)
        }
      }
    }
    if (i < lines.length - 1) out.append('\n')
  }
  code.replaceChildren(out)
}

export interface PreviewHost {
  /** A link to a file of the worktree was clicked. */
  openFile(path: string): void
}

let fenceSeq = 0

/** Render `source` into `host` (replacing what it held). The returned function stops the fence colouring still running. */
export function showPreview(host: HTMLElement, source: string, ctx: MarkdownContext, h: PreviewHost): () => void {
  const parsed = new DOMParser().parseFromString(renderMarkdown(source, ctx), 'text/html')
  const body = document.createDocumentFragment()
  copyAllowed(parsed.body, body, document)
  host.replaceChildren(body)

  host.onclick = (e) => {
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a || !host.contains(a)) return
    // a link never navigates the window
    e.preventDefault()
    const href = a.getAttribute('href')
    const path = a.getAttribute('data-path')
    if (href !== null && EXTERNAL.test(href)) openExternal(href)
    else if (path !== null) h.openFile(path)
  }
  // a middle click, a ⌘-click and a drag would open or carry a link by themselves
  host.onauxclick = (e) => e.preventDefault()

  // fences: one at a time, in document order (one request at a time per document)
  const fences = [...host.querySelectorAll<HTMLElement>('pre > code[data-lang]')]
  let stopped = false
  let running: { cancel(): void } | null = null
  let doc: string | null = null
  const next = () => {
    const code = fences.shift()
    if (stopped || !code) return
    const text = (code.textContent ?? '').replace(/\n$/, '')
    const lang = code.getAttribute('data-lang') as string
    const store = new TokenStore()
    const key = `md:${++fenceSeq}`
    doc = key
    running = highlighter().tokenize({
      doc: key,
      lang,
      text,
      from: 0,
      budgetMs: null,
      onChunk: (chunk) => store.put(chunk),
      onDone: (r) => {
        running = null
        doc = null
        highlighter().forget(key)
        if (stopped) return
        if (!r.failed && code.isConnected) paint(code, text, store)
        next()
      },
    })
  }
  next()

  return () => {
    stopped = true
    running?.cancel()
    if (doc !== null) highlighter().forget(doc)
    host.onclick = null
    host.onauxclick = null
  }
}
