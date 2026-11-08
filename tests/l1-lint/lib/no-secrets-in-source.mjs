// Rules, allowlist and scope of the no-secrets-in-source L1 lint, shared by its whole-tree test and file-lint.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SELF_REL = 'tests/l1-lint/no-secrets-in-source.test.mjs';
const ALLOW_REL = 'tests/l1-lint/.no-secrets-allow';
const PATTERNS = [
  /AKIA[0-9A-Z]{16}/y,
  /ghp_[A-Za-z0-9]{36}/y,
  /github_pat_[A-Za-z0-9_]{22,}/y,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/y,
  /(k(ey)?|secret|token|passw(or)?d|api_key)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/y,
];
export const PLACEHOLDER = /(xxx|example|dummy|<[^>]*>|\$\{[^}]*\}|0000)/;
const PREFILTER = /AKIA|ghp_|github_pat_|PRIVATE KEY|secret|token|passw|api_key|key/;

export function grepSecret(line) {
  const hits = [];
  let i = 0;
  while (i < line.length) {
    let best = 0;
    for (const re of PATTERNS) {
      re.lastIndex = i;
      const m = re.exec(line);
      if (m && m[0].length > best) best = m[0].length;
    }
    if (best) {
      hits.push(line.slice(i, i + best));
      i += best;
    } else i++;
  }
  return hits;
}

export function allowEntries(root = ROOT) {
  const path = join(root, ALLOW_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((e) => e !== '' && !e.startsWith('#'))
    .map((e) => {
      const c = e.indexOf(':');
      return c < 0 ? [e, e] : [e.slice(0, c), e.slice(c + 1)];
    });
}

export function scanFile(rel, text, allow) {
  const findings = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, idx) => {
    if (!PREFILTER.test(line)) return;
    const hit = grepSecret(line).find((h) => !PLACEHOLDER.test(h));
    if (hit === undefined) return;
    const finding = `${rel}:${idx + 1}: ${hit}`;
    if (allow.some(([p, l]) => finding.includes(p) && finding.includes(l))) return;
    findings.push(finding);
  });
  return findings;
}

export function scope() {
  return (rel) => rel !== SELF_REL && rel !== ALLOW_REL && !/^(tests\/fixtures\/|tests\/.*\/fixtures\/|docs\/)/.test(rel);
}

export function trackedFiles(root = ROOT) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
}
