/**
 * Parity of the TypeScript orphan-scan and session-start-prescan gates with
 * their scripts/hooks/<gate>.sh (GH 1692) over
 * tests/fixtures/hook-corpus/<gate>/. The sandbox is built once, kept as a
 * template, and copied back to the same path before each side runs; both
 * sides must exit 0, print the same stdout and stderr byte for byte, and
 * leave the sandbox alike (every path, each file as its sha256, each symlink
 * as its target, a .git dir as itself).
 *
 * No case reads the real ~/.claude or signals a real process. HOME is
 * <s>/home, and bin/ps and bin/lsof, first on PATH, answer from a fixed table
 * of pids above any pid_max: 9000401 the hook (parent 9000402, this session's
 * claude), 9000403 this session's server, 9000404 a server whose claude
 * 9000405 is gone, 9000406 a server with no claude, 9000407 a server whose
 * claude is the test runner itself (alive), 9000408 not a server and 9000409
 * a server on another project's DB. lsof says 9000406 and 9000404 hold
 * held/.claude/tmb/trajectory.db. `kill -0` fails on every fake pid, so clean
 * mode never signals anything.
 *
 * project/ is a git repo (2 commits, 2 dirty paths, manifests one level down)
 * whose DB holds 2 open issues, 2 pending/running tasks and a warm world
 * model; dbs/ holds cold, empty, stale, multi-repo and old-schema DBs; homes/
 * holds the ~/.claude layouts orphan-scan reads (old-layout, zero-byte, live,
 * cache, other-pinned, legacy, all), each beside another project's DBs and
 * cache versions where that matters; skew/tmb/ holds versioned plugin roots;
 * dup/ and legacy-config/ hold installed_plugins.json and settings.json
 * variants. Payload placeholders, corpus_env, corpus_cwd, corpus_stdin,
 * corpus_expect and corpus_divergent read as in hooks-swe-run-parity.suite.ts,
 * plus @SLUG@ for project/'s ~/.claude/projects slug; <s>/bin stays first on
 * PATH whatever corpus_env sets. The gate × payload ×
 * locale (C, en_US.UTF-8) runs split across
 * hooks-session-scans-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { projectSlug } from '../hooks/orphan-scan.js';
import { corpusFiles, type CorpusPaths, noCmdPath } from './hooks-swe-run-parity.suite.js';
import { goldenBash, goldenRoots, sandboxSha, settledTree } from './golden.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8').replace('PRAGMA journal_mode = WAL;', '');
const LEGACY_SETTINGS = join(PLUGIN_ROOT, 'tests/l3-integration/hooks/fixtures/legacy-user-settings.json');
export const SESSION_SCAN_GATES = ['orphan-scan', 'session-start-prescan'] as const;
const MIN_CORPUS: Record<string, number> = { 'orphan-scan': 10, 'session-start-prescan': 8 };
const LOCALES = ['C', 'en_US.UTF-8'];
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
export const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
export const HELD_DB = 'held/.claude/tmb/trajectory.db';
export const OTHER_DB = 'other/.claude/tmb/trajectory.db';
export const SELF_PID = '9000401';
const HOUR_MS = 3_600_000;

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_HOOKS_SQLITE',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_CONFIG_DIR',
  'TMB_INSTALLED_JSON',
  'TMB_SKIP_AUTO_PRESCAN',
  'TMB_DOCTOR_BUDGET_MS',
  'TMB_REVIEW_GRACE_HOURS',
  'TMB_STALE_RUNNING_HOURS',
  'TMB_ORPHAN_SCAN_CLEAN',
  'TMB_ORPHAN_SCAN_HOME',
  'TMB_ORPHAN_SCAN_PROJECT_DIR',
  'TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE',
  'TMB_ORPHAN_SCAN_SELF_PID',
  'LANG',
  'LC_CTYPE',
  'LC_COLLATE',
];

/** pid → [ppid, command] for bin/ps; <runner> is the live claude of 9000407. */
export function processTable(runner: number): ReadonlyMap<string, readonly [string, string]> {
  return new Map<string, readonly [string, string]>([
    [SELF_PID, ['9000402', 'bash /x/scripts/hooks/orphan-scan.sh']],
    ['9000402', ['1', '/usr/local/bin/claude --resume']],
    ['9000403', ['9000402', 'node /x/mcp/trajectory-server/dist/index.js']],
    ['9000404', ['9000405', 'node /x/mcp/trajectory-server/dist/index.js']],
    ['9000405', ['1', 'claude']],
    ['9000406', ['1', 'node /x/mcp/trajectory-server/dist/index.js']],
    ['9000407', [String(runner), 'node /x/mcp/trajectory-server/dist/index.js']],
    [String(runner), ['1', 'claude']],
    ['9000408', ['1', 'python other.py']],
    ['9000409', ['1', 'node /y/mcp/trajectory-server/dist/index.js']],
  ]);
}

