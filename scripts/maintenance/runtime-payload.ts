// Prunes a checkout to the plugin's runtime payload: every tracked path outside
// the allowlist leaves the index and the working tree. Run by dev-build.yml
// before the build commit; `--check` lists offenders and exits 1 instead.
//
//   node --experimental-strip-types scripts/maintenance/runtime-payload.ts [--root <dir>] [--check]

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const KEPT_DIRS: readonly string[] = [
  '.claude-plugin/',
  '.codex-plugin/',
  '.cursor-plugin/',
  '.agents/',
  '.opencode/',
  '.github/',
  'adapters/',
  'agents/',
  'commands/',
  'hooks/',
  'scripts/',
  'skills/',
  'templates/',
  'dashboard/dist/',
];

const KEPT_FILES: ReadonlySet<string> = new Set([
  'gemini-extension.json',
  '.mcp.json',
  'CLAUDE.md',
  'CODEX.md',
  'CURSOR.md',
  'GEMINI.md',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
]);

const KEPT_MCP = /^mcp\/[^/]+\/(?:package\.json$|runtime-deps\/|dist\/)/;
const EXCLUDED = [/^mcp\/[^/]+\/dist\/test\//, /\.map$/];

function isRuntimePath(path: string): boolean {
  if (EXCLUDED.some((re) => re.test(path))) return false;
  if (KEPT_FILES.has(path)) return true;
  if (KEPT_DIRS.some((dir) => path.startsWith(dir))) return true;
  return KEPT_MCP.test(path);
}

function git(root: string, args: string[], input?: string): string {
  const r = spawnSync('git', ['-C', root, ...args], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(`runtime-payload: git ${args.join(' ')} failed: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
}

function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '-z']).split('\0').filter((p) => p !== '');
}

function removeEmptyParents(root: string, path: string): void {
  let dir = dirname(join(root, path));
  while (dir.startsWith(root + '/') && dir !== root) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

function sizeOf(root: string, path: string): number {
  try {
    return statSync(join(root, path)).size;
  } catch {
    return 0;
  }
}

function parseArgs(argv: string[]): { root: string; check: boolean } {
  let root = '';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root' && i + 1 < argv.length) root = argv[++i] ?? '';
    else {
      process.stderr.write(`runtime-payload: unknown argument ${a}\nusage: runtime-payload.ts [--root <dir>] [--check]\n`);
      process.exit(2);
    }
  }
  const top = git(resolve(root || '.'), ['rev-parse', '--show-toplevel']).trim();
  return { root: top, check };
}

function main(): void {
  const { root, check } = parseArgs(process.argv.slice(2));
  const files = trackedFiles(root);
  const kept = files.filter(isRuntimePath);
  const removed = files.filter((p) => !isRuntimePath(p));

  if (check) {
    if (removed.length === 0) {
      process.stdout.write(`runtime-payload: ${kept.length} tracked files, all in the runtime allowlist\n`);
      return;
    }
    process.stdout.write(`runtime-payload: ${removed.length} tracked paths outside the runtime allowlist:\n`);
    for (const p of removed) process.stdout.write(`  ${p}\n`);
    process.exit(1);
  }

  if (removed.length > 0) {
    git(root, ['rm', '-q', '--cached', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], removed.join('\0') + '\0');
    for (const p of removed) {
      rmSync(join(root, p), { force: true });
      removeEmptyParents(root, p);
    }
  }
  const bytes = kept.reduce((sum, p) => sum + sizeOf(root, p), 0);
  process.stdout.write(
    `runtime-payload: kept ${kept.length} files, removed ${removed.length}; payload ${(bytes / 1024 / 1024).toFixed(1)} MB\n`,
  );
}

main();
