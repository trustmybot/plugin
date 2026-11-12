// Shared roundtable-panel seed for the 13-roundtable scenario.
//
// Used by BOTH suites so L5 and L6 convene the identical panel:
//   - L5: setup-l5.ts imports seedAgents to build the whole shape from scratch.
//   - L6: the step-11 chain_setup_command runs this file to add the panel on top
//         of cumulative chain state (step 10 already created cto for real).
//
// Panel = cto + data-engineer, both from this row's prompt files, so the panel
// is the same whatever step 10's /tmb:agent-create drafted. Idempotent: copies
// overwrite, INSERT OR REPLACE.
// Standalone: seed-agents.ts <project_dir>
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../../../lib/setup-helpers.ts';

export function seedAgents(project: string): void {
  const agents = join(project, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const name of ['cto', 'data-engineer']) copyFileSync(join(import.meta.dirname, `${name}.md`), join(agents, `${name}.md`));
  sql(
    project,
    `INSERT OR REPLACE INTO agents (name, kind, file_path, created_at)
VALUES
  ('cto',           'consultant', 'project:.claude/agents/cto.md',           datetime('now')),
  ('data-engineer', 'consultant', 'project:.claude/agents/data-engineer.md', datetime('now'));`,
  );
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  const project = process.argv[2];
  if (project === undefined || project === '') {
    process.stderr.write('usage: seed-agents.ts <project_dir>\n');
    process.exit(2);
  }
  seedAgents(project);
}
