// Onboarded but no /scan has run — simulate the production state where
// bro tried to dispatch tasks against an empty world model.
//
// Bro is asked to "make a todo CLI by Python in src/cli.py with tests in
// tests/test_cli.py" — a full feature ask. The gate response is the
// load-bearing check (deep_scan_completed audit + task created). Bro
// typically continues to dispatch SWE + atomic-close in the same turn;
// step 05 owns its own dispatch assertion.
//
// Drops the fixture-seeded deep_scan_completed audit row so the gate fires, and
// scaffolds src/ + tests/ so /scan has something to discover. Without the
// scaffold, bro's /scan would correctly find nothing and the gate would still fire.
import { gitCommit, setupArgs, sql, writeFile } from '../../../lib/setup-helpers.ts';

const { project } = setupArgs(import.meta.dirname);
sql(
  project,
  `DELETE FROM audit_embeddings WHERE audit_id IN (SELECT id FROM audit WHERE event_type = 'deep_scan_completed');
   DELETE FROM audit WHERE event_type='deep_scan_completed';`,
);
writeFile(project, 'src/__init__.py', '"""src package — SWE lands cli.py here."""\n');
writeFile(project, 'tests/__init__.py', '"""tests package."""\n');
gitCommit(project, ['src/__init__.py', 'tests/__init__.py'], 'feat: scaffold src/ + tests/');
