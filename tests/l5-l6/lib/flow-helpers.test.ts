// node:test suite for flow-helpers.ts: every case of flow-helpers.test.sh (scratch projects carry
// no CLAUDE.md, the TEST MODE preamble and composed prompt, the reonboard and roundtable-slash
// hooks on a composed prompt, the chain-seed scan-row drop, the claude call disabling the
// project-scoped trajectory-server) plus the state dir, scratch setup, seeding, preservation,
// the git snapshot, the claude run against a stub claude, and cleanup. The hooks run through the
// built dist (dist/hooks.js <gate>); no test calls the real claude.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/lib/flow-helpers.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import {
  L5_DOGFOOD_DIR,
  l5CleanupProject,
  l5ComposeTestPrompt,
  l5InitStateDir,
  l5PreserveTrajectory,
  l5RunClaude,
  l5ScoreFlow,
  l5SeedDb,
  l5SetupScratchProject,
  l5TestPromptPrefix,
  l5WritePreRunGitSnapshot,
  PLUGIN_ROOT,
  tmbTestStateDir,
} from './flow-helpers.ts';
import { DISABLE_PROJECT_TRAJECTORY_SERVER, l6cRunStep } from './l6-chain-helpers.ts';

const HAVE_SQLITE3 = spawnSync('sqlite3', ['-version']).status === 0;
const NO_SQLITE3 = !HAVE_SQLITE3 && 'sqlite3 not installed';
const HOOKS_JS = join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'dist', 'hooks.js');

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'tmb-flow-helpers.'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const HOME = tempDir();
const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME, TMB_DISABLE_REMOTE_SYNC: '1' };
delete baseEnv.FLOW_NAME;
delete baseEnv.RUN_ID;

function quietStderr<T>(fn: () => T): { value: T; stderr: string } {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), stderr };
  } finally {
    process.stderr.write = write;
  }
}

function scratchProject(): string {
  const dir = l5SetupScratchProject(baseEnv);
  roots.push(dir);
  return dir;
}

function newProject(fixture: string): string {
  const project = scratchProject();
  assert.equal(l5SeedDb(project, fixture, { env: baseEnv }), 0);
  return project;
}

function dbOf(project: string): string {
  return join(project, '.claude', 'tmb', 'trajectory.db');
}

function query(db: string, sql: string): unknown[] {
  const handle = new DatabaseSync(db);
  try {
    return handle.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    handle.close();
  }
}

function count(db: string, sql: string): number {
  return Number((query(db, sql)[0] as { n: number }).n);
}

function runHook(gate: string, project: string, db: string, prompt: string): string {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', HOOKS_JS, gate], {
    input: JSON.stringify({ prompt }),
    env: { ...baseEnv, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
  });
  return r.stdout ?? '';
}

