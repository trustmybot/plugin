// Local-shape onboarding seed. onboarding-named.sql already seeds identity +
// deep_scan_completed audit; this script ensures plugin_config defaults are
// explicit (idempotent INSERTs that the schema may or may not auto-apply).
import { setupArgs, sql } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
sql(
  project,
  `INSERT OR REPLACE INTO plugin_config (key, value_json)
VALUES
  ('branching_model', '"github-flow"'),
  ('pr_target',       '"main"'),
  ('protected_branches', '["main"]'),
  ('remotes',         '[]'),
  ('issue_sync',      '"off"');`,
);
