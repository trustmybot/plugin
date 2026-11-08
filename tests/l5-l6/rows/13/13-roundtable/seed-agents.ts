// Shared roundtable-panel seed for the 13-roundtable scenario.
//
// Used by BOTH suites so L5 and L6 convene the identical panel:
//   - L5: setup-l5.ts imports seedAgents to build the whole shape from scratch.
//   - L6: the step-11 chain_setup_command runs this file to add the panel on top
//         of cumulative chain state (step 10 already created cto for real).
//
// Panel = cto (templated, mirrors step 10's /tmb:agent-create) + data-engineer
// (from-scratch consultant). Idempotent: copies overwrite, INSERT OR REPLACE.
// Standalone: seed-agents.ts <project_dir> [plugin_root]
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, sql } from '../../../lib/setup-helpers.ts';

export function seedAgents(project: string, pluginRoot: string = PLUGIN_ROOT): void {
  const agents = join(project, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  copyFileSync(join(pluginRoot, 'templates', 'agents', 'cto.md'), join(agents, 'cto.md'));
  copyFileSync(join(import.meta.dirname, 'data-engineer.md'), join(agents, 'data-engineer.md'));
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
    process.stderr.write('usage: seed-agents.ts <project_dir> [plugin_root]\n');
    process.exit(2);
  }
  seedAgents(project, process.argv[3] || process.env.PLUGIN_ROOT || PLUGIN_ROOT);
}
