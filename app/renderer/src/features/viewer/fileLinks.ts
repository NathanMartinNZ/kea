// The viewer's file references, wired to core: what `viewer.resolveRefs` answered, remembered for L.viewerLinkCacheMs,
// at most L.viewerLinkCacheMax answers, keyed by the reference (session, file, family, specifier); one question per key
// is out at once, at most L.viewerLinkCacheMax of them (`lib/linkChecks.ts`). `unknown` (a candidate core could not
// check) is never remembered, so the next hover asks again. The window forgets every answer when it shows another
// session (`forgetFileLinks`, from the viewer's commands). The controller's editor hooks reach core only through here.

import { L, type RefAnswer, type RefFile } from '@kea/protocol'
import { LinkChecks } from '../../lib/linkChecks.ts'
import { call } from '../../lib/rpc.ts'
import type { FoundRef } from './fileRefs.ts'
import type { RefDoc } from './linkView.ts'

const checks = new LinkChecks<RefDoc, FoundRef, RefAnswer>({
  resolve: async (doc, refs) => {
    const args = refs.map((r) => ({ family: r.family, spec: r.spec, ...(r.line !== undefined ? { line: r.line } : {}), ...(r.col !== undefined ? { col: r.col } : {}) }))
    return (await call('viewer.resolveRefs', { sessionId: doc.sessionId, from: doc.path, refs: args })).refs
  },
  key: (doc, r) => `${doc.sessionId}\n${doc.path}\n${r.family}\n${r.spec}`,
  keep: (a) => a !== 'unknown',
  maxAgeMs: L.viewerLinkCacheMs,
  max: L.viewerLinkCacheMax,
})

/** The file a remembered answer gives for `ref`, at the position `ref` itself names (two references to one file may name two lines). */
const atRef = (a: RefFile, ref: FoundRef): RefFile => ({ path: a.path, ...(ref.line !== undefined ? { line: ref.line } : {}), ...(ref.line !== undefined && ref.col !== undefined ? { col: ref.col } : {}) })

/** What the window remembers of core's answer for `ref` in `doc`: its file, null (none), or undefined (not known). */
export function fileLinkAnswer(doc: RefDoc, ref: FoundRef): RefFile | null | undefined {
  const a = checks.known(doc, ref)
  if (a === undefined || a === 'unknown') return undefined
  return a === null ? null : atRef(a, ref)
}

/** Ask core about `refs` of `doc` (those not remembered and not out already): one answer each, undefined for one not asked. */
export async function askFileLinks(doc: RefDoc, refs: FoundRef[]): Promise<(RefAnswer | undefined)[]> {
  const answers = await checks.check(doc, refs)
  return answers.map((a, i) => (a && a !== 'unknown' ? atRef(a, refs[i] as FoundRef) : a))
}

/** The window shows another session: no answer is kept, and none still out will be. */
export function forgetFileLinks(): void {
  checks.clear()
}

/** The resource report's `renderer.viewerLinks` (answers remembered) and `renderer.viewerLinksInFlight` (questions out). */
export function fileLinkCounts(): { answers: number; inFlight: number } {
  return { answers: checks.size, inFlight: checks.inFlight }
}
