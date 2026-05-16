-- Eval/dogfood-only schema. Loaded in addition to schema.sql when TMB_EVAL_MODE=1.

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
