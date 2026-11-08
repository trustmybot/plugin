// Checks that HEAD's tree holds every generated path a reference ref holds, so a
// payload built in CI ships no less than the one it replaces (GH 2054). Run by
// dev-build.yml's dry run against origin/dev-build.
//
//   node --experimental-strip-types scripts/maintenance/payload-parity.ts --ref <ref> [--root <dir>]
//
// Exit 0: every generated path under <ref> is in HEAD. Exit 1: some are missing
// (listed), or HEAD holds no generated file. Exit 2: usage or git error.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATED_PATHS: readonly string[] = [
  'mcp/trajectory-server/dist/',
  'dashboard/dist/',
  'scripts/hooks/lib/audit-events.txt',
  'scripts/hooks/lib/data-contracts.json',
];

function git(root: string, args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(`payload-parity: git ${args.join(' ')} failed: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
}

function generatedFiles(root: string, treeish: string): Set<string> {
  const out = git(root, ['ls-tree', '-r', '--name-only', '-z', treeish, '--', ...GENERATED_PATHS]);
  return new Set(out.split('\0').filter((p) => p !== ''));
}

function parseArgs(argv: string[]): { root: string; ref: string } {
  let root = '';
  let ref = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref' && i + 1 < argv.length) ref = argv[++i] ?? '';
    else if (a === '--root' && i + 1 < argv.length) root = argv[++i] ?? '';
    else {
      process.stderr.write(`payload-parity: unknown argument ${a}\nusage: payload-parity.ts --ref <ref> [--root <dir>]\n`);
      process.exit(2);
    }
  }
  if (ref === '') {
    process.stderr.write('payload-parity: --ref is required\nusage: payload-parity.ts --ref <ref> [--root <dir>]\n');
    process.exit(2);
  }
  return { root: git(resolve(root || '.'), ['rev-parse', '--show-toplevel']).trim(), ref };
}

function main(): void {
  const { root, ref } = parseArgs(process.argv.slice(2));
  const refTree = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]).trim();
  const head = generatedFiles(root, 'HEAD');
  if (head.size === 0) {
    process.stdout.write('payload-parity: HEAD holds no generated file\n');
    process.exit(1);
  }
  const missing = [...generatedFiles(root, refTree)].filter((p) => !head.has(p)).sort();
  if (missing.length > 0) {
    process.stdout.write(`payload-parity: ${missing.length} generated paths in ${ref} are missing from HEAD:\n`);
    for (const p of missing) process.stdout.write(`  ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`payload-parity: HEAD holds all generated paths of ${ref} (${head.size} generated files)\n`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
