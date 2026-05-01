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
    labels            TEXT,
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
    repo              TEXT,
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
    ('remotes',            '[]',            datetime('now'));

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

-- L6 deterministic-trajectory test infrastructure (issue #108).
-- Populated ONLY when env TMB_DEBUG_TRAJECTORY=1. Off by default — zero
-- overhead in production. The L6 test runner pre-seeds DB state, runs
-- claude -p with the env set, then asserts the resulting trajectory
-- matches an expected sequence from FLOWS.md.
CREATE TABLE IF NOT EXISTS debug_trajectory (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT    NOT NULL,
    step_n           INTEGER NOT NULL,
    kind             TEXT    NOT NULL,            -- 'mcp_call' | 'tool_use' | 'agent_thinking'
    agent            TEXT,                        -- 'bro' | 'swe' | 'pr-reviewer' | NULL
    tool_or_mcp_name TEXT    NOT NULL,            -- e.g. 'mcp__plugin_tmb_trajectory-server__identity_get' or 'Bash'
    args_json        TEXT    NOT NULL DEFAULT '{}',
    result_json      TEXT    NOT NULL DEFAULT '{}',
    is_error         INTEGER NOT NULL DEFAULT 0,
    -- Cost / latency tracking (#110 evals v2). Defaulted to 0; populated when
    -- the capture layer can attribute a token / latency value to this call.
    tokens_in        INTEGER NOT NULL DEFAULT 0,
    tokens_out       INTEGER NOT NULL DEFAULT 0,
    latency_ms       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_debug_trajectory_session
    ON debug_trajectory(session_id, step_n);

-- Per-scorer results for L6 v2 (issue #110). One row per (flow, scorer) per run.
-- The runner writes here after each scorer evaluates; reports aggregate over
-- run_id. The "outcome" scorer is the primary signal (binary pass/fail);
-- "trajectory_subset" / "trajectory_superset" are secondary structural checks;
-- "cost" is observability-only (warns on drift but doesn't fail).
CREATE TABLE IF NOT EXISTS eval_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT    NOT NULL,            -- groups all scorers for one flow run
    flow_name     TEXT    NOT NULL,            -- e.g. '02-simple-task'
    scorer_name   TEXT    NOT NULL,            -- 'outcome' | 'trajectory_subset' | 'trajectory_superset' | 'cost' | 'llm_judge'
    pass          INTEGER NOT NULL,            -- 1 = pass, 0 = fail
    value         TEXT,                        -- numeric or categorical detail
    explanation   TEXT,                        -- why pass/fail
    metadata_json TEXT    NOT NULL DEFAULT '{}',
    -- A/B prompt-eval columns (#131). Default 'control' so existing single-arm
    -- L5 dogfood runs continue to work unchanged. A/B scenarios set arm to
    -- 'A' / 'B' / etc. and scenario to a stable identifier (e.g. 'claude-md-slim').
    arm           TEXT    NOT NULL DEFAULT 'control',
    scenario      TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run
    ON eval_results(run_id, scorer_name);

CREATE INDEX IF NOT EXISTS idx_eval_results_flow
    ON eval_results(flow_name, created_at);

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
    started_at   TEXT,
    completed_at TEXT    NOT NULL,
    exit_status  TEXT    NOT NULL DEFAULT 'completed'
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
