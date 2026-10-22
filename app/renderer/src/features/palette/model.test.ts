import { describe, expect, it } from 'vitest'
import { COMMANDS, L } from '@kea/protocol'
import { PaletteData, type Sources } from './data.ts'
import { BOOST, emptyContent, markRuns, matchField, mostUsed, moveRow, needleOf, PaletteIndex, parseQuery, sectioned, STARTERS, usageBoost, type Candidate } from './model.ts'
import { Usage, USAGE_KEY } from './usage.ts'

function score(text: string, query: string): number {
  const { raw, tight } = needleOf(query)
  return matchField(text, text.toLowerCase(), raw, tight)
}

function marked(text: string, query: string): string {
  const { raw, tight } = needleOf(query)
  const out: number[] = []
  matchField(text, text.toLowerCase(), raw, tight, out)
  return markRuns(text, out)
    .map((r) => (r.hit ? `[${r.text}]` : r.text))
    .join('')
}

const session = (id: string, title: string, o: { branch?: string; project?: string; needsYou?: boolean } = {}) => ({ id, title, branch: o.branch ?? null, project: o.project ?? 'kea', glyph: o.needsYou ? ('needsYou' as const) : ('idle' as const), needsYou: o.needsYou ?? false })

function sources(o: Partial<Sources> = {}): Sources {
  return {
    sessions: () => [],
    needing: () => [],
    recent: () => [],
    commands: () => COMMANDS,
    projects: () => [],
    now: (id) => ({ title: COMMANDS.find((c) => c.id === id)?.title ?? id, shortcut: null, reason: null, remedy: null }),
    ...o,
  }
}

const noUsage = { count: () => 0 }
const ids = (rows: readonly { key: string }[]) => rows.map((r) => r.key)

