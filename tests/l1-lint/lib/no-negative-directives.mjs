// Rules and scope of the warn-only no-negative-directives L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function walk(dir, keep, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) walk(child, keep, out);
    else if (keep(entry.name)) out.push(child);
  }
}

function stripMarkers(line) {
  let s = line.replace(/^ */, '');
  for (const prefix of ['- ', '* ', '+ ', '> ', '- ']) if (s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}

export function classify(line) {
  if (line.includes('<!-- LOAD-BEARING-SAFETY:')) return null;
  const s = stripMarkers(line);
  if (s.startsWith("Don't ")) return ['WARN', "start-of-line Don't"];
  if (s.startsWith("DON'T ")) return ['WARN', "start-of-line DON'T"];
  if (s.startsWith('Do not ') || s.startsWith('do not ')) return ['WARN', 'start-of-line do not'];
  if (/\bnever\b/i.test(line)) return ['WARN', 'never'];
  if (/(MUST NOT|must not)/.test(line)) return ['WARN', 'MUST NOT / must not'];
  if (/\bdo not\b/i.test(line)) return ['WARN', 'mid-sentence do not'];
  if (/\bdon't\b/i.test(line)) return ['INFO', "mid-sentence don't"];
  return null;
}

export function findings(file, rel) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  lines.forEach((line, i) => {
    const hit = classify(line);
    if (hit) out.push(`${rel}:${i + 1}: [${hit[0]}] ${hit[1]}`);
  });
  return out;
}

export function files(root = ROOT) {
  const out = [join(root, 'CLAUDE.md')];
  walk(join(root, 'skills'), (name) => name === 'SKILL.md', out);
  walk(join(root, 'agents'), (name) => name.endsWith('.md'), out);
  walk(join(root, 'templates', 'agents'), (name) => name.endsWith('.md'), out);
  return out;
}

export function scope() {
  return (rel) =>
    rel === 'CLAUDE.md' ||
    (rel.startsWith('skills/') && rel.endsWith('/SKILL.md')) ||
    (/^(agents|templates\/agents)\//.test(rel) && rel.endsWith('.md'));
}
