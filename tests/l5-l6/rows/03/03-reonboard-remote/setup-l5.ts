// Reonboard scenario starts from local-shape state. The post-AUQ remote-shape
// flip is the chain-bridge between this row and row 4 in L6 (handled by the
// chain manifest's between-row seed), not applied here in L5. The local-shape
// plugin_config baseline makes onboard_state_get see first_run=false (identity
// exists from the fixture).
import { setupArgs, sql } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
sql(
  project,
  `INSERT OR REPLACE INTO plugin_config (key, value_json)
VALUES
  ('branching_model', '"github-flow"'),
  ('pr_target',       '"main"'),
  ('remotes',         '[]');`,
);
