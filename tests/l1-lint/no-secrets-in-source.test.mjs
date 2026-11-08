// L1 lint: scan tracked source (git ls-files, minus tests/fixtures/**, tests/*/fixtures/**, docs/**, this file and the allowlist) for high-confidence secret patterns: AWS access key IDs AKIA[0-9A-Z]{16}, GitHub personal tokens ghp_[A-Za-z0-9]{36}, GitHub fine-grained PATs github_pat_[A-Za-z0-9_]{22,}, PEM private key headers -----BEGIN [A-Z ]*PRIVATE KEY-----, and generic secret assignments (key/secret/token/password/api_key = or : a quoted literal of >= 20 chars). A hit containing a placeholder (xxx, example, dummy, <...>, ${...}, 0000) is dropped. Allowlist: tests/l1-lint/.no-secrets-allow — path:line-pattern, one entry per line, # comments; a finding is suppressed when its "file:line: matched-text" output contains both the path portion (before the first ':') and the pattern portion. Every run also seeds temp files with one instance of each pattern class and a placeholder, and asserts every class is caught and the placeholder is not.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF_REL = 'tests/l1-lint/no-secrets-in-source.test.mjs';
const ALLOW_REL = 'tests/l1-lint/.no-secrets-allow';
const PATTERNS = [
  /AKIA[0-9A-Z]{16}/y,
  /ghp_[A-Za-z0-9]{36}/y,
  /github_pat_[A-Za-z0-9_]{22,}/y,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/y,
  /(k(ey)?|secret|token|passw(or)?d|api_key)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/y,
];
const PLACEHOLDER = /(xxx|example|dummy|<[^>]*>|\$\{[^}]*\}|0000)/;
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

function allowEntries() {
  const path = join(ROOT, ALLOW_REL);
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

test('every pattern class is caught and a placeholder is not', () => {
  const tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-secrets-'));
  try {
    const seeds = {
      'AWS access key': ['aws.sh', `AWS_KEY=${'AKIA'}${'IOSFODNN7EXAMPLE'}\n`],
      'GitHub ghp_ token': ['ghp.sh', `token=${'ghp_'}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg123'}\n`],
      'GitHub fine-grained PAT': ['pat.sh', `pat=${'github_pat_'}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ1'}\n`],
      'PEM private key header': ['privkey.pem', `${'-----BEGIN RSA '}${'PRIVATE KEY-----'}\n`],
      'generic secret assignment': ['generic.sh', `${'api_key'}${' = "abcdefghijklmnopqrstuvwxyz12345"'}\n`],
    };
    for (const [label, [name, body]] of Object.entries(seeds)) {
      writeFileSync(join(tmp, name), body);
      const hits = readFileSync(join(tmp, name), 'utf8').split('\n').flatMap(grepSecret);
      assert.ok(hits.length, `FAIL self-test: pattern class [${label}] not caught`);
    }
    writeFileSync(join(tmp, 'placeholder.sh'), 'secret = "example"\n');
    const hits = readFileSync(join(tmp, 'placeholder.sh'), 'utf8').split('\n').flatMap(grepSecret);
    assert.ok(!hits.length || hits.some((h) => PLACEHOLDER.test(h)), 'FAIL self-test: placeholder line was incorrectly flagged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no secrets in tracked source', () => {
  const allow = allowEntries();
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  const findings = [];
  for (const rel of tracked) {
    if (rel === SELF_REL || rel === ALLOW_REL) continue;
    if (/^(tests\/fixtures\/|tests\/.*\/fixtures\/|docs\/)/.test(rel)) continue;
    const path = join(ROOT, rel);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    findings.push(...scanFile(rel, readFileSync(path, 'utf8'), allow));
  }
  assert.deepEqual(findings, [], `no-secrets-in-source: FAIL — ${findings.length} finding(s):\n${findings.map((f) => `  ${f}`).join('\n')}`);
});
