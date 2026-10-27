/**
 * Parity of the TypeScript prompt-intent-hints gate with
 * scripts/hooks/prompt-intent-hints.sh (GH 1692), over
 * tests/fixtures/hook-corpus/prompt-intent-hints/. The sandbox is rebuilt at
 * the same path before each side runs; both sides must exit 0, print the same
 * stdout and stderr byte for byte, and leave the sandbox alike (the
 * consultant-spawn nudge's audit row included, timestamps masked).
 *
 * The project DB is onboarded with headless enforcement off and holds an open
 * issue whose task 1 is completed with an unsigned commit (push-intent) and
 * whose task 2 is pending after a planning_complete audit (resume-intent);
 * beside it a schema-only DB (fresh) and an onboarded DB with headless
 * enforcement on (enforced). CLAUDE_PLUGIN_ROOT is this checkout, so the
 * headless hint counts its hooks.json entries. Payload fields and
 * corpus_divergent follow hooks-swe-run-parity.suite.ts. The payload × locale
 * (C, en_US.UTF-8) runs split across
 * hooks-prompt-intent-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { shardOf } from './shard.js';
import {
  assertExpect,
  byLocale,
  corpusFiles,
  type CorpusPaths,
  materialize,
  noCmdPath,
  run,
  type SideExpect,
  snapshot,
} from './hooks-swe-run-parity.suite.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GATE = 'prompt-intent-hints';
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 20;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_FORBID_LIVE_SYNC',
  'TMB_HOOKS_SQLITE',
  'TMB_DB_WRITE_TIMEOUT_MS',
  'LANG',
  'LC_CTYPE',
  'TMB_DISABLE_CHEATCODE_INSTALL_HINT',
  'TMB_DISABLE_CONSULTANT_HINT',
  'TMB_DISABLE_SEARCH_HINT',
  'TMB_DISABLE_CONCERNS_HINT',
  'TMB_DISABLE_PUSH_INTENT_HINT',
  'TMB_DISABLE_REONBOARD_HINT',
  'TMB_DISABLE_HEADLESS_HINT',
  'TMB_DISABLE_RESUME_HINT',
  'TMB_DISABLE_ADR_HINT',
  'TMB_DISABLE_AUDIT_HINT',
];

function trajectoryDb(path: string, rows: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    rows(db);
  } finally {
    db.close();
  }
}

function config(db: DatabaseSync, key: string, valueJson: string): void {
  db.prepare('INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES (?, ?)').run(key, valueJson);
}

/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  mkdirSync(join(s, 'home'), { recursive: true });
  trajectoryDb(join(s, PROJECT_DB), (db) => {
    config(db, 'onboarded', 'true');
    config(db, 'headless_enforcement', '"no"');
    db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'auth | work', 'open', ?, ?)").run(T1, T1);
    const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, title, description, status, commit_sha, created_at, updated_at) VALUES (?, 1, ?, ?, 'd', ?, ?, ?, ?)");
    task.run(1, 'feat/done', 'done task', 'completed', 'abc1234', T1, T1);
    task.run(2, 'feat/next', 'next | task', 'pending', null, T1, T1);
    db.prepare(
      "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (1, 'feat/next', 'bro', 'planning_complete', 'planned', '{}', ?)",
    ).run(T1);
  });
  trajectoryDb(join(s, 'fresh/.claude/tmb/trajectory.db'), () => {});
  trajectoryDb(join(s, 'enforced/.claude/tmb/trajectory.db'), (db) => {
    config(db, 'onboarded', 'true');
    config(db, 'headless_enforcement', '"yes"');
  });
}

function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
    LC_ALL: locale,
    PWD: cwd,
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

const cases = corpusFiles(GATE).flatMap((f) => LOCALES.map((locale) => ({ f, locale })));

export function promptIntentParityShard(k: number, n: number): void {
  describe(
    `prompt-intent-hints parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let paths: CorpusPaths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-prompt-intent-parity-')));
        s = join(base, 'sandbox');
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`the corpus holds at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          const files = corpusFiles(GATE);
          assert.ok(files.length >= MIN_CORPUS, `${files.length} payloads`);
          for (const f of files) {
            const { expect, divergent } = materialize(join(CORPUS_ROOT, GATE, f), '/s', { noJq: '', noSqlite: '' });
            if (divergent === undefined)
              assert.ok(
                typeof expect === 'string' ? expect !== '' : !('bash' in expect) && LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''),
                `${f}: an expectation, or one per locale`,
              );
            else
              assert.ok(
                typeof expect === 'object' && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                `${f}: a divergent case names why and expects each side in every locale`,
              );
          }
        });
      }

      for (const { f, locale } of shardOf(cases, k, n)) {
        it(`${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, GATE, f), s, paths);
          const env = caseEnv(s, locale, c.env, c.cwd);
          buildSandbox(s);
          const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${GATE}.sh`)], c, env);
          const bashTree = snapshot(s);
          buildSandbox(s);
          const node = run(process.execPath, [HOOKS_BUNDLE, GATE], c, env);
          const nodeTree = snapshot(s);
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          if (c.divergent === undefined) {
            assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash, bashTree, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.ok(
              node.stdout + node.stderr !== bash.stdout + bash.stderr || JSON.stringify(nodeTree) !== JSON.stringify(bashTree),
              `divergent (${c.divergent}): the sides must differ`,
            );
            assertExpect('bash', bash, bashTree, byLocale(expect.bash, locale));
            assertExpect('ts', node, nodeTree, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
