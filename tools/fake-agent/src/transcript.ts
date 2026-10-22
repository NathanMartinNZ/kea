// Transcript records: JSONL appended under a stand-in HOME, at the path the real CLI would use. fake-agent never writes
// under the real `~/.claude*` / `~/.commandcode`, which belong to the user's own agent CLIs: with no override and HOME
// pointing at the real home it refuses and says so; an override inside the real home is refused too.

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Flavour } from './argv.ts'
import type { Json, RecordKind } from './scenario.ts'

/** Longest project directory name before Claude truncates and hashes it. */
const MAX_DIR_NAME = 200

/** Claude: every non-alphanumeric character of the cwd becomes `-`; long names are cut and hashed (approximation). */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= MAX_DIR_NAME) return name
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return `${name.slice(0, MAX_DIR_NAME - hash.length - 1)}-${hash}`
}

/**
 * Command Code's project folder name (1.79.2 slugifies the cwd): camel case split first (`kea-fixture-Z6TgWY` →
 * `kea-fixture-z6-tg-wy`), then lower case with each run of other characters as one `-`, none at the ends; `root` for a
 * cwd with nothing left. (The real slugify also transliterates; an ASCII path needs none.)
 */
export function commandCodeSlug(cwd: string): string {
  const split = cwd.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1-$2').replace(/(\p{Lu}+)(\p{Lu}\p{Ll}+)/gu, '$1-$2')
  return split.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

const AGENT_DIRS: Record<Flavour, string> = { claude: '.claude', commandcode: '.commandcode' }

export type TranscriptLocation = { path: string; writable: true } | { path: string; writable: false; reason: string }

/** realpath of `p`, or of its deepest existing ancestor plus the rest (so `/var/…/new` compares as `/private/var/…/new`). */
function real(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(real(parent), abs.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Where the transcript goes. `override` is `--fake-home` / `FAKE_AGENT_HOME`; `home` is $HOME; `realHome` is the
 * account's home from the password database (unaffected by $HOME). The path is reported either way: hook payloads
 * carry it even when nothing is written.
 */
export function transcriptLocation(o: { flavour: Flavour; cwd: string; sessionId: string; override: string | null; home: string; realHome: string }): TranscriptLocation {
  const base = o.override ?? o.home
  const dirName = o.flavour === 'claude' ? claudeProjectDirName(o.cwd) : commandCodeSlug(o.cwd)
  const path = join(base, AGENT_DIRS[o.flavour], 'projects', dirName, `${o.sessionId}.jsonl`)
  const realHome = real(o.realHome)
  const target = real(base)
  if (target === realHome) {
    const why = o.override === null ? 'HOME is the real home and neither --fake-home nor FAKE_AGENT_HOME is set' : 'the fake home is the real home'
    return { path, writable: false, reason: `not writing transcripts: ${why} (fake-agent never writes under the real ~/${AGENT_DIRS[o.flavour]})` }
  }
  if (inside(target, realHome)) {
    const first = target.slice(realHome.length + 1).split(sep)[0] ?? ''
    if (first.startsWith('.claude') || first === '.commandcode' || first.startsWith('.kea')) {
      return { path, writable: false, reason: `not writing transcripts: the fake home is inside the real ~/${first}` }
    }
  }
  return { path, writable: true }
}

export interface RecordContext {
  sessionId: string
  cwd: string
  model: string
  version: string
}

const INTERRUPT = '[Request interrupted by user]'
const INTERRUPT_TOOL = '[Request interrupted by user for tool use]'

/** A Command Code session's id by its name (`--resume <name>`): the session whose meta file has that title; null when none has. */
export function commandCodeSessionByName(projectDir: string, name: string): string | null {
  let files: string[]
  try {
    files = readdirSync(projectDir).sort()
  } catch {
    return null
  }
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue
    try {
      if ((JSON.parse(readFileSync(join(projectDir, f), 'utf8')) as { title?: unknown }).title === name) return f.slice(0, -'.meta.json'.length)
    } catch {
      // not a meta file
    }
  }
  return null
}

/**
 * Appends transcript records. Claude's keep the parentUuid chain and carry the fields of the recorded ones
 * (fixtures/transcripts/claude/2.1.296/). Command Code's are format version 3 as 1.79.2 writes it
 * (fixtures/transcripts/commandcode/): a `session` header when the file is made (it appears with the first record: an
 * empty session leaves none), `message` records, a checkpoint per prompt in `<id>.checkpoints.jsonl` and the title in
 * `<id>.meta.json`.
 */
export class TranscriptWriter {
  private parent: string | null = null
  private msgSeq = 0
  private made = false
  path: string
  private readonly ctx: RecordContext
  private readonly now: () => Date
  private readonly flavour: Flavour
  private turn = 0
  private messages = 0

  constructor(path: string, ctx: RecordContext, now: () => Date = () => new Date(), flavour: Flavour = 'claude') {
    this.path = path
    this.ctx = { ...ctx }
    this.now = now
    this.flavour = flavour
    // a resumed Command Code session's file is already there: no second header
    if (flavour === 'commandcode' && existsSync(path)) this.made = true
  }

  /** Command Code: another conversation in the same process (`/clear`): its own files beside the first's. */
  setSession(sessionId: string): void {
    this.path = join(dirname(this.path), `${sessionId}.jsonl`)
    this.ctx.sessionId = sessionId
    this.parent = null
    this.turn = 0
    this.messages = 0
    this.made = existsSync(this.path)
  }

  /** Command Code: the session's title, in `<id>.meta.json` (`userRenamed`: the person's own, `--name` included). */
  setTitle(title: string, userRenamed = false): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path.slice(0, -'.jsonl'.length) + '.meta.json', `${JSON.stringify(userRenamed ? { title, userRenamed: true } : { title }, null, 2)}`)
  }

  private commandCode(kind: RecordKind, o: { text: string | null; title: string | null; json: Json | null }): Record<string, unknown> {
    const at = this.now()
    if (kind === 'title') {
      this.setTitle(o.title ?? o.text ?? '')
      return { type: 'title', title: o.title ?? o.text ?? '' }
    }
    if (kind === 'raw') return { ...((o.json ?? {}) as Record<string, unknown>) }
    if (!this.made) {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, `${JSON.stringify({ type: 'session', version: 3, id: this.ctx.sessionId, timestamp: at.toISOString(), cwd: this.ctx.cwd })}\n`)
      this.made = true
    }
    const id = randomUUID().slice(0, 8)
    const messageId = randomUUID()
    const base = { type: 'message', id, parentId: this.parent, timestamp: at.toISOString() }
    this.parent = id
    this.messages++
    if (kind === 'assistant') {
      return { ...base, message: { role: 'assistant', content: [{ type: 'text', text: o.text ?? '' }], meta: { source: 'model', createdAt: at.getTime(), messageId } }, usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.ctx.model }
    }
    if (kind === 'error') return { ...base, message: { role: 'user', content: [{ type: 'text', text: `Error: ${o.text ?? 'the run failed'}` }], meta: { messageId } } }
    // a prompt: its checkpoint is written as it is sent (lines joined by newlines, none after the last)
    const checkpoints = this.path.slice(0, -'.jsonl'.length) + '.checkpoints.jsonl'
    const line = JSON.stringify({ id: messageId, messageId, turnNumber: ++this.turn, createdAt: at.toISOString(), prompt: o.text ?? '', messageCount: this.messages - 1, files: [] })
    appendFileSync(checkpoints, existsSync(checkpoints) ? `\n${line}` : line)
    return { ...base, message: { role: 'user', content: [{ type: 'text', text: o.text ?? '' }], meta: { source: 'user', createdAt: at.getTime(), messageId } } }
  }

  append(record: Record<string, unknown>): void {
    if (!this.made) {
      mkdirSync(dirname(this.path), { recursive: true })
      this.made = true
    }
    appendFileSync(this.path, `${JSON.stringify(record)}\n`)
  }

  private message(type: 'user' | 'assistant', message: Record<string, unknown>): Record<string, unknown> {
    const uuid = randomUUID()
    const r = {
      parentUuid: this.parent,
      isSidechain: false,
      userType: 'external',
      cwd: this.ctx.cwd,
      sessionId: this.ctx.sessionId,
      version: this.ctx.version,
      type,
      message,
      uuid,
      timestamp: this.now().toISOString(),
    }
    this.parent = uuid
    return r
  }

  /** Build a record of `kind` (the scenario's transcript step), merge `fields` over it, append it, return it. */
  write(kind: RecordKind, o: { text: string | null; title: string | null; costUsd: number | null; forToolUse: boolean; json: Json | null; fields: Record<string, Json> }): Record<string, unknown> {
    let r: Record<string, unknown>
    if (this.flavour === 'commandcode') {
      r = this.commandCode(kind, o)
      for (const [k, v] of Object.entries(o.fields)) {
        if (v === null) delete r[k]
        else r[k] = v
      }
      if (kind !== 'title') this.append(r)
      return r
    }
    switch (kind) {
      case 'error':
      case 'title':
        throw new Error(`transcript record ${kind} is Command Code's`)
      case 'user':
        r = this.message('user', { role: 'user', content: o.text ?? '' })
        break
      case 'interrupt':
        r = this.message('user', { role: 'user', content: [{ type: 'text', text: o.forToolUse ? INTERRUPT_TOOL : INTERRUPT }] })
        break
      case 'assistant':
        r = this.message('assistant', {
          id: `msg_fake_${String(++this.msgSeq).padStart(4, '0')}`,
          type: 'message',
          role: 'assistant',
          model: this.ctx.model,
          content: [{ type: 'text', text: o.text ?? '' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000, output_tokens: 40 },
        })
        break
      case 'ai-title':
        r = { type: 'ai-title', aiTitle: o.title ?? '', sessionId: this.ctx.sessionId }
        break
      case 'custom-title':
        r = { type: 'custom-title', customTitle: o.title ?? '', sessionId: this.ctx.sessionId }
        break
      case 'cost-state':
        // 2.1.296's shape (fixtures/transcripts/claude/2.1.296)
        r = { type: 'cost-state', sessionId: this.ctx.sessionId, totalCostUSD: o.costUsd ?? 0, totalLinesAdded: 0, totalLinesRemoved: 0 }
        break
      case 'raw':
        r = { ...((o.json ?? {}) as Record<string, unknown>) }
        break
    }
    for (const [k, v] of Object.entries(o.fields)) {
      if (v === null) delete r[k]
      else r[k] = v
    }
    this.append(r)
    return r
  }
}
