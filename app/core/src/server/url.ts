// The dev server's output, read for two things: the URLs it prints, and the lines that say it is up.
//
// Output is terminal output: colours and cursor moves are stripped first (Vite prints the port in bold, so a URL is
// split by escape sequences). A URL counts when it names this machine: `http(s)://(localhost|127.0.0.1|0.0.0.0|[::1]):<port>`,
// with the path printed after it, if any. `0.0.0.0` is not an address a browser opens, so it reads `localhost`.

/** CSI sequences, OSC strings (ended by BEL or ST), and two-character escapes. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g
/** Other control characters a terminal acts on (not tab, line feed or carriage return). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '')
}

const MAX_PORT = 0xffff
const LOCAL_URL = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)(\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]*)?/g
/** Punctuation that ends a sentence or closes a bracket, not a path. */
const TRAILING = /[.,;:!?'")\]]+$/

export interface PrintedUrl {
  url: string
  port: number
}

/**
 * The local URLs in `text` (already stripped), in the order printed, each once. A match that runs to the very end of
 * the text may be cut short (the rest of the port has not been read yet), so it waits for the next read.
 */
export function printedUrls(text: string): PrintedUrl[] {
  const out: PrintedUrl[] = []
  const seen = new Set<string>() // bounded: the URLs of one read of at most L.serverOutputTailBytes
  for (const m of text.matchAll(LOCAL_URL)) {
    const [whole, scheme, host, digits, rawPath] = m as unknown as [string, string, string, string, string | undefined]
    if ((m.index ?? 0) + whole.length === text.length) continue
    const port = Number(digits)
    if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) continue
    const path = (rawPath ?? '').replace(TRAILING, '')
    const url = `${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${port}${path}`
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, port })
  }
  return out
}

const UP_WORDS = /\b(?:listening|ready|started)\b/i

/** Output that says the server may be up now: a local URL, or "listening" / "ready" / "started". */
export function announcesListening(text: string): boolean {
  if (UP_WORDS.test(text)) return true
  LOCAL_URL.lastIndex = 0
  const found = LOCAL_URL.test(text)
  LOCAL_URL.lastIndex = 0
  return found
}

/**
 * The primary URL. The first printed URL whose port is listening; else `http://localhost:<lowest listening
 * port>`; null while nothing listens.
 */
export function primaryUrl(printed: readonly PrintedUrl[], listening: readonly number[]): string | null {
  if (listening.length === 0) return null
  const hit = printed.find((p) => listening.includes(p.port))
  if (hit) return hit.url
  return `http://localhost:${Math.min(...listening)}`
}

/** The port a URL names (the chip's label), or null. */
export function urlPort(url: string): number | null {
  LOCAL_URL.lastIndex = 0
  const m = LOCAL_URL.exec(url)
  LOCAL_URL.lastIndex = 0
  return m ? Number(m[3]) : null
}

/** The server's own "port in use" error, and the port it names when it names one. */
const IN_USE = /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|port is (?:already )?in use/i
const NAMED_PORT = /\bport[ =:]+(\d{2,5})\b/i
const COLON_PORT = /:(\d{2,5})\b/g

/**
 * The latest line of `text` (already stripped) that reports a port in use, with the port it names: "port 3000", else
 * the first `:<port>` after the error's words (`EADDRINUSE: address already in use :::3000`), else the last one before
 * them (`listen tcp :8080: bind: address already in use`). Null when no line reports one.
 */
export function portInUse(text: string): { port: number | null } | null {
  const lines = text.split(/\r?\n|\r/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    const hit = IN_USE.exec(line)
    if (!hit) continue
    const after = [...line.slice(hit.index).matchAll(COLON_PORT)][0]
    const before = [...line.slice(0, hit.index).matchAll(COLON_PORT)].at(-1)
    const port = Number(NAMED_PORT.exec(line)?.[1] ?? after?.[1] ?? before?.[1] ?? Number.NaN)
    return { port: Number.isSafeInteger(port) && port >= 1 && port <= MAX_PORT ? port : null }
  }
  return null
}
