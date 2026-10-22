// File operations a scenario performs in its working directory (E-FT-8, E-FV-3): write, append, modify, delete, rename,
// mkdir. Paths are relative and must stay inside the cwd (checked again here, after the scenario validator).

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { FileOp } from './scenario.ts'

export function resolveInside(cwd: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`${rel}: must be relative to the working directory`)
  const abs = resolve(cwd, rel)
  const r = relative(cwd, abs)
  if (r === '' || r.startsWith('..') || isAbsolute(r)) throw new Error(`${rel}: must stay inside the working directory`)
  return abs
}

export interface FileStep {
  op: FileOp
  path: string
  to: string | null
  content: string | null
  find: string | null
  replace: string | null
}

/** Apply one operation; throws with a short message when it cannot (missing file, `find` text absent, …). */
export function applyFileOp(cwd: string, s: FileStep): void {
  const abs = resolveInside(cwd, s.path)
  switch (s.op) {
    case 'write':
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, s.content ?? '')
      return
    case 'append':
      mkdirSync(dirname(abs), { recursive: true })
      appendFileSync(abs, s.content ?? '')
      return
    case 'modify': {
      const before = readFileSync(abs, 'utf8')
      const find = s.find ?? ''
      if (!before.includes(find)) throw new Error(`${s.path}: text to replace not found`)
      writeFileSync(abs, before.replace(find, s.replace ?? ''))
      return
    }
    case 'delete':
      rmSync(abs, { recursive: true })
      return
    case 'rename': {
      const to = resolveInside(cwd, s.to ?? '')
      mkdirSync(dirname(to), { recursive: true })
      renameSync(abs, to)
      return
    }
    case 'mkdir':
      mkdirSync(abs, { recursive: true })
      return
  }
}
