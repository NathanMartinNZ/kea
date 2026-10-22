import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rawFixtures, scrubTree } from './files.ts'
import { assertRecordable, FIXTURE_REPO_MARKER, NotRecordableError } from './guard.ts'
import { findAbsolutePaths, type Identity, placeholder, scanForPrivateData, scrubBuffer } from './scrub.ts'

// A made-up developer; secrets are assembled at run time so this file never contains one verbatim.
const ID: Identity = {
  home: '/Users/janedoe',
  user: 'janedoe',
  hosts: ['Janes-MBP.local', 'Janes-MBP'],
  names: ['Jane Q. Doe'],
  emails: ['jane.doe@example.org'],
}
const ctx = { identity: ID }
const SECRETS = {
  anthropic: 'sk-' + 'ant-api03-' + 'Ab3dEf6hIj9k'.repeat(4),
  github: 'gh' + 'p_' + 'a1B2c3D4e5'.repeat(4),
  githubPat: 'github' + '_pat_' + '11ABCDEFG0'.repeat(4),
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  slack: 'xo' + 'xb-' + '123456789012-abcdefABCDEF',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36P',
  pem: '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END ' + 'PRIVATE KEY-----',
}

const s = (b: Buffer) => b.toString('utf8')
const scrub = (text: string, c = ctx) => s(scrubBuffer(Buffer.from(text), c).output)

