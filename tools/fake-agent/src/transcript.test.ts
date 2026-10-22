import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { claudeProjectDirName, commandCodeSlug, transcriptLocation, TranscriptWriter } from './transcript.ts'

const dir = mkdtempSync(join(tmpdir(), 'fake-agent-transcript-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fields = { text: null, title: null, costUsd: null, forToolUse: false, json: null, fields: {} }

describe('fake-agent transcripts', () => {
  it('U-FAKE-15 · transcript paths follow each CLI\'s project-directory naming', () => {
    expect(claudeProjectDirName('/Users/x/my.repo_1')).toBe('-Users-x-my-repo-1')
    // Command Code slugifies the cwd: camel case split, lower case, runs of other characters one `-`, none at the ends
    expect(commandCodeSlug('/Users/X/My..Repo__1')).toBe('users-x-my-repo-1')
    expect(commandCodeSlug('/private/tmp/kea-fixture-Z6TgWY/demo')).toBe('private-tmp-kea-fixture-z6-tg-wy-demo')
    expect(commandCodeSlug('/private/tmp/kea-fixture-IQpdhM/demo')).toBe('private-tmp-kea-fixture-i-qpdh-m-demo')
    expect(commandCodeSlug('/')).toBe('root')
    const long = `/${'a'.repeat(300)}`
    expect(claudeProjectDirName(long).length).toBe(200)
    expect(claudeProjectDirName(long)).not.toBe(claudeProjectDirName(`/${'a'.repeat(299)}b`))
    const home = join(dir, 'home')
    const loc = transcriptLocation({ flavour: 'claude', cwd: '/w/t', sessionId: 'sid', override: home, home: '/Users/real', realHome: '/Users/real' })
    expect(loc).toEqual({ path: join(home, '.claude/projects/-w-t/sid.jsonl'), writable: true })
    expect(transcriptLocation({ flavour: 'commandcode', cwd: '/W/T', sessionId: 'sid', override: home, home: '/Users/real', realHome: '/Users/real' }).path).toBe(join(home, '.commandcode/projects/w-t/sid.jsonl'))
  })

  it('U-FAKE-16 · never under the real home: refused when HOME is the real home with no override, or when the override is the real home or inside its ~/.claude*', () => {
    const realHome = join(dir, 'real-home')
    mkdirSync(join(realHome, '.claude'), { recursive: true })
    const base = { flavour: 'claude' as const, cwd: '/w', sessionId: 'sid', realHome }
    const noOverride = transcriptLocation({ ...base, override: null, home: realHome })
    expect(noOverride).toMatchObject({ writable: false, reason: expect.stringMatching(/HOME is the real home and neither --fake-home nor FAKE_AGENT_HOME is set/) })
    expect(noOverride.path).toBe(join(realHome, '.claude/projects/-w/sid.jsonl')) // still reported for payloads
    expect(transcriptLocation({ ...base, override: realHome, home: '/elsewhere' })).toMatchObject({ writable: false })
    expect(transcriptLocation({ ...base, override: join(realHome, '.claude'), home: '/elsewhere' })).toMatchObject({ writable: false, reason: expect.stringMatching(/inside the real ~\/\.claude/) })
    expect(transcriptLocation({ ...base, override: join(realHome, '.claude-dev', 'x'), home: '/elsewhere' })).toMatchObject({ writable: false })
    expect(transcriptLocation({ ...base, override: join(realHome, '.kea'), home: '/elsewhere' })).toMatchObject({ writable: false })
    // a sandboxed HOME (tests set HOME to a temp dir) is fine without an override; so is a scratch dir in the real home
    expect(transcriptLocation({ ...base, override: null, home: join(dir, 'sandbox') })).toMatchObject({ writable: true })
    expect(transcriptLocation({ ...base, override: join(realHome, 'scratch'), home: realHome })).toMatchObject({ writable: true })
  })

  it('U-FAKE-17 · the writer appends JSONL records (user, assistant, both interrupt markers, ai-title, custom-title, cost-state, raw) and chains parentUuid', () => {
    const path = join(dir, 'h', '.claude', 'projects', '-w', 'sid.jsonl')
    const w = new TranscriptWriter(path, { sessionId: 'sid', cwd: '/w', model: 'opus', version: '0.1.0 (fake-agent)' }, () => new Date(0))
    expect(existsSync(path)).toBe(false) // nothing until the first record
    w.write('user', { ...fields, text: 'hello' })
    w.write('assistant', { ...fields, text: 'hi', fields: { costHint: 1 } })
    w.write('interrupt', fields)
    w.write('interrupt', { ...fields, forToolUse: true })
    w.write('ai-title', { ...fields, title: 'A title' })
    w.write('custom-title', { ...fields, title: 'Mine' })
    w.write('cost-state', { ...fields, costUsd: 0.25 })
    w.write('raw', { ...fields, json: { type: 'summary', summary: 's' } })
    const recs = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(recs.map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'user', 'ai-title', 'custom-title', 'cost-state', 'summary'])
    expect(recs[0]).toMatchObject({ parentUuid: null, sessionId: 'sid', cwd: '/w', message: { role: 'user', content: 'hello' }, timestamp: '1970-01-01T00:00:00.000Z' })
    expect(recs[1]).toMatchObject({ parentUuid: recs[0]?.uuid, message: { role: 'assistant', model: 'opus', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }, costHint: 1 })
    expect((recs[1]?.message as { usage: object }).usage).toHaveProperty('input_tokens')
    expect(recs[2]).toMatchObject({ message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    expect(recs[3]).toMatchObject({ message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
    expect(recs[4]).toEqual({ type: 'ai-title', aiTitle: 'A title', sessionId: 'sid' })
    expect(recs[5]).toEqual({ type: 'custom-title', customTitle: 'Mine', sessionId: 'sid' })
    expect(recs[6]).toMatchObject({ type: 'cost-state', totalCostUSD: 0.25 })
    expect(recs[7]).toEqual({ type: 'summary', summary: 's' })
  })
})
