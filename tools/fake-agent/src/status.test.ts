import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { statusFileLocation, StatusFileWriter } from './status.ts'

const dir = mkdtempSync(join(tmpdir(), 'fake-agent-status-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SEQUENCE = fileURLToPath(new URL('../../../fixtures/status/claude/2.1.296/sequence.json', import.meta.url))
type Entry = { t: number; source: 'file' | 'hook' | 'input' | 'screen'; what: string | { status: string | null; waitingFor: string | null } }

const label = (v: { status?: unknown; waitingFor?: unknown } | 'removed'): string =>
  v === 'removed' ? 'removed' : v.status ? `${String(v.status)}${v.waitingFor ? `:${String(v.waitingFor)}` : ''}` : 'registered'

describe('fake-agent status file', () => {
  it('U-FAKE-28 · auto mode writes the recorded 2.1.296 sequence of statuses for the recorded hooks and keys, in place, and removes the file at the end', () => {
    const recorded = (JSON.parse(readFileSync(SEQUENCE, 'utf8')) as { entries: Entry[] }).entries
    const expected = recorded.filter((e) => e.source === 'file').map((e) => label(e.what === 'removed' ? 'removed' : (e.what as { status: string | null; waitingFor: string | null })))
    const path = join(dir, 'cfg', 'sessions', '4242.json')
    const seen: string[] = []
    let inode: number | null = null
    const look = () => {
      let v: Record<string, unknown> | 'removed'
      try {
        v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const ino = statSync(path).ino
        inode ??= ino
        expect(ino).toBe(inode) // rewritten in place: one inode for the session
        expect(v).toMatchObject({ pid: 4242, sessionId: 'sid-1', cwd: '/w', version: '2.1.296' })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        v = 'removed'
      }
      if (seen.at(-1) !== label(v)) seen.push(label(v))
    }
    // every write is looked at (an interrupt at a prompt writes busy, then idle)
    class Watched extends StatusFileWriter {
      override set(v: { status: string; waitingFor?: string }): void {
        super.set(v)
        look()
      }
    }
    const w = new Watched(path, { pid: 4242, sessionId: 'sid-1', cwd: '/w', version: '2.1.296' })
    w.register()
    look()
    w.set({ status: 'idle' })
    look()
    for (const e of recorded) {
      if (e.source === 'hook' && typeof e.what === 'string') {
        const [event = '', tool = null] = e.what.split(' ')
        w.beforeHook(event, tool)
        look()
        w.afterHook(event, tool)
        look()
      } else if (e.source === 'input' && e.what === 'key Esc') {
        w.interrupted()
        look()
      } else if (e.source === 'input' && e.what === 'typed "/exit"') {
        w.remove()
        look()
      }
    }
    // the recording turns busy before SessionStart for its argv prompt; the fake turns busy at UserPromptSubmit: same sequence
    expect(seen).toEqual(expected)
  })

  it('U-FAKE-28 · the file goes under CLAUDE_CONFIG_DIR, else the fake home’s .claude, and never under the real home', () => {
    const realHome = join(dir, 'real-home')
    mkdirSync(join(realHome, '.claude'), { recursive: true })
    const base = { pid: 7, cwd: '/w', realHome }
    expect(statusFileLocation({ ...base, configDir: join(dir, 'cfg'), override: null, home: realHome })).toEqual({ path: join(dir, 'cfg', 'sessions', '7.json'), writable: true })
    expect(statusFileLocation({ ...base, configDir: undefined, override: join(dir, 'fh'), home: realHome })).toEqual({ path: join(dir, 'fh', '.claude', 'sessions', '7.json'), writable: true })
    expect(statusFileLocation({ ...base, configDir: undefined, override: null, home: realHome })).toMatchObject({ writable: false })
    expect(statusFileLocation({ ...base, configDir: join(realHome, '.claude'), override: null, home: '/elsewhere' })).toMatchObject({ writable: false })
    expect(statusFileLocation({ ...base, configDir: join(realHome, '.claude-dev', 'x'), override: null, home: '/elsewhere' })).toMatchObject({ writable: false })
    expect(statusFileLocation({ ...base, configDir: 'relative/dir', override: join(dir, 'fh'), home: realHome }).path).toBe(join(dir, 'fh', '.claude', 'sessions', '7.json'))
  })
})
