// The OS layer's `browser`: how each system hands a checked page to the default browser, with Electron and the
// process runner replaced by recorders (no browser starts).
import { describe, expect, it } from 'vitest'
import { darwin } from './darwin.ts'
import type { BrowserVia } from './index.ts'
import { linux } from './linux.ts'

type Call = { kind: string; args: unknown[] }

function via(o: { app?: () => Promise<{ path: string }>; run?: () => Promise<{ code: number | null; timedOut: boolean; stderr: string }>; openPath?: () => Promise<string> }): { via: BrowserVia; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    via: {
      app: {
        getApplicationInfoForProtocol: (url: string) => {
          calls.push({ kind: 'app', args: [url] })
          return (o.app ?? (() => Promise.resolve({ path: '/Applications/Firefox.app' })))() as never
        },
      },
      shell: {
        openPath: (p: string) => {
          calls.push({ kind: 'openPath', args: [p] })
          return (o.openPath ?? (() => Promise.resolve('')))()
        },
      },
      run: (file, args) => {
        calls.push({ kind: 'run', args: [file, [...args]] })
        return (o.run ?? (() => Promise.resolve({ code: 0, timedOut: false, stderr: '' })))()
      },
    },
  }
}

const FILE = '/work tree/site/index.html'

describe('Open in Browser', () => {
  it('U-FV-34 · macOS opens the page with the app the system opens web addresses with, named by its path; Linux hands it to the desktop’s app for its type; a failure comes back in words', async () => {
    // macOS: the https handler, then `open -a <that app> <file>` as argv; never the type's own handler
    const ok = via({})
    expect(await darwin.browser.openPage(FILE, ok.via)).toBeNull()
    expect(ok.calls).toEqual([
      { kind: 'app', args: ['https://'] },
      { kind: 'run', args: ['/usr/bin/open', ['-a', '/Applications/Firefox.app', FILE]] },
    ])
    // no handler: nothing runs
    for (const app of [() => Promise.reject(new Error('none')), () => Promise.resolve({ path: '' })]) {
      const none = via({ app })
      expect(await darwin.browser.openPage(FILE, none.via)).toBe('No default browser was found')
      expect(none.calls.map((c) => c.kind)).toEqual(['app'])
    }
    // `open` failed: its last line of stderr, else plain words; one that never started, or timed out, too
    expect(await darwin.browser.openPage(FILE, via({ run: () => Promise.resolve({ code: 1, timedOut: false, stderr: 'LSOpenURLsWithRole() failed\nUnable to open the page\n' }) }).via)).toBe('Unable to open the page')
    expect(await darwin.browser.openPage(FILE, via({ run: () => Promise.resolve({ code: 1, timedOut: false, stderr: '' }) }).via)).toBe('The page could not be opened')
    expect(await darwin.browser.openPage(FILE, via({ run: () => Promise.resolve({ code: null, timedOut: true, stderr: '' }) }).via)).toBe('The page could not be opened')
    expect(await darwin.browser.openPage(FILE, via({ run: () => Promise.reject(new Error('spawn')) }).via)).toBe('The page could not be opened')

    // Linux: Electron's openPath (xdg-open's handler for the type), nothing run by Kea itself
    const lx = via({})
    expect(await linux.browser.openPage(FILE, lx.via)).toBeNull()
    expect(lx.calls).toEqual([{ kind: 'openPath', args: [FILE] }])
    expect(await linux.browser.openPage(FILE, via({ openPath: () => Promise.resolve('No application found') }).via)).toBe('No application found')
    expect(await linux.browser.openPage(FILE, via({ openPath: () => Promise.reject(new Error('x')) }).via)).toBe('The page could not be opened')
  })
})
