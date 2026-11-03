PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- repos table: written by /scan. One row per discovered git repo under the
-- session dir. World-model rows (wm_directories, wm_files) carry repos.name as
-- their repo; this table is the deterministic precursor to those writes.
-- repos(name) is the FK hub for the repos-centric schema (#155): every work
-- table carries a repo column referencing it. Declared early so the work-table
-- FKs below resolve at fresh-DB CREATE time.
-- onboard_scan: JSON evidence + branching recommendation from the /onboard
-- pre-scan (GH 1575), rewritten by every onboard_state_get call.
CREATE TABLE IF NOT EXISTS repos (
    name              TEXT PRIMARY KEY,
    path              TEXT    NOT NULL,
    file_count        INTEGER NOT NULL DEFAULT 0,
    last_scanned_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    target_branch     TEXT,
    branching_model   TEXT,
    protected_branches TEXT,
    onboard_scan      TEXT
);

-- repo_remotes: a repo's git remotes, the sole source of truth for them.
-- scan_run and onboard_apply write it from each repo's own git remotes;
-- issue sync, milestone sync, pr_monitor and repo_rename read it to pick the
-- explicit gh --repo / glab -R target. provider comes from the URL host
-- (bitbucket and other hosts are 'other'); is_primary marks `origin`, else the
-- first remote. sync is the Human's onboard Remote choice: issue and milestone
-- sync reach only sync = 1 rows. A new row starts at sync = is_primary; scan
-- never changes it, only onboard_apply does. Rows follow their repo on delete
-- and on a name change.
CREATE TABLE IF NOT EXISTS repo_remotes (
    repo        TEXT    NOT NULL REFERENCES repos(name) ON DELETE CASCADE ON UPDATE CASCADE,
    name        TEXT    NOT NULL,
    provider    TEXT    NOT NULL CHECK (provider IN ('github','gitlab','other')),
    url         TEXT    NOT NULL,
    is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    sync        INTEGER NOT NULL DEFAULT 0 CHECK (sync IN (0,1)),
    PRIMARY KEY (repo, name)
);
CREATE INDEX IF NOT EXISTS idx_repo_remotes_primary ON repo_remotes(repo, is_primary);

-- milestones table (#155): GitHub-style per-repo milestones. issues.milestone
-- is an FK into this table. PK is (name, repo) so the same milestone name can
-- exist independently per repo.
CREATE TABLE IF NOT EXISTS milestones (
    name   TEXT NOT NULL,
    repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
    state  TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
    PRIMARY KEY (name, repo)
);

CREATE TABLE IF NOT EXISTS issues (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    objective         TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    closed_at         TEXT,
    remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
    gh_iid            INTEGER,
    gl_iid            INTEGER,
    -- repo (#155): the repo this issue belongs to. Nullable for single-repo
    -- installs (no repos row yet at issue-create time). FK to repos(name).
    repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    -- milestone (#155): FK into milestones(name, repo). Nullable.
    milestone         TEXT,
    -- labels (#53): the validated label set from issue_create, stored as a JSON
    -- array string so issue_sync_retry replays the original set. Nullable; NULL
    -- means a pre-v28 row (falls back to defaultSyncLabels on retry).
    labels            TEXT,
    FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_gh_iid ON issues(gh_iid);

CREATE TABLE IF NOT EXISTS tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id          INTEGER NOT NULL REFERENCES issues(id),
    branch_id         TEXT    NOT NULL,
    parent_branch_id  TEXT,
    title             TEXT    NOT NULL DEFAULT '',
    description       TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','needs_validation','completed','closed','failed','escalated')),
    spec_body         TEXT    NOT NULL DEFAULT '',
    commit_sha        TEXT,
    -- repo (#155): formalized as an FK to repos(name). Nullable for single-repo
    -- CC (no repos row yet). Relative path string (e.g. "plugin", "repos/backend").
    repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    -- prompt_bearing: 1 when this task intentionally modifies agent/skill/command
    -- prompt-surface files. When 0 (default), the swe-boundary hook denies writes
    -- to agents/, skills/*/SKILL.md, commands/, templates/, and *.md identity files.
    prompt_bearing    INTEGER NOT NULL DEFAULT 0,
    -- Typed Rails (#673): files/verification are JSON arrays the enforcement
    -- hooks read directly. files[] is the scope-fence allowlist (swe-scope-fence.sh);
    -- verification[] is the command list the verification gate runs
    -- (swe-verification-gate.sh). Both default to an empty array; an empty array
    -- means the hook skips enforcement with a warning (no spec_body markdown
    -- fallback). See docs/architecture/TYPED_RAILS.md.
    files             TEXT    NOT NULL DEFAULT '[]',
    verification      TEXT    NOT NULL DEFAULT '[]',
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    completed_at      TEXT,
    -- effort: the reasoning effort swe runs this task at. task_create_batch /
    -- task_provision write it (omitted → plugin_config.swe_default_effort,
    -- medium when unset); task_reopen / task_retry may raise it. The
    -- require-spawn-effort hook denies a swe spawn whose Agent effort differs.
    effort            TEXT    NOT NULL DEFAULT 'medium'
                        CHECK (effort IN ('low','medium','high')),
    -- completion_report (v48 GH 1744): swe's typed completion report as JSON
    -- {criteria: [{id status evidence_cmd? note?}] extras? findings_fixed?}.
    -- task_update_status writes it with a move to completed (required when the
    -- spec's Success Criteria carry SC<n>: ids) and clears it on any move but
    -- completed/closed; task_reopen clears it. NULL before a typed completion.
    -- No commas in these two comments: ALTER TABLE DROP COLUMN on the last
    -- column scans back to the nearest comma.
    completion_report TEXT,
    -- spawn_note (v48 GH 1744): at most 300 chars of context for the next
    -- spawn and returned by task_brief. bro_atomic_close and task_reopen each
    -- overwrite it (NULL when the call passes none).
    spawn_note        TEXT,
    -- checkpoint (v52 GH 1905): swe's handback as JSON {done left files
    -- commit_sha? at}. task_update_status writes it with status running and
    -- task_brief returns it so the next spawn resumes from it. A move to
    -- completed clears it and every other move keeps it. Keep this comment
    -- comma-free: DROP COLUMN on the last column cuts back to the nearest comma.
    checkpoint        TEXT,
    -- worktree_path (v54 GH 2032): the realpath of the linked worktree the
    -- task's swe works in when it is not <repo>/.claude/worktrees/<slug>. NULL
    -- keeps the slug path. adoptTaskWorktree is its only writer. Keep these two
    -- comments comma-free for the same DROP COLUMN reason.
    worktree_path     TEXT,
    -- worktree_adopted (v54 GH 2032): 1 once adoptTaskWorktree recorded the
    -- session worktree as worktree_path and 0 for a task_provision worktree.
    worktree_adopted  INTEGER NOT NULL DEFAULT 0 CHECK (worktree_adopted IN (0,1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_issue_branch ON tasks(issue_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_commit_sha ON tasks(commit_sha);

CREATE TABLE IF NOT EXISTS audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id     INTEGER NOT NULL REFERENCES issues(id),
    branch_id    TEXT,
    from_node    TEXT    NOT NULL DEFAULT 'executor',
    event_type   TEXT    NOT NULL,
    summary      TEXT    NOT NULL,
    content_json TEXT    NOT NULL DEFAULT '{}',
    -- repo (#155): the repo this audit event belongs to, FK to repos(name).
    -- Nullable; backfilled from the parent issue's repo on migration.
    repo         TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS validation_attempts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             INTEGER NOT NULL REFERENCES tasks(id),
    attempt_n           INTEGER NOT NULL,
    agent               TEXT    NOT NULL DEFAULT '',
    verdict             TEXT    NOT NULL CHECK (verdict IN ('pass','fail','escalate')),
    feedback            TEXT    NOT NULL DEFAULT '',
    -- LOAD-BEARING-SAFETY: mcp_available is the typed push-gate signal (1=MCP up,
    -- 0=honor-system fallback). Bro reads it off this column via validation_history,
    -- so the code-reviewer verdict + availability travel as typed fields, never scraped
    -- from a free-text feedback prefix. No DEFAULT: every writer states it.
    mcp_available       INTEGER NOT NULL,
    subagent_session_id TEXT,
    -- repo (#155): FK to repos(name); backfilled from the parent task's repo.
    repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    created_at          TEXT    NOT NULL,
    -- reviewer_agent_id: the code-reviewer subagent's Claude Code agent_id
    -- (subagent_session_id stays the Claude Code session). NULL until
    -- validation_record writes it, and for honor-system rows.
    reviewer_agent_id   TEXT,
    UNIQUE(task_id, attempt_n)
);

-- verification_runs: one row per run of a task's verification[] commands.
-- swe-verification-gate.sh writes it through the db-write lib: the row at the
-- start of a run, a verification_run_commands row after each command, then
-- finished_at/exit_code (both NULL only while the run is in progress). The
-- gate allows a close on a passing run for the same (task, commit) that
-- finished within the hour instead of running the commands again.
CREATE TABLE IF NOT EXISTS verification_runs (
    id           INTEGER PRIMARY KEY,
    task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    commit_sha   TEXT    NOT NULL,
    source       TEXT    NOT NULL CHECK (source IN ('gate','manual')),
    started_at   TEXT    NOT NULL,
    finished_at  TEXT,
    exit_code    INTEGER,
    budget_s     INTEGER NOT NULL,
    timed_out    INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_verification_runs_task_commit
    ON verification_runs(task_id, commit_sha, finished_at);

-- verification_run_commands: one row per command of a run, in verification[]
-- order. exit_code 124 marks the command the budget ran out on.
CREATE TABLE IF NOT EXISTS verification_run_commands (
    run_id       INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
    ordinal      INTEGER NOT NULL,
    command      TEXT    NOT NULL,
    exit_code    INTEGER,
    elapsed_s    REAL,
    output_tail  TEXT,
    PRIMARY KEY (run_id, ordinal)
);

-- review_findings (v47, GH 1737): one row per defect a code-reviewer FAIL or
-- escalate verdict names. validation_record writes the row (id F<task_id>-<n>,
-- n counting up per task; status 'open'); swe-verification-gate.sh runs every
-- non-wontfix probe_cmd after verification[] on each close attempt and sets
-- status 'fixed' + resolved_at when an open finding's probe exits 0.
-- criterion_id is NULL when the finding covers no single criterion;
-- resolved_at is NULL while the finding is open.
CREATE TABLE IF NOT EXISTS review_findings (
    id           TEXT    PRIMARY KEY,
    task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_n    INTEGER NOT NULL,
    criterion_id TEXT,
    probe_cmd    TEXT    NOT NULL,
    expected     TEXT    NOT NULL,
    observed     TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','wontfix')),
    created_at   TEXT    NOT NULL,
    resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_findings_task_status
    ON review_findings(task_id, status);

-- agents.file_path names the root the prompt file ships from: 'plugin:' is
-- relative to the installed plugin root (backbone agents, consultant
-- templates), 'project:' to the workspace root (.claude/agents/<name>.md).
CREATE TABLE IF NOT EXISTS agents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    kind        TEXT    NOT NULL CHECK (kind IN ('backbone','consultant')),
    file_path   TEXT    NOT NULL CHECK (file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The seeds run on every open; INSERT … WHERE NOT EXISTS leaves the
-- AUTOINCREMENT counter untouched when the rows are already present.
WITH seed (name, kind, file_path) AS (VALUES
    ('swe',          'backbone',   'plugin:agents/swe.md'),
    ('code-reviewer', 'backbone',   'plugin:agents/code-reviewer.md'),
    ('architect',    'consultant', 'plugin:templates/agents/architect.md'),
    ('cto',          'consultant', 'plugin:templates/agents/cto.md'),
    ('ceo',          'consultant', 'plugin:templates/agents/ceo.md'),
    ('pm',           'consultant', 'plugin:templates/agents/pm.md'))
INSERT INTO agents (name, kind, file_path)
SELECT name, kind, file_path FROM seed
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.name = seed.name);

-- Synthetic "system" issue (id=-1) — parent FK for system-level audit and
-- discussion writes that don't belong to any user-created work issue. The
-- tmb_recovery doctrine and the /onboard recovery path target this id.
-- Schema-seeded so every fresh DB has it without fixtures needing to add it.
--
-- Negative sentinel rather than a high positive (e.g. 999999) so SQLite's
-- AUTOINCREMENT counter remains at 0 and the first user-created issue gets
-- id=1 — production installs see clean 1, 2, 3... numbering without a
-- million-id gap polluting the issue space.
INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (-1, 'system', 'parent issue for recovery / system-level audit and discussion events', 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE IF NOT EXISTS roundtables (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id                INTEGER NOT NULL REFERENCES issues(id),
    topic                   TEXT    NOT NULL,
    outcome                 TEXT    NOT NULL DEFAULT '',
    created_at              TEXT    NOT NULL,
    closed_at               TEXT,
    state                   TEXT    NOT NULL DEFAULT 'collecting'
                              CHECK (state IN ('collecting','awaiting_human','closed','skipped')),
    expected_participants   INTEGER
);

CREATE TABLE IF NOT EXISTS roundtable_votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    roundtable_id  INTEGER NOT NULL REFERENCES roundtables(id),
    participant    TEXT    NOT NULL,
    vote           TEXT    NOT NULL,
    rationale      TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS discussions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id       INTEGER NOT NULL REFERENCES issues(id),
    author         TEXT    NOT NULL,
    kind           TEXT    NOT NULL DEFAULT 'note'
                     CHECK (kind IN ('intent','question','answer','decision','note','analysis')),
    body           TEXT    NOT NULL,
    -- repo (#155): FK to repos(name); backfilled from the parent issue's repo.
    repo           TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    created_at     TEXT    NOT NULL,
    -- remote_comment_id: the PR/MR comment id a persisted remote comment came
    -- from — the dedupe key for comment ingestion. NULL for local discussions.
    remote_comment_id TEXT,
    -- task_id (v46, GH 1741): the task a decision/intent row belongs to, set
    -- by task_provision, task_reopen, task_retry, task_update_spec and
    -- discussion_append(task_id). NULL marks an issue-level row.
    task_id        INTEGER REFERENCES tasks(id),
    -- supersedes (v46, GH 1741): the row this one replaces, set by
    -- discussion_append(supersedes); task_brief skips a superseded row.
    supersedes     INTEGER REFERENCES discussions(id)
);

CREATE INDEX IF NOT EXISTS idx_discussions_issue_created
    ON discussions(issue_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_remote_comment
    ON discussions(remote_comment_id) WHERE remote_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discussions_task
    ON discussions(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discussions_supersedes
    ON discussions(supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE IF NOT EXISTS plugin_meta (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    plugin_version TEXT    NOT NULL
);

INSERT OR IGNORE INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 55, '0.0.0');

CREATE TABLE IF NOT EXISTS plugin_config (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

-- Default policy keys, seeded at DB init so bro never has to "apply defaults"
-- on first contact. Modern-agent UX: the system gives bro working state out
-- of the box; the user changes anything via tmb_reonboard. INSERT OR IGNORE
-- makes this safe to re-run on existing DBs (no overwrite of user choices).
-- Repo-scoped policy (target_branch, branching_model, protected_branches,
-- remotes) lives on the repos table, not here (#980).
INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES
    ('issue_sync',         '"off"'),
    ('issue_classification_labels', '["Bug","Feature","Improvement","Docs","Test","Chore"]'),
    ('issue_priority_labels',       '["Priority: Urgent","Priority: High","Priority: Medium","Priority: Low"]'),
    -- model_prices: USD per 1M tokens per model id,
    -- {"<model>": {"input", "output", "cache_read", "cache_creation"}}; read by
    -- task_stats.cost_estimate. Seeded empty; filled via config_set.
    ('model_prices',                '{}');

-- The "onboarded" marker lives in plugin_config now (#2876). The legacy
-- identity table was a single-row marker with no columns of meaning —
-- folded into plugin_config('onboarded': true).

-- One row per metered run of an agent. A row covers the time window
-- [started_at, completed_at): started_at is server time when the run opens,
-- completed_at stays NULL while it is open.
--   bro rows — one per CC session (task_id and issue_id NULL), written by the
--     bro Stop hook: the session transcript's main-loop usage, rewritten
--     absolutely on every Stop. Per-task bro rows from older versions stay
--     as history.
--   swe rows — opened by task_brief; the SubagentStop hook binds the spawn to
--     the task_id in its spawn prompt and writes the spawn transcript's totals.
--     A swe resumed through SendMessage gets a row of its own at its next
--     task_brief, linked to its previous row by resumed_from (GH 1742).
-- bro_atomic_close and a terminal task_update_status close every open row of
-- the task; task_recover sweeps rows whose task is already terminal. Whoever
-- closes a row stamps its exit_reason.
-- The total token count is not stored: it is computed as tokens_in +
-- tokens_out + cache_read_tokens + cache_creation_tokens.
CREATE TABLE IF NOT EXISTS agent_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id              INTEGER REFERENCES tasks(id),
    issue_id             INTEGER REFERENCES issues(id),
    agent_type           TEXT    NOT NULL,
    -- Token columns are NULL when the run was never measured; a measured
    -- run writes absolute values (usage_source says where they came from).
    tokens_in            INTEGER,
    tokens_out           INTEGER,
    -- cache_read_tokens: tokens served from Anthropic's prompt cache (billed at ~0.1x input rate).
    -- cache_creation_tokens: tokens written into the prompt cache (billed at ~1.25x input rate).
    -- Both classes are excluded from tokens_in in CC's modelUsage; we track them separately
    -- because the cost difference is ~100x (cache_read is cheapest, cache_creation is most expensive
    -- per-token relative to plain input).
    cache_read_tokens     INTEGER,
    cache_creation_tokens INTEGER,
    tool_uses            INTEGER NOT NULL DEFAULT 0,
    duration_ms          INTEGER NOT NULL DEFAULT 0,
    started_at           TEXT,
    completed_at         TEXT,
    -- repo (#155): FK to repos(name); backfilled from the parent task/issue repo.
    repo                 TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    -- spawn_id: the Agent-tool spawn this run measures (one fresh row per spawn
    --   per task, plus one row per resume of it).
    -- session_id: the CC session that owns the run, so a hook resolves its own row.
    -- usage_source: where the token values came from; NULL until first measured.
    spawn_id             TEXT,
    session_id           TEXT,
    usage_source         TEXT CHECK (usage_source IN ('transcript','subagent_stop','unmeasured','backfill')),
    -- root_dir: absolute path this run may write to (bro: the project root;
    --   swe: the task's worktree). The containment-guard hook reads it.
    -- model: the dominant model id over the run's window (written with tokens).
    -- host: the agent host that ran it.
    -- exit_reason: how the row was closed; NULL while open.
    root_dir             TEXT,
    model                TEXT,
    host                 TEXT CHECK (host IN ('claude','codex')),
    exit_reason          TEXT CHECK (exit_reason IN ('completed','failed','escalated','swept_orphan','swept_stale','issue_closed')),
    -- effort: the reasoning effort the run was spawned at, written by
    -- swe-atomic-close.sh at SubagentStop (swe: the task's effort; code-reviewer:
    -- plugin_config.reviewer_effort). NULL on other agent types and on runs
    -- recorded before schema v37.
    effort               TEXT CHECK (effort IN ('low','medium','high')),
    -- resumed_from: the row of the same spawn_id this run resumed (a swe sent
    -- a SendMessage after it stopped). task_brief's openSweRun sets it; it is
    -- NULL on a fresh spawn and on every other agent type (GH 1742; schema
    -- v49). The row meters only the transcript entries from its started_at on.
    resumed_from         INTEGER REFERENCES agent_runs(id),
    -- plugin_version: the plugin version of the code that inserted the row
    -- (GH 1884; schema v50). openSweRun writes it from the TrajectoryDB
    -- instance and record-swe-spawn.sh and swe-atomic-close.sh and
    -- bro-turn-usage.sh write it from the plugin manifest. No UPDATE changes
    -- it. NULL means the row predates v50 or agent_runs_backfill wrote it.
    -- Keep this comment comma-free: SQLite's DROP COLUMN on a last column cuts back to the
    -- nearest comma and would land inside this comment.
    plugin_version       TEXT,
    -- stop_cause (GH 1905; schema v52): why a swe run stopped short. budget
    -- when swe handed back a checkpoint in the run and hook_block when its last
    -- tool result was a PreToolUse hook deny. NULL otherwise. The swe-stop-cause
    -- gate writes it at SubagentStop. Keep this comment comma-free.
    stop_cause           TEXT CHECK (stop_cause IN ('budget','hook_block')),
    -- stop_detail (GH 1905; schema v52): the deny text of a hook_block stop
    -- capped at 500 characters. NULL on every other stop. Keep this comment comma-free.
    stop_detail          TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(agent_type) WHERE completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_spawn ON agent_runs(task_id, spawn_id) WHERE spawn_id IS NOT NULL AND resumed_from IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_resumed ON agent_runs(resumed_from) WHERE resumed_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id) WHERE session_id IS NOT NULL;

-- session_handoffs (GH 2193; schema v55): one row per bro session that stopped
-- past its usage limits with no work running. The session-handoff Stop gate
-- upserts it until it is consumed. issue_id is the newest issue a non-bro run of
-- that session recorded (NULL with no such run); summary is the session's last
-- assistant message capped at 2000 characters (NULL when absent).
-- session-start-persona sets consumed_at and consumed_by_session when a new
-- session in the same cwd takes the handoff.
CREATE TABLE IF NOT EXISTS session_handoffs (
    session_id          TEXT PRIMARY KEY,
    cwd                 TEXT NOT NULL,
    issue_id            INTEGER REFERENCES issues(id),
    summary             TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    consumed_at         TEXT,
    consumed_by_session TEXT
);

-- agent_run_tool_output (GH 1957; schema v53): how much text each tool returned
-- into one agent run, one row per (run, tool). calls counts the run's
-- tool_result blocks of that tool; result_chars sums their text length (image
-- and other non-text blocks count 0); est_tokens = ceil(result_chars / 4). The
-- tool-output-size recorder rewrites a run's rows from its transcript at stop
-- (swe and code-reviewer at SubagentStop, bro at every Stop); a result with no
-- matching tool_use counts under tool_name 'unknown'.
CREATE TABLE IF NOT EXISTS agent_run_tool_output (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool_name    TEXT    NOT NULL,
    calls        INTEGER NOT NULL DEFAULT 0,
    result_chars INTEGER NOT NULL DEFAULT 0,
    est_tokens   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (run_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_tool_output_run ON agent_run_tool_output(run_id);

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_issue_branch ON audit(issue_id, branch_id);

-- /monitor incremental-polling cursor: exactly one row per real PR, keyed by
-- (pr_number, repo). `last_fetched_at` is the wall-clock cursor for the next
-- `since` query; `last_comment_id` is the comment-id cursor when the backend
-- supports id-based deltas (gh REST does; glab uses created_at). task_id links
-- the PR to the task it ships, so pr_monitor_comments_get resolves
-- pr_number → task → issue when it persists the PR's comments. Code-reviewer
-- verdicts live in validation_attempts.
CREATE TABLE IF NOT EXISTS pr_review_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number       INTEGER NOT NULL CHECK (pr_number > 0),
  repo            TEXT    NOT NULL CHECK (repo <> ''),
  last_fetched_at DATETIME NOT NULL,
  last_comment_id TEXT,
  task_id         INTEGER REFERENCES tasks(id),
  UNIQUE (pr_number, repo)
);

CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id);

-- FTS5 virtual tables for keyword search (Phase 1 of #2905).
-- content= tables shadow the source table so SQLite keeps them in sync
-- via the triggers below.

CREATE VIRTUAL TABLE IF NOT EXISTS discussions_fts USING fts5(
  body,
  content='discussions',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS discussions_ai AFTER INSERT ON discussions BEGIN
  INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS discussions_ad AFTER DELETE ON discussions BEGIN
  INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS discussions_au AFTER UPDATE ON discussions BEGIN
  INSERT INTO discussions_fts(discussions_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO discussions_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
  summary,
  content_json,
  content='audit',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS audit_ai AFTER INSERT ON audit BEGIN
  INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
END;
CREATE TRIGGER IF NOT EXISTS audit_ad AFTER DELETE ON audit BEGIN
  INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
END;
CREATE TRIGGER IF NOT EXISTS audit_au AFTER UPDATE ON audit BEGIN
  INSERT INTO audit_fts(audit_fts, rowid, summary, content_json) VALUES ('delete', old.id, old.summary, old.content_json);
  INSERT INTO audit_fts(rowid, summary, content_json) VALUES (new.id, new.summary, new.content_json);
END;

-- Embedding tables for semantic search (Phase 2 of #2905).
-- One table per source. Empty on migration; populated by background backfill
-- on server startup and inline on new writes.

CREATE TABLE IF NOT EXISTS discussions_embeddings (
  discussion_id INTEGER PRIMARY KEY REFERENCES discussions(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model_id TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discussions_embeddings_model ON discussions_embeddings(model_id);

CREATE TABLE IF NOT EXISTS audit_embeddings (
  audit_id INTEGER PRIMARY KEY REFERENCES audit(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model_id TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_embeddings_model ON audit_embeddings(model_id);

-- Unified capability registry (#101). One typed table for every capability the
-- project knows about, split by `origin` — a provenance enum, NOT a lifecycle:
--   origin='builtin'     — plugin-shipped tmb_* skills (was the `skills` table).
--                          source_url IS NULL; file_path points at the SKILL.md.
--   origin='marketplace' — acquired from a registered Claude Code marketplace
--                          (source_url is the <name>@<marketplace> ref or a
--                          marketplace-relative path). source_url IS NOT NULL.
--   origin='external'    — acquired from a raw external repo URL (a git URL the
--                          install registered as a marketplace first). The
--                          install lifecycle lives in `status`, never `origin`.
--                          source_url IS NOT NULL (the candidate identity).
-- cheatcode_install writes installed rows through the marketplace path;
-- cheatcode_uninstall (#676) reverses them. skill_register/skill_promote operate
-- on builtin rows. trust_tier carries the cheatcode_vet (#658) classification for
-- installed rows and the curation tier for builtin ones; status tracks lifecycle.
-- The natural key is (name, kind): a plugin and the MCP server it bundles
-- routinely share a name (`linear` plugin → `linear` server). scan.sh records a
-- plugin-bundled server with source_url 'mcp:<plugin>/<server>'.
CREATE TABLE IF NOT EXISTS cheatcodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('skill','mcp','plugin')),
    -- origin (#101, #152): provenance, not lifecycle. 'builtin' = plugin-shipped;
    -- 'marketplace' = from a registered marketplace ref; 'external' = from a raw
    -- external repo URL. The install path sets the value explicitly from the
    -- source; 'external' is the default for a bare acquired row.
    origin       TEXT    NOT NULL DEFAULT 'external' CHECK (origin IN ('builtin','marketplace','external')),
    description  TEXT    NOT NULL DEFAULT '',
    source_url   TEXT,
    -- file_path (#101): the SKILL.md location for skill-kind capabilities.
    -- Required for every skill row (builtin or skill-kind install); NULL for
    -- mcp/plugin kinds.
    file_path    TEXT,
    version      TEXT,
    trust_tier   TEXT,
    -- scope (#101): where the capability lives, unifying the install location
    -- with the skill placement enum. 'global' = plugin-shipped / user-wide;
    -- 'template' = templates/ copied per-project on demand; 'project-local' =
    -- <project>/.claude/ authored locally. cheatcode_install maps its
    -- local→project-local default; scripts/cheatcode-install.sh keeps the
    -- local|global --scope vocabulary it forwards to the marketplace.
    scope        TEXT    NOT NULL DEFAULT 'project-local'
                   CHECK (scope IN ('global','template','project-local')),
    -- status (#112): the install lifecycle. 'installed' = recorded but not
    -- confirmed loaded (new installs land here); 'active' = loaded/usable
    -- (builtin skills seed here); 'broken' = recorded but failed (e.g. an
    -- uninstall whose teardown left the artifact on disk). No CHECK — runtime
    -- reconciliation to active/broken is the health-check (#113).
    status       TEXT    NOT NULL DEFAULT 'installed',
    installed_at TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- A skill must record its file_path; an acquired capability (marketplace or
    -- external) must carry its source identity; a builtin must not (#101, #152).
    CHECK (kind != 'skill' OR file_path IS NOT NULL),
    CHECK (origin = 'builtin' OR source_url IS NOT NULL),
    CHECK (origin != 'builtin' OR source_url IS NULL),
    UNIQUE (name, kind)
);

-- Schema-seed the bundled tmb_* skills (#2884, #101). Without this seed the
-- registry sits empty of plugin skills on every install — none of the shipped
-- skills register themselves at session start. Mirrors the `agents` seed above.
-- Descriptions come from each SKILL.md's frontmatter (kept short — full routing
-- logic lives in the SKILL.md body, this row is just the index). origin='builtin'
-- and source_url omitted (NULL) per the builtin CHECK.
WITH seed (name, kind, origin, description, file_path, scope, trust_tier, status, installed_at, created_at, updated_at) AS (VALUES
    ('tmb_planning',           'skill', 'builtin', 'Bro''s full code-touching flow — cold-start judgment, branch_id confirm, spec authoring (defaults table + ADR when architectural), decision audit, SWE spawn, V1/V2/V3 verification, atomic close, retry-on-fail.', 'skills/tmb_planning/SKILL.md',           'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_concerns-protocol',  'skill', 'builtin', 'How bro raises a concern when doubting the Human''s plan — surface inline via discussion_append + ask, or spawn a consultant in analysis-only mode for technical disagreement.',                              'skills/tmb_concerns-protocol/SKILL.md',  'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_recovery',           'skill', 'builtin', 'Bro''s response when something fails — AskUserQuestion errors, MCP tool returns is_error=true, or the trajectory-server is unreachable.',                                                                 'skills/tmb_recovery/SKILL.md',           'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_review',             'skill', 'builtin', 'Code-reviewer''s diff-level push-gate protocol — check this task''s diff against its spec, then write the validation_record verdict that gates the push.',                                                       'skills/tmb_review/SKILL.md',             'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_push-gate',          'skill', 'builtin', 'Bro''s push-gate orchestration — reaping unsigned commits, spawning code-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.', 'skills/tmb_push-gate/SKILL.md',          'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_comment-triage',     'skill', 'builtin', 'Bro''s PR/MR comment triage — resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per ratified group. Loaded by bro when /monitor surfaces PR/MR comments.', 'skills/tmb_comment-triage/SKILL.md',     'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_swe-checklist',      'skill', 'builtin', 'SWE''s self-review heuristics — spec-fidelity + scope discipline judgment loaded only when about to atomic-close.',                                                                                          'skills/tmb_swe-checklist/SKILL.md',      'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_docs-conventions',   'skill', 'builtin', 'Discipline rules for editing prompt files (agents, skills, CLAUDE.md, workflow markdown) and the docs-update expectation.',                                                                                  'skills/tmb_docs-conventions/SKILL.md',   'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_skill-creator',      'skill', 'builtin', 'Generate a new project-local skill at .claude/skills/<name>/SKILL.md and attach it to existing agents.',                                                                                                     'skills/tmb_skill-creator/SKILL.md',      'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_cheatcode',          'skill', 'builtin', 'When bro hits a wall — a task leans on a capability the project lacks and a published skill / MCP toolkit / plugin would close the gap — name the gap, cheatcode_search for ranked candidates, judge the best fit, and recommend it for Human approval.', 'skills/tmb_cheatcode/SKILL.md',          'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('tmb_audit',              'skill', 'builtin', 'How bro audits, verifies or checks a component or an architecture — start from its outputs, state the invariants they must satisfy, prove each against live data, and report violations architecture-first. Loaded when the Human asks for an audit, a verification, a check, or an architecture review.', 'skills/tmb_audit/SKILL.md',              'global', 'curated', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')))
INSERT INTO cheatcodes (name, kind, origin, description, file_path, scope, trust_tier, status, installed_at, created_at, updated_at)
SELECT name, kind, origin, description, file_path, scope, trust_tier, status, installed_at, created_at, updated_at FROM seed
 WHERE NOT EXISTS (SELECT 1 FROM cheatcodes c WHERE c.name = seed.name AND c.kind = seed.kind);

-- Attachment records (#677). One row per artifact wired into the project by an
-- install — the marketplace plugin manifest, an MCP server registration, or a
-- proposed agent-frontmatter PR. target names the agent/role the capability is
-- attached to (or 'plugin'/'mcp' when attachment needs no prompt-surface edit);
-- artifact records what was wired so cheatcode_uninstall can reverse exactly it.
CREATE TABLE IF NOT EXISTS cheatcode_attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cheatcode_id INTEGER NOT NULL REFERENCES cheatcodes(id) ON DELETE CASCADE,
    target       TEXT    NOT NULL,
    artifact     TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cheatcode_attachments_cheatcode
    ON cheatcode_attachments(cheatcode_id);

-- World model (GH 1632): bro's project map, written by scan_run through
-- src/graph.ts. A derived cache rebuilt by every scan, so it carries no FK to
-- repos; repo_rename moves its rows. The retired v6 'directories' tables (see
-- migrateV7toV8) are unrelated.
--   wm_directories: one row per directory. parent_path is NULL for the repo
--     root ('') and the parent directory's path otherwise. summary comes from
--     the directory README (summary_source='readme') or a structural fallback.
--     For a README dir in a git repo (GH 1680): summary_sha is the last commit
--     touching the README, commits_behind (GH 1833) counts later commits that
--     change, other than by adding, a file the README references, dead_refs
--     is a JSON array of repo-relative paths the README names that no longer
--     exist. All three NULL otherwise.
--   wm_files: one row per tracked file. path is repo-relative; dir is its
--     directory's path. purpose is extracted from the file head (or written
--     by swe, purpose_source='swe'); content_md5 keys re-extraction.
--     symbols_md5 (GH 1680) is the stamp content_md5 || ':' ||
--     EXTRACTOR_VERSION the file's wm_symbols rows were parsed at; NULL until
--     first parsed. A scan re-parses a file only when it differs from the
--     current stamp.
--   wm_symbols (GH 1680, ADR 0001 L1): one row per definition tree-sitter
--     finds in a TS/JS, shell or SQL file. The stable anchor key is
--     (repo, path, kind, qualified_name): 'Class.method' for methods, the
--     file-local name for shell functions, the repo-relative path for the
--     per-file 'module' row. A re-parse upserts by that key, so an unchanged
--     symbol keeps its id. body_hash is the md5 of the body with comments and
--     whitespace runs stripped. terms is the split-name text the FTS indexes
--     (camelCase and snake_case split, plus kind and file basename).
--   wm_edges: one row per reference found in a symbol's body (or at module
--     level, on the 'module' row). dst_name is the referenced name, kept when
--     unresolved. resolution: 'exact' (same file, a resolved relative import or
--     a sourced file), 'name' (the only candidate by name), 'unresolved'
--     (dst_id NULL). A re-parse rebuilds the file's outgoing edges; a scan
--     re-resolves non-exact edges whose dst_name it inserted or moved. hint
--     (GH 1680) is the import specifier of an 'imports' edge or the receiver
--     of a member call, kept so that re-resolution needs no re-parse.
--   hook rows (GH 1680): each hooks/hooks.json entry is a kind='hook' symbol,
--     qualified_name '<Event>#<pos>:<gate>', with run_order = event rank * 100
--     + position (NULL on every other kind) and a 'runs' edge to its gate.
--   wm_concepts (GH 1680, ADR 0002 L2): an agent-written, named run of steps
--     (a flow, subsystem or invariant), unique per (repo, name). status is the
--     worst step trust; status_reason names the step. verified_sha is the repo
--     HEAD at the last upsert. steps_text is the step descriptions joined, the
--     text wm_concepts_fts indexes beside name and body.
--   wm_concept_steps: one ordered step per (concept_id, ordinal), anchored by
--     the ADR 0001 key (repo, path, kind, qualified_name; kind '' anchors the
--     file), not by wm_symbols.id, so a re-created symbol still matches.
--     hash_at_verify is the anchor's body_hash (or content_md5) at upsert;
--     handoff is how the step passes control to the next one (NULL on the
--     last). trust: 'suspect' once the hash moves, 'broken' once the anchor
--     is gone.
--   wm_concept_claims: checkable facts a concept asserts (exists, calls,
--     only_writers_of, tested_by), args a JSON object; last_result is 'pass'
--     or 'fail: <why>' from the last evaluation.
CREATE TABLE IF NOT EXISTS wm_directories (
    id                 INTEGER PRIMARY KEY,
    repo               TEXT    NOT NULL,
    path               TEXT    NOT NULL,
    parent_path        TEXT,
    summary            TEXT,
    summary_source     TEXT    NOT NULL,
    summary_updated_at TEXT,
    file_count         INTEGER NOT NULL DEFAULT 0,
    summary_sha        TEXT,
    commits_behind     INTEGER,
    dead_refs          TEXT,
    UNIQUE (repo, path)
);

CREATE INDEX IF NOT EXISTS idx_wm_directories_parent ON wm_directories(repo, parent_path);

CREATE TABLE IF NOT EXISTS wm_files (
    id              INTEGER PRIMARY KEY,
    repo            TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    dir             TEXT    NOT NULL,
    purpose         TEXT    NOT NULL DEFAULT '',
    purpose_source  TEXT    NOT NULL DEFAULT 'none',
    content_md5     TEXT    NOT NULL DEFAULT '',
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    last_commit_sha TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL,
    symbols_md5     TEXT,
    UNIQUE (repo, path)
);

CREATE INDEX IF NOT EXISTS idx_wm_files_dir ON wm_files(repo, dir);

CREATE TABLE IF NOT EXISTS wm_symbols (
    id              INTEGER PRIMARY KEY,
    repo            TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    kind            TEXT    NOT NULL CHECK (kind IN ('function','method','class','interface','type','const','sh_function','sql_table','sql_index','sql_trigger','module','hook')),
    qualified_name  TEXT    NOT NULL,
    signature       TEXT    NOT NULL DEFAULT '',
    doc             TEXT    NOT NULL DEFAULT '',
    start_line      INTEGER,
    end_line        INTEGER,
    body_hash       TEXT    NOT NULL,
    exported        INTEGER NOT NULL DEFAULT 0,
    terms           TEXT    NOT NULL DEFAULT '',
    run_order       INTEGER,
    UNIQUE (repo, path, kind, qualified_name)
);

CREATE TABLE IF NOT EXISTS wm_edges (
    src_id      INTEGER NOT NULL REFERENCES wm_symbols(id) ON DELETE CASCADE,
    dst_id      INTEGER REFERENCES wm_symbols(id) ON DELETE SET NULL,
    dst_name    TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('calls','imports','instantiates','sources','runs','reads_table','writes_table','indexes','triggers_on')),
    resolution  TEXT    NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('exact','name','unresolved')),
    line        INTEGER,
    hint        TEXT
);

CREATE INDEX IF NOT EXISTS idx_wm_edges_src ON wm_edges(src_id);
CREATE INDEX IF NOT EXISTS idx_wm_edges_dst ON wm_edges(dst_id);

CREATE TABLE IF NOT EXISTS wm_concepts (
    id             INTEGER PRIMARY KEY,
    repo           TEXT    NOT NULL,
    kind           TEXT    NOT NULL CHECK (kind IN ('flow','subsystem','invariant')),
    name           TEXT    NOT NULL,
    body           TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','suspect','broken','retired')),
    status_reason  TEXT,
    verified_sha   TEXT,
    verified_by    TEXT,
    verified_at    TEXT,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    steps_text     TEXT    NOT NULL DEFAULT '',
    UNIQUE (repo, name)
);

CREATE TABLE IF NOT EXISTS wm_concept_steps (
    concept_id      INTEGER NOT NULL REFERENCES wm_concepts(id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL,
    repo            TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT '',
    qualified_name  TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL,
    handoff         TEXT    CHECK (handoff IN ('calls','sources','runs','hook_fires')),
    hash_at_verify  TEXT    NOT NULL,
    trust           TEXT    NOT NULL DEFAULT 'verified' CHECK (trust IN ('verified','suspect','broken')),
    trust_reason    TEXT,
    PRIMARY KEY (concept_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_wm_concept_steps_anchor ON wm_concept_steps(repo, path);

CREATE TABLE IF NOT EXISTS wm_concept_claims (
    id           INTEGER PRIMARY KEY,
    concept_id   INTEGER NOT NULL REFERENCES wm_concepts(id) ON DELETE CASCADE,
    claim        TEXT    NOT NULL CHECK (claim IN ('exists','calls','only_writers_of','tested_by')),
    args         TEXT    NOT NULL DEFAULT '{}',
    last_result  TEXT
);

CREATE INDEX IF NOT EXISTS idx_wm_concept_claims_concept ON wm_concept_claims(concept_id);

CREATE VIRTUAL TABLE IF NOT EXISTS wm_directories_fts USING fts5(
  path,
  summary,
  content='wm_directories',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS wm_directories_ai AFTER INSERT ON wm_directories BEGIN
  INSERT INTO wm_directories_fts(rowid, path, summary) VALUES (new.id, new.path, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS wm_directories_ad AFTER DELETE ON wm_directories BEGIN
  INSERT INTO wm_directories_fts(wm_directories_fts, rowid, path, summary) VALUES ('delete', old.id, old.path, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS wm_directories_au AFTER UPDATE ON wm_directories BEGIN
  INSERT INTO wm_directories_fts(wm_directories_fts, rowid, path, summary) VALUES ('delete', old.id, old.path, old.summary);
  INSERT INTO wm_directories_fts(rowid, path, summary) VALUES (new.id, new.path, new.summary);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS wm_files_fts USING fts5(
  path,
  purpose,
  content='wm_files',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS wm_files_ai AFTER INSERT ON wm_files BEGIN
  INSERT INTO wm_files_fts(rowid, path, purpose) VALUES (new.id, new.path, new.purpose);
END;
CREATE TRIGGER IF NOT EXISTS wm_files_ad AFTER DELETE ON wm_files BEGIN
  INSERT INTO wm_files_fts(wm_files_fts, rowid, path, purpose) VALUES ('delete', old.id, old.path, old.purpose);
END;
CREATE TRIGGER IF NOT EXISTS wm_files_au AFTER UPDATE ON wm_files BEGIN
  INSERT INTO wm_files_fts(wm_files_fts, rowid, path, purpose) VALUES ('delete', old.id, old.path, old.purpose);
  INSERT INTO wm_files_fts(rowid, path, purpose) VALUES (new.id, new.path, new.purpose);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS wm_symbols_fts USING fts5(
  terms,
  signature,
  doc,
  content='wm_symbols',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS wm_symbols_ai AFTER INSERT ON wm_symbols BEGIN
  INSERT INTO wm_symbols_fts(rowid, terms, signature, doc) VALUES (new.id, new.terms, new.signature, new.doc);
END;
CREATE TRIGGER IF NOT EXISTS wm_symbols_ad AFTER DELETE ON wm_symbols BEGIN
  INSERT INTO wm_symbols_fts(wm_symbols_fts, rowid, terms, signature, doc) VALUES ('delete', old.id, old.terms, old.signature, old.doc);
END;
CREATE TRIGGER IF NOT EXISTS wm_symbols_au AFTER UPDATE OF terms, signature, doc ON wm_symbols BEGIN
  INSERT INTO wm_symbols_fts(wm_symbols_fts, rowid, terms, signature, doc) VALUES ('delete', old.id, old.terms, old.signature, old.doc);
  INSERT INTO wm_symbols_fts(rowid, terms, signature, doc) VALUES (new.id, new.terms, new.signature, new.doc);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS wm_concepts_fts USING fts5(
  name,
  body,
  steps_text,
  content='wm_concepts',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS wm_concepts_ai AFTER INSERT ON wm_concepts BEGIN
  INSERT INTO wm_concepts_fts(rowid, name, body, steps_text) VALUES (new.id, new.name, new.body, new.steps_text);
END;
CREATE TRIGGER IF NOT EXISTS wm_concepts_ad AFTER DELETE ON wm_concepts BEGIN
  INSERT INTO wm_concepts_fts(wm_concepts_fts, rowid, name, body, steps_text) VALUES ('delete', old.id, old.name, old.body, old.steps_text);
END;
CREATE TRIGGER IF NOT EXISTS wm_concepts_au AFTER UPDATE OF name, body, steps_text ON wm_concepts BEGIN
  INSERT INTO wm_concepts_fts(wm_concepts_fts, rowid, name, body, steps_text) VALUES ('delete', old.id, old.name, old.body, old.steps_text);
  INSERT INTO wm_concepts_fts(rowid, name, body, steps_text) VALUES (new.id, new.name, new.body, new.steps_text);
END;

-- World-model embeddings for semantic world_model_search: one vector per
-- directory (path + summary) and per file with a purpose (path + purpose).
-- Filled lazily by world_model_search and the startup backfill; a row whose
-- embedded text changes drops its vector so the next backfill re-embeds it.
CREATE TABLE IF NOT EXISTS wm_directories_embeddings (
  dir_id INTEGER PRIMARY KEY REFERENCES wm_directories(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model_id TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_directories_embeddings_model ON wm_directories_embeddings(model_id);

CREATE TABLE IF NOT EXISTS wm_files_embeddings (
  file_id INTEGER PRIMARY KEY REFERENCES wm_files(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model_id TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_files_embeddings_model ON wm_files_embeddings(model_id);

CREATE TRIGGER IF NOT EXISTS wm_directories_embedding_stale
AFTER UPDATE OF path, summary ON wm_directories
WHEN old.path IS NOT new.path OR old.summary IS NOT new.summary BEGIN
  -- LINT-ALLOW: drops a stale derived vector; the backfill re-embeds the row.
  DELETE FROM wm_directories_embeddings WHERE dir_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS wm_files_embedding_stale
AFTER UPDATE OF path, purpose ON wm_files
WHEN old.path IS NOT new.path OR old.purpose IS NOT new.purpose BEGIN
  -- LINT-ALLOW: drops a stale derived vector; the backfill re-embeds the row.
  DELETE FROM wm_files_embeddings WHERE file_id = old.id;
END;
