import { describe, expect, it } from 'vitest'
import { defaultRegistry } from './registry.ts'
import type { LaunchContext } from './types.ts'

const ctx = (helperPath: string, o: Partial<LaunchContext> = {}): LaunchContext => ({
  keaSessionId: '01JXKEASESSION0000000000AA',
  agentSessionId: '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70',
  cwd: '/tmp/wt/fix-auth',
  helperPath,
  keaHome: '/tmp/kea home',
  portBase: 41000,
  binary: null,
  version: null,
  env: { PATH: '/usr/bin:/bin', HOME: '/tmp/h' },
  settings: { extraArgs: [], env: {}, allowDangerousModes: false },
  filesDir: '/tmp/kea home/bin/agents/x-0123456789ab',
  ownWorktree: true,
  ...o,
})

describe('the adapter registry', () => {
  // Core keeps a kea-helper copy for as long as a running terminal's command names it. Read as plain text, Command
  // Code's command names none: its launch carries the helper inside one encoded option, and the copy its hooks run
  // from would go while the agent still runs. Which helper a command names is the adapter's to say.
  it('U-AGT-50 · each adapter says which kea-helper a command it started names: for a launch and a resume, behind the login-shell wrapper, whatever the path holds (a space, a quote, a backslash, a letter past ASCII); a command that is not its own, or whose option cannot be read, names none', () => {
    const registry = defaultRegistry()
    const session = (launch: { prompt: string }) => ({ keaSessionId: '01JXKEASESSION0000000000AA', agentSessionId: '6f1c2b8e-1d2a-4c55-9a7e-0b3c4d5e6f70', transcriptPath: null, cwd: '/tmp/wt/fix-auth', launch })
    for (const helper of ['/Users/u/.kea/bin/0.1.0-aaaaaaaaaaaa/kea-helper', '/tmp/hé x/bin/0.1.0-aaaaaaaaaaaa/kea-helper', '/tmp/a "quoted" \\ home/bin/0.1.0-aaaaaaaaaaaa/kea-helper']) {
      for (const a of registry.list()) {
        const launch = a.buildLaunch({ prompt: 'fix it, with --settings and --mod-option in the prompt' }, ctx(helper))
        const resume = a.buildResume(session({ prompt: 'x' }), ctx(helper))!
        for (const spec of [launch, resume]) {
          const argv = [spec.file, ...spec.args]
          expect(a.helperPaths?.(argv), `${a.id}: ${helper}`).toEqual([helper])
          expect(registry.helperPaths(argv), `${a.id} by the registry`).toEqual([helper])
          // the login-shell wrapper stands in front of the agent's own arguments
          expect(registry.helperPaths(['/bin/zsh', '-l', '-i', '-c', 'exec "$@"', 'kea', ...argv]), `${a.id} through the login shell`).toEqual([helper])
        }
      }
    }
    for (const argv of [[], ['/bin/zsh', '-l'], ['claude', '--settings'], ['claude', '--settings', '{not json'], ['claude', '--settings', '"a string"'], ['claude', '--settings', '{"hooks":{"Stop":[{"hooks":[{"command":7}]}]}}'], ['cmd', '--mod-option'], ['cmd', '--mod-option', 'kea=%%%'], ['cmd', '--mod-option', 'other=abc'], ['npm', 'run', 'dev']]) {
      expect(registry.helperPaths(argv), JSON.stringify(argv)).toEqual([])
    }
  })
})
