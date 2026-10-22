// Every enum of core's database, defined once. TypeScript types and zod schemas derive from these arrays, and
// migrations build each CHECK (col IN (…)) from them (U-DB-3).
import { z } from 'zod'

export const LIFECYCLE = ['creating', 'live', 'detached', 'archived', 'create_failed', 'deleted'] as const
export const PHASE = ['starting', 'working', 'blocked', 'ready', 'failed', 'idle'] as const
export const END_REASON = ['exited', 'stopped', 'crashed', 'lost'] as const
export const FAILURE_KIND = ['rate_limit', 'overloaded', 'auth', 'billing', 'other'] as const
export const TITLE_SOURCE = ['auto', 'agent', 'user'] as const
export const ISOLATION = ['worktree', 'inplace'] as const
export const PTY_KIND = ['agent', 'shell', 'server', 'script'] as const
export const PTY_STATE = ['running', 'exited', 'lost'] as const
export const STATUS_SOURCE = ['hook', 'status-file', 'transcript', 'heuristic', 'reconcile', 'user'] as const

export type Lifecycle = (typeof LIFECYCLE)[number]
export type Phase = (typeof PHASE)[number]
export type EndReason = (typeof END_REASON)[number]
export type FailureKind = (typeof FAILURE_KIND)[number]
export type TitleSource = (typeof TITLE_SOURCE)[number]
export type Isolation = (typeof ISOLATION)[number]
export type PtyKind = (typeof PTY_KIND)[number]
export type PtyState = (typeof PTY_STATE)[number]
export type StatusSource = (typeof STATUS_SOURCE)[number]

export const zLifecycle = z.enum(LIFECYCLE)
export const zPhase = z.enum(PHASE)
export const zEndReason = z.enum(END_REASON)
export const zFailureKind = z.enum(FAILURE_KIND)
export const zTitleSource = z.enum(TITLE_SOURCE)
export const zIsolation = z.enum(ISOLATION)
export const zPtyKind = z.enum(PTY_KIND)
export const zPtyState = z.enum(PTY_STATE)
export const zStatusSource = z.enum(STATUS_SOURCE)

/** The columns each enum constrains: migrations read this table, and so does a unit test (U-DB-3). */
export const ENUM_COLUMNS = [
  { table: 'sessions', column: 'lifecycle', values: LIFECYCLE },
  { table: 'sessions', column: 'end_reason', values: END_REASON, nullable: true },
  { table: 'sessions', column: 'title_source', values: TITLE_SOURCE },
  { table: 'sessions', column: 'isolation', values: ISOLATION },
  { table: 'session_runtime', column: 'phase', values: PHASE },
  { table: 'session_runtime', column: 'failure_kind', values: FAILURE_KIND, nullable: true },
  { table: 'session_runtime', column: 'status_source', values: STATUS_SOURCE, nullable: true },
  { table: 'ptys', column: 'kind', values: PTY_KIND },
  { table: 'ptys', column: 'state', values: PTY_STATE },
  { table: 'status_events', column: 'source', values: STATUS_SOURCE },
] as const

/** `title_source` only ever moves auto → agent → user. */
export function titleSourceRank(s: TitleSource): number {
  return TITLE_SOURCE.indexOf(s)
}
