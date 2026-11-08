/**
 * `cli.js hook-lib <mode>` (GH 1692): the hook-lib answers the codex-owned
 * L5/L6 shell harness still asks for, through the sourced shims
 * scripts/hooks/lib/query-task.sh and resolve-install.sh.
 *   db-path              dbPath(env) on stdout; exit 1 and no stdout when no DB resolves
 *   install-plugin-name  installPluginName(env) on stdout
 * Exit 2 on a missing or unknown mode.
 */
import { dbPath } from '../hooks/lib/db.js';
import { installPluginName } from '../hooks/lib/install.js';
import type { CliIo } from './fallback-db.js';

const USAGE = 'usage: cli.js hook-lib <db-path|install-plugin-name>\n';

export function hookLib(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): number {
  const [mode] = argv;
  if (mode === 'db-path') {
    const db = dbPath(env, (line) => io.err(`${line}\n`));
    if (db === null) return 1;
    io.out(`${db}\n`);
    return 0;
  }
  if (mode === 'install-plugin-name') {
    io.out(`${installPluginName(env)}\n`);
    return 0;
  }
  io.err(mode === undefined ? USAGE : `hook-lib: unknown mode '${mode}'\n${USAGE}`);
  return 2;
}
