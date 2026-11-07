// L1 lint: no "kuzu" (any case) in shipped prompt files. The world model moved from a kuzu graph to directory/file tables in the trajectory DB, so a prompt naming kuzu describes a store that no longer exists. Scans CLAUDE.md, agents/ and commands/ (depth 1) and every *.md under skills/. Allowlist: tests/l1-lint/no-kuzu-in-prompts.allowlist — <path><TAB><substring of the line><TAB><reason>; an entry with no reason or matching no hit fails. Every run also checks fixtures/kuzu-in-prompts/: every non-blank line of has-kuzu.md is a hit, clean.md has none, and allowlist.tsv suppresses exactly its one entry.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-kuzu-in-prompts.allowlist';
const FIXTURES = 'tests/l1-lint/fixtures/kuzu-in-prompts';

function lines(text) {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

function isFile(rel) {
  try {
    return statSync(join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

export function scan(allowlist, files) {
  const out = [];
  const allow = [];
  if (allowlist && isFile(allowlist)) {
    lines(readFileSync(join(ROOT, allowlist), 'utf8')).forEach((line, idx) => {
      if (line === '' || line.startsWith('#')) return;
      const [path, sub, ...rest] = line.replace(/^\t+/, '').split(/\t+/);
      const reason = rest.join('\t');
      if (!sub || !reason) {
        out.push(`ALLOWLIST ${allowlist}:${idx + 1}: needs <path><TAB><substring><TAB><reason>`);
        return;
      }
      allow.push({ path, sub, used: false });
    });
  }
  for (const f of files) {
    if (!isFile(f)) continue;
    lines(readFileSync(join(ROOT, f), 'utf8')).forEach((text, idx) => {
      if (!text.toLowerCase().includes('kuzu')) return;
      const hit = allow.find((a) => a.path === f && text.includes(a.sub));
      if (hit) {
        hit.used = true;
        return;
      }
      out.push(`${f}:${idx + 1}: ${text}`);
    });
  }
  for (const a of allow) if (!a.used) out.push(`ALLOWLIST ${allowlist}: stale entry (no hit): ${a.path}\t${a.sub}`);
  return out;
}

function mdFiles(dir, depth, out) {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory() && depth !== 1) mdFiles(rel, depth, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

const BAD = `${FIXTURES}/has-kuzu.md`;
const expected = lines(readFileSync(join(ROOT, BAD), 'utf8')).filter((l) => l !== '').length;

test('fixture has-kuzu.md: every non-blank line is a hit', () => {
  const out = scan(null, [BAD]);
  assert.equal(out.filter((l) => l.startsWith(`${BAD}:`)).length, expected, `no-kuzu-in-prompts self-test: expected ${expected} hits in has-kuzu.md, got:\n${out.join('\n')}`);
});

test('fixture clean.md: no hits', () => {
  const out = scan(null, [`${FIXTURES}/clean.md`]);
  assert.deepEqual(out, [], `no-kuzu-in-prompts self-test: false positives in clean.md:\n${out.join('\n')}`);
});

test('fixture allowlist.tsv suppresses exactly one hit', () => {
  const out = scan(`${FIXTURES}/allowlist.tsv`, [BAD]);
  const ok = out.filter((l) => l.startsWith(`${BAD}:`)).length === expected - 1 && !out.some((l) => l.startsWith('ALLOWLIST'));
  assert.ok(ok, `no-kuzu-in-prompts self-test: allowlist.tsv should suppress exactly one hit, got:\n${out.join('\n')}`);
});

test('no kuzu in prompts', () => {
  const files = [];
  if (isFile('CLAUDE.md')) files.push('CLAUDE.md');
  files.push(...[...mdFiles('agents', 1, []), ...mdFiles('commands', 1, [])].sort());
  files.push(...mdFiles('skills', 0, []).sort());
  const out = scan(ALLOWLIST, files);
  assert.deepEqual(out, [], `No-kuzu-in-prompts: FAIL — prompts name kuzu; the world model is directory/file tables in the trajectory DB, built by /scan:\n${out.join('\n')}`);
});