function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** orphan-scan.sh stops scanning 4 s after its first `date +%s`, so a recording on a loaded machine would lose report lines. */
const FROZEN_DATE_STUB = '#!/bin/sh\n[ "$1" = +%s ] && { echo 1700000000; exit 0; }\nexec /bin/date "$@"\n';

/** bin/ps and bin/lsof over processTable: sh scripts, so the 4 s scan deadline never hangs on a stub's startup. */
export function writeProcessStubs(bin: string, s: string, runner: number): void {
  mkdirSync(bin, { recursive: true });
  const rows = [...processTable(runner)].map(([pid, [ppid, cmd]]) => `  ${pid}) ppid=${ppid} cmd=${shQuote(cmd)} ;;`);
  const ps = [
    '#!/bin/sh',
    'fmt= pid=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -o) fmt=$2; shift 2 ;;',
    '    -p) pid=$2; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'case "$pid" in',
    ...rows,
    '  *) exit 1 ;;',
    'esac',
    'case "$fmt" in',
    `  ppid=) printf '%5s\\n' "$ppid" ;;`,
    `  command=) printf '%s\\n' "$cmd" ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  const lsof = [
    '#!/bin/sh',
    '[ "$1" = -t ] && [ "$2" = -- ] || exit 1',
    'case "$3" in',
    `  ${shQuote(join(s, HELD_DB))}) printf '%s\\n' 9000406 9000404 9000406 ;;`,
    `  ${shQuote(join(s, OTHER_DB))}) printf '%s\\n' 9000409 ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'ps'), ps);
  writeFileSync(join(bin, 'lsof'), lsof);
  writeFileSync(join(bin, 'date'), FROZEN_DATE_STUB);
  for (const stub of ['ps', 'lsof', 'date']) chmodSync(join(bin, stub), 0o755);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function json(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A DB with only plugin_meta at <version>, as old layouts left them. */
function metaDb(path: string, version: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER)');
    db.prepare('INSERT INTO plugin_meta (schema_version) VALUES (?)').run(version);
  } finally {
    db.close();
  }
}

function fullDb(path: string, fill: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    fill(db);
  } finally {
    db.close();
  }
}

function repo(db: DatabaseSync, name: string, path: string, fileCount: number, scannedAt: string): void {
  db.prepare('INSERT INTO repos (name, path, file_count, last_scanned_at) VALUES (?, ?, ?, ?)').run(name, path, fileCount, scannedAt);
}

function warmDirectory(db: DatabaseSync, repoName: string): void {
  db.prepare("INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count) VALUES (?, '.', NULL, 'root', 'readme', 7)").run(repoName);
}

