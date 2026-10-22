import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemOf } from '../../../packages/protocol/src/platform.ts'
import { validateScenario } from './record.ts'
import { agentEnv, makeWorld, sandboxProfile, type World } from './world.ts'

const scenario = (env: Record<string, unknown>) => ({ name: 'x', agent: 'claude', prompt: 'p', cols: 80, rows: 24, env, mock: {}, steps: [{ type: 'prompt' }] })

describe('recorder world', () => {
  it('U-REC-1 · a scenario cannot redirect the model, the proxy, HOME or the config, or load code', () => {
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'all_proxy', 'HOME', 'CLAUDE_CONFIG_DIR', 'PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'CLAUDE_CODE_USE_BEDROCK'])
      expect(() => validateScenario(scenario({ [k]: 'x' })), k).toThrow(/may not set/)
    expect(() => validateScenario(scenario({ CLAUDE_CODE_NO_FLICKER: '1' }))).not.toThrow()
    expect(() => validateScenario(scenario({ A: 1 }))).toThrow(/must be a string/)
    const w = { root: '/r', home: '/r/h', config: '/r/h/.claude', tmp: '/r/t', run: '/r/run', bin: '/r/bin', profile: '/r/p', dispose() {} } satisfies World
    expect(() => agentEnv(w, { mockUrl: 'http://127.0.0.1:1', proxyUrl: 'http://127.0.0.1:2', extra: { ANTHROPIC_BASE_URL: 'https://example.invalid' } })).toThrow(/may not set/)
    expect(agentEnv(w, { mockUrl: 'http://127.0.0.1:1', proxyUrl: 'http://127.0.0.1:2', extra: { CLAUDE_CODE_NO_FLICKER: '1' } }).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1')
  })

  it('U-REC-1 · the profile names only the recorder’s ports and the world’s unix sockets', () => {
    const p = sandboxProfile({ ports: [4100, 4200], world: '/private/tmp/kea-rec-x' })
    expect(p).not.toMatch(/localhost:\*/)
    expect(p.match(/remote ip "[^"]+"/g)).toEqual(['remote ip "localhost:4100"', 'remote ip "localhost:4200"'])
    expect(p).toContain('(allow network-outbound (remote unix-socket (subpath "/private/tmp/kea-rec-x")))')
    expect(() => sandboxProfile({ ports: [0], world: '/x' })).toThrow()
  })

  // contract capture under sandbox-exec stays macOS-only: a named skip on Linux
  describe.runIf(systemOf(process.platform) === 'darwin')('under sandbox-exec', () => { // os-ok: sandbox-exec is macOS's
    const servers: net.Server[] = []
    let allowed = 0
    let other = 0
    let world: World
    let repo = ''
    beforeAll(async () => {
      const listen = async () => {
        const s = net.createServer((c) => c.end())
        servers.push(s)
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
        return (s.address() as net.AddressInfo).port
      }
      allowed = await listen()
      other = await listen()
      repo = realpathSync(mkdtempSync(join(tmpdir(), 'kea-rec-repo-')))
      world = makeWorld({ repo, trusted: true, ports: [allowed] })
    })
    afterAll(async () => {
      world.dispose()
      rmSync(repo, { recursive: true, force: true })
      for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
    })

    const connect = (port: number) => {
      const script = join(world.root, 'probe.mjs')
      writeFileSync(script, `import net from 'node:net'; const s = net.connect(${port}, '127.0.0.1'); s.on('connect', () => { console.log('ok'); s.destroy() }); s.on('error', (e) => console.log(e.code))`)
      return spawnSync('/usr/bin/sandbox-exec', ['-f', world.profile, process.execPath, script], { encoding: 'utf8', timeout: 20_000 }).stdout.trim() // os-ok: contract capture stays macOS-only
    }

    it('U-REC-1 · the agent reaches the recorder’s port and no other local listener', () => {
      expect(connect(allowed)).toBe('ok')
      expect(connect(other)).toMatch(/EPERM|EACCES/)
    })
  })
})
