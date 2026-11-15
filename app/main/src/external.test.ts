// The answer to a link the window asked to open (`kea:openLink`), with the system replaced by recorders.
import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { handLink, LINK_NOT_OPENED, LINK_REFUSALS, RecordingOpener, type ExternalOpener } from './external.ts'

describe('kea:openLink', () => {
  it('U-TERM-63 · a link is checked, then handed over (null), the opener told after the call that cannot be taken back; a refused address, the system’s refusal and a long address each come back in words', async () => {
    const steps: string[] = []
    const recorder = new RecordingOpener()
    const opener: ExternalOpener = { open: (url) => (steps.push(`open ${url}`), recorder.open(url)) }
    expect(await handLink('https://example.com/a', opener, () => steps.push('called'))).toBeNull()
    expect(steps).toEqual(['called', 'open https://example.com/a'])
    expect([...recorder.log]).toEqual(['https://example.com/a'])

    // refused before anything is called
    steps.length = 0
    expect(await handLink('javascript:alert(1)', opener, () => steps.push('called'))).toBe(LINK_REFUSALS.scheme)
    expect(await handLink('https://', opener, () => steps.push('called'))).toBe(LINK_REFUSALS.malformed)
    expect(await handLink(null, opener, () => steps.push('called'))).toBe(LINK_REFUSALS.malformed)
    expect(await handLink(`https://x.dev/${'a'.repeat(L.linkOpenMaxChars)}`, opener, () => steps.push('called'))).toBe(LINK_REFUSALS.long)
    expect(steps).toEqual([])

    // the system refused it
    const refusing: ExternalOpener = { open: () => Promise.reject(new Error('Failed to open')) }
    expect(await handLink('https://example.com/b', refusing, () => undefined)).toBe(LINK_NOT_OPENED)
  })
})
