-- Between-row seed: post-AUQ state of row 3 (reonboard to remote/gitflow).
-- Flips plugin_config from local-shape values (set by after-01 seed) to
-- remote-shape values so downstream rows see GitLab + gitflow.

INSERT OR REPLACE INTO plugin_config (key, value_json)
VALUES
  ('branching_model',    '"gitflow"'),
  ('pr_target',          '"dev"'),
  ('protected_branches', '["main","dev"]'),
  ('remotes',            '[{"name":"origin","provider":"gitlab","slug":"test-org/todo-cli"}]'),
  ('issue_sync',         '"auto"');
