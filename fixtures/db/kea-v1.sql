-- kea.db at schema version 1 (data model §1b), with a few rows of every table. Historical: never edit;
-- U-DB-1 migrates it to the current schema. Made by the v1 migration of app/core/src/platform/db/schema.ts (triggers last,
-- as sqlite3 .dump writes them, so the rows below load as they are).
PRAGMA user_version = 1;
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
  title_source     TEXT NOT NULL CHECK (title_source IN ('auto', 'agent', 'user')),
  isolation        TEXT NOT NULL CHECK (isolation IN ('worktree', 'inplace')),
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
  lifecycle        TEXT NOT NULL CHECK (lifecycle IN ('creating', 'live', 'detached', 'archived', 'create_failed', 'deleted')),
  end_reason       TEXT CHECK (end_reason IS NULL OR end_reason IN ('exited', 'stopped', 'crashed', 'lost')),
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
CREATE TABLE session_runtime (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  phase            TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('starting', 'working', 'blocked', 'ready', 'failed', 'idle')),
  attention        TEXT NOT NULL DEFAULT '[]',
  background       INTEGER NOT NULL DEFAULT 0,
  failure_kind     TEXT CHECK (failure_kind IS NULL OR failure_kind IN ('rate_limit', 'overloaded', 'auth', 'billing', 'other')),
  unread           INTEGER NOT NULL DEFAULT 0,
  status_source    TEXT CHECK (status_source IS NULL OR status_source IN ('hook', 'status-file', 'transcript', 'heuristic', 'reconcile', 'user')),
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
  kind              TEXT NOT NULL CHECK (kind IN ('agent', 'shell', 'server', 'script')),
  title             TEXT,
  argv              TEXT NOT NULL,
  holder_pid        INTEGER,
  holder_started_at INTEGER,
  child_pid         INTEGER,
  cols              INTEGER,
  rows              INTEGER,
  state             TEXT NOT NULL CHECK (state IN ('running', 'exited', 'lost')),
  exit_code         INTEGER,
  exit_signal       INTEGER,
  tab_order         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE TABLE status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('hook', 'status-file', 'transcript', 'heuristic', 'reconcile', 'user')),
  event       TEXT NOT NULL,
  summary     TEXT,
  phase_after TEXT NOT NULL
);
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
CREATE INDEX sessions_by_project ON sessions(project_id, lifecycle);
CREATE UNIQUE INDEX sessions_port_base ON sessions(port_base) WHERE port_base IS NOT NULL;
CREATE INDEX ptys_by_session ON ptys(session_id);
CREATE INDEX status_events_by_session ON status_events(session_id, id);
INSERT INTO projects (id, name, root_path, is_git, default_branch, sort_order, collapsed, settings, missing, trust_confirmed, created_at) VALUES ('01K0000000000000000000PRJ1', 'demo', '/repos/demo', 1, 'main', 1, 0, '{"runCommand":"pnpm dev","services":"shared"}', 0, 1, 1790000000000);
INSERT INTO projects (id, name, root_path, is_git, default_branch, sort_order, collapsed, settings, missing, trust_confirmed, created_at) VALUES ('01K0000000000000000000PRJ2', 'notes', '/repos/notes', 0, NULL, 2, 1, '{}', 1, 0, 1790000000001);
INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, worktree_root, branch, base_branch, base_commit, port_base, agent, agent_session_id, transcript_path, launch_config, lifecycle, end_reason, deleted_at, snapshot_ref, creation_step, disk_bytes, disk_at, sort_order, pinned_order, created_at, archived_at) VALUES ('01K0000000000000000000SES1', '01K0000000000000000000PRJ1', 'fix-auth', 'Fix auth', 'auto', 'worktree', '/kea/worktrees/demo/fix-auth', '/kea/worktrees', 'kea/fix-auth', 'main', 'abc123', 41000, 'shell', NULL, NULL, '{"prompt":"fix auth"}', 'live', NULL, NULL, NULL, NULL, 1024, 1790000000000, -1790000000000, 0, 1790000000000, NULL);
INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, worktree_root, branch, base_branch, base_commit, port_base, agent, agent_session_id, transcript_path, launch_config, lifecycle, end_reason, deleted_at, snapshot_ref, creation_step, disk_bytes, disk_at, sort_order, pinned_order, created_at, archived_at) VALUES ('01K0000000000000000000SES2', '01K0000000000000000000PRJ1', 'old-idea', 'Old idea', 'user', 'worktree', '/kea/worktrees/demo/old-idea', '/kea/worktrees', 'kea/old-idea', 'main', 'abc123', NULL, 'shell', NULL, NULL, '{"prompt":"old idea"}', 'archived', 'stopped', NULL, NULL, NULL, NULL, NULL, -1789999999995, 0, 1789999999995, 1790000000000);
INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, worktree_root, branch, base_branch, base_commit, port_base, agent, agent_session_id, transcript_path, launch_config, lifecycle, end_reason, deleted_at, snapshot_ref, creation_step, disk_bytes, disk_at, sort_order, pinned_order, created_at, archived_at) VALUES ('01K0000000000000000000SES3', '01K0000000000000000000PRJ2', 'notes-1', 'Notes', 'auto', 'inplace', '/repos/notes', NULL, NULL, NULL, NULL, NULL, 'shell', NULL, NULL, '{"prompt":""}', 'detached', 'lost', NULL, NULL, NULL, NULL, NULL, -1790000000002, 0, 1790000000002, NULL);
INSERT INTO session_runtime (session_id, phase, attention, background, failure_kind, unread, status_source, status_at, last_activity_at, model, effort, permission_mode, cost_usd, context_pct) VALUES ('01K0000000000000000000SES1', 'working', '[]', 0, NULL, 0, 'hook', 1790000000010, 1790000000000, NULL, NULL, NULL, NULL, NULL);
INSERT INTO session_runtime (session_id, phase, attention, background, failure_kind, unread, status_source, status_at, last_activity_at, model, effort, permission_mode, cost_usd, context_pct) VALUES ('01K0000000000000000000SES2', 'idle', '[]', 0, NULL, 0, NULL, NULL, 1789999999995, NULL, NULL, NULL, NULL, NULL);
INSERT INTO session_runtime (session_id, phase, attention, background, failure_kind, unread, status_source, status_at, last_activity_at, model, effort, permission_mode, cost_usd, context_pct) VALUES ('01K0000000000000000000SES3', 'idle', '[]', 0, NULL, 0, NULL, NULL, 1790000000002, NULL, NULL, NULL, NULL, NULL);
INSERT INTO session_ui (session_id, state) VALUES ('01K0000000000000000000SES1', '{}');
INSERT INTO session_ui (session_id, state) VALUES ('01K0000000000000000000SES2', '{}');
INSERT INTO session_ui (session_id, state) VALUES ('01K0000000000000000000SES3', '{}');
INSERT INTO ptys (id, session_id, kind, title, argv, holder_pid, holder_started_at, child_pid, cols, rows, state, exit_code, exit_signal, tab_order, created_at, ended_at) VALUES ('aaaaaaaaa1', '01K0000000000000000000SES1', 'agent', NULL, '["/bin/zsh","-l"]', 4242, 1790000000000, 4243, 120, 40, 'running', NULL, NULL, 0, 1790000000000, NULL);
INSERT INTO ptys (id, session_id, kind, title, argv, holder_pid, holder_started_at, child_pid, cols, rows, state, exit_code, exit_signal, tab_order, created_at, ended_at) VALUES ('aaaaaaaaa2', '01K0000000000000000000SES3', 'agent', 'zsh', '["/bin/zsh","-l"]', NULL, NULL, NULL, 80, 24, 'lost', NULL, NULL, 0, 1790000000002, 1790000000003);
INSERT INTO status_events (id, session_id, at, source, event, summary, phase_after) VALUES (1, '01K0000000000000000000SES1', 1790000000010, 'hook', 'turn.started', 'prompt submitted', 'working');
INSERT INTO presets (id, name, agent, config, sort_order) VALUES ('01K0000000000000000000PST1', 'Quick', 'shell', '{}', 1);
INSERT INTO kv (key, value) VALUES ('window.bounds', '{"x":0,"y":0,"w":1200,"h":800}');
CREATE TRIGGER sessions_children AFTER INSERT ON sessions BEGIN
  INSERT INTO session_runtime (session_id, last_activity_at) VALUES (NEW.id, NEW.created_at);
  INSERT INTO session_ui (session_id) VALUES (NEW.id);
END;
CREATE TRIGGER sessions_title_forward BEFORE UPDATE OF title_source ON sessions
WHEN (CASE NEW.title_source WHEN 'auto' THEN 0 WHEN 'agent' THEN 1 WHEN 'user' THEN 2 END) < (CASE OLD.title_source WHEN 'auto' THEN 0 WHEN 'agent' THEN 1 WHEN 'user' THEN 2 END) BEGIN
  SELECT RAISE(ABORT, 'title_source only moves auto -> agent -> user (SES-3)');
END;
