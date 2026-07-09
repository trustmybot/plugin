PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- repos table: written by /scan. One row per discovered git repo under the
-- session dir. Kuzu world-model Directory nodes reference repos.name as their
-- root; this SQLite table is the deterministic precursor to the kuzu writes.
-- repos(name) is the FK hub for the repos-centric schema (#155): every work
-- table carries a repo column referencing it. Declared early so the work-table
-- FKs below resolve at fresh-DB CREATE time.
CREATE TABLE IF NOT EXISTS repos (
    name              TEXT PRIMARY KEY,
    path              TEXT    NOT NULL,
    file_count        INTEGER NOT NULL DEFAULT 0,
    last_scanned_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    target_branch     TEXT,
    branching_model   TEXT,
    protected_branches TEXT,
    -- remotes (#155, #980): per-repo remote list, the sole source of truth.
    -- Populated by scan_run from each repo's git remotes (#979). JSON array of
    -- {name, provider, url}. The issue-scoped sync path reads this to pick the
    -- explicit gh --repo / glab -R for the issue's repo rather than process.cwd().
    remotes           TEXT
);

-- milestones table (#155): GitHub-style per-repo milestones. issues.milestone
-- is an FK into this table. PK is (name, repo) so the same milestone name can
-- exist independently per repo.
CREATE TABLE IF NOT EXISTS milestones (
    name   TEXT NOT NULL,
    repo   TEXT NOT NULL REFERENCES repos(name) ON DELETE RESTRICT,
    state  TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (name, repo)
);

CREATE TABLE IF NOT EXISTS issues (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    objective         TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    status            TEXT    NOT NULL DEFAULT 'open',
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    closed_at         TEXT,
    remote_iid        INTEGER,
    remote_kind       TEXT CHECK(remote_kind IN ('github','gitlab')),
    gh_iid            INTEGER,
    gl_iid            INTEGER,
    -- repo (#155): the repo this issue belongs to. Nullable for single-repo
    -- installs (no repos row yet at issue-create time). FK to repos(name).
    repo              TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    -- milestone (#155): FK into milestones(name, repo). Nullable.
    milestone         TEXT,
    FOREIGN KEY (milestone, repo) REFERENCES milestones(name, repo) ON DELETE RESTRICT
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
    verdict             TEXT    NOT NULL,
    feedback            TEXT    NOT NULL DEFAULT '',
    -- LOAD-BEARING-SAFETY: mcp_available is the typed push-gate signal (1=MCP up,
    -- 0=honor-system fallback). Bro reads it off this column via validation_history,
    -- so the pr-reviewer verdict + availability travel as typed fields, never scraped
    -- from a free-text feedback prefix.
    mcp_available       INTEGER NOT NULL DEFAULT 1,
    subagent_session_id TEXT,
    -- repo (#155): FK to repos(name); backfilled from the parent task's repo.
    repo                TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    created_at          TEXT    NOT NULL,
    UNIQUE(task_id, attempt_n)
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
VALUES (-1, 'system', 'parent issue for recovery / system-level audit and discussion events', 'open', datetime('now'), datetime('now'));

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
    -- repo (#155): FK to repos(name); backfilled from the parent issue's repo.
    repo           TEXT    REFERENCES repos(name) ON DELETE RESTRICT,
    created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_issue_created
    ON discussions(issue_id, created_at);

CREATE TABLE IF NOT EXISTS plugin_meta (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    plugin_version TEXT    NOT NULL
);

INSERT OR IGNORE INTO plugin_meta (id, schema_version, plugin_version) VALUES (1, 27, '0.0.0');

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
    ('issue_priority_labels',       '["Priority: Urgent","Priority: High","Priority: Medium","Priority: Low"]');

-- The "onboarded" marker lives in plugin_config now (#2876). The legacy
-- identity table was a single-row marker with no columns of meaning —
-- folded into plugin_config('onboarded': true).

-- Per-spawn resource tracking (issue #131). Written by the SubagentStop hook
-- via swe-atomic-close.sh on every SWE completion, AND by composites for the
-- bro-as-agent_run row (#2886): bro's per-task tokens become a first-class
-- citizen. Bro rows
-- are inserted at task_create_batch (completed_at NULL until close) and
-- finalized at bro_atomic_close — hence completed_at is nullable.
CREATE TABLE IF NOT EXISTS agent_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id              INTEGER REFERENCES tasks(id),
    issue_id             INTEGER REFERENCES issues(id),
    agent_type           TEXT    NOT NULL,
    tokens_in            INTEGER NOT NULL DEFAULT 0,
    tokens_out           INTEGER NOT NULL DEFAULT 0,
    tokens_total         INTEGER NOT NULL DEFAULT 0,
    -- cache_read_tokens: tokens served from Anthropic's prompt cache (billed at ~0.1x input rate).
    -- cache_creation_tokens: tokens written into the prompt cache (billed at ~1.25x input rate).
    -- Both classes are excluded from tokens_in in CC's modelUsage; we track them separately
    -- because the cost difference is ~100x (cache_read is cheapest, cache_creation is most expensive
    -- per-token relative to plain input).
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    tool_uses            INTEGER NOT NULL DEFAULT 0,
    duration_ms          INTEGER NOT NULL DEFAULT 0,
    started_at           TEXT,
    completed_at         TEXT,
    usage_baseline_json  TEXT,
    -- repo (#155): FK to repos(name); backfilled from the parent task/issue repo.
    repo                 TEXT    REFERENCES repos(name) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_id);

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_issue_branch ON audit(issue_id, branch_id);

-- Incremental polling state for the /monitor flow (#2886 follow-up). One row
-- per (pr_number, repo). `last_fetched_at` is the wall-clock cursor for the
-- next `since` query; `last_comment_id` is the comment-id cursor when the
-- backend supports id-based deltas (gh REST does; glab uses created_at).
-- task_id + verdict + attempt_n are populated server-side by validation_record
-- to record pr-reviewer invocations (#334) — rows written for the reviewer
-- audit path have pr_number=0 and repo='' (sentinel) while task_id is non-null.
CREATE TABLE IF NOT EXISTS pr_review_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number       INTEGER NOT NULL DEFAULT 0,
  repo            TEXT    NOT NULL DEFAULT '',
  last_fetched_at DATETIME NOT NULL,
  last_comment_id TEXT,
  task_id         INTEGER REFERENCES tasks(id),
  verdict         TEXT,
  attempt_n       INTEGER
);

-- Monitoring rows (pr_number > 0) remain one per (pr_number, repo); audit rows
-- (pr_number = 0) are exempt from this constraint via the WHERE clause so that
-- multiple validation attempts for the same task each get their own row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_pr ON pr_review_runs(pr_number, repo) WHERE pr_number > 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_audit ON pr_review_runs(task_id, attempt_n) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pr_review_runs_task ON pr_review_runs(task_id);

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
CREATE TABLE IF NOT EXISTS cheatcodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
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
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    -- A skill must record its file_path; an acquired capability (marketplace or
    -- external) must carry its source identity; a builtin must not (#101, #152).
    CHECK (kind != 'skill' OR file_path IS NOT NULL),
    CHECK (origin = 'builtin' OR source_url IS NOT NULL),
    CHECK (origin != 'builtin' OR source_url IS NULL)
);

-- Schema-seed the bundled tmb_* skills (#2884, #101). Without this seed the
-- registry sits empty of plugin skills on every install — none of the shipped
-- skills register themselves at session start. Mirrors the `agents` seed above.
-- Descriptions come from each SKILL.md's frontmatter (kept short — full routing
-- logic lives in the SKILL.md body, this row is just the index). origin='builtin'
-- and source_url omitted (NULL) per the builtin CHECK.
INSERT OR IGNORE INTO cheatcodes (name, kind, origin, description, file_path, scope, trust_tier, status, installed_at, created_at, updated_at) VALUES
    ('tmb_planning',           'skill', 'builtin', 'Bro''s full code-touching flow — cold-start judgment, branch_id confirm, spec authoring (defaults table + ADR when architectural), decision audit, SWE spawn, V1/V2/V3 verification, atomic close, retry-on-fail.', 'skills/tmb_planning/SKILL.md',           'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_concerns-protocol',  'skill', 'builtin', 'How bro raises a concern when doubting the Human''s plan — surface inline via discussion_append + ask, or spawn a consultant in analysis-only mode for technical disagreement.',                              'skills/tmb_concerns-protocol/SKILL.md',  'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_recovery',           'skill', 'builtin', 'Bro''s response when something fails — AskUserQuestion errors, MCP tool returns is_error=true, or the trajectory-server is unreachable.',                                                                 'skills/tmb_recovery/SKILL.md',           'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_review',             'skill', 'builtin', 'PR-reviewer''s diff-level push-gate protocol — check this task''s diff against its spec, then write the validation_record verdict that gates the push.',                                                       'skills/tmb_review/SKILL.md',             'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_push-gate',          'skill', 'builtin', 'Bro''s push-gate orchestration — reaping unsigned commits, spawning pr-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.', 'skills/tmb_push-gate/SKILL.md',          'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_comment-triage',     'skill', 'builtin', 'Bro''s PR/MR comment triage — resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per ratified group. Loaded by bro when /monitor surfaces PR/MR comments.', 'skills/tmb_comment-triage/SKILL.md',     'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_swe-checklist',      'skill', 'builtin', 'SWE''s self-review heuristics — spec-fidelity + scope discipline judgment loaded only when about to atomic-close.',                                                                                          'skills/tmb_swe-checklist/SKILL.md',      'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_docs-conventions',   'skill', 'builtin', 'Discipline rules for editing prompt files (agents, skills, CLAUDE.md, workflow markdown) and the docs-update expectation.',                                                                                  'skills/tmb_docs-conventions/SKILL.md',   'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_skill-creator',      'skill', 'builtin', 'Generate a new project-local skill at .claude/skills/<name>/SKILL.md and attach it to existing agents.',                                                                                                     'skills/tmb_skill-creator/SKILL.md',      'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now')),
    ('tmb_cheatcode',          'skill', 'builtin', 'When bro hits a wall — a task leans on a capability the project lacks and a published skill / MCP toolkit / plugin would close the gap — name the gap, cheatcode_search for ranked candidates, judge the best fit, and recommend it for Human approval.', 'skills/tmb_cheatcode/SKILL.md',          'global', 'curated', 'active', datetime('now'), datetime('now'), datetime('now'));

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

-- World model lives in a sibling kuzu graph DB (ADR 0002), not in this
-- SQLite file. The previous v6 'directories' / 'directories_fts' /
-- 'directories_embeddings' tables were retired at v8 — see migrateV7toV8
-- in db.ts. scan_run populates the kuzu file via src/graph-db.ts.
