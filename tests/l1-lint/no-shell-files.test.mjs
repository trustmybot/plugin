// L1 lint: no tracked shell file (*.sh, *.bash) outside tests/l1-lint/no-shell-files.allowlist (GH 2662). TMB ships TypeScript, not shell (GH 1692), and the shell-scanning lints were retired with the last shell they covered, so a new shell file would go unchecked. Allowlist entries are `<repo-relative path>  # <reason>`; an entry without a reason, or one naming no tracked shell file (stale), fails. Every run also self-tests a temp git repo: an unlisted .sh, a .bash, a reasonless entry and a stale entry each fail, and a fully listed tree passes.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-shell-files.allowlist';
const SHELL = /\.(?:sh|bash)$/;

function git(root, args, env = process.env) {
  return execFileSync('git', ['-C', root, ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function scan(root = ROOT, env = process.env) {
  const out = [];
  const entries = new Map();
  readFileSync(join(root, ALLOWLIST), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.trim() === '' || line.startsWith('#')) return;
      const m = /^(\S+)\s+#\s*(\S.*)$/.exec(line);
      if (!m) {
        out.push(`${ALLOWLIST}:${i + 1}: needs <repo-relative path>  # <reason>: ${line}`);
        return;
      }
      entries.set(m[1], false);
    });
  const tracked = git(root, ['ls-files', '-z'], env)
    .split('\0')
    .filter((f) => SHELL.test(f))
    .sort();
  for (const file of tracked) {
    if (entries.has(file)) entries.set(file, true);
    else out.push(`tracked shell file not on ${ALLOWLIST}: ${file}`);
  }
  for (const [path, used] of entries) {
    if (!used) out.push(`STALE ${ALLOWLIST} entry (no tracked shell file): ${path}`);
  }
  return out;
}

const HINT = `TMB ships TypeScript, not shell (GH 1692): port the file to TypeScript, or list it in ${ALLOWLIST} as <path>  # <reason>.`;

test('no tracked shell file outside the allowlist', () => {
  const out = scan();
  assert.deepEqual(out, [], `no-shell-files: FAIL\n${out.join('\n')}\n\n${HINT}`);
});

describe('self-test: a temp git repo', () => {
  let tmp;
  let repo;
  let env;
  const run = (...args) => git(repo, args, env);
  const write = (rel, text) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
    run('add', '--', rel);
  };
  const allow = (...lines) => write(ALLOWLIST, `# header comment\n${lines.map((l) => `${l}\n`).join('')}`);

  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-shell-files.'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(tmp, 'home'),
      TMPDIR: tmp,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    mkdirSync(env.HOME);
    repo = join(tmp, 'repo');
    mkdirSync(repo);
    run('init', '-q');
    write('src/index.ts', 'export {};\n');
    write('tests/kept.sh', '#!/usr/bin/env bash\n');
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('passes when every tracked shell file is listed with a reason', () => {
    allow('tests/kept.sh  # kept on purpose');
    assert.deepEqual(scan(repo, env), []);
  });

  for (const rel of ['scripts/new.sh', 'scripts/new.bash']) {
    test(`fails on an unlisted tracked ${rel.slice(rel.lastIndexOf('.'))}`, () => {
      allow('tests/kept.sh  # kept on purpose');
      write(rel, '#!/usr/bin/env bash\n');
      try {
        assert.deepEqual(scan(repo, env), [`tracked shell file not on ${ALLOWLIST}: ${rel}`]);
      } finally {
        run('rm', '-qf', '--', rel);
      }
    });
  }

  test('fails on an entry with no reason', () => {
    allow('tests/kept.sh');
    const out = scan(repo, env);
    assert.ok(out.some((l) => l.includes('needs <repo-relative path>  # <reason>')), out.join('\n'));
  });

  test('fails on an entry with an empty reason', () => {
    allow('tests/kept.sh  #');
    const out = scan(repo, env);
    assert.ok(out.some((l) => l.includes('needs <repo-relative path>  # <reason>')), out.join('\n'));
  });

  test('fails on a stale entry', () => {
    allow('tests/kept.sh  # kept on purpose', 'tests/gone.sh  # ported long ago');
    assert.deepEqual(scan(repo, env), [`STALE ${ALLOWLIST} entry (no tracked shell file): tests/gone.sh`]);
  });
});
