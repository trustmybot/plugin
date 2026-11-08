/**
 * builtin-lints.ts (GH 2570) on temp git repos: the missing_changelog and
 * stale_doc_ref checks moved out of code-reviewer-preflight give the results
 * they gave there, and on a failing case the preflight still denies with the
 * check, expected and actual builtinLints reports.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { codeReviewerPreflight } from '../hooks/code-reviewer-preflight.js';
import {
  builtinLints,
  MISSING_CHANGELOG,
  missingChangelog,
  missingChangelogExpected,
  STALE_DOC_REF,
  staleDocRefExpected,
  staleDocRefs,
} from '../hooks/lib/builtin-lints.js';
import { sandboxDir } from './db-test-fixtures.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const NOW = '2026-10-25T10:00:00.000Z';
const TASK_ID = 3;
const BRANCH = 'feat/3-x';
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const BASE_FILES: Record<string, string> = {
  'README.md': 'See docs/guide.md.\n',
  'docs/guide.md': 'Run `scripts/old.sh` first.\n',
  'scripts/old.sh': 'echo old\n',
  'skills/s/SKILL.md': 'Call `mcp__plugin_tmb_trajectory-server__old_tool` then `keep_tool`.\n',
  'mcp/srv/src/tools/t.ts': "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n  {\n    name: 'old_tool',\n  },\n];\n",
  'changelog.d/README.md': 'One file per change.\n',
  'src/a.txt': 'one\n',
};

interface Repo {
  repo: string;
  db: string;
  env: NodeJS.ProcessEnv;
  base: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  commit(message: string): string;
}

let sandbox: string;
let seq = 0;

function repoFixture(files: Record<string, string> = BASE_FILES): Repo {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const repo = join(root, 'repo');
  const db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(repo, { recursive: true });
  mkdirSync(dirname(db), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db, ...GIT_ENV };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'dev');
  for (const [path, text] of Object.entries(files)) write(path, text);
  const base = commit('base');
  git('checkout', '-q', '-b', BRANCH);
  return { repo, db, env, base, git, write, commit };
}

/** The preflight's deny for <r>'s branch tip, recorded as a closed task with a passing verification run. */
async function preflightDeny(r: Repo, sha: string): Promise<{ check: string; expected: string | null; actual: string | null } | null> {
  const d = new DatabaseSync(r.db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('repo', ?, 'dev')").run(r.repo);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(NOW, NOW);
  d.prepare(
    "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, commit_sha, created_at, updated_at) VALUES (?, 9, ?, 'dev', 'd', 'closed', 'repo', ?, ?, ?)",
  ).run(TASK_ID, BRANCH, sha, NOW, NOW);
  d.prepare(
    "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', ?, ?, 0, 600, 0)",
  ).run(TASK_ID, sha, NOW, NOW);
  d.close();
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer', prompt: `task_id=${TASK_ID} commit_sha=${sha}` } });
  const out = ((await codeReviewerPreflight(payload, r.env)) as { stdout: string }).stdout;
  if (out === '') return null;
  const parsed = JSON.parse(JSON.parse(out).hookSpecificOutput.permissionDecisionReason) as { check: string; expected: string | null; actual: string | null };
  return { check: parsed.check, expected: parsed.expected, actual: parsed.actual };
}

describe('builtin lints (GH 2570)', () => {
  before(() => {
    sandbox = sandboxDir('builtin-lints');
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  it('passes both checks on a diff that adds a fragment and removes nothing a doc names', async () => {
    const r = repoFixture();
    r.write('src/a.txt', 'one\ntwo\n');
    r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    const sha = r.commit('feature');
    assert.deepEqual(await builtinLints(r.repo, r.base, sha, r.env), [
      { name: MISSING_CHANGELOG, exitCode: 0, output: '' },
      { name: STALE_DOC_REF, exitCode: 0, output: '' },
    ]);
    assert.equal(await preflightDeny(r, sha), null);
  });

  it('fails missing_changelog on a diff that adds no fragment, as the preflight denies it', async () => {
    const r = repoFixture();
    r.write('src/a.txt', 'one\ntwo\n');
    const sha = r.commit('feature without fragment');
    assert.equal(await missingChangelog(r.repo, r.base, sha, r.env), 'no file added under changelog.d/');
    const [changelog, stale] = await builtinLints(r.repo, r.base, sha, r.env);
    assert.deepEqual(changelog, {
      name: MISSING_CHANGELOG,
      exitCode: 1,
      output: `expected: ${missingChangelogExpected(r.base, sha)}\nactual: no file added under changelog.d/`,
    });
    assert.equal(stale!.exitCode, 0);
    assert.deepEqual(await preflightDeny(r, sha), {
      check: MISSING_CHANGELOG,
      expected: `${r.base}..${sha} adds a file under changelog.d/`,
      actual: 'no file added under changelog.d/',
    });
  });

  it('passes missing_changelog in a repo without changelog.d/', async () => {
    const files = { ...BASE_FILES };
    delete files['changelog.d/README.md'];
    const r = repoFixture(files);
    r.write('src/a.txt', 'one\ntwo\n');
    const sha = r.commit('feature');
    assert.equal(await missingChangelog(r.repo, r.base, sha, r.env), null);
    assert.equal((await builtinLints(r.repo, r.base, sha, r.env))[0]!.exitCode, 0);
  });

  it('fails stale_doc_ref on a deleted path, a renamed path and a removed MCP tool the docs still name, as the preflight denies it', async () => {
    const r = repoFixture();
    r.git('rm', '-q', 'scripts/old.sh');
    r.git('mv', 'docs/guide.md', 'docs/handbook.md');
    r.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
    r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    const sha = r.commit('drop old.sh, old_tool; rename guide');
    const hits = await staleDocRefs(r.repo, r.base, sha, r.env);
    assert.ok(Array.isArray(hits), String(hits));
    assert.ok(hits.includes("README.md mentions removed path 'docs/guide.md'"), hits.join('\n'));
    assert.ok(hits.includes("docs/handbook.md mentions removed path 'scripts/old.sh'"), hits.join('\n'));
    assert.ok(hits.includes("skills/s/SKILL.md mentions removed MCP tool 'old_tool'"), hits.join('\n'));
    const [changelog, stale] = await builtinLints(r.repo, r.base, sha, r.env);
    assert.equal(changelog!.exitCode, 0);
    assert.deepEqual(stale, { name: STALE_DOC_REF, exitCode: 1, output: `expected: ${staleDocRefExpected(r.base, sha)}\nactual: ${hits.join('\n')}` });
    const denied = await preflightDeny(r, sha);
    assert.equal(denied?.check, STALE_DOC_REF);
    assert.equal(denied?.expected, staleDocRefExpected(r.base, sha));
    for (const hit of hits) assert.ok(denied?.actual?.includes(hit), `${hit} in ${denied?.actual}`);
  });

  it('passes stale_doc_ref once the docs drop what the diff removes, and on a path the commit .gitignore untracks', async () => {
    const r = repoFixture({ ...BASE_FILES, 'docs/guide.md': 'Run `node pkg/dist/out.js`.\n', 'pkg/dist/out.js': 'built\n' });
    r.write('pkg/.gitignore', 'dist/\n');
    r.git('rm', '-q', '--cached', 'pkg/dist/out.js');
    r.git('rm', '-q', 'scripts/old.sh');
    r.write('skills/s/SKILL.md', 'Call `keep_tool`.\n');
    r.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
    r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    const sha = r.commit('untrack dist, drop old.sh and old_tool');
    assert.deepEqual(await staleDocRefs(r.repo, r.base, sha, r.env), []);
    assert.equal((await builtinLints(r.repo, r.base, sha, r.env))[1]!.exitCode, 0);
  });

  it('fails both checks closed when git cannot diff the range', async () => {
    const r = repoFixture();
    const bogus = 'f'.repeat(40);
    const [changelog, stale] = await builtinLints(r.repo, bogus, r.base, r.env);
    assert.equal(changelog!.exitCode, 1);
    assert.match(changelog!.output, /actual: git diff failed: /);
    assert.equal(stale!.exitCode, 1);
  });
});
