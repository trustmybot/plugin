-- Reonboard completed: identity set to "Test User" + defaults persisted.
-- Use this fixture for any flow that needs a clean post-configuration state
-- where bro knows the user's name and policy keys are set.
-- Filename retained for backward compat; no first-run-onboarding ceremony exists
-- in the post-no-onboarding doctrine.

-- plugin_config is schema-seeded — fixture only adds the identity row
-- and a synthetic "system" issue (id=999999) so headless-recovery writes
-- (audit_log + discussion_append, per `tmb_recovery §A`) have a parent
-- issue to attach to. Without it, the audit/discussions FK rejects every
-- system-level event in a fresh project, breaking flow 32 (config-change
-- routing) and any other flow that depends on the recovery doctrine.
--
-- High id (999999) keeps it clear of normal flow seeds — flows 06, 08,
-- and others insert issues at id=1, so a low system id would collide.

INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, 'Test User', datetime('now'), datetime('now'));

INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (999999, 'system', 'parent issue for headless-recovery / system-level audit and discussion events', 'open', datetime('now'), datetime('now'));