function git(cwd: string, home: string, ...args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Corpus',
      GIT_AUTHOR_EMAIL: 'corpus@example.invalid',
      GIT_COMMITTER_NAME: 'Corpus',
      GIT_COMMITTER_EMAIL: 'corpus@example.invalid',
      GIT_AUTHOR_DATE: T1,
      GIT_COMMITTER_DATE: T1,
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function cacheTree(home: string, versions: readonly string[]): string {
  const cache = join(home, '.claude/plugins/cache');
  for (const v of versions) mkdirSync(join(cache, v), { recursive: true });
  return cache;
}

function installed(path: string, plugins: Record<string, { scope: string; projectPath?: string; installPath: string; version: string }[]>): void {
  json(path, { version: 2, plugins });
}

/** The sandbox every case starts from; <runner> is the live claude pid of 9000407. */
export function buildSessionScansSandbox(s: string, runner: number): void {
  rmSync(s, { recursive: true, force: true });
  const project = join(s, 'project');
  const other = join(s, 'other');
  const slug = projectSlug(project);
  const otherSlug = projectSlug(other);
  const now = Date.now();
  const warmAt = new Date(now - 2.5 * HOUR_MS).toISOString();
  const staleAt = new Date(now - 10 * 24 * HOUR_MS).toISOString();
  const home = join(s, 'home');
  mkdirSync(home, { recursive: true });
  writeProcessStubs(join(s, 'bin'), s, runner);

  for (const [file, text] of [
    ['README.md', '# corpus\n'],
    ['src/main.ts', 'export {};\n'],
    ['src/util.ts', 'export const x = 1;\n'],
    ['dist/x.js', '"use strict";\n'],
    ['node_modules/m/i.js', 'module.exports = 1;\n'],
    ['.claude/settings.json', '{}\n'],
    ['web/package.json', '{"name":"web"}\n'],
    ['api/pyproject.toml', '[project]\nname = "api"\n'],
    ['a-b/go.mod', 'module a-b\n'],
    ['a/Cargo.toml', '[package]\nname = "a"\n'],
    ['_tools/Gemfile', "source 'https://rubygems.org'\n"],
    ['Zeta/composer.json', '{}\n'],
  ] as const) {
    write(join(project, file), text);
  }
  git(project, home, 'init', '-q', '-b', 'main');
  git(project, home, 'add', '-A');
  git(project, home, 'commit', '-q', '-m', 'first');
  write(join(project, 'src/main.ts'), 'export const main = 1;\n');
  git(project, home, 'commit', '-q', '-am', 'second');
  write(join(project, 'README.md'), '# corpus, edited\n');
  write(join(project, 'notes.txt'), 'untracked\n');
  write(join(project, '.claude/settings.local.json'), `${JSON.stringify({ enabledPlugins: { 'tmb@trustmybot': true, 'tmb@trustmybot-dev': true } })}\n`);
  mkdirSync(join(s, 'empty-repo'));
  git(join(s, 'empty-repo'), home, 'init', '-q', '-b', 'main');
  mkdirSync(join(s, 'fresh'));
  mkdirSync(join(s, 'old-project'));

  fullDb(join(s, PROJECT_DB), (db) => {
    const issue = db.prepare('INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    issue.run(1, 'first', 'open', T1, T1);
    issue.run(2, 'second', 'open', T1, T1);
    issue.run(3, 'third', 'closed', T1, T1);
    const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, 1, ?, 'd', ?, ?, ?)");
    task.run(10, 'feat/pending', 'pending', T1, T1);
    task.run(11, 'feat/running', 'running', T1, T1);
    task.run(12, 'feat/completed', 'completed', T1, T1);
    repo(db, 'plugin', project, 7, warmAt);
    warmDirectory(db, 'plugin');
  });
  fullDb(join(s, 'dbs/cold.db'), (db) => repo(db, 'plugin', project, 0, warmAt));
  fullDb(join(s, 'dbs/empty.db'), (db) => repo(db, 'empty-repo', join(s, 'empty-repo'), 0, warmAt));
  fullDb(join(s, 'dbs/stale.db'), (db) => {
    repo(db, 'plugin', project, 7, staleAt);
    warmDirectory(db, 'plugin');
  });
  fullDb(join(s, 'dbs/multi.db'), (db) => {
    repo(db, 'plugin', project, 7, warmAt);
    repo(db, 'web', '../project/web/', 1, warmAt);
    repo(db, 'ghost', join(s, 'missing'), 0, warmAt);
    repo(db, 'odd|name', project, 0, warmAt);
    warmDirectory(db, 'plugin');
  });
  fullDb(join(s, 'dbs/old-schema.db'), (db) => {
    db.exec('UPDATE plugin_meta SET schema_version = 30');
    repo(db, 'plugin', project, 7, warmAt);
    warmDirectory(db, 'plugin');
  });
  metaDb(join(s, HELD_DB), 53);
  metaDb(join(s, OTHER_DB), 53);
  write(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));

  const pinnedHere = { scope: 'local', projectPath: project, installPath: '', version: '1.1.0' };
  const homeCache = cacheTree(home, ['trustmybot/tmb/1.1.0']);
  installed(join(home, '.claude/plugins/installed_plugins.json'), {
    'tmb@trustmybot': [{ ...pinnedHere, installPath: join(homeCache, 'trustmybot/tmb/1.1.0') }],
  });

  const homes = join(s, 'homes');
  metaDb(join(homes, 'old-layout/.claude/projects', slug, 'trajectory.db'), 30);
  metaDb(join(homes, 'old-layout/.claude/projects', slug, 'memory/trajectory.db'), 53);
  write(join(homes, 'zero-byte/.claude/projects', slug, 'memory/trajectory.db'), '');
  metaDb(join(homes, 'live/.claude/projects', slug, 'trajectory.db'), 30);
  write(join(homes, 'legacy/.claude/tmb/trajectory.db'), '');

  const cacheHome = (h: string, versions: readonly string[]): void => {
    const cache = cacheTree(h, versions);
    installed(join(h, '.claude/plugins/installed_plugins.json'), {
      'tmb@trustmybot': [
        { ...pinnedHere, installPath: join(cache, 'trustmybot/tmb/1.1.0') },
        { scope: 'local', projectPath: other, installPath: join(cache, 'trustmybot/tmb/1.2.0'), version: '1.2.0' },
      ],
      'othertool@other': [{ scope: 'user', installPath: join(cache, 'other/othertool/0.9.0'), version: '0.9.0' }],
    });
  };
  const fullCache = ['trustmybot/tmb/1.0.0', 'trustmybot/tmb/1.1.0', 'trustmybot/tmb/1.2.0', 'trustmybot-dev/tmb/1.2.0-dev.5', 'other/othertool/1.0.0'];
  cacheHome(join(homes, 'cache'), fullCache);
  symlinkSync(join(homes, 'cache/.claude/plugins/cache/trustmybot/tmb/1.0.0'), join(homes, 'cache/.claude/plugins/cache/trustmybot/tmb/link'));
  write(join(homes, 'cache/.claude/plugins/cache/trustmybot/tmb/notes.txt'), 'not a version\n');
  cacheHome(join(homes, 'other-pinned'), ['trustmybot/tmb/1.1.0', 'trustmybot/tmb/1.2.0']);
  for (const h of ['other-pinned', 'all']) {
    metaDb(join(homes, h, '.claude/projects', otherSlug, 'trajectory.db'), 30);
    write(join(homes, h, '.claude/projects', otherSlug, 'memory/trajectory.db'), '');
  }
  cacheHome(join(homes, 'all'), fullCache);
  metaDb(join(homes, 'all/.claude/projects', slug, 'trajectory.db'), 30);
  write(join(homes, 'all/.claude/projects', slug, 'memory/trajectory.db'), '');
  write(join(homes, 'all/.claude/tmb/trajectory.db'), '');

  for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.10.0-rc.1', '1.2.0-dev.5', 'latest']) {
    json(join(s, 'skew/tmb', v, '.claude-plugin/plugin.json'), { name: 'tmb', version: v });
  }

  installed(join(s, 'dup/installed_plugins.json'), {
    'tmb@trustmybot': [{ ...pinnedHere, installPath: join(s, 'skew/tmb/1.1.0') }],
    'tmb@trustmybot-dev': [{ scope: 'project', projectPath: project, installPath: join(s, 'skew/tmb/1.2.0-dev.5'), version: '1.2.0-dev.5' }],
    'tmb@trustmybot-rc': [{ scope: 'local', projectPath: project, installPath: join(s, 'skew/tmb/1.2.0'), version: '1.2.0' }],
  });

  write(join(s, 'legacy-config/settings.json'), readFileSync(LEGACY_SETTINGS, 'utf8'));
  installed(join(s, 'legacy-config/plugins/installed_plugins.json'), {
    'tmb@trustmybot': [
      { scope: 'local', projectPath: join(s, 'old-project'), installPath: join(s, 'skew/tmb/1.0.0'), version: '1.0.2' },
      { scope: 'local', projectPath: project, installPath: join(s, 'skew/tmb/1.0.0'), version: '1.0.0' },
      { scope: 'local', projectPath: join(s, 'gone'), installPath: join(s, 'skew/tmb/1.0.0'), version: '1.0.1' },
    ],
  });
}

