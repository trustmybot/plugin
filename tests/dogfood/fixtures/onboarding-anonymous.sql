-- Defaults applied + the user explicitly created an identity row but left
-- the name blank (via tmb_reonboard with an empty name choice).
-- The first-action chain must see the row + the config values and proceed
-- without re-applying defaults or re-asking.
-- Filename retained for backward compat; no first-run-onboarding ceremony exists
-- in the post-no-onboarding doctrine.

INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, NULL, datetime('now'), datetime('now'));

INSERT INTO plugin_config (key, value_json, updated_at) VALUES
  ('branching_model', '"github-flow"', datetime('now')),
  ('pr_target',       '"main"',         datetime('now')),
  ('protected_branches', '["main"]',    datetime('now'));

INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, created_at)
VALUES (
  0, NULL, 'bro', 'tmb_defaults_applied',
  'Test fixture — anonymous identity, github-flow.',
  datetime('now')
);
