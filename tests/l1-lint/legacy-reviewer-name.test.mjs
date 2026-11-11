// L1 lint: fail when a tracked file names the reviewer by its pre-GH-1641 name (pr-reviewer / pr_reviewer, any case) outside an explicit allowlist. The reviewer is code-reviewer with no alias; the old name survives only in the v51 migration, its tests and schema fixtures, the rejection tests, a research question about the rename, and history (changelog, upgrade notes). It also checks that the UPGRADE.md schema v51 bullet names the audit.content_json rewrite. Allowlist: tests/l1-lint/legacy-reviewer-name.allowlist — <path><TAB><reason>. A path ending in / covers every file under it. An entry with no reason, or one that matches no hit, fails, so the list shrinks as the old name goes away. scan(root) checks the git repo at root; the cases below plant tracked files in a copy.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/legacy-reviewer-name.allowlist';
const UPGRADE = 'docs/reference/UPGRADE.md';
const PATTERN = 'pr-reviewer\\|pr_reviewer';

function git(root, args, env = process.env) {
  try {
    return execFileSync('git', ['-C', root, ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.status === 1 && args[0] === 'grep') return '';
    throw e;
  }
}

function nonEmpty(text) {
  return text.split('\n').filter((l) => l !== '');
}

export function scan(root = ROOT, env = process.env) {
  const out = [];
  const entries = [];
  readFileSync(join(root, ALLOWLIST), 'utf8')
    .split('\n')
    .forEach((line, i, all) => {
      if (i === all.length - 1 && line === '') return;
      if (line === '' || line.startsWith('#')) return;
      const trimmed = line.replace(/^\t+/, '');
      const tab = trimmed.indexOf('\t');
      const path = tab < 0 ? trimmed : trimmed.slice(0, tab);
      const reason = tab < 0 ? '' : trimmed.slice(tab).replace(/^\t+/, '').replace(/\t+$/, '');
      if (!path || !reason) {
        out.push(`ALLOWLIST ${ALLOWLIST}:${i + 1}: needs <path><TAB><reason>`);
        return;
      }
      entries.push({ path, used: false });
    });

  const allowed = (file) => {
    const e = entries.find((x) => (x.path.endsWith('/') ? file.startsWith(x.path) : file === x.path));
    if (!e) return false;
    e.used = true;
    return true;
  };

  for (const file of nonEmpty(git(root, ['grep', '-il', PATTERN], env))) {
    if (allowed(file)) continue;
    out.push(`legacy reviewer name in ${file}:`);
    for (const l of nonEmpty(git(root, ['grep', '-in', PATTERN, '--', file], env)).slice(0, 5)) out.push(`  ${l}`);
  }

  for (const e of entries) {
    if (!e.used) out.push(`STALE allowlist entry (no file still names pr-reviewer): ${e.path}`);
  }

  const upgrade = existsSync(join(root, UPGRADE)) ? readFileSync(join(root, UPGRADE), 'utf8') : null;
  if (
    upgrade === null ||
    upgrade.includes('audit rows are untouched') ||
    !upgrade.split('\n').some((l) => /^- [^*].*schema v51/.test(l) && l.includes('content_json'))
  ) {
    out.push(`${UPGRADE}: the schema v51 migration-list bullet must name the audit.content_json rewrite and not say audit rows are untouched (F182-1)`);
  }
  return { ok: out.length === 0, out: out.join('\n') };
}

const HINT = `The reviewer is code-reviewer (GH 1641). Rename the reference, or allowlist the file in ${ALLOWLIST} with a reason.`;

test('the legacy reviewer name appears only where allowlisted', () => {
  const r = scan();
  assert.ok(r.ok, `${r.out}\n\n${HINT}`);
});

describe('a planted repo', () => {
  const OLD_NAME = 'pr-' + 'reviewer';
  let tmp;
  let repo;
  let env;
  const run = (...args) => git(repo, args, env);

  function copyTracked(rel) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(repo, rel));
  }

  function plant(rel) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), `agent = "${OLD_NAME}"\n`);
    run('add', '--', rel);
  }

  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-legacy-reviewer-name.'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(tmp, 'home'),
      TMPDIR: tmp,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      TRAJECTORY_DB_PATH: join(tmp, 'no-such.db'),
    };
    mkdirSync(env.HOME);
    repo = join(tmp, 'repo');
    mkdirSync(repo);
    run('init', '-q');
    const hits = nonEmpty(git(ROOT, ['grep', '-il', 'pr[-_]reviewer']));
    for (const rel of new Set([...hits, 'tests/l1-lint/legacy-reviewer-name.test.mjs', ALLOWLIST, UPGRADE])) copyTracked(rel);
    run('add', '-A');
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('passes when every current hit is allowlisted', () => {
    const r = scan(repo, env);
    assert.ok(r.ok, r.out);
  });

  for (const [label, rel] of [
    ['a new tracked file using the old name', 'scripts/new-agent.sh'],
    ['a file beside the exactly allowlisted db.ts', 'mcp/trajectory-server/src/other-db.ts'],
  ]) {
    test(`fails on ${label}, naming it`, () => {
      plant(rel);
      try {
        const r = scan(repo, env);
        assert.equal(r.ok, false, r.out);
        assert.ok(r.out.includes(`legacy reviewer name in ${rel}`), r.out);
      } finally {
        run('rm', '-qf', '--', rel);
      }
    });
  }
});
