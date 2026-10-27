/**
 * Parity of the TypeScript code-reviewer Agent-spawn gates with their
 * scripts/hooks/<gate>.sh (GH 1692): code-reviewer-no-worktree,
 * code-reviewer-spawn-prompt-shape and code-reviewer-after-atomic-close,
 * over tests/fixtures/hook-corpus/<gate>/. The sandbox is rebuilt at the same
 * path before each side runs; both sides must exit 0, print the same stdout
 * and stderr byte for byte, and leave the sandbox alike.
 *
 * The sandbox holds a project DB with tasks closed (11), completed (12),
 * running (13) and needs_validation (14), a schema-only DB, a corrupt DB and
 * a bare dir. A payload names the sandbox as @SANDBOX@ and the PATH without
 * jq or without the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env
 * (null unsets), corpus_cwd, corpus_stdin and corpus_expect (`empty`, or a
 * phrase of the observed stdout and stderr, or an object of them by locale)
 * are removed before the run. A
 * payload with corpus_divergent names a divergence decision 703 allows:
 * corpus_expect is then { bash, ts }, each a phrase or an object of them by
 * locale, and the two sides must differ. The payload × locale (C,
 * en_US.UTF-8) runs split across hooks-reviewer-spawn-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 8;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';

export const REVIEWER_SPAWN_GATES = ['code-reviewer-after-atomic-close', 'code-reviewer-no-worktree', 'code-reviewer-spawn-prompt-shape'] as const;

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_FORBID_LIVE_SYNC',
  'TMB_HOOKS_SQLITE',
  'TMB_ALLOW_CODE_REVIEWER_WORKTREE',
  'TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE',
  'TMB_SKIP_CODE_REVIEWER_CLOSE_GATE',
  'LANG',
  'LC_CTYPE',
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

/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  mkdirSync(join(s, 'home'), { recursive: true });
  mkdirSync(join(s, 'bare'));
  trajectoryDb(join(s, 'project/.claude/tmb/trajectory.db'), (db) => {
    db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'reviewer spawn gates', 'open', ?, ?)").run(T1, T1);
    const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?, ?)");
    task.run(11, 'feat/closed', 'closed', T1, T1);
    task.run(12, 'feat/completed', 'completed', T1, T1);
    task.run(13, 'feat/running', 'running', T1, T1);
    task.run(14, 'feat/needs-validation', 'needs_validation', T1, T1);
  });
  trajectoryDb(join(s, 'fresh/.claude/tmb/trajectory.db'), () => {});
  mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
  writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
}

/** PATH with <cmd> gone: each dir holding it replaced by a dir of links to everything else. */
function noCmdPath(dir: string, cmd: string, path: string): string {
  let n = 0;
  return path
    .split(':')
    .filter((d) => d !== '')
    .map((d) => {
      if (!existsSync(join(d, cmd))) return d;
      n += 1;
      const shadow = join(dir, String(n));
      mkdirSync(shadow, { recursive: true });
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        /* unreadable dir: empty shadow */
      }
      for (const name of names) if (name !== cmd) symlinkSync(join(d, name), join(shadow, name));
      return shadow;
    })
    .join(':');
}

function dumpDb(path: string): string {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  try {
    return JSON.stringify(db.prepare('SELECT id, status FROM tasks ORDER BY id').all());
  } catch {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } finally {
    db.close();
  }
}

/** Every path under <root> but SQLite's side files; each DB as its tasks' statuses, any other file as its sha256. */
export function snapshot(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (/-(wal|shm|journal)$/.test(name)) continue;
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = null;
        walk(path);
      } else {
        out[rel] = name.endsWith('.db') ? dumpDb(path) : createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

type SideExpect = string | Record<string, string>;
type Expect = string | { bash: SideExpect; ts: SideExpect };

function byLocale(expect: SideExpect, locale: string): string {
  return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}

interface Case {
  input: Buffer;
  env: Record<string, string | null>;
  cwd: string;
  expect: Expect;
  divergent: string | undefined;
}

export interface CorpusPaths {
  noJq: string;
  noSqlite: string;
}

export function materialize(file: string, s: string, paths: CorpusPaths): Case {
  const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
  const {
    corpus_env: env = {},
    corpus_cwd: cwd = 'project',
    corpus_stdin: stdin,
    corpus_expect: expect = '',
    corpus_divergent: divergent,
    ...payload
  } = JSON.parse(text) as {
    corpus_env?: Record<string, string | null>;
    corpus_cwd?: string;
    corpus_stdin?: string;
    corpus_expect?: Expect;
    corpus_divergent?: string;
  };
  return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect, divergent };
}

function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
    LC_ALL: locale,
    PWD: cwd,
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], c: Case, env: NodeJS.ProcessEnv): Run {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-reviewer-spawn-stdin-'));
  const file = join(dir, 'stdin');
  writeFileSync(file, c.input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd: c.cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertExpect(side: string, observed: string, expect: string): void {
  if (expect === 'empty') assert.equal(observed, '', `${side}: no output`);
  else assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 600)}`);
}

export function corpusFiles(gate: string): string[] {
  const dir = join(CORPUS_ROOT, gate);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

const cases = REVIEWER_SPAWN_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));

export function reviewerSpawnParityShard(k: number, n: number): void {
  describe(
    `code-reviewer spawn gates parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let paths: CorpusPaths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-reviewer-spawn-parity-')));
        s = join(base, 'sandbox');
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`every code-reviewer spawn gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          for (const gate of REVIEWER_SPAWN_GATES) {
            const files = corpusFiles(gate);
            assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
            for (const f of files) {
              const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noJq: '', noSqlite: '' });
              if (divergent === undefined)
                assert.ok(
                  typeof expect === 'string' ? expect !== '' : !('bash' in expect) && LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''),
                  `${gate}/${f}: an expectation, or one per locale`,
                );
              else
                assert.ok(
                  typeof expect === 'object' && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                  `${gate}/${f}: a divergent case names why and expects each side in every locale`,
                );
            }
          }
        });
      }

      for (const { gate, f, locale } of shardOf(cases, k, n)) {
        it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
          const env = caseEnv(s, locale, c.env, c.cwd);
          buildSandbox(s);
          const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env);
          const bashTree = snapshot(s);
          buildSandbox(s);
          const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env);
          const nodeTree = snapshot(s);
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
          if (c.divergent === undefined) {
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash.stdout + bash.stderr, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.notEqual(node.stdout + node.stderr, bash.stdout + bash.stderr, `divergent (${c.divergent}): the sides must differ`);
            assertExpect('bash', bash.stdout + bash.stderr, byLocale(expect.bash, locale));
            assertExpect('ts', node.stdout + node.stderr, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
