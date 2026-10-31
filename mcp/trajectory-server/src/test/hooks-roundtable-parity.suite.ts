/**
 * Parity of the TypeScript roundtable and consultant hooks with their
 * scripts/hooks/<gate>.sh (GH 1692): roundtable-slash-detect,
 * roundtable-cleanup-postcheck, roundtable-auq-shape and
 * consultant-persistence-gate, over tests/fixtures/hook-corpus/<gate>/. The
 * sandbox is rebuilt at the same path before each side runs; both sides must
 * give the same exit code, stdout and stderr, and leave the same audit rows
 * (summaries compared as hex, timestamps masked) and row counts.
 *
 * The sandbox holds an onboarded project DB (issues, roundtables in every
 * capture state, one awaiting_human, votes, discussions, consultants), a DB
 * whose awaiting roundtable the human already voted on, a schema-only DB, a
 * corrupt DB and a bare dir. A payload names the sandbox as @SANDBOX@ and the
 * PATH without jq or without the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@;
 * corpus_env (null unsets), corpus_cwd, corpus_stdin and corpus_expect
 * (`empty`, or a phrase of the observed stdout, stderr and new audit rows)
 * are removed before the run. A payload with corpus_divergent names a
 * divergence decision 703 allows: corpus_expect is then { bash, ts }, each a
 * phrase or an object of them by locale, and the two sides must differ. The
 * payload × locale (C, en_US.UTF-8) runs split across
 * hooks-roundtable-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';

export const ROUNDTABLE_GATES = [
  'consultant-persistence-gate',
  'roundtable-auq-shape',
  'roundtable-cleanup-postcheck',
  'roundtable-slash-detect',
] as const;

const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'CLAUDE_SESSION_ID', 'TMB_HOOKS_SQLITE', 'LANG', 'LC_CTYPE'];

function trajectoryDb(path: string, rows: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    db.prepare('UPDATE issues SET updated_at = ?, created_at = ? WHERE id = -1').run(T0, T0);
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
  mkdirSync(join(s, 'project/sub/dir'), { recursive: true });

  trajectoryDb(join(s, 'project/.claude/tmb/trajectory.db'), (db) => {
    const issue = db.prepare('INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    issue.run(1, 'the older open issue', 'open', T1, T1);
    issue.run(2, 'the newest open issue', 'open', T2, T2);
    issue.run(3, 'a closed issue', 'closed', T2, T2);
    const discussion = db.prepare('INSERT INTO discussions (issue_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)');
    discussion.run(1, 'bro', 'analysis', 'analysis body', T1);
    discussion.run(1, 'bro', 'decision', 'decision body', T1);
    discussion.run(1, 'cto', 'analysis', 'cto on the older issue', T1);
    discussion.run(2, 'architect', 'analysis', 'architect on the newest issue', T2);
    const rt = db.prepare('INSERT INTO roundtables (id, issue_id, topic, state, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    rt.run(1, 1, 'fully captured', 'closed', 'proceed', T1);
    rt.run(2, 2, 'nothing captured', 'collecting', '', T2);
    rt.run(3, 1, 'outcome is a lone pipe', 'closed', '|', T1);
    rt.run(4, 1, 'outcome holds a pipe', 'closed', 'a|b', T1);
    rt.run(5, 1, 'awaiting the human', 'awaiting_human', '', T1);
    rt.run(6, 1, 'outcome over two lines', 'closed', 'line one\nline two', T1);
    const vote = db.prepare('INSERT INTO roundtable_votes (roundtable_id, participant, vote, created_at) VALUES (?, ?, ?, ?)');
    for (const id of [1, 4, 6]) vote.run(id, 'architect', 'yes', T1);
    db.prepare(
      "INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (1, NULL, 'system', 'roundtable_summary', 'summary', '{}', ?)",
    ).run(T1);
  });

  trajectoryDb(join(s, 'ratified/.claude/tmb/trajectory.db'), (db) => {
    db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'ratified', 'open', ?, ?)").run(T1, T1);
    db.prepare("INSERT INTO roundtables (id, issue_id, topic, state, created_at) VALUES (1, 1, 'ratified', 'awaiting_human', ?)").run(T1);
    db.prepare("INSERT INTO roundtable_votes (roundtable_id, participant, vote, created_at) VALUES (1, 'human', 'ratified', ?)").run(T1);
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

const TS_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g;

interface AuditRow {
  issue_id: number;
  branch_id: string | null;
  from_node: string;
  event_type: string;
  summary: string;
  summary_hex: string;
  content_json: string;
  created_at: string;
}

interface DbDump {
  audit: AuditRow[];
  counts: unknown;
}

function dumpDb(path: string): DbDump | string {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return readFileSync(path).toString('base64');
  }
  try {
    const audit = db
      .prepare('SELECT issue_id, branch_id, from_node, event_type, summary, hex(summary) AS summary_hex, content_json, created_at FROM audit ORDER BY id')
      .all() as unknown as AuditRow[];
    const counts = db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM issues) AS issues, (SELECT COUNT(*) FROM discussions) AS discussions, (SELECT COUNT(*) FROM roundtables) AS roundtables, (SELECT COUNT(*) FROM roundtable_votes) AS votes, (SELECT COUNT(*) FROM agents) AS agents',
      )
      .get();
    return { audit: audit.map((r) => ({ ...r, created_at: r.created_at.replace(TS_RE, '<TS>') })), counts };
  } catch {
    return readFileSync(path).toString('base64');
  } finally {
    db.close();
  }
}

/** Every path under <root> but SQLite's side files; each DB as its audit rows and row counts. */
export function snapshot(root: string): Record<string, DbDump | string | null> {
  const out: Record<string, DbDump | string | null> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (/-(wal|shm|journal)$/.test(name)) continue;
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = null;
        walk(path);
      } else {
        out[rel] = name.endsWith('.db') ? dumpDb(path) : readFileSync(path, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

/** The rows a run added: every audit row but the seeded roundtable_summary, as `audit:` and `hex:` lines. */
function auditLines(tree: Record<string, DbDump | string | null>): string {
  const lines: string[] = [];
  for (const dump of Object.values(tree)) {
    if (dump === null || typeof dump === 'string') continue;
    for (const r of dump.audit) {
      if (r.event_type === 'roundtable_summary') continue;
      lines.push(`audit: ${r.issue_id} ${r.from_node} ${r.event_type}: ${r.summary}`, `hex: ${r.summary_hex}`);
    }
  }
  return lines.map((l) => `${l}\n`).join('');
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

export function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
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
  const dir = mkdtempSync(join(tmpdir(), 'tmb-roundtable-stdin-'));
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
  if (expect === 'empty') assert.equal(observed, '', `${side}: no output and no audit row`);
  else assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 600)}`);
}

export function corpusFiles(gate: string): string[] {
  const dir = join(CORPUS_ROOT, gate);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

const cases = ROUNDTABLE_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));

export function roundtableHooksParityShard(k: number, n: number): void {
  describe(
    `roundtable hooks parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let paths: CorpusPaths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-roundtable-parity-')));
        s = join(base, 'sandbox');
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`every roundtable gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          for (const gate of ROUNDTABLE_GATES) {
            const files = corpusFiles(gate);
            assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
            for (const f of files) {
              const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noJq: '', noSqlite: '' });
              if (divergent === undefined) assert.ok(typeof expect === 'string' && expect !== '', `${gate}/${f}`);
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
          const bashObserved = bash.stdout + bash.stderr + auditLines(bashTree);
          const nodeObserved = node.stdout + node.stderr + auditLines(nodeTree);
          if (c.divergent === undefined) {
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
            assertExpect('bash', bashObserved, c.expect as string);
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.notEqual(nodeObserved, bashObserved, `divergent (${c.divergent}): the sides must differ`);
            assertExpect('bash', bashObserved, byLocale(expect.bash, locale));
            assertExpect('ts', nodeObserved, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
