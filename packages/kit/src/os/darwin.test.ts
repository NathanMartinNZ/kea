import { describe, expect, it } from 'vitest'
import { need, systemOf, unavailable } from '@kea/protocol/platform'
import { darwin } from './darwin.ts'
import { kitOs } from './index.ts'
import { linux } from './linux.ts'

describe("kit's OS layer", () => {
  it("U-PLT-11 · kit's layer: chosen once for this system; both systems have every capability, Linux's `paths` included", () => {
    expect(kitOs).toBe(systemOf(process.platform) === 'linux' ? linux : darwin) // os-ok: the layer of the system this runs on (both systems run this suite)
    expect(unavailable(darwin)).toEqual([])
    expect(unavailable(linux)).toEqual([])
  })

  // Electron's appData as each system finds it: macOS under the account's home whatever HOME says; Linux under
  // an absolute $XDG_CONFIG_HOME, else $HOME/.config (a harness launch's own HOME, tools/perf/src/holders.ts).
  it('U-PLT-37 · the app data folder: ~/Library/Application Support on macOS; $XDG_CONFIG_HOME, else $HOME/.config, on Linux', () => {
    const o = (env: Record<string, string | undefined>) => ({ accountHome: '/Users/kea', env })
    expect(need(darwin.paths).appData(o({ HOME: '/tmp/run/user-home' }), 'Kea-dev-1a2b')).toBe('/Users/kea/Library/Application Support/Kea-dev-1a2b')
    expect(need(linux.paths).appData(o({ HOME: '/tmp/run/user-home' }), 'Kea')).toBe('/tmp/run/user-home/.config/Kea')
    expect(need(linux.paths).appData(o({ HOME: '/home/kea', XDG_CONFIG_HOME: '/xdg' }), 'Kea')).toBe('/xdg/Kea')
    expect(need(linux.paths).appData(o({ HOME: '/home/kea', XDG_CONFIG_HOME: 'relative' }), 'Kea'), 'a relative XDG_CONFIG_HOME is ignored').toBe('/home/kea/.config/Kea')
    expect(need(linux.paths).appData(o({}), 'Kea'), 'no HOME: the account’s').toBe('/Users/kea/.config/Kea')
  })
})
