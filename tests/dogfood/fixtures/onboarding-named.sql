-- Onboarded state with a named identity. Use this fixture for any flow that
-- needs a clean post-onboard project where bro knows the user's name.
--
-- Schema-seeded automatically (no fixture work needed):
--   - plugin_config defaults (branching_model='github-flow', pr_target='main',
--     protected_branches=["main"], remotes=[], issue_sync='off')
--   - agents registry (swe, pr-reviewer, architect, cto, ceo, pm)
--   - system issue (id=999999) — parent FK for headless-recovery audit writes

INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, 'Test User', datetime('now'), datetime('now'));
