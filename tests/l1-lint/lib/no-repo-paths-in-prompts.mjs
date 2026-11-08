// Rules and scope of the no-repo-paths-in-prompts L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_PATH = /mcp\/trajectory-server|scripts\/hooks\/|scripts\/maintenance\/|changelog\.d|tests\/l[0-9]|regen-generated|dist-fresh|docs\/architecture/;
const ALLOW = /CLAUDE_PLUGIN_ROOT|\.claude\/tmb\/|plugin cache/;

const isFile = (abs) => existsSync(abs) && statSync(abs).isFile();

export function findingsInText(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.flatMap((line, i) => (REPO_PATH.test(line) && !ALLOW.test(line) ? [i + 1] : []));
}

export const message = (rel, n) => `${rel}:${n}: repository path in prompt`;

function mdFiles(root, rel, recursive, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive) mdFiles(root, child, recursive, out);
    } else if (entry.name.endsWith('.md') && isFile(join(root, child))) out.push(child);
  }
  return out;
}

export function files(root) {
  return [
    ...mdFiles(root, 'agents', false, []),
    ...mdFiles(root, 'commands', false, []),
    ...mdFiles(root, 'templates/agents', false, []),
    ...mdFiles(root, 'skills', true, []),
  ];
}

export function scope() {
  return (rel) => rel.endsWith('.md') && (/^(agents|commands|templates\/agents)\/[^/]+$/.test(rel) || rel.startsWith('skills/'));
}

export function repoPathProblems(root) {
  return files(root).flatMap((rel) => findingsInText(readFileSync(join(root, rel), 'utf8')).map((n) => message(rel, n)));
}