describe('scrubber', () => {
  it('U-SCRUB-1 · identity becomes same-length placeholders (home keeps its /Users/ prefix)', () => {
    const input = 'cwd=/Users/janedoe/demo\nuser janedoe@Janes-MBP.local\nAuthor: Jane Q. Doe <jane.doe@example.org>\nJANEDOE and jonathan-janedoes stay apart'
    const out = scrub(input)
    expect(out).toBe(
      'cwd=/Users/HOME___/demo\nuser USER___@HOST___________\nAuthor: NAME_______ <EMAIL_______________>\nUSER___ and jonathan-janedoes stay apart',
    )
    expect(Buffer.byteLength(out)).toBe(Buffer.byteLength(input))
    expect(placeholder('EMAIL', 3)).toBe('EMA')
    expect(placeholder('HOME', 6)).toBe('HOME__')
    // a non-ASCII name keeps its byte length too
    const nonAscii = scrubBuffer(Buffer.from('by Zoë Ångström.'), { identity: { names: ['Zoë Ångström'] } }).output
    expect(nonAscii.length).toBe(Buffer.byteLength('by Zoë Ångström.'))
    expect(s(nonAscii)).toBe(`by ${placeholder('NAME', Buffer.byteLength('Zoë Ångström'))}.`)
  })

  it('U-SCRUB-2 · every secret pattern is replaced by a same-length x run and the gate passes afterwards', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const input = Buffer.from(`before ${secret} after`)
      expect(scanForPrivateData(input, ctx).length, name).toBeGreaterThan(0)
      const { output, counts } = scrubBuffer(input, ctx)
      expect(output.length, name).toBe(input.length)
      expect(Object.values(counts).reduce((a, b) => a + b, 0), name).toBe(1)
      expect(scanForPrivateData(output, ctx), name).toEqual([])
      expect(s(output).startsWith('before ') && s(output).endsWith(' after'), name).toBe(true)
      // scrubbing is idempotent
      expect(scrubBuffer(output, ctx).output.equals(output), name).toBe(true)
    }
    expect(scrub(`k=${SECRETS.anthropic}`)).toBe(`k=sk-ant-${'x'.repeat(SECRETS.anthropic.length - 7)}`)
    expect(scrub(SECRETS.jwt)).toMatch(/^eyJx+\.x+\.x+$/)
    expect(scrub(SECRETS.pem).split('\n').map((l) => l.replace(/x/g, ''))).toEqual(['-----BEGIN PRIVATE KEY-----', '', '', '-----END PRIVATE KEY-----'])
    expect(scrub('git clone https://bob:hunter2pass@example.com/r.git')).toBe(`git clone https://bob:${'x'.repeat('hunter2pass'.length)}@example.com/r.git`)
    expect(scrub('Authorization: Bearer abcdef0123456789')).toBe('Authorization: Bearer xxxxxxxxxxxxxxxx')
  })

  it('U-SCRUB-3 · KEY=value lines and secret JSON fields; .env files scrub every value; references and other keys stay', () => {
    expect(scrub('export STRIPE_SECRET_KEY="abc123"\nDB_PASSWORD=pa55\nPORT=3000\nTERM=xterm-256color\nKEA_SESSION_ID=s1\nAPI_KEY=${OTHER}')).toBe(
      'export STRIPE_SECRET_KEY="xxxxxx"\nDB_PASSWORD=xxxx\nPORT=3000\nTERM=xterm-256color\nKEA_SESSION_ID=s1\nAPI_KEY=${OTHER}',
    )
    expect(scrub('{"session_id":"abc","api_key":"k-123","refresh_token":"r","input_tokens":5,"tool_name":"Bash"}')).toBe(
      '{"session_id":"abc","api_key":"xxxxx","refresh_token":"x","input_tokens":5,"tool_name":"Bash"}',
    )
    const env = scrubBuffer(Buffer.from('DATABASE_URL=postgres://localhost/db\nFEATURE=on\n'), { identity: ID, envFile: true }).output
    expect(s(env)).toBe(`DATABASE_URL=${'x'.repeat('postgres://localhost/db'.length)}\nFEATURE=xx\n`)
    // a cassette line: escape sequences after a value are not touched
    expect(scrub('API_TOKEN=abc\x1b[0m\r\n')).toBe('API_TOKEN=xxx\x1b[0m\r\n')
  })

  it('U-SCRUB-4 · binary safe: arbitrary bytes keep their length and only matched bytes change', () => {
    const secret = Buffer.from(SECRETS.github)
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.uint8Array({ maxLength: 512 }), (a, b) => {
        const input = Buffer.concat([Buffer.from(a), Buffer.from(' '), secret, Buffer.from(' '), Buffer.from(b)])
        const { output } = scrubBuffer(input, ctx)
        expect(output.length).toBe(input.length)
        // bytes before the secret are untouched unless they themselves matched something
        if (scanForPrivateData(Buffer.from(a), ctx).length === 0 && !/[A-Za-z0-9_=-]$/.test(Buffer.from(a).toString('latin1'))) {
          expect(output.subarray(0, a.length).equals(Buffer.from(a))).toBe(true)
        }
        expect(output.includes(secret)).toBe(false)
      }),
      { numRuns: 200 },
    )
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x80, ...Buffer.from('/Users/janedoe'), 0xc3, 0x28, 0x00])
    const out = scrubBuffer(bin, ctx).output
    expect(out.length).toBe(bin.length)
    expect([...out.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x00, 0x80])
    expect([...out.subarray(-3)]).toEqual([0xc3, 0x28, 0x00])
    expect(out.subarray(4, -3).toString('latin1')).toBe('/Users/HOME___')
  })

  it('U-SCRUB-5 · absolute paths outside the demo repo are reported for review', () => {
    // os-ok: in /usr/bin on both systems
    const text = Buffer.from('open /private/var/folders/x/demo-1/src/a.ts\nread /Users/HOME___/secret/plan.md\nexec /usr/bin/git\nfile:///Volumes/Work/x')
    expect(findAbsolutePaths(text, ['/private/var/folders/x/demo-1'])).toEqual([
      { path: '/Users/HOME___/secret/plan.md', line: 2 },
      { path: '/Volumes/Work/x', line: 4 },
    ])
  })

  it('U-SCRUB-8 · generic account and host names are not searched for, nor a home such as /root; names, emails and a home under /Users or /home always are', () => {
    const container: Identity = { home: '/root', user: 'Root', hosts: ['ubuntu', 'localhost'], names: ['Jane Q. Doe'], emails: ['jane.doe@example.org'] }
    const text = 'the test runner on ubuntu ran as root in /root/.cache and /mnt/root; Author: Jane Q. Doe <jane.doe@example.org>'
    expect(scanForPrivateData(Buffer.from(text), { identity: container }).map((f) => f.label)).toEqual(['name', 'email'])
    expect(scrub(text, { identity: container })).toBe('the test runner on ubuntu ran as root in /root/.cache and /mnt/root; Author: NAME_______ <EMAIL_______________>')
    // a CI runner's home is still scrubbed and found; the word stays
    const runner: Identity = { home: '/home/runner', user: 'runner', hosts: ['fv-az123-456'] }
    const log = 'a test runner wrote /home/runner/work/kea on fv-az123-456'
    expect(scanForPrivateData(Buffer.from(log), { identity: runner }).map((f) => f.label)).toEqual(['home path', 'host name'])
    expect(scrub(log, { identity: runner })).toBe('a test runner wrote /home/HOME__/work/kea on HOST________')
  })

  it('U-SCRUB-9 · a home folder under /Users or /home is found whoever the developer is, unless it is a placeholder or the test account', () => {
    const text = [
      'cwd=/Users/alice/demo',
      'HOME=/home/bob',
      '"cwd":"\\/Users\\/carol\\/x"',
      'sock /Users/kea-test/.kea/run and /home/kea-test',
      'exec /home/HOME___/.local/bin/zed, /Users/HOM/x, /home/USER__/y',
      'home /Users/xxxxxxxx/.kea',
      'claude /tmp/kea-world/home/.claude/projects',
    ].join('\n')
    expect(scanForPrivateData(Buffer.from(text), { identity: {} }).map((f) => [f.kind, f.label, f.line])).toEqual([
      ['identity', 'home folder', 1],
      ['identity', 'home folder', 2],
      ['identity', 'home folder', 3],
    ])
    // the scrubber leaves them alone: only the developer's own identity has a placeholder
    expect(scrub(text, { identity: {} })).toBe(text)
  })
})

