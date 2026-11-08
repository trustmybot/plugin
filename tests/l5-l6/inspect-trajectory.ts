// Inspect a debug_trajectory dump in the format L5 expects.
//
// Use this when authoring an expected-trajectory file for a new flow:
//   1. Run the flow once with TMB_DEBUG_TRAJECTORY=1
//   2. Run this script against the resulting DB
//   3. Copy the output to tests/l5-l6/expected/<flow>.txt
//
// Usage:
//   node --experimental-strip-types tests/l5-l6/inspect-trajectory.ts <project-dir>
//   node --experimental-strip-types tests/l5-l6/inspect-trajectory.ts "$TMPDIR/tmb-l5-run"
//   node --experimental-strip-types tests/l5-l6/inspect-trajectory.ts   # uses the working directory

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** .claude/tmb/, then the channel-isolated .claude/tmb-rc/, then any .claude/<dir>/ in name order. */
export function findDb(project: string): string | null {
  const claude = join(project, '.claude');
  const candidates = [join(claude, 'tmb', 'trajectory.db'), join(claude, 'tmb-rc', 'trajectory.db')];
  if (existsSync(claude)) {
    for (const name of readdirSync(claude).filter((n) => !n.startsWith('.')).sort()) candidates.push(join(claude, name, 'trajectory.db'));
  }
  return candidates.find(isFile) ?? null;
}

function readLines(dbPath: string): string[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT kind || ':' || tool_or_mcp_name AS line FROM debug_trajectory ORDER BY id").all();
    return rows.map((r) => (typeof r['line'] === 'string' ? r['line'] : ''));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function main(argv: readonly string[]): number {
  const project = argv[0] ?? process.cwd();
  const dbPath = findDb(project);
  if (dbPath === null) {
    process.stderr.write(`❌ no trajectory.db found under ${project}/.claude/\n`);
    return 1;
  }
  const lines = readLines(dbPath);
  if (lines.length === 0) {
    process.stderr.write('⊘ no debug_trajectory rows recorded.\n   Was TMB_DEBUG_TRAJECTORY=1 set when claude ran?\n');
    return 1;
  }
  process.stdout.write(
    [
      `# Trajectory from ${dbPath} (${lines.length} rows)`,
      '# Copy lines below into tests/l5-l6/expected/<flow>.txt',
      "# (Edit out any setup/teardown calls that aren't part of the flow under test.)",
      '',
      ...lines,
    ].join('\n') + '\n',
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
