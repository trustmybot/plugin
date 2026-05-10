PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS issues (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    objective         TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    post_commit_hash  TEXT,
    status            TEXT    NOT NULL DEFAULT 'open',
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    closed_at         TEXT,
    remote_iid        INTEGER,
    remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
    remote_synced_at  DATETIME
);

CREATE TABLE IF NOT EXISTS tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id          INTEGER NOT NULL REFERENCES issues(id),
    branch_id         TEXT    NOT NULL,
    parent_branch_id  TEXT,
    title             TEXT    NOT NULL DEFAULT '',
    description       TEXT    NOT NULL,
    tools_required    TEXT    NOT NULL DEFAULT '[]',
    skills_required   TEXT    NOT NULL DEFAULT '[]',
    success_criteria  TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending',
    attempts          INTEGER NOT NULL DEFAULT 0,
    spec_body         TEXT    NOT NULL DEFAULT '',
    commit_sha        TEXT,
    repo              TEXT,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    completed_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id);

CREATE TABLE IF NOT EXISTS audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id     INTEGER NOT NULL REFERENCES issues(id),
    branch_id    TEXT,
    from_node    TEXT    NOT NULL DEFAULT 'executor',

    -- All audit rows are kind='event'. The kind='tool_call' branch was retired
    -- in #179 (always-empty across production data; tool-call records live in
    -- debug_trajectory). The CHECK keeps 'event' as the only valid value so
    -- writers fail loudly if they regress to the old discriminator.
    kind         TEXT    NOT NULL DEFAULT 'event' CHECK(kind = 'event'),

    event_type   TEXT    NOT NULL,
    summary      TEXT    NOT NULL,
    content_json TEXT    NOT NULL DEFAULT '{}',

    is_truncated INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS validation_attempts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             INTEGER NOT NULL REFERENCES tasks(id),
    attempt_n           INTEGER NOT NULL,
    agent               TEXT    NOT NULL DEFAULT '',
    verdict             TEXT    NOT NULL,
    -- LOAD-BEARING-SAFETY (#97): feedback MUST start with the literal MCP-availability prefix.
    -- Bro's push-gate parser depends on this exact format; raw-SQL inserts via sqlite3 fallback
    -- (tmb_review §B) bypass the MCP handler, so the constraint lives at the schema layer.
    feedback            TEXT    NOT NULL DEFAULT '' CHECK (
        feedback LIKE 'MCP available: yes%' OR
        feedback LIKE 'MCP available: no — honor-system fallback%' OR
        feedback = ''
    ),
    subagent_session_id TEXT,
    created_at          TEXT    NOT NULL,
    UNIQUE(task_id, attempt_n)
);

