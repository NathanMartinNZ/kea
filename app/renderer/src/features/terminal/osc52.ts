// OSC 52 clipboard writes from terminal output. Output is untrusted, so a write is applied only while its terminal is
// the visible one and the window is focused (`terminal.clipboardWrite`: `focused` default, `always`, `never`), and only
// up to `L.osc52MaxBytes`. Reads (`OSC 52 ; c ; ?`) are never answered anywhere: the query table swallows them.
// Everything else is dropped and logged.

export type ClipboardWritePolicy = 'focused' | 'always' | 'never'

export type Osc52 =
  | { kind: 'write'; text: string; bytes: number }
  | { kind: 'read' }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'invalid' }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Parse the payload of `OSC 52 ; Pc ; Pd`. Oversized payloads are measured, never decoded. */
export function parseOsc52(data: string, maxBytes: number): Osc52 {
  const semi = data.indexOf(';')
  if (semi < 0) return { kind: 'invalid' }
  const pd = data.slice(semi + 1)
  if (pd === '?') return { kind: 'read' }
  if (pd.length === 0 || pd.length % 4 === 1) return { kind: 'invalid' }
  const decodedLength = Math.floor((pd.length * 3) / 4) - (pd.endsWith('==') ? 2 : pd.endsWith('=') ? 1 : 0)
  if (decodedLength > maxBytes) return { kind: 'oversize', bytes: decodedLength }
  if (!BASE64.test(pd)) return { kind: 'invalid' }
  let bin: string
  try {
    bin = atob(pd)
  } catch {
    return { kind: 'invalid' }
  }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  if (bytes.length > maxBytes) return { kind: 'oversize', bytes: bytes.length }
  return { kind: 'write', text: new TextDecoder().decode(bytes), bytes: bytes.length }
}

export type Osc52Decision = { apply: true; text: string } | { apply: false; reason: 'read' | 'invalid' | 'oversize' | 'never' | 'hidden' | 'unfocused' }

export function osc52Decision(o: { parsed: Osc52; policy: ClipboardWritePolicy; visible: boolean; windowFocused: boolean }): Osc52Decision {
  const p = o.parsed
  if (p.kind !== 'write') return { apply: false, reason: p.kind }
  if (o.policy === 'never') return { apply: false, reason: 'never' }
  if (o.policy === 'focused') {
    if (!o.visible) return { apply: false, reason: 'hidden' }
    if (!o.windowFocused) return { apply: false, reason: 'unfocused' }
  }
  return { apply: true, text: p.text }
}
