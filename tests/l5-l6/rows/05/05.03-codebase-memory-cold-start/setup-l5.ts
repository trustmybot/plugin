// Seed an existing-repo state: identity exists (so onboarding doesn't fire),
// git ls-files non-empty (so cold-start trigger fires), world model cold: the
// onboarding-named fixture's deep_scan_completed audit row is dropped so the
// world-model-cold gate genuinely fires.
import { gitCommit, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
sql(
  project,
  `DELETE FROM audit_embeddings WHERE audit_id IN (SELECT id FROM audit WHERE event_type = 'deep_scan_completed');
   DELETE FROM audit WHERE event_type='deep_scan_completed';`,
);
writeFile(project, 'src/existing.py', '# placeholder\n');
gitCommit(project, ['.'], 'seed existing files');
