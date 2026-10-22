import { describe, expect, it } from 'vitest'
import { launchArgs, type LaunchRequest } from '../holder/launch.ts'
import { need } from '@kea/protocol'
import { clientOption, linux } from './linux.ts'

describe("Linux's client option", () => {
  // ptyhost's own executable decides: root's alone (an installed package) → `--client-exe`, checked in full; anything
  // its user can change (install.sh --user, a dev build) → `--client-exe-unchecked`; a test runner's node is always
  // unchecked. The launcher gets the option and its value as two arguments.
  it('U-PLT-16 · --client-exe when only root can change ptyhost\'s executable, else --client-exe-unchecked; a test runner is unchecked; the launcher gets the pair', async () => {
    expect(clientOption('/opt/Kea/kea', () => true)).toEqual({ option: '--client-exe', value: '/opt/Kea/kea' })
    expect(clientOption('/home/u/.local/share/kea/kea', () => false)).toEqual({ option: '--client-exe-unchecked', value: '/home/u/.local/share/kea/kea' })
    expect(await need(linux.clientRequirement).unchecked('/x/node')).toEqual({ option: '--client-exe-unchecked', value: '/x/node' })
    const r: LaunchRequest = {
      helper: '/h/kea-helper',
      ptyId: 'abcdefghij',
      sessionId: 's1',
      kind: 'shell',
      stateDir: '/k/sessions/s1',
      sock: '/k/run/abcdefghij.sock',
      cols: 80,
      rows: 24,
      client: clientOption('/opt/Kea/kea', () => true),
      ringBytes: 1,
      keaVersion: 'test',
      spec: { file: '/bin/sh', args: [], env: {}, cwd: '/' },
    }
    const args = launchArgs(r)
    expect(args.slice(args.indexOf('--client-exe'), args.indexOf('--client-exe') + 2)).toEqual(['--client-exe', '/opt/Kea/kea'])
    expect(args).not.toContain('--client-req')
  })
})
