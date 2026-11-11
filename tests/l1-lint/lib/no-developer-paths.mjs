// Rules and scope of the no-developer-paths L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEV_PATH = /\/Users\/[A-Za-z][A-Za-z0-9_-]*\/|\/home\/[a-z][a-z0-9_-]*\/|\/Volumes\/[A-Za-z]|C:\\Users\\[A-Za-z]/;
const ALLOWLIST = ['tests/l1-lint/fixtures/', 'tests/l5-l6/fixtures/', 'templates/docs-trustmybot/snapshots/', 'CHANGELOG.md'];
const SCAN_TARGETS = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'SECURITY.md', 'docs', 'agents', 'skills', 'commands', 'templates'];

function walk(abs, out) {
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child, out);
      else if (entry.isFile()) out.push(child);
    }
  } else out.push(abs);
}

export function matchingLines(file) {
  const buf = readFileSync(file);
  if (buf.includes(0)) return [];
  const lines = buf.toString('utf8').split('\n');
  return lines.flatMap((line, i) => (DEV_PATH.test(line) ? [i + 1] : []));
}

export const message = (rel, n) => `${rel}:${n}: hardcoded developer path`;

export function scope() {
  return (rel) => SCAN_TARGETS.some((t) => rel === t || rel.startsWith(`${t}/`)) && !ALLOWLIST.some((p) => rel.startsWith(p));
}

export function files(root) {
  const all = [];
  for (const target of SCAN_TARGETS) {
    const abs = join(root, target);
    if (existsSync(abs)) walk(abs, all);
  }
  return all.map((f) => f.slice(root.length + 1)).filter((rel) => !ALLOWLIST.some((p) => rel.startsWith(p)));
}