/** Every path under <root> but SQLite's side files: a dir as null, a symlink as its target, a file as its sha256, a .git dir unopened. */
export function scanTree(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (/-(wal|shm|journal)$/.test(name)) continue;
      const path = join(dir, name);
      const rel = relative(root, path);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(path)}`;
      else if (st.isDirectory()) {
        out[`${rel}/`] = null;
        if (name !== '.git') walk(path);
      } else out[rel] = sandboxSha(path, root);
    }
  };
  walk(root);
  return out;
}

type SideExpect = string | Record<string, string>;
type Expect = string | { bash: SideExpect; ts: SideExpect };

interface Case {
  input: Buffer;
  env: Record<string, string | null>;
  cwd: string;
  expect: Expect;
  divergent: string | undefined;
}

/** hooks-swe-run-parity.suite.ts's materialize, with @SLUG@ the project's ~/.claude/projects slug. */
export function materialize(file: string, s: string, paths: CorpusPaths): Case {
  const text = readFileSync(file, 'utf8')
    .replaceAll('@SLUG@', projectSlug(join(s, 'project')))
    .replaceAll('@SANDBOX@', s)
    .replaceAll('@NOJQ_PATH@', paths.noJq)
    .replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
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

function byLocale(expect: SideExpect, locale: string): string {
  return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}

/** The env a case runs in: the sandbox HOME and project, its corpus_env, then <s>/bin first on PATH. */
export function sessionScanEnv(s: string, gate: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
    TMB_DOCTOR_BUDGET_MS: '3000',
    LC_ALL: locale,
    PWD: cwd,
  });
  if (gate === 'orphan-scan') Object.assign(env, { TMB_ORPHAN_SCAN_SELF_PID: SELF_PID });
  else Object.assign(env, { TMB_SKIP_AUTO_PRESCAN: '1' });
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  env.PATH = `${join(s, 'bin')}:${env.PATH ?? ''}`;
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv, cwd: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-session-scans-stdin-'));
  const file = join(dir, 'stdin');
  writeFileSync(file, input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `empty`: no stdout or stderr; anything else: a phrase of the output. */
function assertExpect(side: string, r: Run, expect: string): void {
  const output = r.stdout + r.stderr;
  if (expect === 'empty') {
    assert.equal(output, '', `${side}: no output`);
    return;
  }
  assert.ok(output.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${output.slice(0, 1600)}`);
}

