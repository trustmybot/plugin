-- Between-row seed: post-AUQ state of row 1 (cold-start onboard). Without
-- this seed the chain can't progress because row 2+ require an onboarded
-- project (plugin_config defaults + scan-completed audit).
--
-- This mirrors fixtures/onboarding-named.sql but is applied AFTER row 1
-- ran rather than seeded as the initial fixture.

INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');

INSERT OR REPLACE INTO plugin_config (key, value_json)
VALUES
  ('branching_model',    '"github-flow"'),
  ('pr_target',          '"main"'),
  ('protected_branches', '["main"]'),
  ('remotes',            '[]'),
  ('issue_sync',         '"off"');

INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
VALUES (-1, NULL, 'bro', 'deep_scan_completed', 'L6 chain bridge: row 1 → 2 (post-AUQ seed)', '{}', datetime('now'));
