// The visible set: each window's connection scope carries the session it shows, and core keeps the one set everything
// keys on — the watch policy, the session-scoped stores (`tree:`, `git:`, `server:<sessionId>`, registered only for
// visible sessions), port scans, the viewer's caches, and main's `kea-file://` handler (core passes main the set's
// working directories, process.ts `visible`).
//
// A window tells core before it subscribes to a session's stores, and again first thing on a new RPC port (a restarted
// core knows nothing): core registers a session's stores inside this call, so the subscriptions that follow it on the
// port find them.

import { z } from 'zod'
import { defineApi } from './rpc.ts'
import { zSessionId } from './terminal.ts'

export const visibleApi = defineApi({
  /** This window shows `sessionId` now; null: no session (the composer, the shells, nothing). v1: one session per window. */
  'visible.set': { args: z.object({ sessionId: zSessionId.nullable() }), result: z.object({ ok: z.boolean() }) },
})
