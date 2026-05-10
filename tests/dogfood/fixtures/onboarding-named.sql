-- Onboarded state. Identity row is a pure marker (no name stored — bro
-- doesn't ask for or persist user names). Use this fixture for any flow
-- that needs a clean post-onboard project state.
--
-- Schema-seeded automatically (no fixture work needed):
--   - plugin_config defaults (branching_model='github-flow', pr_target='main',
--     protected_branches=["main"], remotes=[], issue_sync='off')
--   - agents registry (swe, pr-reviewer, architect, cto, ceo, pm)
--   - system issue (id=999999) — parent FK for headless-recovery audit writes
--
-- Filename retained for backward compat; the legacy "named vs anonymous"
-- distinction no longer applies — identity is just an onboarded flag.

INSERT INTO identity (id, created_at, updated_at)
VALUES (1, datetime('now'), datetime('now'));
