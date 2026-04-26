-- Reonboard completed: identity set to "Test User" + defaults persisted.
-- Use this fixture for any flow that needs a clean post-configuration state
-- where bro knows the user's name and policy keys are set.
-- Filename retained for backward compat; no first-run-onboarding ceremony exists
-- in the post-no-onboarding doctrine.

-- plugin_config is schema-seeded — fixture only adds the identity row + ledger marker.
INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, 'Test User', datetime('now'), datetime('now'));

INSERT INTO ledger (issue_id, branch_id, from_node, event_type, summary, created_at)
VALUES (
  0, NULL, 'bro', 'tmb_user_named',
  'Test fixture — identity Test User set via tmb_reonboard.',
  datetime('now')
);
