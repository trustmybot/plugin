-- Between-row seed: post-AUQ state of row 1 (cold-start onboard). Without
-- this seed the chain can't progress because row 2+ require an onboarded
-- project (identity row + plugin_config defaults + scan-completed audit).
--
-- This mirrors fixtures/onboarding-named.sql but is applied AFTER row 1
-- ran rather than seeded as the initial fixture.

INSERT OR IGNORE INTO identity (id, created_at, updated_at)
VALUES (1, datetime('now'), datetime('now'));

INSERT OR REPLACE INTO plugin_config (key, value_json, updated_at)
VALUES
  ('branching_model',    '"github-flow"', datetime('now')),
  ('pr_target',          '"main"',        datetime('now')),
  ('protected_branches', '["main"]',      datetime('now')),
  ('remotes',            '[]',            datetime('now')),
  ('issue_sync',         '"off"',         datetime('now'));

INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary, content_json, created_at)
VALUES (999999, NULL, 'bro', 'event', 'deep_scan_completed', 'L6 chain bridge: row 1 → 2 (post-AUQ seed)', '{}', datetime('now'));
