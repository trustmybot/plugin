-- Onboarded state — identical to onboarding-named.sql now that bro doesn't
-- store user names. Filename retained for backward compat with flows that
-- still reference it (e.g., 95-anonymous-cold-restart, which now exercises
-- the same onboarded-marker invariant: row presence suppresses auto-fire).
INSERT INTO identity (id, created_at, updated_at)
VALUES (1, datetime('now'), datetime('now'));
