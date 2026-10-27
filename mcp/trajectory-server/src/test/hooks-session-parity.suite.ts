/**
 * Byte-for-byte parity of the TypeScript session and prompt hooks with their
 * scripts/hooks/<gate>.sh (GH 1692): session-start-persona,
 * user-prompt-persona, plugin-hooks-marker, session-log-capture,
 * debug-trajectory and activation-routine, over
 * tests/fixtures/hook-corpus/<gate>/. These hooks write markers, logs and DB
 * rows, so the sandbox is rebuilt at the same path before each side runs,
 * and both sides must leave it alike (timestamps, dates and the pid of a
 * fallback session id masked) besides giving the same exit code and stdout.
 *
 * The sandbox holds plugin roots (tmb, a renamed one, one without and one
 * with an empty CLAUDE.md), an onboarded project with markers, a sentinel and
 * an open issue, a non-onboarded project, a bare dir, a corrupt DB, bro
 * transcripts and a pgrep stub (PGREP_STUB=up|down|fail). A corpus payload
 * names the sandbox as @SANDBOX@ and the PATH without jq as @NOJQ_PATH@; its
 * corpus_env (null unsets), corpus_cwd (sandbox-relative, default project),
 * corpus_stdin (raw stdin in place of the payload) and corpus_expect (`empty`,
 * or a phrase of the stdout; an object of them by locale where grep's `\b`
 * differs) are removed before the run. The payload × locale
 * runs split across hooks-session-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const SCHEMA_EVAL = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema-eval.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8', 'UTF-8'];
const MIN_CORPUS = 8;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const NOW = '2026-10-11T10:00:00.000Z';
const DAY_MS = 86_400_000;

export const SESSION_GATES = [
  'activation-routine',
  'debug-trajectory',
  'plugin-hooks-marker',
  'session-log-capture',
  'session-start-persona',
  'user-prompt-persona',
] as const;

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_FORBID_LIVE_SYNC',
  'CLAUDE_SESSION_ID',
  'TMB_HOOKS_SQLITE',
  'TMB_EVAL_MODE',
  'TMB_DEBUG_TRAJECTORY',
  'LANG',
  'LC_CTYPE',
];

const PERSONA = '# You are bro\n\nThe persona body, with ü and a `code span`.\n\n';

function write(path: string, content: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function plugin(dir: string, name: string, version: string, claudeMd: string | null): void {
  write(join(dir, '.claude-plugin/plugin.json'), `{\n  "name": "${name}",\n  "version": "${version}"\n}\n`);
  if (claudeMd !== null) write(join(dir, 'CLAUDE.md'), claudeMd);
}

function trajectoryDb(path: string, rows: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    db.exec(SCHEMA_EVAL);
    rows(db);
  } finally {
    db.close();
  }
}

function stale(path: string): void {
  write(path, '');
  const old = new Date(Date.now() - 2 * DAY_MS);
  utimesSync(path, old, old);
}

/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  mkdirSync(s, { recursive: true });
  plugin(join(s, 'plugin'), 'tmb', '1.1.0', PERSONA);
  plugin(join(s, 'plugin-named'), 'acme', '2.0.0', PERSONA);
  plugin(join(s, 'plugin-nomd'), 'tmb', '1.1.0', null);
  plugin(join(s, 'plugin-empty'), 'tmb', '1.1.0', '\n\n');
  write(join(s, 'bin/pgrep'), '#!/bin/sh\ncase "${PGREP_STUB:-up}" in up) exit 0 ;; down) exit 1 ;; *) exit 3 ;; esac\n', 0o755);
  mkdirSync(join(s, 'home'));
  mkdirSync(join(s, 'bare'));

  const project = join(s, 'project');
  trajectoryDb(join(project, '.claude/tmb/trajectory.db'), (db) => {
    db.exec("INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')");
    const issue = db.prepare('INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    issue.run(2, 'an older issue', 'open', NOW, NOW);
    issue.run(3, 'ship the | bar thing\nover two lines', 'open', NOW, NOW);
    issue.run(4, 'a closed issue', 'closed', NOW, NOW);
    db.prepare(
      "INSERT INTO debug_trajectory (session_id, step_n, kind, tool_or_mcp_name, args_json, created_at) VALUES ('dbg-session-0001', 1, 'tool_use', 'Read', '{}', ?)",
    ).run(NOW);
  });
  write(join(project, '.claude/tmb/.current-session-id'), 'sentinel-session-01\n');
  const sessions = join(project, '.claude/tmb/sessions');
  write(join(sessions, 'marked-session-0001.persona'), '');
  write(join(sessions, 'noticed-session-0001.persona-notice'), '');
  write(join(sessions, 'recent-session-0001.plugin-hooks'), '');
  stale(join(sessions, 'stale-session-0001.persona'));
  stale(join(sessions, 'stale-session-0001.plugin-hooks'));
  write(join(project, 'CLAUDE.md'), '# Project notes\n');

  trajectoryDb(join(s, 'fresh/.claude/tmb/trajectory.db'), () => {});
  write(join(s, 'old-block/CLAUDE.md'), '# Notes\n<!-- tmb:persona start v1 -->\nold persona\n<!-- tmb:persona end -->\n');
  write(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));

  const t = join(s, 'transcripts');
  write(join(t, 'sticky.jsonl'), '{"message":{"content":"Entering bro mode."}}\n');
  write(join(t, 'exited.jsonl'), '{"message":{"content":"Entering bro mode."}}\n{"message":{"content":"please EXIT BRO MODE now"}}\n');
  write(join(t, 'at-bro.jsonl'), '{"message":{"content":"ping @BRO, help"}}\n');
  write(join(t, 'at-brother.jsonl'), '{"message":{"content":"ping @brother and @bros"}}\n');
  write(join(t, 'latin1.jsonl'), Buffer.concat([Buffer.from('{"m":"caf'), Buffer.from([0xe9]), Buffer.from(' Entering bro mode."}\n')]));
  write(join(t, 'quiet.jsonl'), '{"message":{"content":"nothing to see"}}\n');
}

/** PATH with <cmd> gone: each dir holding it replaced by a dir of links to everything else (no_cmd_path). */
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

