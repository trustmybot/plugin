-- Onboarding completed with a named identity ("Test User").
-- Use this fixture to skip past first-run onboarding for any flow that
-- needs a clean post-onboarding state.

INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, 'Test User', datetime('now'), datetime('now'));

INSERT INTO plugin_config (key, value_json, updated_at) VALUES
  ('branching_model', '"github-flow"', datetime('now')),
  ('pr_target',       '"main"',         datetime('now')),
  ('protected_branches', '["main"]',    datetime('now'));

INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, created_at)
VALUES (
  0, NULL, 'bro', 'tmb_onboarding_complete',
  'Test fixture — identity Test User, github-flow, main protected.',
  datetime('now')
);
