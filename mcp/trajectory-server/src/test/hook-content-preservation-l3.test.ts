/**
 * The hook-content-preservation l3 bash suite in node:test (GH 1692): guards
 * against information loss disguised as a reorder (B14: a hook refactor
 * silently deleted recovery steps while only changing order). Each case runs
 * a gate as `node dist/hooks.js <gate>` from a fixture git project
 * (CLAUDE_PROJECT_DIR pinned to it, PWD set), masks the volatile lines and
 * every absolute path token, and compares the whitespace-token multiset with
 * a golden in tests/l3-integration/hooks/fixtures/. TMB_UPDATE_GOLDENS=1
 * rewrites the goldens instead.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { contextOf, makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { gateEnv, git } from './git-push-guard-l3.js';

const FIXTURES = join(PLUGIN_ROOT, 'tests/l3-integration/hooks/fixtures');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** <text> with each line passed through <edit>, a line it maps to null dropped (a sed script). */
function perLine(text: string, edit: (line: string) => string | null): string {
  return text
    .split('\n')
    .map(edit)
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** The whitespace-split tokens of <text>, sorted. */
const tokens = (text: string) =>
  text
    .split(/\s+/)
    .filter((t) => t !== '')
    .sort();

const PRESCAN_LABELS = [
  'Plugin version',
  'Top-level dirs',
  'Stacks detected',
  'World model',
  'Trajectory DB',
  'Git branch',
  'Open issues',
  'Pending tasks',
  'Last 5 commits',
];
const PRESCAN_DROPPED = [/^ {2}[0-9a-f]* /, /^ {2}✨/, /^ {2}🐛/, /^ {2}✍️/, /^ {2}🔧/, /^ {2}📦/, /^ {2}🧪/];

describe('hook-content-preservation l3', () => {
  let sb: Sandbox;
  let project: string;

  /** The sandbox root, the plugin root and any word holding two or more slashes from the root, as __PATH__. */
  function maskPaths(text: string): string {
    return text
      .replace(new RegExp(escapeRe(sb.dir), 'g'), '__PATH__')
      .replace(new RegExp(escapeRe(PLUGIN_ROOT), 'g'), '__PATH__')
      .replace(/\/[^\s/]*\/\S*/g, '__PATH__');
  }

  const maskPrescan = (text: string) =>
    maskPaths(
      perLine(text, (line) => {
        let l = line;
        for (const label of PRESCAN_LABELS) l = l.replace(new RegExp(`${escapeRe(label)}:.*`), `${label}: __VOLATILE__`);
        return PRESCAN_DROPPED.some((re) => re.test(l)) ? null : l;
      }),
    );

  const maskActivation = (text: string) => maskPaths(perLine(text, (l) => l.replace(/pending=#[0-9]+:.*/, 'pending=__VOLATILE__')));

  const maskHealth = (text: string) =>
    maskPaths(
      perLine(text, (line) =>
        line
          .replace(/\(issue #[0-9]+\)/g, '__VOLATILE__')
          .replace(/^DB:.*$/, 'DB: __VOLATILE__')
          .replace(/tmb@[^ ]*/g, 'tmb@__VOLATILE__')
          .replace('🚨 ', '')
          .replace('⛔ ', ''),
      ),
    );

  function checkGolden(masked: string, golden: string, label: string): void {
    const path = join(FIXTURES, golden);
    if (process.env.TMB_UPDATE_GOLDENS === '1') {
      writeFileSync(path, `${masked}\n`);
      return;
    }
    assert.deepEqual(tokens(masked), tokens(readFileSync(path, 'utf8')), `${label}: token multisets differ`);
  }

  /** hookSpecificOutput.additionalContext of <gate>'s stdout, run from the fixture project. */
  function context(gate: string, env: NodeJS.ProcessEnv, input = ''): string {
    const base: NodeJS.ProcessEnv = { ...gateEnv(sb, project), CLAUDE_PROJECT_DIR: project };
    const path = env.PATH === undefined ? base.PATH : `${env.PATH}${delimiter}${base.PATH}`;
    const r = runGate(gate, { cwd: project, input, env: { ...base, ...env, PATH: path } });
    return contextOf(r.stdout);
  }

  function stubDir(name: string, pgrep: string): string {
    const dir = join(sb.dir, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'pgrep'), `#!/usr/bin/env bash\n${pgrep}\n`, { mode: 0o755 });
    return dir;
  }

  function newDb(name: string, statements: string): string {
    const path = join(sb.dir, name);
    const d = new DatabaseSync(path);
    try {
      d.exec(statements);
    } finally {
      d.close();
    }
    return path;
  }

  before(() => {
    sb = makeSandbox('hook-content-preservation');
    project = join(sb.dir, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'README.md'), 'fixture\n');
    git(sb.env, project, 'init', '-q', '-b', 'main');
    git(sb.env, project, 'add', 'README.md');
    git(sb.env, project, 'commit', '-q', '-m', 'fixture');
  });
  after(() => sb.remove());

  it('session-start-prescan: masked token multiset matches golden', () => {
    const db = newDb(
      'prescan.db',
      `CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')));
       CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')));
       CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
       INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
       INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');`,
    );
    const out = context('session-start-prescan', { TRAJECTORY_DB_PATH: db });
    assert.notEqual(out, '', 'session-start-prescan produced no output');
    checkGolden(maskPrescan(out), 'session-start-prescan.golden.txt', 'session-start-prescan stable tokens');
  });

  it('activation-routine: masked token multiset matches golden', () => {
    const db = newDb(
      'activation.db',
      `CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
       CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')));
       INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true');
       INSERT INTO issues (objective, status) VALUES ('test issue', 'open');`,
    );
    const out = context(
      'activation-routine',
      { PATH: stubDir('live-stubs', 'echo 99999'), TRAJECTORY_DB_PATH: db },
      JSON.stringify({ prompt: '@bro status', transcript_path: '' }),
    );
    assert.notEqual(out, '', 'activation-routine produced no output');
    checkGolden(maskActivation(out), 'activation-routine.golden.txt', 'activation-routine stable tokens');
  });

  it('mcp-health-check: masked token multiset matches golden', () => {
    const out = context(
      'mcp-health-check',
      { PATH: stubDir('stubs', 'exit 1'), TMB_MCP_HEALTH_INTERVAL_S: '0.05' },
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'golden-test', source: 'startup' }),
    );
    assert.notEqual(out, '', 'mcp-health-check produced no output (expected the soft not-detected note)');
    checkGolden(maskHealth(out), 'mcp-health-check.golden.txt', 'mcp-health-check stable tokens');
  });
});
