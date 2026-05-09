-- Defaults applied + the user explicitly created an identity row but left
-- the name blank (via the /onboard slash command with an empty name choice).
-- The first-action chain must see the row + the config values and proceed
-- without re-applying defaults or re-asking.
-- Filename retained for backward compat; no first-run-onboarding ceremony exists
-- in the post-no-onboarding doctrine.

-- plugin_config is schema-seeded — fixture only adds the deliberately-blank identity row.
INSERT INTO identity (id, human_name, created_at, updated_at)
VALUES (1, NULL, datetime('now'), datetime('now'));