describe('recorder guard and fixture tree', () => {
  // made in beforeAll, not in the describe body: a `-t`-filtered run that skips every test here skips afterAll too
  let tmp = ''
  let prompts = ''
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kea-scrub-'))
    prompts = join(tmp, 'demo-prompts.json')
    writeFileSync(prompts, JSON.stringify({ prompts: ['add a README section describing the project'] }))
  })
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })
  const repo = (name: string, marker: boolean) => {
    const dir = join(tmp, name)
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, 'src'), { recursive: true })
    if (marker) writeFileSync(join(dir, FIXTURE_REPO_MARKER), '')
    return dir
  }

  it('U-SCRUB-6 · recording needs a .kea-fixture-repo root and a demo prompt', () => {
    const demo = repo('demo', true)
    const own = repo('own-project', false)
    const prompt = 'add a README section describing the project'
    expect(assertRecordable({ cwd: join(demo, 'src'), prompt, promptsFile: prompts }).root).toContain('demo')
    expect(() => assertRecordable({ cwd: own, prompt, promptsFile: prompts })).toThrow(NotRecordableError)
    expect(() => assertRecordable({ cwd: demo, prompt: 'summarise ~/notes', promptsFile: prompts })).toThrow(/not in/)
    expect(() => assertRecordable({ cwd: tmp, prompt, promptsFile: prompts })).toThrow(/not inside a git repo|marker/)
    // the real demo prompt list loads and is non-empty
    expect(() => assertRecordable({ cwd: demo, prompt: 'add a README section describing the project' })).not.toThrow()
  })

  it('U-SCRUB-7 · fixtures/**/.raw/** files are scrubbed into the same path without the .raw segment', () => {
    const fixtures = join(tmp, 'fixtures')
    mkdirSync(join(fixtures, 'hooks', '.raw', 'claude', '2.1.233'), { recursive: true })
    writeFileSync(join(fixtures, 'hooks', '.raw', 'claude', '2.1.233', 'Stop.json'), '{"cwd":"/Users/janedoe/demo","api_key":"k1"}')
    const pairs = rawFixtures(fixtures)
    expect(pairs.map((p) => p.dest.slice(fixtures.length))).toEqual(['/hooks/claude/2.1.233/Stop.json'])
    const report = scrubTree(pairs, ID)
    expect(readFileSync(join(fixtures, 'hooks', 'claude', '2.1.233', 'Stop.json'), 'utf8')).toBe('{"cwd":"/Users/HOME___/demo","api_key":"xx"}')
    expect(report.residual).toEqual([])
    expect(report.paths.map((p) => p.path)).toEqual(['/Users/HOME___/demo'])
  })
})
