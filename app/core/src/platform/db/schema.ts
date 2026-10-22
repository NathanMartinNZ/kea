// The database schema, as migrations: each one an ordered step from `PRAGMA user_version` N − 1 to N. Every
// `CHECK (col IN (…))` is built from the enum arrays of `@kea/protocol`, so the schema and the TypeScript types cannot
// drift; U-DB-3 compares the live schema's CHECKs with them.
//
// Two triggers carry invariants the CHECKs cannot (numbered as in invariants.ts):
//   · sessions_children — every session gets its `session_runtime` and `session_ui` rows in the same transaction (6);
//   · sessions_title_forward — `title_source` only ever moves auto → agent → user (4).
//
// A shipped migration is never edited: a schema change is a new migration appended to MIGRATIONS (U-DB-1 runs every
// migration on an empty database and on each historical fixture in fixtures/db/).

import { ENUM_COLUMNS, TITLE_SOURCE } from '@kea/protocol'

export interface Migration {
  /** The `user_version` this migration leaves the database at. */
  version: number
  name: string
  sql: string
}

const quote = (v: string) => `'${v.replaceAll("'", "''")}'`

/** `CHECK (col IN (…))` for an enum column of ENUM_COLUMNS (NULL allowed where the column is nullable). */
export function enumCheck(table: string, column: string): string {
  const e = ENUM_COLUMNS.find((c) => c.table === table && c.column === column)
  if (!e) throw new Error(`schema: no enum for ${table}.${column}`)
  const list = `${column} IN (${e.values.map(quote).join(', ')})`
  return 'nullable' in e && e.nullable ? `CHECK (${column} IS NULL OR ${list})` : `CHECK (${list})`
}

/** `title_source` as a rank (auto 0, agent 1, user 2), for the forward-only trigger. */
function titleRank(ref: string): string {
  return `(CASE ${ref} ${TITLE_SOURCE.map((t, i) => `WHEN ${quote(t)} THEN ${i}`).join(' ')} END)`
}

/** `{{check table.column}}` → that enum's CHECK, `{{rank ref}}` → titleRank(ref). */
function expand(sql: string): string {
  return sql
    .replace(/\{\{check (\w+)\.(\w+)\}\}/g, (_, t: string, c: string) => enumCheck(t, c))
    .replace(/\{\{rank ([\w.]+)\}\}/g, (_, ref: string) => titleRank(ref))
}

const V1 = expand(`
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL UNIQUE,
  is_git          INTEGER NOT NULL DEFAULT 1,
  default_branch  TEXT,
  sort_order      REAL NOT NULL,
  collapsed       INTEGER NOT NULL DEFAULT 0,
  settings        TEXT NOT NULL DEFAULT '{}',
  missing         INTEGER NOT NULL DEFAULT 0,
  trust_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  title            TEXT NOT NULL,
  title_source     TEXT NOT NULL {{check sessions.title_source}},
  isolation        TEXT NOT NULL {{check sessions.isolation}},
  cwd              TEXT NOT NULL,
  worktree_root    TEXT,
  branch           TEXT,
  base_branch      TEXT,
  base_commit      TEXT,
  port_base        INTEGER,
  agent            TEXT NOT NULL,
  agent_session_id TEXT,
  transcript_path  TEXT,
  launch_config    TEXT NOT NULL,
  lifecycle        TEXT NOT NULL {{check sessions.lifecycle}},
  end_reason       TEXT {{check sessions.end_reason}},
  deleted_at       INTEGER,
  snapshot_ref     TEXT,
  creation_step    TEXT,
  disk_bytes       INTEGER,
  disk_at          INTEGER,
  sort_order       REAL NOT NULL,
  pinned_order     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  archived_at      INTEGER,
  UNIQUE (project_id, slug)
);
CREATE INDEX sessions_by_project ON sessions(project_id, lifecycle);
CREATE UNIQUE INDEX sessions_port_base ON sessions(port_base) WHERE port_base IS NOT NULL;

CREATE TABLE session_runtime (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  phase            TEXT NOT NULL DEFAULT 'idle' {{check session_runtime.phase}},
  attention        TEXT NOT NULL DEFAULT '[]',
  background       INTEGER NOT NULL DEFAULT 0,
  failure_kind     TEXT {{check session_runtime.failure_kind}},
  unread           INTEGER NOT NULL DEFAULT 0,
  status_source    TEXT {{check session_runtime.status_source}},
  status_at        INTEGER,
  last_activity_at INTEGER NOT NULL,
  model            TEXT,
  effort           TEXT,
  permission_mode  TEXT,
  cost_usd         REAL,
  context_pct      REAL
);

CREATE TABLE session_ui (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE ptys (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL {{check ptys.kind}},
  title             TEXT,
  argv              TEXT NOT NULL,
  holder_pid        INTEGER,
  holder_started_at INTEGER,
  child_pid         INTEGER,
  cols              INTEGER,
  rows              INTEGER,
  state             TEXT NOT NULL {{check ptys.state}},
  exit_code         INTEGER,
  exit_signal       INTEGER,
  tab_order         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX ptys_by_session ON ptys(session_id);

CREATE TABLE status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  source      TEXT NOT NULL {{check status_events.source}},
  event       TEXT NOT NULL,
  summary     TEXT,
  phase_after TEXT NOT NULL
);
CREATE INDEX status_events_by_session ON status_events(session_id, id);

CREATE TABLE presets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  agent      TEXT NOT NULL,
  config     TEXT NOT NULL,
  sort_order REAL NOT NULL
);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TRIGGER sessions_children AFTER INSERT ON sessions BEGIN
  INSERT INTO session_runtime (session_id, last_activity_at) VALUES (NEW.id, NEW.created_at);
  INSERT INTO session_ui (session_id) VALUES (NEW.id);
END;

CREATE TRIGGER sessions_title_forward BEFORE UPDATE OF title_source ON sessions
WHEN {{rank NEW.title_source}} < {{rank OLD.title_source}} BEGIN
  SELECT RAISE(ABORT, 'title_source only moves auto -> agent -> user (SES-3)');
END;
`)

/** Every migration, in order. `MIGRATIONS.at(-1).version` is the schema this build writes. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial schema', sql: V1 }]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

/** The schema's tables. */
export const TABLES = ['projects', 'sessions', 'session_runtime', 'session_ui', 'ptys', 'status_events', 'presets', 'kv'] as const