const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), debug: process.env.TMB_DEBUG_TRAJECTORY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'again' }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', duration_ms: 1234 }) + '\\n');
process.stderr.write('stub warning\\n');
`;

function stubClaudeEnv(extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; record: string } {
  const bin = tempDir('tmb-flow-bin.');
  writeFileSync(join(bin, 'claude'), STUB_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  const record = join(bin, 'record.jsonl');
  return { env: { ...baseEnv, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_RECORD: record, ...extra }, record };
}

function calls(record: string): { argv: string[]; cwd: string; debug?: string; token?: string }[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const PREAMBLE = l5TestPromptPrefix();
const COMPOSED = l5ComposeTestPrompt('/roundtable topic');

describe('scratch projects', () => {
  for (const fixture of ['onboarding-named', 'empty']) {
    test(`${fixture} fixture: scratch project has no CLAUDE.md`, { skip: NO_SQLITE3 }, () => {
      const project = newProject(fixture);
      assert.equal(existsSync(join(project, 'CLAUDE.md')), false);
    });
  }

  test('l5SetupScratchProject: a git repo on main with one commit, the .gitignore and the standalone marker', () => {
    const project = scratchProject();
    assert.equal(basename(project).startsWith('tmb-l5-'), true);
    const git = (...args: string[]) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' }).stdout.trim();
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git('log', '--format=%s|%ae|%an'), 'init|l6@l6.test|L5 Test');
    assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), 'init\n');
    assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.claude/\n');
    assert.equal(readFileSync(join(project, '.claude', 'tmb', 'standalone'), 'utf8'), '');
    assert.equal(git('status', '--porcelain'), '');
  });

  test('l5InitStateDir: creates .claude/tmb and an empty standalone marker', () => {
    const project = tempDir();
    l5InitStateDir(project);
    assert.equal(readFileSync(join(project, '.claude', 'tmb', 'standalone'), 'utf8'), '');
  });

  test('l5SeedDb: a missing fixture returns 1 with a stderr line', () => {
    const project = tempDir();
    const { value, stderr } = quietStderr(() => l5SeedDb(project, 'no-such-fixture'));
    assert.equal(value, 1);
    assert.match(stderr, new RegExp(`✗ fixture not found: ${L5_DOGFOOD_DIR}/fixtures/no-such-fixture\\.sql`));
  });
});

describe('TEST MODE preamble', () => {
  test('compose: starts with the unchanged preamble', () => {
    assert.equal(COMPOSED.slice(0, PREAMBLE.length), PREAMBLE);
    assert.equal(readFileSync(join(import.meta.dirname, 'flow-helpers.sh'), 'utf8').includes(PREAMBLE), true);
  });

  test('preamble pins the /onboard sandbox answer to no (GH 1549)', () => {
    assert.ok(PREAMBLE.includes("sandbox_enforcement: 'no'"));
  });

  test('preamble carries no /onboard token, which would suppress the reonboard hint (GH 1553)', () => {
    assert.equal(PREAMBLE.includes('/onboard'), false);
  });

  test('compose: row prompt follows after exactly one blank line', () => {
    assert.equal(COMPOSED, `${PREAMBLE}\n\n/roundtable topic`);
  });
});

describe('hooks on a composed prompt (dist/hooks.js)', () => {
  test('reonboard hook: composed remote-setup prompt on an onboarded DB emits the reonboard hint (GH 1553)', () => {
    const project = tempDir();
    mkdirSync(join(project, '.claude', 'tmb'), { recursive: true });
    const db = dbOf(project);
    const handle = new DatabaseSync(db);
    handle.exec("CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT); INSERT INTO plugin_config VALUES ('onboarded', 'true');");
    handle.close();
    const out = runHook('prompt-intent-hints', project, db, l5ComposeTestPrompt('@bro this project needs to live on a remote — set it up.'));
    assert.ok(out.includes('reonboard-intent hint'), out);
  });

  const slashRows = (project: string) => count(dbOf(project), "SELECT COUNT(*) AS n FROM audit WHERE event_type='roundtable_slash_invoked'");

  test('slash hook: composed /roundtable prompt writes one roundtable_slash_invoked row', { skip: NO_SQLITE3 }, () => {
    const project = newProject('onboarding-named');
    runHook('roundtable-slash-detect', project, dbOf(project), COMPOSED);
    assert.equal(slashRows(project), 1);
  });

  test('slash hook: composed plain prompt writes no roundtable_slash_invoked row', { skip: NO_SQLITE3 }, () => {
    const project = newProject('onboarding-named');
    runHook('roundtable-slash-detect', project, dbOf(project), l5ComposeTestPrompt('just a normal prompt'));
    assert.equal(slashRows(project), 0);
  });
});

describe('deep_scan_completed deleters cascade audit_embeddings (GH 1460)', () => {
  function embeddedScanProject(): string {
    const project = newProject('onboarding-named');
    const handle = new DatabaseSync(dbOf(project));
    handle.exec(
      "INSERT INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) SELECT id, X'00', 'test', datetime('now') FROM audit WHERE event_type = 'deep_scan_completed';",
    );
    handle.close();
    return project;
  }

  function assertScanRowDroppedCleanly(project: string): void {
    assert.deepEqual(query(dbOf(project), 'PRAGMA foreign_key_check'), []);
    assert.equal(count(dbOf(project), "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'deep_scan_completed'"), 0);
  }

  test('chain seed before-05: embedded deep_scan_completed row dropped without dangling FK rows', { skip: NO_SQLITE3 }, () => {
    const project = embeddedScanProject();
    assert.equal(count(dbOf(project), 'SELECT COUNT(*) AS n FROM audit_embeddings'), 1);
    const r = spawnSync('sqlite3', [dbOf(project)], {
      input: readFileSync(join(L5_DOGFOOD_DIR, 'l6-chain', 'seeds', 'before-05-first-task-hits-gate.sql')),
    });
    assert.equal(r.status, 0, String(r.stderr));
    assertScanRowDroppedCleanly(project);
  });

  for (const rowDir of [
    join(L5_DOGFOOD_DIR, 'rows', '05', '05-first-task-hits-gate'),
    join(L5_DOGFOOD_DIR, 'rows', '05', '05.03-codebase-memory-cold-start'),
  ]) {
    test(`${basename(rowDir)} setup-l5: embedded deep_scan_completed row dropped without dangling FK rows`, { skip: NO_SQLITE3 }, () => {
      const project = embeddedScanProject();
      spawnSync('bash', [join(rowDir, 'setup-l5.sh'), project, rowDir], { env: baseEnv, stdio: 'ignore' });
      assertScanRowDroppedCleanly(project);
    });
  }
});

describe('l6 chain helper', () => {
  test('claude call disables the project-scoped trajectory-server', () => {
    const project = tempDir();
    const row = tempDir();
    writeFileSync(join(row, 'prompt.txt'), 'row prompt\n');
    const { env, record } = stubClaudeEnv();
    quietStderr(() => l6cRunStep(project, row, join(project, 'turn.jsonl'), { env }));
    const [call] = calls(record);
    assert.equal(call.argv[call.argv.indexOf('--settings') + 1], '{"disabledMcpjsonServers":["trajectory-server"]}');
    assert.equal(DISABLE_PROJECT_TRAJECTORY_SERVER, '{"disabledMcpjsonServers":["trajectory-server"]}');
  });
});

describe('tmbTestStateDir', () => {
  test('<CLAUDE_PROJECT_DIR>/.claude/<manifest name>', () => {
    assert.equal(tmbTestStateDir(PLUGIN_ROOT, { ...baseEnv, CLAUDE_PROJECT_DIR: '/proj/x' }), '/proj/x/.claude/tmb');
  });

  test('the plugin name comes from the manifest at <plugin_root>', () => {
    const root = tempDir();
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"tmb-fork"}');
    assert.equal(tmbTestStateDir(root, { ...baseEnv, CLAUDE_PROJECT_DIR: '/proj/x' }), '/proj/x/.claude/tmb-fork');
  });

  test('without CLAUDE_PROJECT_DIR: the main checkout of the repo holding the lib', () => {
    const env = { ...baseEnv };
    delete env.CLAUDE_PROJECT_DIR;
    const common = spawnSync('git', ['-C', import.meta.dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
    assert.equal(tmbTestStateDir(PLUGIN_ROOT, env), `${dirname(common.stdout.trim())}/.claude/tmb`);
  });
});

describe('l5PreserveTrajectory', () => {
  test('copies trajectory.jsonl and trajectory.db into <state>/l5-trajectories/<flow>/<run_id>', () => {
    const project = tempDir();
    const state = tempDir();
    l5InitStateDir(project);
    writeFileSync(join(project, 'trajectory.jsonl'), '{"a":1}\n');
    writeFileSync(dbOf(project), 'db');
    l5PreserveTrajectory(project, 'flow-x', 'run-1', { env: { ...baseEnv, CLAUDE_PROJECT_DIR: state } });
    const dest = join(state, '.claude', 'tmb', 'l5-trajectories', 'flow-x', 'run-1');
    assert.equal(readFileSync(join(dest, 'trajectory.jsonl'), 'utf8'), '{"a":1}\n');
    assert.equal(readFileSync(join(dest, 'trajectory.db'), 'utf8'), 'db');
  });

  test('missing sources are skipped without error', () => {
    const project = tempDir();
    const state = tempDir();
    l5PreserveTrajectory(project, 'f', 'r', { env: { ...baseEnv, CLAUDE_PROJECT_DIR: state } });
    assert.equal(existsSync(join(state, '.claude', 'tmb', 'l5-trajectories', 'f', 'r', 'trajectory.db')), false);
  });
});

describe('l5WritePreRunGitSnapshot', () => {
  test('writes HEAD and branch when HEAD resolves', () => {
    const project = scratchProject();
    rmSync(join(project, '.claude'), { recursive: true });
    l5WritePreRunGitSnapshot(project);
    const head = spawnSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(readFileSync(join(project, '.claude', 'tmb', '_l5_pre_run_git.json'), 'utf8'), `{"head":"${head}","branch":"main"}\n`);
    assert.ok(existsSync(join(project, '.claude', 'tmb', 'standalone')));
  });

  test('writes nothing outside a repo', () => {
    const project = tempDir();
    l5WritePreRunGitSnapshot(project, { ...baseEnv, GIT_CEILING_DIRECTORIES: dirname(project) });
    assert.equal(existsSync(join(project, '.claude')), false);
  });
});

describe('l5RunClaude (stub claude)', () => {
  test('runs claude in the project with the composed prompt, stream-json into trajectory.jsonl, and returns 0', () => {
    const project = scratchProject();
    const { env, record } = stubClaudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', FLOW_NAME: '', RUN_ID: '' });
    const { value, stderr } = quietStderr(() => l5RunClaude(project, 'do it', { pluginRoot: '/plugin', env }));
    assert.equal(value, 0);
    const [call] = calls(record);
    assert.deepEqual(call.argv, [
      '--plugin-dir',
      '/plugin',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--include-hook-events',
      '--include-partial-messages',
      '--verbose',
      '-p',
      l5ComposeTestPrompt('do it'),
    ]);
    assert.deepEqual([call.debug, call.token], ['1', 'tok']);
    assert.equal(readFileSync(join(project, 'trajectory.jsonl'), 'utf8').split('\n').filter(Boolean).length, 3);
    assert.ok(existsSync(join(project, '.claude', 'tmb', '_l5_pre_run_git.json')));
    assert.match(stderr, /── claude invocation start ──\n {2}cwd: .*\n {2}plugin-dir: \/plugin\n {2}prompt: do it\n {2}jsonl: .*trajectory\.jsonl\n/);
    assert.match(stderr, /^ {2}\[claude-err\] stub warning$/m);
    assert.match(stderr, /── claude invocation end \(assistant_msgs=2, duration_ms=1234\) ──/);
  });

  test('FLOW_NAME and RUN_ID preserve the run log under the state dir', () => {
    const project = scratchProject();
    const state = tempDir();
    const { env } = stubClaudeEnv({ FLOW_NAME: 'flow-y', RUN_ID: 'run-9', CLAUDE_PROJECT_DIR: state });
    quietStderr(() => l5RunClaude(project, 'go', { env }));
    assert.ok(existsSync(join(state, '.claude', 'tmb', 'l5-trajectories', 'flow-y', 'run-9', 'trajectory.jsonl')));
  });

  test('a claude past TMB_CLAUDE_TIMEOUT is killed and the run still returns 0', () => {
    const project = scratchProject();
    const bin = tempDir('tmb-flow-bin.');
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const env = { ...baseEnv, PATH: `${bin}${delimiter}${process.env.PATH}`, TMB_CLAUDE_TIMEOUT: '1' };
    const { value, stderr } = quietStderr(() => l5RunClaude(project, 'slow', { env }));
    assert.equal(value, 0);
    assert.match(stderr, /assistant_msgs=0, duration_ms=0/);
  });

  test("a caller's FLOW_NAME and RUN_ID do not reach the runs, so no run log lands in the checkout's state dir", () => {
    assert.equal(baseEnv.FLOW_NAME, undefined);
    assert.equal(baseEnv.RUN_ID, undefined);
    const project = scratchProject();
    const { env } = stubClaudeEnv();
    quietStderr(() => l5RunClaude(project, 'go', { env }));
    const state = tmbTestStateDir(PLUGIN_ROOT, env);
    assert.ok(state !== null);
    assert.equal(existsSync(join(state, 'l5-trajectories', String(process.env.FLOW_NAME ?? '-'), String(process.env.RUN_ID ?? '-'))), false);
  });
});

describe('l5ScoreFlow', () => {
  test('returns the score-all fail count: 0 when every opt-in scorer config is absent', () => {
    const root = tempDir();
    assert.equal(l5ScoreFlow(join(root, 'none'), 'flow', join(root, 'none'), 'run'), 0);
  });
});

describe('l5CleanupProject', () => {
  test('removes the project dir', () => {
    const project = tempDir();
    l5CleanupProject(project, baseEnv);
    assert.equal(existsSync(project), false);
  });

  test('L5_KEEP_ARTIFACTS=1 keeps it', () => {
    const project = tempDir();
    l5CleanupProject(project, { ...baseEnv, L5_KEEP_ARTIFACTS: '1' });
    assert.ok(existsSync(project));
  });
});
