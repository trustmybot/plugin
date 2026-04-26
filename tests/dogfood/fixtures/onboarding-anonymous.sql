-- Onboarding completed but the user picked Anonymous.
-- Per #95 fix: identity row exists with human_name=NULL, created_at non-null.
-- The first-action chain should see this and skip re-onboarding.

INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, NULL, datetime('now'), datetime('now'));

INSERT INTO plugin_config (key, value_json, updated_at) VALUES
  ('branching_model', '"github-flow"', datetime('now')),
  ('pr_target',       '"main"',         datetime('now')),
  ('protected_branches', '["main"]',    datetime('now'));

INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, created_at)
VALUES (
  0, NULL, 'bro', 'tmb_onboarding_complete',
  'Test fixture — anonymous identity, github-flow.',
  datetime('now')
);
