PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS issues (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    objective         TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    status            TEXT    NOT NULL DEFAULT 'open',
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    closed_at         TEXT,
    remote_iid        INTEGER,
    remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id          INTEGER NOT NULL REFERENCES issues(id),
    branch_id         TEXT    NOT NULL,
    parent_branch_id  TEXT,
    title             TEXT    NOT NULL DEFAULT '',
    description       TEXT    NOT NULL,
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
    event_type   TEXT    NOT NULL,
    summary      TEXT    NOT NULL,
    content_json TEXT    NOT NULL DEFAULT '{}',
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
    -- scope mirrors agents.scope (#2886). 'global' = plugin-shipped `tmb_*`
    -- skills in skills/<name>/SKILL.md; 'template' = `templates/skills/...`
    -- copied per-project on demand; 'project-local' = `<project>/.claude/
    -- skills/<name>/SKILL.md` authored by `tmb_skill-creator`.
    scope           TEXT    NOT NULL DEFAULT 'global'
                      CHECK (scope IN ('global','template','project-local')),
    trust_tier      TEXT    NOT NULL DEFAULT 'curated',
    status          TEXT    NOT NULL DEFAULT 'active',
    uses            INTEGER NOT NULL DEFAULT 0,
    successes       INTEGER NOT NULL DEFAULT 0,
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
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO agents (name, kind, scope, file_path) VALUES
    ('swe',          'backbone',   'global',   'agents/swe.md'),
    ('pr-reviewer',  'backbone',   'global',   'agents/pr-reviewer.md'),
    ('architect',    'consultant', 'template', 'templates/agents/architect.md'),
    ('cto',          'consultant', 'template', 'templates/agents/cto.md'),
    ('ceo',          'consultant', 'template', 'templates/agents/ceo.md'),
    ('pm',           'consultant', 'template', 'templates/agents/pm.md');

-- Schema-seed the bundled tmb_* skills (#2884). Without this seed the skills
-- table sits empty on every install — none of the shipped skills register
-- themselves at session start. Mirrors the `agents` seed pattern above.
-- Descriptions come from each SKILL.md's frontmatter (kept short — full
-- routing logic lives in the SKILL.md body, this row is just the index).
INSERT OR IGNORE INTO skills (name, description, file_path, scope, trust_tier, status, created_at, updated_at) VALUES
    ('tmb_planning',           'Bro''s full code-touching flow — cold-start judgment, branch_id confirm, spec authoring (defaults table + ADR when architectural), decision audit, SWE spawn, V1/V2/V3 verification, atomic close, retry-on-fail.', 'skills/tmb_planning/SKILL.md',           'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_concerns-protocol',  'How bro raises a concern when doubting the Human''s plan — surface inline via discussion_append + ask, or spawn a consultant in analysis-only mode for technical disagreement.',                              'skills/tmb_concerns-protocol/SKILL.md',  'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_recovery',           'Bro''s response when something fails — AskUserQuestion errors / TMB_HEADLESS=1, MCP tool returns is_error=true, or the trajectory-server is unreachable.',                                                  'skills/tmb_recovery/SKILL.md',           'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_review',             'Review surface — pr-reviewer''s qualitative phases at the push gate, bro''s PR/MR comment triage flow, and bro''s push-time orchestration.',                                                                 'skills/tmb_review/SKILL.md',             'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_swe-checklist',      'SWE''s self-review heuristics — spec-fidelity + scope discipline judgment loaded only when about to atomic-close.',                                                                                          'skills/tmb_swe-checklist/SKILL.md',      'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_docs-conventions',   'Discipline rules for editing prompt files (agents, skills, CLAUDE.md, workflow markdown) and the docs-update expectation.',                                                                                  'skills/tmb_docs-conventions/SKILL.md',   'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_skill-creator',      'Generate a new project-local skill at .claude/skills/<name>/SKILL.md and attach it to existing agents.',                                                                                                     'skills/tmb_skill-creator/SKILL.md',      'global', 'curated', 'active', datetime('now'), datetime('now')),
    ('tmb_agent-creator',      'Resolve a consultant ask: list the registry via agent_list, then either spawn an existing agent via Agent, copy a template + register + spawn, or create from-scratch + register + spawn.',                  'skills/tmb_agent-creator/SKILL.md',      'global', 'curated', 'active', datetime('now'), datetime('now'));

-- Synthetic "system" issue (id=-1) — parent FK for system-level audit and
-- discussion writes that don't belong to any user-created work issue. The
-- tmb_recovery doctrine and the /onboard headless-block path target this id.
-- Schema-seeded so every fresh DB has it without fixtures needing to add it.
--
-- Negative sentinel rather than a high positive (e.g. 999999) so SQLite's
-- AUTOINCREMENT counter remains at 0 and the first user-created issue gets
-- id=1 — production installs see clean 1, 2, 3... numbering without a
-- million-id gap polluting the issue space.
INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (-1, 'system', 'parent issue for headless-recovery / system-level audit and discussion events', 'open', datetime('now'), datetime('now'));

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
    kind           TEXT    NOT NULL DEFAULT 'note',
    body           TEXT    NOT NULL,
    created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_issue_created
    ON discussions(issue_id, created_at);

CREATE TABLE IF NOT EXISTS plugin_meta (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    plugin_version TEXT    NOT NULL
);

INSERT OR IGNORE INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 3, '0.0.0');

-- repos table: written by /scan. One row per discovered git repo under the
-- session dir. file_registry rows reference repos.name via the repo column.
-- Pure metadata — drift detection itself is md5-only on file_registry rows.
CREATE TABLE IF NOT EXISTS repos (
    name              TEXT PRIMARY KEY,
    path              TEXT    NOT NULL,
    file_count        INTEGER NOT NULL DEFAULT 0,
    last_scanned_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_registry (
    repo                TEXT NOT NULL DEFAULT '',
    path                TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'unknown',
    -- Codebase-memory columns (#45). content_md5 is the cheap drift probe;
    -- summary is the LLM-generated summary written by bro on Read or by SWE
    -- at atomic-close; summary_updated_at gates staleness.
    content_md5         TEXT,
    summary             TEXT,
    summary_updated_at  TEXT,
    PRIMARY KEY (repo, path)
);

CREATE TABLE IF NOT EXISTS plugin_config (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

-- Default policy keys, seeded at DB init so bro never has to "apply defaults"
-- on first contact. Modern-agent UX: the system gives bro working state out
-- of the box; the user changes anything via tmb_reonboard. INSERT OR IGNORE
-- makes this safe to re-run on existing DBs (no overwrite of user choices).
INSERT OR IGNORE INTO plugin_config (key, value_json) VALUES
    ('branching_model',    '"github-flow"'),
    ('pr_target',          '"main"'),
    ('protected_branches', '["main"]'),
    ('remotes',            '[]'),
    ('issue_sync',         '"off"');

-- The "onboarded" marker lives in plugin_config now (#2876). The legacy
-- identity table was a single-row marker with no columns of meaning —
-- folded into plugin_config('onboarded': true).

-- Per-spawn resource tracking (issue #131). Written by the SubagentStop hook
-- via swe-atomic-close.sh on every SWE completion, AND by composites for the
-- bro-as-agent_run row (#2886): bro's per-task tokens become a first-class
-- citizen so skill_invocations + rule_invocations can FK to them. Bro rows
-- are inserted at task_create_batch (completed_at NULL until close) and
-- finalized at bro_atomic_close — hence completed_at is nullable.
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
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_issue_branch ON audit(issue_id, branch_id);

-- Incremental polling state for the /monitor flow (#2886 follow-up). One row
-- per (pr_number, repo). `last_fetched_at` is the wall-clock cursor for the
-- next `since` query; `last_comment_id` is the comment-id cursor when the
-- backend supports id-based deltas (gh REST does; glab uses created_at).
CREATE TABLE IF NOT EXISTS pr_review_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL,
  repo TEXT NOT NULL,
  last_fetched_at DATETIME NOT NULL,
  last_comment_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo);

-- Rules catalog (#2886). First-class registry for `.claude/rules/*.md`
-- documents. Severity captures enforcement weight — some rules are
-- advisory (suggestion only), some are warning (surface to bro on read),
-- some are blocking (deny the operation via a hook). Plugin ships no
-- built-in rules; the table is populated by project-local `rule_register`
-- calls or by an upcoming rules-scanner.
CREATE TABLE IF NOT EXISTS rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT    NOT NULL,
    file_path   TEXT    NOT NULL,
    scope       TEXT    NOT NULL DEFAULT 'project-local'
                  CHECK (scope IN ('global','template','project-local')),
    severity    TEXT    NOT NULL DEFAULT 'advisory'
                  CHECK (severity IN ('advisory','warning','blocking')),
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

-- Commands catalog (#2886). One row per slash command. The plugin ships
-- 4 first-class commands (/scan, /onboard, /monitor, /roundtable); project-
-- local commands land at `<project>/.claude/commands/<name>.md`.
CREATE TABLE IF NOT EXISTS commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    description  TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    scope        TEXT    NOT NULL DEFAULT 'global'
                   CHECK (scope IN ('global','template','project-local')),
    args_schema  TEXT    NOT NULL DEFAULT '{}',
    status       TEXT    NOT NULL DEFAULT 'active',
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);

-- Seed the bundled slash commands so a fresh DB doesn't sit empty
-- (same pattern as agents + skills seeds above).
INSERT OR IGNORE INTO commands (name, description, file_path, scope, args_schema, status, created_at, updated_at) VALUES
    ('scan',       'Deterministically populate the file_registry by walking the session dir for git repos, computing content_md5 per file. Phase 1 (programmatic) clears the registry-cold gate; Phase 2 (parallel summary fill) runs in the background.', 'commands/scan.md',       'global', '{}',                                                          'active', datetime('now'), datetime('now')),
    ('onboard',    'Configure or change identity, branching model, PR target, remotes, and issue-sync. Server-driven — bro orchestrates AskUserQuestion rounds; the MCP `onboard_*` tools own every if/else branch.',                                                       'commands/onboard.md',    'global', '{}',                                                          'active', datetime('now'), datetime('now')),
    ('monitor',    'Pull review comments from a GitHub PR or GitLab MR and plan/dispatch SWE work to address them.',                                                                                                                                                       'commands/monitor.md',    'global', '{"argument_hint":"<PR or MR number>"}',                       'active', datetime('now'), datetime('now')),
    ('roundtable', 'Multi-agent deliberation on a topic with checkbox/radio AUQ ratification.',                                                                                                                                                                            'commands/roundtable.md', 'global', '{"argument_hint":"<topic to deliberate>"}',                   'active', datetime('now'), datetime('now'));

-- Junction tables — the load-bearing bridge (#2886). One row per
-- skill / rule invocation. Bridges the catalog (skills, rules) to the
-- agent_run that triggered it. Enables forward queries ("what did this
-- agent_run touch") and reverse queries ("which agent_runs used skill X")
-- with cheap indexes on both sides.
--
-- agent_run_id is nullable: a Skill can fire during a session that has no
-- tracked agent_run yet (e.g., bro firing tmb_planning during onboarding
-- before the first task_create_batch creates a bro row). In that case
-- agent_name is the fallback attribution.
CREATE TABLE IF NOT EXISTS skill_invocations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name    TEXT    NOT NULL REFERENCES skills(name),
    agent_name    TEXT    NOT NULL,
    agent_run_id  INTEGER REFERENCES agent_runs(id),
    task_id       INTEGER REFERENCES tasks(id),
    invoked_at    TEXT    NOT NULL,
    outcome       TEXT    NOT NULL DEFAULT 'completed'
                    CHECK (outcome IN ('completed','failed','partial'))
);

CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill ON skill_invocations(skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_task  ON skill_invocations(task_id);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_agent_run ON skill_invocations(agent_run_id);

CREATE TABLE IF NOT EXISTS rule_invocations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name     TEXT    NOT NULL REFERENCES rules(name),
    agent_name    TEXT    NOT NULL,
    agent_run_id  INTEGER REFERENCES agent_runs(id),
    task_id       INTEGER REFERENCES tasks(id),
    applied_at    TEXT    NOT NULL,
    outcome       TEXT    NOT NULL DEFAULT 'applied'
                    CHECK (outcome IN ('applied','violated','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_rule_invocations_rule ON rule_invocations(rule_name);
CREATE INDEX IF NOT EXISTS idx_rule_invocations_task ON rule_invocations(task_id);
CREATE INDEX IF NOT EXISTS idx_rule_invocations_agent_run ON rule_invocations(agent_run_id);

-- FTS5 virtual tables for keyword search (Phase 1 of #2905).
-- content= tables shadow the source table so SQLite keeps them in sync
-- via the triggers below; we also backfill on fresh DBs here.

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

CREATE VIRTUAL TABLE IF NOT EXISTS file_registry_fts USING fts5(
  summary,
  path,
  content='file_registry',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS file_registry_ai AFTER INSERT ON file_registry
WHEN new.summary IS NOT NULL BEGIN
  INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
END;
CREATE TRIGGER IF NOT EXISTS file_registry_ad AFTER DELETE ON file_registry
WHEN old.summary IS NOT NULL BEGIN
  INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
END;
CREATE TRIGGER IF NOT EXISTS file_registry_au AFTER UPDATE ON file_registry
WHEN old.summary IS NOT NULL BEGIN
  INSERT INTO file_registry_fts(file_registry_fts, rowid, summary, path) VALUES ('delete', old.rowid, old.summary, old.path);
END;
CREATE TRIGGER IF NOT EXISTS file_registry_au_new AFTER UPDATE ON file_registry
WHEN new.summary IS NOT NULL BEGIN
  INSERT INTO file_registry_fts(rowid, summary, path) VALUES (new.rowid, new.summary, new.path);
END;
