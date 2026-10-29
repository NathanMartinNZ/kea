// The update check's world under the test hooks, read from main's command line: an install kind it knows, a stand-in
// feed only on 127.0.0.1 over http, a first delay in whole milliseconds; nothing given, no hooks.
import { describe, expect, it } from 'vitest'
import { updateTestHooks } from './testHooks.ts'

describe('the update test hooks', () => {
  it('U-DST-48 · the install kind, the stand-in feed, the delay and the updater left out; a feed anywhere but 127.0.0.1, or a word it does not know, is dropped', () => {
    expect(updateTestHooks(['/electron', 'main.cjs'])).toBeNull()
    expect(updateTestHooks(['--kea-test-install-kind=deb', '--kea-test-update-feed=http://127.0.0.1:4100/o/n/releases/latest/download/', '--kea-test-update-delay=50'])).toEqual({ kind: 'deb', feed: 'http://127.0.0.1:4100/o/n/releases/latest/download/', delayMs: 50, command: false })
    expect(updateTestHooks(['--kea-test-install-kind=snap', '--kea-test-update-feed=https://example.com/', '--kea-test-update-delay=-1'])).toEqual({ kind: null, feed: null, delayMs: null, command: false })
    expect(updateTestHooks(['--kea-test-update-feed=http://127.0.0.1:4100/no-slash'])).toEqual({ kind: null, feed: null, delayMs: null, command: false })
    expect(updateTestHooks(['--kea-test-update-command'])).toEqual({ kind: null, feed: null, delayMs: null, command: true })
  })
})
