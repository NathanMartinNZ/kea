// A code signature read back: identifier, signer and cdhash of a bundle or binary, from
// `codesign -d --verbose=3`. The verbosity matters: codesign prints no `Authority` line below 2 and no `CDHash` below 3.

import { spawnSync } from 'node:child_process'
import { need } from '../../../packages/protocol/src/platform.ts'
import { packOs } from './os/index.ts'

export interface SignatureInfo {
  identifier: string | null
  format: string | null
  /** The leaf certificate's name (the first `Authority` line); null when ad hoc or unsigned. */
  signer: string | null
  adhoc: boolean
  cdhash: string | null
  /** The hardened runtime flag (Kea's builds are signed without it). */
  runtime: boolean
  /** codesign's output, for error messages. */
  raw: string
}

export function parseSignature(out: string): SignatureInfo {
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1] ?? null
  const adhoc = field('Signature') === 'adhoc'
  return {
    identifier: field('Identifier'),
    format: field('Format'),
    signer: adhoc ? null : field('Authority'),
    adhoc,
    cdhash: field('CDHash'),
    runtime: /^CodeDirectory .*flags=\S*runtime/m.test(out),
    raw: out,
  }
}

export function readSignature(file: string): SignatureInfo {
  const r = spawnSync(need(packOs.tools).path('codesign'), ['-d', '--verbose=3', file], { encoding: 'utf8' })
  return parseSignature(`${r.stdout ?? ''}${r.stderr ?? ''}`)
}