describe('the palette as data', () => {
  it('U-PAL-1 · the prefixes: > is commands only, / is the files of the session on screen; ⌘P starts in file mode', () => {
    expect(parseQuery('all', 'fix auth')).toEqual({ mode: 'all', needle: 'fix auth' })
    expect(parseQuery('all', '  fix  ')).toEqual({ mode: 'all', needle: 'fix' })
    expect(parseQuery('all', '')).toEqual({ mode: 'all', needle: '' })
    expect(parseQuery('all', '>')).toEqual({ mode: 'commands', needle: '' })
    expect(parseQuery('all', '> arch')).toEqual({ mode: 'commands', needle: 'arch' })
    expect(parseQuery('all', '/')).toEqual({ mode: 'files', needle: '' })
    expect(parseQuery('all', '/ login.ts')).toEqual({ mode: 'files', needle: 'login.ts' })
    // opened by ⌘P it is the finder: a path may begin with a slash, and > still reaches the commands
    expect(parseQuery('files', 'login')).toEqual({ mode: 'files', needle: 'login' })
    expect(parseQuery('files', '/src/login')).toEqual({ mode: 'files', needle: '/src/login' })
    expect(parseQuery('files', '>new')).toEqual({ mode: 'commands', needle: 'new' })
  })

  it('U-PAL-1 · a match: the query as it stands beats word starts, which beat characters anywhere; none is no match', () => {
    // as it stands: at the start, then at a word's start, then inside a word
    expect(score('Archive Session', 'arch')).toBeGreaterThan(score('Session Archive', 'arch'))
    expect(score('Session Archive', 'arch')).toBeGreaterThan(score('Search', 'arch'))
    // the shorter title wins among equals
    expect(score('New Session', 'new')).toBeGreaterThan(score('New Session in Project…', 'new'))
    // word starts: initials, and the beginnings of words run together
    expect(score('Toggle File Panel', 'tfp')).toBeGreaterThan(0)
    expect(score('Toggle File Panel', 'togfil')).toBeGreaterThan(score('Toggle File Panel', 'tfp') - 200)
    expect(score('Toggle File Panel', 'tfp')).toBeGreaterThan(score('Text for people', 'txp'))
    // anything as it stands beats any word-start match, which beats any loose one
    expect(score('xx fix the auth flow that is rather long indeed', 'auth')).toBeGreaterThan(score('Add User To Host', 'auth'))
    expect(score('Add User To Host', 'auth')).toBeGreaterThan(score('launch', 'auh'))
    // case and extra spaces do not matter; a capital inside a word starts a word
    expect(score('fix-auth', 'FIX')).toBe(score('fix-auth', 'fix'))
    expect(score('New Session', ' new   session ')).toBe(score('New Session', 'new session'))
    expect(score('openInEditor', 'oie')).toBeGreaterThan(1000)
    // no match
    expect(score('Archive Session', 'xyz')).toBe(0)
    expect(score('abc', 'abcd')).toBe(0)
    expect(score('abc', 'cba')).toBe(0)
    // letters in order but scattered over the text are no match; close together they are
    expect(score('Previous Session in the List', 'eioi')).toBe(0)
    expect(score('/var/folders/tmp/kea-fixture/demo', 'oth')).toBe(0)
    expect(score('launch', 'lnc')).toBeGreaterThan(0)
    // what is marked is what matched
    expect(marked('Archive Session', 'arch')).toBe('[Arch]ive Session')
    expect(marked('Session Archive', 'arch')).toBe('Session [Arch]ive')
    expect(marked('Toggle File Panel', 'tfp')).toBe('[T]oggle [F]ile [P]anel')
    expect(marked('Toggle File Panel', 'togfil')).toBe('[Tog]gle [Fil]e Panel')
    expect(marked('New Session', 'new ses')).toBe('[New] [Ses]sion')
    expect(marked('launch', 'lnc')).toBe('[l]au[nc]h')
    expect(marked('abc', 'x')).toBe('abc')
  })

  it('U-PAL-1 · ranking: sessions, commands and projects together; a session that needs you first; a later field counts less', () => {
    const items: Candidate[] = [
      { kind: 'command', id: 'c.new', fields: ['New Session', 'Session New Session'], boost: BOOST.command },
      { kind: 'project', id: 'p1', fields: ['newsletter'], boost: BOOST.project },
      { kind: 'session', id: 's1', fields: ['new login page', 'feat/login', 'web'], boost: BOOST.session },
      { kind: 'session', id: 's2', fields: ['new signup page', 'feat/signup', 'web'], boost: BOOST.session + BOOST.needsYou },
      { kind: 'session', id: 's3', fields: ['fix flaky test', 'new-runner', 'web'], boost: BOOST.session },
      { kind: 'session', id: 's4', fields: ['tidy docs', 'docs', 'newsroom'], boost: BOOST.session },
    ]
    const index = new PaletteIndex(items)
    const found = index.search('new')
    // every source in one ranking: the session that needs you, the session whose title has it, the command, the
    // project; then the sessions found by a later field, the branch before the project
    expect(found.map((h) => h.item.id)).toEqual(['s2', 's1', 'c.new', 'p1', 's3', 's4'])
    expect(found.map((h) => h.field)).toEqual([0, 0, 0, 0, 1, 2])
    // a better match outranks a category: the command whose title is the query, before a session that merely has it
    expect(index.search('new session').map((h) => h.item.id)).toEqual(['c.new'])
    expect(new PaletteIndex([items[2] as Candidate, { ...(items[0] as Candidate), fields: ['Login'] }]).search('login').map((h) => h.item.id)).toEqual(['c.new', 's1'])
    // > asks for one kind only; a limit keeps the best
    expect(index.search('new', L.paletteResults, 'command').map((h) => h.item.id)).toEqual(['c.new'])
    expect(index.search('new', 2).map((h) => h.item.id)).toEqual(['s2', 's1'])
    expect(index.search('zzz')).toEqual([])
    // a hit found by another field marks nothing in the title
    expect(index.marks(found[4] as (typeof found)[number], 'new')).toEqual([])
    expect(index.marks(found[0] as (typeof found)[number], 'new')).toEqual([0, 1, 2])
    // equal scores keep the order the candidates came in
    const same = new PaletteIndex(['a', 'b', 'c'].map((id) => ({ kind: 'command' as const, id, fields: ['Same Title'], boost: 0 })))
    expect(same.search('same').map((h) => h.item.id)).toEqual(['a', 'b', 'c'])
  })

  it('U-PAL-1 · the list: laid out by section, the section of the best match first, each in rank order', () => {
    const hit = (kind: Candidate['kind'], id: string) => ({ item: { kind }, id })
    const s = sectioned([hit('command', 'c1'), hit('session', 's1'), hit('command', 'c2'), hit('project', 'p1'), hit('session', 's2')])
    expect(s.map((x) => [x.id, x.hits.map((h) => h.id)])).toEqual([
      ['actions', ['c1', 'c2']],
      ['sessions', ['s1', 's2']],
      ['projects', ['p1']],
    ])
    expect(sectioned([])).toEqual([])
    // ↑ ↓ wrap; PageUp and PageDown go to the ends; another key is not the list's
    expect(moveRow(3, 2, 'ArrowDown')).toBe(0)
    expect(moveRow(3, 0, 'ArrowUp')).toBe(2)
    expect(moveRow(3, 1, 'PageDown')).toBe(2)
    expect(moveRow(3, 1, 'PageUp')).toBe(0)
    expect(moveRow(0, 0, 'ArrowDown')).toBe(-1)
    expect(moveRow(3, 1, 'a')).toBeNull()
  })

  it('U-PAL-2 · an empty query: the sessions that need you, the recent ones, the most-used commands', () => {
    const recent = Array.from({ length: 12 }, (_, i) => `r${i}`)
    const c = emptyContent({ needing: ['n1', 'r3'], recent, used: COMMANDS.map((x) => x.id) })
    // those that need you lead, in the order given; a recent one already listed is not listed twice
    expect(c.sessions.slice(0, 2)).toEqual(['n1', 'r3'])
    expect(c.sessions.slice(2)).toEqual(['r0', 'r1', 'r2', 'r4', 'r5', 'r6', 'r7', 'r8'])
    expect(c.sessions).toHaveLength(2 + L.paletteRecentSessions)
    expect(c.actions).toHaveLength(L.paletteRecentCommands)
    expect(emptyContent({ needing: [], recent: [], used: [] })).toEqual({ sessions: [], actions: [] })

    // most used first; never used, the starters lead and the table's order follows
    const table = COMMANDS.map((x) => x.id)
    const fresh = mostUsed(table, () => 0, STARTERS)
    expect(fresh.slice(0, STARTERS.length)).toEqual(STARTERS)
    expect(fresh).toHaveLength(table.length)
    expect(new Set(fresh)).toEqual(new Set(table))
    const counts: Record<string, number> = { 'view.toggleSidebar': 3, 'session.archive': 7, 'session.new': 3 }
    expect(mostUsed(table, (id) => counts[id] ?? 0, STARTERS).slice(0, 4)).toEqual(['session.archive', 'session.new', 'view.toggleSidebar', 'project.add'])
    // every starter is a command of the table
    for (const id of STARTERS) expect(table).toContain(id)
    // use adds to a command's rank, up to a ceiling
    expect(usageBoost(0)).toBe(0)
    expect(usageBoost(1)).toBe(BOOST.usedOnce)
    expect(usageBoost(1_000_000)).toBe(BOOST.usedMax)
  })

  it('U-PAL-2 · the usage record: only known commands are counted, a broken record reads as none, storage that fails is survived', () => {
    const store = new Map<string, string>()
    const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const known = (id: string) => COMMANDS.some((c) => c.id === id)
    const u = new Usage(kv, known)
    expect(u.count('session.new')).toBe(0)
    u.ran('session.new')
    u.ran('session.new')
    u.ran('not.a.command')
    expect(u.count('session.new')).toBe(2)
    expect(u.size).toBe(1)
    expect(JSON.parse(store.get(USAGE_KEY) as string)).toEqual({ 'session.new': 2 })
    // read back by the next window; an id the table no longer has and a count that is not one are dropped
    store.set(USAGE_KEY, JSON.stringify({ 'session.new': 2, 'gone.command': 9, 'project.add': -1, 'view.palette': 1.5, 'app.settings': '3' }))
    const next = new Usage(kv, known)
    expect(next.size).toBe(1)
    expect(next.count('session.new')).toBe(2)
    for (const broken of ['{', '[1,2]', '"x"', 'null', '7']) {
      store.set(USAGE_KEY, broken)
      expect(new Usage(kv, known).size).toBe(0)
    }
    // the record never grows past the table: 500 runs of every command are one count each
    const all = new Usage(kv, known)
    for (let i = 0; i < 500; i++) for (const c of COMMANDS) all.ran(c.id)
    expect(all.size).toBe(COMMANDS.length)
    // no storage, or storage that throws: the counts hold for the window
    const none = new Usage(null, known)
    none.ran('session.new')
    expect(none.count('session.new')).toBe(1)
    const failing = new Usage(
      {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('full')
        },
      },
      known,
    )
    failing.ran('session.new')
    expect(failing.count('session.new')).toBe(1)
  })

  it('U-PAL-3 · rows: a session with its project and branch, a command with its title, key and reason now, a project', () => {
    const src = sources({
      sessions: () => [session('s1', 'fix auth redirect', { branch: 'fix/auth', project: 'web' }), session('s2', 'server logs', { needsYou: true }), session('s3', 'old work')],
      needing: () => ['s2'],
      recent: () => ['s3', 'gone', 's2', 's1'],
      projects: () => [{ id: 'p1', name: 'server-tools' }],
      now: (id) =>
        id === 'server.toggle'
          ? { title: 'Stop Dev Server', shortcut: '⌘R', reason: null, remedy: null }
          : id === 'server.restart'
            ? { title: 'Restart Dev Server', shortcut: '⇧⌘R', reason: 'No start.sh in this project', remedy: 'Set a run command…' }
            : { title: COMMANDS.find((c) => c.id === id)?.title ?? id, shortcut: null, reason: null, remedy: null },
    })
    const data = new PaletteData(src, noUsage)
    expect(data.size).toBe(3 + COMMANDS.length + 1)
    expect(data.commandCount).toBe(COMMANDS.length)

    // empty: needs you, then recent (a session that is gone is not listed), then the commands
    const empty = data.empty()
    expect(ids(empty).slice(0, 3)).toEqual(['session:s2', 'session:s3', 'session:s1'])
    expect(ids(empty).slice(3)).toEqual(STARTERS.slice(0, L.paletteRecentCommands).map((id) => `command:${id}`))
    expect(empty[0]).toMatchObject({ kind: 'session', id: 's2', glyph: 'needsYou', detail: 'kea', disabled: false })
    expect(empty[2]).toMatchObject({ detail: 'web · fix/auth' })

    // one ranking over every source
    const rows = data.search('server', { commandsOnly: false })
    expect(rows[0]).toMatchObject({ key: 'session:s2' })
    expect(rows.map((r) => r.kind)).toContain('command')
    expect(rows.find((r) => r.kind === 'project')).toMatchObject({ key: 'project:p1', detail: 'New session', disabled: false })
    expect(rows[0]?.title).toEqual([
      { text: 'server', hit: true },
      { text: ' logs', hit: false },
    ])
    // a session is found by its branch and by its project, its title unmarked then
    expect(data.search('fix/auth', { commandsOnly: false })[0]).toMatchObject({ key: 'session:s1', title: [{ text: 'fix auth redirect', hit: false }] })
    expect(ids(data.search('web', { commandsOnly: false }))).toContain('session:s1')

    // > lists commands only; the row says the title that applies now, its key now, and why it cannot run now
    const cmds = data.search('dev server', { commandsOnly: true })
    expect(cmds.every((r) => r.kind === 'command')).toBe(true)
    const toggle = cmds.find((r) => r.id === 'server.toggle')
    expect(toggle).toMatchObject({ shortcut: '⌘R', disabled: false, detail: 'Server', remedy: null })
    expect(toggle?.title.map((t) => t.text).join('')).toBe('Stop Dev Server')
    expect(toggle?.title.filter((t) => t.hit).map((t) => t.text)).toEqual(['Dev', 'Server'])
    expect(cmds.find((r) => r.id === 'server.restart')).toMatchObject({ shortcut: '⇧⌘R', disabled: true, detail: 'No start.sh in this project', remedy: 'Set a run command…' })
    // a command is also found by its category with its title
    expect(ids(data.search('server restart', { commandsOnly: true }))[0]).toBe('command:server.restart')
    // > alone: every command, at most the cap, the starters first
    const all = data.allCommands()
    expect(all).toHaveLength(Math.min(COMMANDS.length, L.paletteResults))
    expect(all[0]).toMatchObject({ key: `command:${STARTERS[0]}` })
    // a search never returns more than the cap
    expect(data.search('e', { commandsOnly: false }).length).toBeLessThanOrEqual(L.paletteResults)
  })

  it('U-PAL-3 · use moves a command up among equals, and what a row says now is asked once per command', () => {
    let asked = 0
    const src = sources({
      now: (id) => {
        asked++
        return { title: COMMANDS.find((c) => c.id === id)?.title ?? id, shortcut: null, reason: null, remedy: null }
      },
    })
    const plain = new PaletteData(src, noUsage).search('toggle', { commandsOnly: true })
    const last = plain[plain.length - 1] as (typeof plain)[number]
    const used = new PaletteData(src, { count: (id) => (id === last.id ? 50 : 0) }).search('toggle', { commandsOnly: true })
    expect(used[0]?.id).toBe(last.id)
    asked = 0
    const data = new PaletteData(src, noUsage)
    data.search('toggle', { commandsOnly: true })
    const first = asked
    expect(first).toBeGreaterThan(0)
    data.search('toggle', { commandsOnly: true })
    data.search('toggl', { commandsOnly: true })
    expect(asked).toBe(first)
  })

  it('U-PAL-4 · 500 sessions and 200 commands: a query returns only the rows the list shows', () => {
    const many = Array.from({ length: 500 }, (_, i) => session(`s${i}`, `session number ${i} about feature ${i % 17}`, { branch: `feat/branch-${i}`, project: `project-${i % 9}` }))
    const cmds = Array.from({ length: 200 }, (_, i) => ({ id: `cmd.${i}`, title: `Command Number ${i}`, category: 'Test' }))
    let asked = 0
    const data = new PaletteData(
      sources({
        sessions: () => many,
        commands: () => cmds,
        now: (id) => {
          asked++
          return { title: id, shortcut: null, reason: null, remedy: null }
        },
      }),
      noUsage,
    )
    expect(data.size).toBe(700)
    const rows = data.search('number', { commandsOnly: false })
    expect(rows).toHaveLength(L.paletteResults)
    // every one of the 700 matches, yet only the commands among the rows shown were asked what they say now
    expect(asked).toBe(rows.filter((r) => r.kind === 'command').length)
    expect(data.search('e', { commandsOnly: false })).toHaveLength(L.paletteResults)
    expect(data.search('feat/branch-499', { commandsOnly: false })[0]).toMatchObject({ key: 'session:s499' })
    expect(data.search('zzzz', { commandsOnly: false })).toEqual([])
  })
})