const MASKS: [RegExp, string][] = [
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z/g, '<TS>'],
  [/\d{8}-\d{6}-\d+/g, '<SID>'],
  [/\d{4}-\d\d-\d\d/g, '<DATE>'],
  [/\d{8}-\d\d/g, '<HOUR>'],
];

function mask(text: string): string {
  return MASKS.reduce((t, [re, to]) => t.replace(re, to), text);
}

function dumpDb(path: string): string {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return readFileSync(path).toString('base64');
  }
  try {
    const rows = db
      .prepare('SELECT session_id, step_n, kind, tool_or_mcp_name, args_json, created_at FROM debug_trajectory ORDER BY id')
      .all();
    return mask(JSON.stringify(rows));
  } catch {
    return readFileSync(path).toString('base64');
  } finally {
    db.close();
  }
}

/** Every path under <root> but bin/ and SQLite's side files, with file contents (DBs as their debug_trajectory rows), masked. */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel === 'bin' || /-(wal|shm|journal)$/.test(name)) continue;
      if (statSync(path).isDirectory()) {
        out.push(`${mask(rel)}/`);
        walk(path);
      } else if (name.endsWith('.db')) {
        out.push(`${rel}: ${dumpDb(path)}`);
      } else {
        out.push(`${mask(rel)}: ${mask(readFileSync(path, 'utf8'))}`);
      }
    }
  };
  walk(root);
  return out;
}

interface Case {
  input: Buffer;
  env: Record<string, string | null>;
  cwd: string;
  expect: string | Record<string, string>;
}

export function materialize(file: string, s: string, noJqPath: string): Case {
  const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', noJqPath);
  const {
    corpus_env: env = {},
    corpus_cwd: cwd = 'project',
    corpus_stdin: stdin,
    corpus_expect: expect = '',
    ...payload
  } = JSON.parse(text) as {
    corpus_env?: Record<string, string | null>;
    corpus_cwd?: string;
    corpus_stdin?: string;
    corpus_expect?: string | Record<string, string>;
  };
  return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect };
}

function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    CLAUDE_PLUGIN_ROOT: join(s, 'plugin'),
    PATH: `${join(s, 'bin')}:${process.env.PATH ?? ''}`,
    PGREP_STUB: 'up',
    LC_ALL: locale,
    PWD: cwd,
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(cmd: string, args: string[], c: Case, env: NodeJS.ProcessEnv): { code: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-session-stdin-'));
  const file = join(dir, 'stdin');
  writeFileSync(file, c.input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd: c.cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function corpusFiles(gate: string): string[] {
  const dir = join(CORPUS_ROOT, gate);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

const cases = SESSION_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));

export function sessionHooksParityShard(k: number, n: number): void {
  describe(
    `session hooks parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let noJqPath: string;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-session-parity-')));
        s = join(base, 'sandbox');
        noJqPath = `${join(s, 'bin')}:${noCmdPath(join(base, 'nojq'), 'jq', process.env.PATH ?? '')}`;
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`every session gate has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          const s0 = '/s';
          for (const gate of SESSION_GATES) {
            const files = corpusFiles(gate);
            assert.ok(files.length >= MIN_CORPUS, `${gate}: ${files.length} payloads`);
            for (const f of files) {
              const { expect } = materialize(join(CORPUS_ROOT, gate, f), s0, '');
              const perLocale = typeof expect === 'string' ? LOCALES.map(() => expect) : LOCALES.map((l) => expect[l] ?? '');
              assert.ok(perLocale.every((e) => e !== ''), `${gate}/${f}`);
            }
          }
        });
      }

      for (const { gate, f, locale } of shardOf(cases, k, n)) {
        it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, gate, f), s, noJqPath);
          const env = caseEnv(s, locale, c.env, c.cwd);
          buildSandbox(s);
          const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env);
          const bashTree = snapshot(s);
          buildSandbox(s);
          const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env);
          const nodeTree = snapshot(s);
          assert.equal(node.code, bash.code, 'exit code');
          assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
          assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
          assert.equal(bash.code, 0);
          const expect = typeof c.expect === 'string' ? c.expect : c.expect[locale];
          if (expect === 'empty') assert.equal(bash.stdout, '', 'no output');
          else assert.ok(bash.stdout.includes(expect), `stdout holds ${JSON.stringify(expect)}: ${bash.stdout.slice(0, 400)}`);
        });
      }
    },
  );
}
