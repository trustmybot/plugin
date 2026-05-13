-- Onboarded state. Identity row is a pure marker (no name stored — bro
-- doesn't ask for or persist user names). Use this fixture for any flow
-- that needs a clean post-onboard project state.
--
-- Schema-seeded automatically (no fixture work needed):
--   - plugin_config defaults (branching_model='github-flow', pr_target='main',
--     protected_branches=["main"], remotes=[], issue_sync='off')
--   - agents registry (swe, pr-reviewer, architect, cto, ceo, pm)
--   - system issue (id=-1) — parent FK for headless-recovery audit writes
--
-- Filename retained for backward compat; the legacy "named vs anonymous"
-- distinction no longer applies — the marker is plugin_config('onboarded': true).

INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');

-- Pre-clear the registry-cold gate. /scan would normally run before any
-- task_create_batch; for flows that don't exercise scan itself, the seed
-- audit row stands in. Flows targeting the gate (or scan_run) start from
-- the empty fixture instead.
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'L5/L6 fixture: gate cleared', '{}', datetime('now'));