const cases = SESSION_SCAN_GATES.flatMap((gate) => corpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));

export function sessionScansParityShard(k: number, n: number): void {
  describe(
    `orphan-scan and session-start-prescan parity: bash vs node over a sandbox copy (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ || !HAVE_GIT) && 'the .sh side needs the sqlite3 CLI, jq and git' },
    () => {
      let base: string;
      let s: string;
      let template: string;
      let paths: CorpusPaths;
      const fresh = (): void => {
        rmSync(s, { recursive: true, force: true });
        cpSync(template, s, { recursive: true, verbatimSymlinks: true });
      };
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-session-scans-parity-')));
        s = join(base, 'sandbox');
        template = join(base, 'template');
        buildSessionScansSandbox(s, process.pid);
        cpSync(s, template, { recursive: true, verbatimSymlinks: true });
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        for (const gate of SESSION_SCAN_GATES) {
          it(`the ${gate} corpus has at least ${MIN_CORPUS[gate]} payloads, each with an expectation`, () => {
            const files = corpusFiles(gate);
            assert.ok(files.length >= MIN_CORPUS[gate], `${files.length} payloads`);
            for (const f of files) {
              const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noJq: '', noSqlite: '' }) as { expect: Expect; divergent?: string };
              if (divergent === undefined) assert.ok(typeof expect === 'string' ? expect !== '' : LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''), `${f}: an expectation`);
              else
                assert.ok(
                  typeof expect === 'object' && 'bash' in expect && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                  `${f}: a divergent case names why and expects each side in every locale`,
                );
            }
          });
        }

        it('the stubs answer for the fake pids and nothing else', () => {
          fresh();
          const env = sessionScanEnv(s, 'orphan-scan', 'C', {}, s);
          const ps = (...args: string[]): string => spawnSync('ps', args, { env, encoding: 'utf8' }).stdout;
          assert.equal(ps('-o', 'ppid=', '-p', '9000404'), '9000405\n');
          assert.equal(ps('-p', '9000403', '-o', 'command='), 'node /x/mcp/trajectory-server/dist/index.js\n');
          assert.equal(ps('-o', 'command=', '-p', String(process.pid)), 'claude\n');
          assert.equal(spawnSync('ps', ['-o', 'ppid=', '-p', '1'], { env }).status, 1);
          assert.equal(spawnSync('lsof', ['-t', '--', join(s, HELD_DB)], { env, encoding: 'utf8' }).stdout, '9000406\n9000404\n9000406\n');
          assert.equal(spawnSync('lsof', ['-t', '--', join(s, PROJECT_DB)], { env }).status, 1);
        });
      }

      for (const { gate, f, locale } of shardOf(cases, k, n)) {
        it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
          const env = sessionScanEnv(s, gate, locale, c.env, c.cwd);
          const { tree: bashTree, ...bash } = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base, '@SLUG@': projectSlug(join(s, 'project')), '@OTHER_SLUG@': projectSlug(join(s, 'other')) }), () => {
            fresh();
            const setup = scanTree(s);
            return { ...run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c.input, env, c.cwd), tree: settledTree(setup, scanTree(s)) };
          });
          fresh();
          const setup = scanTree(s);
          const node = run(process.execPath, [HOOKS_BUNDLE, gate], c.input, env, c.cwd);
          const nodeTree = settledTree(setup, scanTree(s));
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          if (c.divergent === undefined) {
            assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.ok(
              node.stdout + node.stderr !== bash.stdout + bash.stderr || !isDeepStrictEqual(nodeTree, bashTree),
              `divergent (${c.divergent}): the sides must differ`,
            );
            assertExpect('bash', bash, byLocale(expect.bash, locale));
            assertExpect('ts', node, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