CREATE TABLE IF NOT EXISTS skills (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL UNIQUE,
    description     TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    tags            TEXT    NOT NULL DEFAULT '[]',
    created_by      TEXT    NOT NULL DEFAULT 'system',
    trust_tier      TEXT    NOT NULL DEFAULT 'curated',
    status          TEXT    NOT NULL DEFAULT 'active',
    when_to_use     TEXT    NOT NULL DEFAULT '',
    when_not_to_use TEXT    NOT NULL DEFAULT '',
    uses            INTEGER NOT NULL DEFAULT 0,
    successes       INTEGER NOT NULL DEFAULT 0,
    failures        INTEGER NOT NULL DEFAULT 0,
    effectiveness   REAL,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
    scope       TEXT    NOT NULL CHECK (scope IN ('global','template','project-local')),
    file_path   TEXT    NOT NULL,
    tmb_owner   TEXT    NOT NULL DEFAULT 'bro' CHECK (tmb_owner IN ('bro','user-adopted','user')),
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO agents (name, kind, scope, file_path, tmb_owner) VALUES
    ('swe',          'backbone',   'global',   'agents/swe.md',                 'bro'),
    ('pr-reviewer',  'backbone',   'global',   'agents/pr-reviewer.md',         'bro'),
    ('architect',    'consultant', 'template', 'templates/agents/architect.md', 'bro'),
    ('cto',          'consultant', 'template', 'templates/agents/cto.md',       'bro'),
    ('ceo',          'consultant', 'template', 'templates/agents/ceo.md',       'bro'),
    ('pm',           'consultant', 'template', 'templates/agents/pm.md',        'bro');

-- Synthetic "system" issue (id=999999) — parent FK for system-level audit and
-- discussion writes that don't belong to any user-created work issue. The
-- tmb_recovery doctrine and the /onboard headless-block path target this id.
-- Schema-seeded so every fresh DB has it without fixtures needing to add it.
INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (999999, 'system', 'parent issue for headless-recovery / system-level audit and discussion events', 'open', datetime('now'), datetime('now'));

CREATE TABLE IF NOT EXISTS roundtables (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id                INTEGER NOT NULL REFERENCES issues(id),
    topic                   TEXT    NOT NULL,
    status                  TEXT    NOT NULL DEFAULT 'open',
    outcome                 TEXT    NOT NULL DEFAULT '',
    created_at              TEXT    NOT NULL,
    closed_at               TEXT,
    state                   TEXT    NOT NULL DEFAULT 'collecting'
                              CHECK (state IN ('collecting','awaiting_human','closed','skipped')),
    expected_participants   INTEGER,
    ratification_received_at TEXT
);

CREATE TABLE IF NOT EXISTS roundtable_votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    roundtable_id  INTEGER NOT NULL REFERENCES roundtables(id),
    agent          TEXT    NOT NULL,
    participant    TEXT,
    vote           TEXT    NOT NULL,
    rationale      TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS discussions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id       INTEGER NOT NULL REFERENCES issues(id),
    author         TEXT    NOT NULL,
    kind           TEXT    NOT NULL DEFAULT 'note',
    body           TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,
    verified_human INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_discussions_issue_created
    ON discussions(issue_id, created_at);

CREATE TABLE IF NOT EXISTS plugin_meta (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    plugin_version TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 1, '0.0.0');

CREATE TABLE IF NOT EXISTS file_registry (
    path                TEXT PRIMARY KEY,
    type                TEXT NOT NULL DEFAULT 'unknown',
    language            TEXT,
    size_bytes          INTEGER,
    last_commit_sha     TEXT,
    last_change_type    TEXT,
    last_change_at      TEXT,
    imports_json        TEXT NOT NULL DEFAULT '[]',
    exports_json        TEXT NOT NULL DEFAULT '[]',
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    -- Codebase-memory columns (#45). content_md5 is the cheap drift probe;
    -- summary is the LLM-generated summary written by bro on Read or by SWE
    -- at atomic-close; summary_updated_at gates staleness.
    -- NOTE: the 8 derived-metadata columns above (language/size_bytes/etc.)
    -- are always-empty in production (#179 audit) but kept in the schema for
    -- module-graph rendering and architecture_regen compat. Drop deferred to
    -- a follow-up PR that also rewrites those consumers.
    content_md5         TEXT,
    summary             TEXT,
    summary_updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS plugin_config (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Default policy keys, seeded at DB init so bro never has to "apply defaults"
-- on first contact. Modern-agent UX: the system gives bro working state out
-- of the box; the user changes anything via tmb_reonboard. INSERT OR IGNORE
-- makes this safe to re-run on existing DBs (no overwrite of user choices).
INSERT OR IGNORE INTO plugin_config (key, value_json, updated_at) VALUES
    ('branching_model',    '"github-flow"', datetime('now')),
    ('pr_target',          '"main"',        datetime('now')),
    ('protected_branches', '["main"]',      datetime('now')),
    ('remotes',            '[]',            datetime('now')),
    ('issue_sync',         '"off"',         datetime('now'));

-- The identity table is now a pure onboarded-marker. Row presence at id=1
-- means /onboard has been completed in this project; row absence means
-- first-contact, fire /onboard. We deliberately don't store the user's name
-- — bro doesn't need it for any workflow, and asking for it bloated the
-- onboarding ceremony with a free-text question that AUQ's radio model
-- fits poorly. The legacy `human_name` column is migrated away in db.ts.
CREATE TABLE IF NOT EXISTS identity (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regen_state (
    target        TEXT PRIMARY KEY,
    last_regen_at TEXT,
    last_seen_sha TEXT,
    notes         TEXT NOT NULL DEFAULT ''
);

-- Per-spawn resource tracking (issue #131). Written by the SubagentStop hook
-- via swe-atomic-close.sh on every SWE completion. Zero overhead when the
-- hook fires for non-task agents — graceful fallback to all-zero fields.
CREATE TABLE IF NOT EXISTS agent_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      INTEGER REFERENCES tasks(id),
    issue_id     INTEGER REFERENCES issues(id),
    agent_type   TEXT    NOT NULL,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    tokens_total INTEGER NOT NULL DEFAULT 0,
    tool_uses    INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    -- started_at retired in #179 (never written; only completed_at is set).
    completed_at TEXT    NOT NULL,
    exit_status  TEXT    NOT NULL DEFAULT 'completed'
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);

CREATE TABLE IF NOT EXISTS pr_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL,
  repo TEXT NOT NULL,
  remote_kind TEXT NOT NULL CHECK(remote_kind IN ('github','gitlab')),
  last_fetched_at DATETIME NOT NULL,
  last_comment_id TEXT,
  comments_processed INTEGER NOT NULL DEFAULT 0,
  tasks_created INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo);
