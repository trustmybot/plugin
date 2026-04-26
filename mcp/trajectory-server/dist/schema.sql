PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS issues (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_issue_id   INTEGER REFERENCES issues(id),
    objective         TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    pre_commit_hash   TEXT    NOT NULL DEFAULT '',
    post_commit_hash  TEXT,
    status            TEXT    NOT NULL DEFAULT 'open',
    current_task_id   INTEGER REFERENCES tasks(id),
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    closed_at         TEXT
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
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    completed_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id);

CREATE TABLE IF NOT EXISTS ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id     INTEGER NOT NULL REFERENCES issues(id),
    branch_id    TEXT,
    from_node    TEXT    NOT NULL,
    event_type   TEXT    NOT NULL,
    summary      TEXT    NOT NULL DEFAULT '',
    content      TEXT    NOT NULL DEFAULT '{}',
    is_truncated INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id     INTEGER NOT NULL REFERENCES issues(id),
    branch_id    TEXT,
    from_node    TEXT    NOT NULL DEFAULT 'executor',
    round        INTEGER NOT NULL DEFAULT 0,
    tool_name    TEXT    NOT NULL,
    tool_args    TEXT    NOT NULL DEFAULT '{}',
    output       TEXT    NOT NULL DEFAULT '',
    output_chars INTEGER NOT NULL DEFAULT 0,
    is_truncated INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS validation_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         INTEGER NOT NULL REFERENCES tasks(id),
    attempt_n       INTEGER NOT NULL,
    agent           TEXT    NOT NULL DEFAULT '',
    verdict         TEXT    NOT NULL,
    feedback         TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
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

CREATE TABLE IF NOT EXISTS roundtables (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id    INTEGER NOT NULL REFERENCES issues(id),
    topic       TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open',
    outcome     TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS roundtable_votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    roundtable_id  INTEGER NOT NULL REFERENCES roundtables(id),
    agent          TEXT    NOT NULL,
    vote           TEXT    NOT NULL,
    rationale      TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS discussions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id    INTEGER NOT NULL REFERENCES issues(id),
    author      TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'note',
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_issue_created
    ON discussions(issue_id, created_at);

CREATE TABLE IF NOT EXISTS plugin_meta (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    plugin_version TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO plugin_meta (schema_version, plugin_version) VALUES (1, '0.3.2');

CREATE TABLE IF NOT EXISTS file_registry (
    path             TEXT PRIMARY KEY,
    type             TEXT NOT NULL DEFAULT 'unknown',
    language         TEXT,
    size_bytes       INTEGER,
    last_commit_sha  TEXT,
    last_change_type TEXT,
    last_change_at   TEXT,
    imports_json     TEXT NOT NULL DEFAULT '[]',
    exports_json     TEXT NOT NULL DEFAULT '[]',
    metadata_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS plugin_config (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    human_name       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regen_state (
    target        TEXT PRIMARY KEY,
    last_regen_at TEXT,
    last_seen_sha TEXT,
    notes         TEXT NOT NULL DEFAULT ''
);
