// L1 lint: TMB writes nothing under the user's home directory. Project state (trajectory DB, logs, locks, session markers, the headless shim) lives under <project>/.claude/<plugin>/; the only path outside the project is the embedding model cache, declared once as TMB_MODEL_CACHE_DIR. Scans scripts/, skills/*/scripts/ and the L5/L6 runners + their libs under tests/l5-l6/ (shell, *.sh) and mcp/trajectory-server/src/ (TypeScript, tests excluded). A line is a violation when it writes and its target references the home directory — directly ($HOME, ${HOME}, ~/, homedir(), process.env.HOME) or through a variable assigned from one in the same file. Shell writes: > / >> redirects (target), mkdir, tee, touch (any arg), cp, mv, ln, install (last arg). TS writes: writeFileSync, mkdirSync, appendFileSync, cpSync, renameSync, symlinkSync, writeFile, mkdir, appendFile. TS taint also covers a `homeDir` parameter and functions that return a home-rooted path. Lines naming TMB_MODEL_CACHE_DIR are allowed; comment lines are skipped. Allowlist: tests/l1-lint/no-home-writes.allowlist — repo-relative paths of Human-run tools whose job is repairing Claude Code's own config; nothing a hook or the server runs may be listed. Every run also checks fixtures/no-home-writes/.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = 'tests/l1-lint/fixtures/no-home-writes';
const ALLOWLIST = 'tests/l1-lint/no-home-writes.allowlist';
const HOME_SH = /\$\{?HOME\b\}?|(?:^|[\s"=:(])~\//;
const HOME_TS = /\bhomedir\s*\(\s*\)|process\.env(?:\.HOME\b|\[\s*["']HOME["']\s*\])/;
const COMMENT = /^\s*(#|\/\/|\*)/;
const TS_WRITE = /\b(?:writeFileSync|mkdirSync|appendFileSync|cpSync|renameSync|symlinkSync|writeFile|mkdir|appendFile)\s*\(([^;]*)/g;
const SH_REDIRECT = /(?<![0-9&<>])>>?\s*("[^"]*"|'[^']*'|[^\s;|&)]+)/g;

function rawLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function scan(files) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const ts = file.endsWith('.ts');
    const lines = rawLines(text).map((l) => l.replace(ts ? /\s+\/\/\s.*(?=\n?$)/ : /\s+#\s.*(?=\n?$)/, ''));
    const home = ts ? HOME_TS : HOME_SH;
    const taint = new Set();
    const mentions = (s, t) => (ts ? new RegExp(String.raw`\b${t}\b`) : new RegExp(String.raw`\$\{?${t}\b`)).test(s);
    if (ts) {
      taint.add('homeDir');
      let fn;
      for (const l of lines) {
        const m = /\bfunction\s+([A-Za-z_]\w*)\s*\(/.exec(l);
        if (m) fn = m[1];
        if (fn !== undefined && /\breturn\b/.test(l) && home.test(l) && !l.includes('TMB_MODEL_CACHE_DIR')) taint.add(fn);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of lines) {
        if (COMMENT.test(l) || l.includes('TMB_MODEL_CACHE_DIR')) continue;
        const m = ts
          ? /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.*)/.exec(l)
          : /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(.*)/.exec(l);
        if (!m) continue;
        const [, name, rhs] = m;
        if (taint.has(name)) continue;
        if (ts && /\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|JSON\.parse)\b/.test(rhs)) continue;
        if (!ts && /\$\((?!\s*dirname\b)/.test(rhs)) continue;
        if (home.test(rhs) || [...taint].some((t) => mentions(rhs, t))) {
          taint.add(name);
          changed = true;
        }
      }
    }
    const refs = (s) => home.test(s) || [...taint].some((t) => mentions(s, t));
    lines.forEach((l, idx) => {
      if (COMMENT.test(l) || l.includes('TMB_MODEL_CACHE_DIR')) return;
      let bad = false;
      if (ts) {
        for (const m of l.matchAll(TS_WRITE)) if (refs(m[1])) bad = true;
      } else {
        for (const m of l.matchAll(SH_REDIRECT)) {
          if (/^\/dev\/null$|^&/.test(m[1])) continue;
          if (refs(m[1])) bad = true;
        }
        for (const seg of l.split(/&&|\|\||;|\|/)) {
          const w = /(?:^|\s)(mkdir|tee|touch)\s+(.*)/.exec(seg);
          if (w) {
            if (refs(w[2])) bad = true;
            continue;
          }
          const c = /(?:^|\s)(cp|mv|ln|install)\s+(.*)/.exec(seg);
          if (c) {
            const args = c[2].split(/\s+/).filter((a) => a !== '' && !a.startsWith('-') && !/^\d*>/.test(a));
            if (args.length && refs(args.at(-1))) bad = true;
          }
        }
      }
      if (bad) out.push(`${file}:${idx + 1}: ${l.replace(/\n$/, '').replace(/^\s+/, '')}`);
    });
  }
  return out;
}

function find(dir, match, out, depth = Infinity) {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth > 1) find(rel, match, out, depth - 1);
    } else if (entry.isFile() && match(rel)) out.push(rel);
  }
  return out;
}

function countViolations(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => l.includes('VIOLATION')).length;
}

test('fixtures bad.sh and bad.ts: every VIOLATION line is reported', () => {
  const bad = scan([`${FIXTURES}/bad.sh`, `${FIXTURES}/bad.ts`]);
  const expected = countViolations(`${FIXTURES}/bad.sh`) + countViolations(`${FIXTURES}/bad.ts`);
  assert.equal(bad.length, expected, `no-home-writes self-test: expected ${expected} violations in bad fixtures, got ${bad.length}\n${bad.join('\n')}`);
});

test('fixtures good.sh and good.ts: no violations', () => {
  const good = scan([`${FIXTURES}/good.sh`, `${FIXTURES}/good.ts`]);
  assert.deepEqual(good, [], `no-home-writes self-test: false positives in good fixtures:\n${good.join('\n')}`);
});

test('no writes under the home directory', () => {
  const allowed = new Set(
    existsSync(join(ROOT, ALLOWLIST))
      ? readFileSync(join(ROOT, ALLOWLIST), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
      : [],
  );
  const sh = (rel) => rel.endsWith('.sh');
  const skillScripts = existsSync(join(ROOT, 'skills'))
    ? readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .flatMap((e) => find(`skills/${e.name}/scripts`, sh, []))
    : [];
  const files = [
    ...[...find('scripts', sh, []), ...skillScripts].sort(),
    ...[...find('tests/l5-l6', sh, [], 1), ...find('tests/l5-l6/lib', sh, [], 1)].sort(),
    ...find('mcp/trajectory-server/src', (rel) => rel.endsWith('.ts') && !rel.includes('/test/'), []).sort(),
  ].filter((f) => !allowed.has(f));
  const out = scan(files);
  assert.deepEqual(out, [], `No-home-writes: FAIL — writes under the home directory (project state belongs in <project>/.claude/<plugin>/):\n${out.join('\n')}`);
});
