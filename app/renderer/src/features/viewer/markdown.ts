// The Markdown preview's renderer. A Markdown file is untrusted input: whatever it says, the preview runs no script,
// loads nothing remote and shows no file from outside the session's folder.
//
//   raw HTML      off (`html: false`): tags in the source are shown as the text they are
//   links         only http, https and mailto leave Kea (through the system browser); a relative link names a file of
//                 the worktree and opens in the viewer; any other scheme (`javascript:`, `data:`, `file:`, …) gets no
//                 target at all: its text is shown, and a click does nothing
//   images        a relative path inside the worktree with an image type's extension becomes a `kea-file://` URL,
//                 which main serves only from inside the session's folder (a symlink that leads out resolves to
//                 nothing there); everything else — remote, `data:`, `file:`, a path that climbs out — is not
//                 requested: its alt text is shown instead
//   code fences   plain text here; `preview.ts` colours them with the highlight worker once they are in the page
//
// This module is pure (source → HTML string; U-FV-9). `preview.ts` puts the result in the page through a second,
// independent filter that keeps only the tags and attributes this renderer makes.

import createMarkdownIt, { type MarkdownIt } from 'markdown-it'
import { imageExtension, isWorktreePath, keaFileUrl } from '@kea/protocol'
import { languageOf, LANGUAGE_NAMES } from './language.ts'

export interface MarkdownContext {
  /** The session's working directory, absolute. */
  cwd: string
  /** The Markdown file, relative to it. */
  path: string
  /** Makes a changed image a new URL (the file's mtime). */
  version?: number
}

const EXTERNAL = /^(https?:\/\/|mailto:)/i
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function decoded(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/**
 * A relative reference from the Markdown file → a path inside the worktree, or null when it is not one: a URL with a
 * scheme or a host, a path that climbs out of the worktree, an empty one. A leading `/` means the worktree's root.
 */
export function worktreeTarget(ctx: Pick<MarkdownContext, 'path'>, ref: string): string | null {
  if (ref === '' || HAS_SCHEME.test(ref) || ref.startsWith('//') || ref.includes('\\')) return null
  const bare = ref.replace(/[?#].*$/, '')
  const plain = decoded(bare)
  if (plain === null || plain === '') return null
  const base = plain.startsWith('/') ? [] : ctx.path.split('/').slice(0, -1)
  for (const seg of plain.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (base.length === 0) return null
      base.pop()
    } else base.push(seg)
  }
  const out = base.join('/')
  return isWorktreePath(out) ? out : null
}

/** The `kea-file://` URL of an image the preview may show, or null (then its alt text is shown). */
export function imageUrl(ctx: MarkdownContext, src: string): string | null {
  const target = worktreeTarget(ctx, src)
  if (target === null || imageExtension(target) === null) return null
  return keaFileUrl(`${ctx.cwd.replace(/\/+$/, '')}/${target}`, ctx.version)
}

export type LinkTarget = { kind: 'external'; url: string } | { kind: 'file'; path: string }

/** Where a link of the preview leads, or null for one that leads nowhere Kea goes (an in-page anchor, a refused scheme). */
export function linkTarget(ctx: Pick<MarkdownContext, 'path'>, href: string): LinkTarget | null {
  if (EXTERNAL.test(href)) return { kind: 'external', url: href }
  const path = worktreeTarget(ctx, href)
  return path === null ? null : { kind: 'file', path }
}

/** A fence's info string (` ```ts `, ` ```python title="x" `) → a grammar id of the highlight worker, or null. */
export function fenceLanguage(info: string): string | null {
  const word = info.trim().split(/[\s,{]/)[0]?.toLowerCase() ?? ''
  if (word === '' || !/^[a-z0-9+#._-]+$/.test(word)) return null
  if (Object.hasOwn(LANGUAGE_NAMES, word)) return word
  const alias: Readonly<Record<string, string>> = { shell: 'shellscript', console: 'shellscript', 'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', objc: 'objective-c', golang: 'go', dockerfile: 'docker', makefile: 'make', text: '', plaintext: '', txt: '' }
  if (Object.hasOwn(alias, word)) return alias[word] || null
  // otherwise as a file extension would be read: ts, py, rs, yml, sh, …
  return languageOf(`x.${word}`)?.id ?? null
}

let md: MarkdownIt | null = null

function attr(token: { attrGet(name: string): string | number | null }, name: string): string | null {
  const v = token.attrGet(name)
  return v === null ? null : String(v)
}

function renderer(): MarkdownIt {
  if (md) return md
  const m = createMarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })
  const escape = m.utils.escapeHtml
  // every link and image reaches the two rules below (markdown-it's own list would leave a refused one as source
  // text); they alone decide what gets a target: nothing else in this renderer writes a URL
  m.validateLink = () => true
  m.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const alt = self.renderInlineAsText(token.children ?? [], options, env)
    const url = imageUrl(env as unknown as MarkdownContext, attr(token, 'src') ?? '')
    if (url === null) return `<span class="md-no-image">${escape(alt === '' ? 'image' : alt)}</span>`
    const title = attr(token, 'title')
    return `<img src="${escape(url)}" alt="${escape(alt)}"${title ? ` title="${escape(title)}"` : ''}>`
  }
  m.renderer.rules.link_open = (tokens, idx, _options, env) => {
    const href = attr(tokens[idx]!, 'href') ?? ''
    const target = linkTarget(env as unknown as MarkdownContext, href)
    // an in-page anchor, or a relative reference that names nothing inside the worktree: text that looks like a link
    if (target === null) return '<a>'
    const title = attr(tokens[idx]!, 'title')
    return target.kind === 'external' ? `<a href="${escape(target.url)}"${title ? ` title="${escape(title)}"` : ''}>` : `<a data-path="${escape(target.path)}"${title ? ` title="${escape(title)}"` : ''}>`
  }
  m.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]!
    const lang = fenceLanguage(token.info)
    return `<pre><code${lang ? ` data-lang="${escape(lang)}"` : ''}>${escape(token.content)}</code></pre>\n`
  }
  md = m
  return m
}

/** Markdown source → the preview's HTML. */
export function renderMarkdown(source: string, ctx: MarkdownContext): string {
  return renderer().render(source, { ...ctx })
}
