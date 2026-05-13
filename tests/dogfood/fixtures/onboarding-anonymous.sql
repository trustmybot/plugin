-- Onboarded state — identical to onboarding-named.sql now that bro doesn't
-- store user names. Filename retained for backward compat with flows that
-- still reference it (e.g., 95-anonymous-cold-restart, which now exercises
-- the same onboarded-marker invariant: row presence suppresses auto-fire).
INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');

-- Pre-clear the registry-cold gate (see onboarding-named.sql for rationale).
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'L5/L6 fixture: gate cleared', '{}', datetime('now'));
