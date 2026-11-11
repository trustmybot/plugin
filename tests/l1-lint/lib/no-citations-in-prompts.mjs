// Rules and scope of the no-citations-in-prompts L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CITATION = /\((#|GL #|MR !|PR !)[0-9]+\)/;
const TOP_LEVEL = ['CLAUDE.md'];

const isFile = (abs) => existsSync(abs) && statSync(abs).isFile();

export function citationLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.flatMap((line, i) => (CITATION.test(line) ? [i + 1] : []));
}

export const message = (rel, n) => `${rel}:${n}: citation in prompt`;

function mdInDir(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith('.md') && isFile(join(abs, name)))
    .sort()
    .map((name) => `${rel}/${name}`);
}

function skillFiles(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) skillFiles(root, child, out);
    else if (entry.name === 'SKILL.md' && isFile(join(root, child))) out.push(child);
  }
  return out;
}

export function files(root) {
  return [
    ...mdInDir(root, 'agents'),
    ...mdInDir(root, 'commands'),
    ...mdInDir(root, 'templates/agents'),
    ...skillFiles(root, 'skills', []),
    ...TOP_LEVEL.filter((name) => isFile(join(root, name))),
  ];
}

export function scope() {
  return (rel) =>
    TOP_LEVEL.includes(rel) ||
    (rel.endsWith('.md') && /^(agents|commands|templates\/agents)\/[^/]+$/.test(rel)) ||
    (rel.startsWith('skills/') && rel.endsWith('/SKILL.md'));
}

export function citationProblems(root) {
  return files(root).flatMap((rel) => citationLines(readFileSync(join(root, rel), 'utf8')).map((n) => message(rel, n)));
}
