/**
 * Six small l3 bash suites in node:test (GH 1692): the attribution-footer and
 * orphan-scan gates run as `node dist/hooks.js <gate>` with CLAUDE_PROJECT_DIR
 * pinned and PWD set; the enums-stable lint runs as its node:test file and
 * its literal extractor runs as a node script; resolveTaskIdForTarget,
 * taskBySlug and repoRemotes run as shipped TS; the live Claude Code hook-env
 * proof runs only with TMB_L3_LIVE_CC=1.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeFooter } from '../hooks/attribution-footer.js';
import * as dbLib from '../hooks/lib/db.js';
import { repoRemotes } from '../hooks/lib/repo.js';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { gateEnv, git, has, hasNot, sql } from './git-push-guard-l3.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');

/** A `$(...)` capture: trailing newlines gone. */
const cap = (s: string) => s.replace(/\n+$/, '');

function schemaDb(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  try {
    d.exec(SCHEMA);
  } finally {
    d.close();
  }
  return path;
}

function execDb(path: string, statements: string): void {
  const d = new DatabaseSync(path);
  try {
    d.exec(statements);
  } finally {
    d.close();
  }
}

const TARGET_TASK_JS = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks/lib/target-task.js');

/** resolveTaskIdForTarget <target> '' <db> in a node child process, so its stderr warning is captured. */
function resolveInChild(target: string, db: string, env: NodeJS.ProcessEnv, cwd: string) {
  const script = 'const m = await import(process.argv[1]); process.stdout.write(await m.resolveTaskIdForTarget(process.argv[2], "", process.argv[3]));';
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script, TARGET_TASK_JS, target, db], {
    env,
    cwd,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, r.stderr);
  return { stdout: cap(r.stdout), stderr: cap(r.stderr) };
}

describe('attribution-footer l3', () => {
  const TMB_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code), powered by [Bro](https://github.com/trustmybot/plugin)';
  const BARE_CC = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  let sb: Sandbox;
  let stubDir: string;
  let editLog: string;

  const normalize = (body: string) => cap(normalizeFooter(body, gateEnv(sb, sb.dir)));
  const edited = () => existsSync(editLog);

  function runHook(payload: object): void {
    const env = gateEnv(sb, sb.dir);
    runGate('attribution-footer', { cwd: sb.dir, input: JSON.stringify(payload), env: { ...env, PATH: `${stubDir}${delimiter}${env.PATH}` } });
  }

  function writeStub(name: string, body: string): void {
    writeFileSync(join(stubDir, name), body, { mode: 0o755 });
  }

  before(() => {
    sb = makeSandbox('attribution-footer');
    stubDir = join(sb.dir, 'stubs');
    mkdirSync(stubDir);
    editLog = join(stubDir, 'edit.log');
    writeStub(
      'gh',
      `#!/usr/bin/env bash
case "$1 $2" in
  "pr view"|"issue view")
    printf '%s\\n\\n%s' "Stub body." '${BARE_CC}'
    ;;
  "pr edit"|"issue edit")
    body="\${!#}"
    printf '%s' "$body" > "${editLog}"
    ;;
esac
exit 0
`,
    );
    writeStub(
      'glab',
      `#!/usr/bin/env bash
case "$1 $2" in
  "mr view"|"issue view")
    printf '%s\\n' '${JSON.stringify({ description: `Glab body.\n\n${BARE_CC}` })}'
    ;;
  "mr update"|"issue update")
    body="\${!#}"
    printf '%s' "$body" > "${editLog}"
    ;;
esac
exit 0
`,
    );
  });
  after(() => sb.remove());

  it('bare Claude-Code footer is rewritten to the TMB footer', () => {
    const out = normalize(`Fixes the thing.\n\n${BARE_CC}`);
    has(out, TMB_FOOTER, 'TMB footer present after rewrite');
    assert.equal(out.split('\n').at(-1), TMB_FOOTER, 'body ends with exactly the TMB footer');
  });

  it('bare-CC line is stripped (not left alongside TMB footer)', () => {
    const out = normalize(`Fixes the thing.\n\n${BARE_CC}`);
    const bareOnly = out.split('\n').filter((l) => l.includes(BARE_CC) && !l.includes('powered by'));
    assert.deepEqual(bareOnly, [], 'no bare Claude-Code-only line remains');
  });

  it('normalize_footer is idempotent (twice == once)', () => {
    const once = normalize(`Body text.\n\n${BARE_CC}`);
    assert.equal(normalize(once), once, 'applying normalize twice equals once');
  });

  it('body already carrying the TMB footer is unchanged', () => {
    const already = `Already attributed.\n\n${TMB_FOOTER}`;
    assert.equal(normalize(already), already, 'TMB-footer body unchanged');
  });

  it('plain body gains the TMB footer', () => {
    const plain = normalize('Just a description.');
    has(plain, TMB_FOOTER, 'TMB footer appended to plain body');
    has(plain, 'Just a description.', 'original body text preserved');
  });

  it('gh pr create with a pull URL triggers an edit carrying the TMB footer', () => {
    rmSync(editLog, { force: true });
    runHook({ tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/o/r/pull/42\n' });
    assert.ok(edited(), 'expected gh edit to be called');
    has(readFileSync(editLog, 'utf8'), TMB_FOOTER, 'edit body carries the TMB footer');
  });

  it('gh issue create with an issues URL triggers an edit', () => {
    rmSync(editLog, { force: true });
    runHook({ tool_name: 'Bash', tool_input: { command: 'gh issue create --title x' }, tool_response: 'https://github.com/o/r/issues/7\n' });
    assert.equal(edited(), true, 'gh issue edit called');
  });

  it('non-create Bash command makes no edit call', () => {
    rmSync(editLog, { force: true });
    runHook({ tool_name: 'Bash', tool_input: { command: 'gh pr view 42' }, tool_response: 'some output\n' });
    assert.equal(edited(), false, 'no edit on non-create command');
  });

  it('create command but no URL in response (failed create) → no edit', () => {
    rmSync(editLog, { force: true });
    runHook({ tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'error: could not create pull request\n' });
    assert.equal(edited(), false, 'no edit when create produced no URL');
  });

  it('non-Bash tool is ignored', () => {
    rmSync(editLog, { force: true });
    runHook({ tool_name: 'Read', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/9' });
    assert.equal(edited(), false, 'no edit for non-Bash tool');
  });

  it('glab mr create with a merge_requests URL triggers an update', () => {
    rmSync(editLog, { force: true });
    runHook({ tool_name: 'Bash', tool_input: { command: 'glab mr create --fill' }, tool_response: 'https://gitlab.com/o/r/-/merge_requests/13\n' });
    assert.ok(edited(), 'expected glab update to be called');
    has(readFileSync(editLog, 'utf8'), TMB_FOOTER, 'glab update carries the TMB footer');
  });
});

describe('enums-stable lint and extractor l3', () => {
  const LINT = join(PLUGIN_ROOT, 'tests/l1-lint/enums-stable.test.mjs');
  const EXTRACT = join(PLUGIN_ROOT, 'tests/l1-lint/enums-stable-extract.mjs');
  const LINT_FIXTURES = join(PLUGIN_ROOT, 'tests/l1-lint/fixtures/enums-stable');
  const SOURCES = join(PLUGIN_ROOT, 'tests/l3-integration/hooks/fixtures/enums-stable-extract');
  let sb: Sandbox;
  let work: string;

  /** The extractor's first column for <source>, sorted, each value followed by a space. */
  function extract(enumName: string, source: string): string {
    const r = spawnSync(process.execPath, [EXTRACT, enumName, '/dev/null', join(SOURCES, source)], { env: sb.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t')[0])
      .sort()
      .map((v) => `${v} `)
      .join('');
  }

  /** The lint's passing base tree, with a fixture overlay. */
  function newTree(name: string, overlay?: string): string {
    const dir = join(work, name);
    cpSync(join(LINT_FIXTURES, 'base'), dir, { recursive: true });
    if (overlay !== undefined) cpSync(join(LINT_FIXTURES, overlay), dir, { recursive: true });
    return dir;
  }

  function runLint(name: string): { exit: number | null; output: string } {
    const r = spawnSync(process.execPath, [LINT, join(work, name)], { env: sb.env, encoding: 'utf8' });
    return { exit: r.status, output: cap(r.stdout + r.stderr) };
  }

  const tools = (name: string, file: string) => join(work, name, 'mcp/trajectory-server/src/tools', file);

  before(() => {
    sb = makeSandbox('enums-stable-extract');
    work = join(sb.dir, 'work');
    mkdirSync(work);
  });
  after(() => sb.remove());

  it('a comment mention emits no event', () => {
    assert.equal(extract('audit.event_type', 'comment.ts'), '', 'events from comments');
  });

  it('a comment mention emits no from_node', () => {
    assert.equal(extract('audit.from_node', 'comment.ts'), '', 'from_node from comments');
  });

  it('a hook: prefix operation emits no from_node', () => {
    assert.equal(extract('audit.from_node', 'prefix.ts'), '', 'from_node from prefixes');
  });

  it('constants passed to insertAudit emit their values, unresolved ones nothing', () => {
    assert.equal(extract('audit.event_type', 'constant.ts'), 'aliased_event barrel_event imported_event local_event ', 'resolved events');
  });

  it('comment markers inside strings, regexes and templates are text', () => {
    assert.equal(extract('audit.event_type', 'markers-in-text.ts'), 'after_glob_event after_regex_event after_url_event ', 'events after markers');
  });

  it('the lint passes its base tree', () => {
    newTree('base');
    const { exit, output } = runLint('base');
    assert.equal(exit, 0, `base tree: ${output}`);
  });

  it('the lint rejects an undocumented event', () => {
    const dir = newTree('undocumented', 'undocumented');
    mkdirSync(join(dir, 'scripts/maintenance'), { recursive: true });
    cpSync(join(dir, 'scripts', 'hooks', 'extra.sh'), join(dir, 'scripts/maintenance/extra.sh'));
    rmSync(join(dir, 'scripts', 'hooks', 'extra.sh'));
    const { exit, output } = runLint('undocumented');
    assert.equal(exit, 1, 'undocumented event');
    has(output, "audit.event_type 'ghost_event' used in scripts/maintenance/extra.sh but missing from ENUMS.md", 'output');
  });

  it('the lint rejects an undocumented event behind a constant', () => {
    newTree('ghost-constant');
    writeFileSync(
      tools('ghost-constant', 'ghost.ts'),
      "const GHOST_EVENT = 'ghost_constant_event';\nexport const write = (db: unknown) => insertAudit(db, { event_type: GHOST_EVENT, summary: 's' });\n",
    );
    const { exit, output } = runLint('ghost-constant');
    assert.equal(exit, 1, 'undocumented constant');
    has(output, "audit.event_type 'ghost_constant_event' used in mcp/trajectory-server/src/tools/ghost.ts", 'output');
  });

  it('the lint rejects a documented value with no use', () => {
    newTree('unused', 'unused');
    const { exit, output } = runLint('unused');
    assert.equal(exit, 1, 'unused value');
    has(output, "audit.event_type 'phantom_event' documented in ENUMS.md but not found", 'output');
  });

  it('a comment mention does not count as a use', () => {
    newTree('unused-comment', 'unused');
    writeFileSync(tools('unused-comment', 'note.ts'), "// event_type: 'phantom_event'\n");
    const { exit, output } = runLint('unused-comment');
    assert.equal(exit, 1, 'comment-only value');
    has(output, "audit.event_type 'phantom_event' documented in ENUMS.md but not found", 'output');
  });

  it('an imported constant passed to insertAudit counts as a use', () => {
    newTree('used-constant', 'unused');
    writeFileSync(tools('used-constant', 'names.ts'), "export const PHANTOM_EVENT = 'phantom_event';\n");
    writeFileSync(
      tools('used-constant', 'writer.ts'),
      "import { PHANTOM_EVENT } from './names.js';\nexport const write = (db: unknown) => insertAudit(db, { event_type: PHANTOM_EVENT, summary: 's' });\n",
    );
    const { exit, output } = runLint('used-constant');
    assert.equal(exit, 0, `constant use: ${output}`);
  });

  it('the lint rejects a malformed complete hook: identifier', () => {
    newTree('malformed');
    writeFileSync(tools('malformed', 'bad.ts'), "export const from = 'hook:Bad_Name';\n");
    const { exit, output } = runLint('malformed');
    assert.equal(exit, 1, 'malformed identifier');
    has(output, "from_node 'hook:Bad_Name' in mcp/trajectory-server/src/tools/bad.ts does not match hook:[a-z0-9-]+", 'output');
  });

  it('the lint rejects a bare hook: literal outside a prefix operation', () => {
    newTree('bare');
    writeFileSync(tools('bare', 'bare.ts'), "export const from = 'hook:';\n");
    const { exit, output } = runLint('bare');
    assert.equal(exit, 1, 'bare prefix');
    has(output, "from_node 'hook:' in mcp/trajectory-server/src/tools/bare.ts does not match", 'output');
  });

  it('a prefix operation and a comment leave the lint passing', () => {
    newTree('prefix');
    for (const f of ['prefix.ts', 'comment.ts']) cpSync(join(SOURCES, f), tools('prefix', f));
    const { exit, output } = runLint('prefix');
    assert.equal(exit, 0, `prefix and comment: ${output}`);
  });
});

const onPath = (cmd: string) => (process.env.PATH ?? '').split(delimiter).some((d) => d !== '' && existsSync(join(d, cmd)));
const LIVE_CC = process.env.TMB_L3_LIVE_CC === '1' && onPath('claude') && (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '') !== '';

/**
 * Live Claude Code proof for the facts the footprint design rests on: a real,
 * billed haiku run. In a sandbox project under a temp HOME, one `claude -p`
 * run spawns a subagent that runs Bash; hooks registered in the project's
 * settings.local.json and in a --plugin-dir plugin record each fire's event,
 * session_id and CLAUDE_PROJECT_DIR.
 */
describe('live Claude Code hook env l3', { skip: !LIVE_CC && 'set TMB_L3_LIVE_CC=1 with claude + CLAUDE_CODE_OAUTH_TOKEN to run' }, () => {
  let sb: Sandbox;
  let proj: string;
  let fired: Array<{ src: string; event: string; agent_id: string | null; session_id: string; cpd: string }> = [];

  before(() => {
    sb = makeSandbox('live-cc-hook-env');
    const t = sb.dir;
    for (const d of ['proj/.claude', 'plug/.claude-plugin', 'plug/hooks']) mkdirSync(join(t, d), { recursive: true });
    proj = realpathSync(join(t, 'proj'));
    const log = join(t, 'fired.jsonl');
    const dump = join(t, 'dump.mjs');
    writeFileSync(
      dump,
      `import { appendFileSync, readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ src: process.argv[2], event: p.hook_event_name, tool: p.tool_name ?? null, agent_id: p.agent_id ?? null, session_id: p.session_id, cpd: process.env.CLAUDE_PROJECT_DIR ?? '<unset>' }) + '\\n');
`,
    );
    const hook = (src: string) => ({ type: 'command', command: `"${process.execPath}" "${dump}" ${src}` });
    const events = (src: string) =>
      `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook(src)] }], PreToolUse: [{ matcher: '*', hooks: [hook(src)] }], SubagentStop: [{ hooks: [hook(src)] }] } })}\n`;
    writeFileSync(join(proj, '.claude/settings.local.json'), events('settings'));
    writeFileSync(join(t, 'plug/.claude-plugin/plugin.json'), '{"name":"cc-hook-env-proof","version":"0.0.1"}\n');
    writeFileSync(join(t, 'plug/hooks/hooks.json'), events('plugin'));
    spawnSync(
      'claude',
      [
        '-p',
        'Use the Agent tool exactly once to spawn a general-purpose subagent whose only job is to run the bash command: cd / && echo hi . Then reply DONE.',
        '--model',
        'haiku',
        '--plugin-dir',
        join(t, 'plug'),
        '--permission-mode',
        'bypassPermissions',
        '--max-turns',
        '6',
      ],
      {
        cwd: proj,
        stdio: 'ignore',
        env: { PATH: process.env.PATH, HOME: sb.home, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, TERM: 'dumb' },
      },
    );
    fired = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l))
      : [];
  });
  after(() => sb?.remove());

  it('project settings.local.json PreToolUse fires under claude -p', () => {
    assert.ok(fired.some((f) => f.src === 'settings' && f.event === 'PreToolUse'), 'settings.local.json hook fired');
  });

  it('CLAUDE_PROJECT_DIR reaches subagent PreToolUse and SubagentStop hooks', () => {
    assert.ok(fired.some((f) => f.event === 'PreToolUse' && f.agent_id !== null), 'subagent tool call observed');
    assert.ok(fired.some((f) => f.event === 'SubagentStop'), 'SubagentStop observed');
    assert.equal(fired.filter((f) => f.cpd !== proj).length, 0, `every hook saw CLAUDE_PROJECT_DIR=${proj}`);
  });

  it('subagent hooks carry the main session_id', () => {
    assert.equal(new Set(fired.map((f) => f.session_id)).size, 1, 'one session_id across main and subagent hooks');
  });
});

/**
 * orphan-scan: self-PID exclusion and owner-liveness classification of
 * trajectory-server procs holding this project's live DB. A "CC" proc is a
 * bash renamed `claude` (exec -a); a "server" is a sleep whose argv carries
 * trajectory-server/dist/index.js. DB holders come from
 * TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE (no lsof); the own-CC ancestry walk starts
 * at TMB_ORPHAN_SCAN_SELF_PID.
 */
describe('orphan-scan l3', () => {
  const SRV_ARGV = 'node /x/mcp/trajectory-server/dist/index.js';
  const LIVE_TREE = `( exec -a claude bash -c '
    ( exec -a "${SRV_ARGV}" sleep 300 ) &
    echo "SRV $!" >> "$0"
    ( exec -a "cc-hook-runner" sleep 300 ) &
    echo "HOOK $!" >> "$0"
    wait
  ' "$1" ) &
echo "CC $!" >> "$1"`;
  const DEAD_OWNER_TREE = `( exec -a claude bash -c '
    ( exec -a "${SRV_ARGV}" sleep 300 ) &
    echo "SRV $!" >> "$0"
  ' "$1" ) &
echo "CC $!" >> "$1"`;
  let sb: Sandbox;
  let projectDir: string;
  let scanHome: string;
  const pids: number[] = [];
  let selfHook: string;
  let otherSrv: string;
  let deadSrv: string;

  /** Runs <script>, whose procs outlive it, and returns the file it writes "<role> <pid>" lines to. */
  function spawnTree(name: string, script: string): string {
    const pf = join(sb.dir, `${name}.pids`);
    writeFileSync(pf, '');
    const r = spawnSync('bash', ['-c', script, 'bash', pf], { env: sb.env, stdio: 'ignore' });
    if (r.error) throw r.error;
    return pf;
  }

  function readPids(pf: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(pf, 'utf8').split('\n')) {
      const [role, pid] = line.split(' ');
      if (pid !== undefined) out[role] = pid;
    }
    for (const pid of Object.values(out)) pids.push(Number(pid));
    return out;
  }

  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };

  function runHook(holders: string, clean = false): string {
    const env: NodeJS.ProcessEnv = {
      ...gateEnv(sb, sb.dir),
      CLAUDE_PROJECT_DIR: projectDir,
      TMB_ORPHAN_SCAN_PROJECT_DIR: projectDir,
      TMB_ORPHAN_SCAN_HOME: scanHome,
      TMB_ORPHAN_SCAN_HOLDERS_OVERRIDE: holders,
      TMB_ORPHAN_SCAN_SELF_PID: selfHook,
    };
    if (clean) env.TMB_ORPHAN_SCAN_CLEAN = '1';
    const r = runGate('orphan-scan', { cwd: sb.dir, input: '{}', env });
    return cap(r.stdout + r.stderr);
  }

  before(async () => {
    sb = makeSandbox('orphan-scan');
    const top = (dir: string) => spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: sb.env, encoding: 'utf8' }).stdout.trim();
    const sbTop = top(sb.dir);
    assert.ok(sbTop === '' || sbTop !== top(PLUGIN_ROOT), `test cwd is the plugin repo root (${sbTop}) — sandbox isolation breach`);
    projectDir = join(sb.dir, 'project');
    scanHome = join(sb.dir, 'home-scan');
    mkdirSync(join(projectDir, '.claude/tmb'), { recursive: true });
    mkdirSync(join(scanHome, '.claude'), { recursive: true });
    execDb(join(projectDir, '.claude/tmb/trajectory.db'), 'CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER);');
    const self = spawnTree('self', LIVE_TREE);
    await sleep(600);
    selfHook = readPids(self).HOOK;
  });

  after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    sb.remove();
  });

  it('own-session server is never flagged (self-PID exclusion)', () => {
    const selfSrv = readPids(join(sb.dir, 'self.pids')).SRV;
    const out = runHook(selfSrv);
    hasNot(out, 'trajectory-server', 'own server produces no proc report');
    hasNot(out, 'lock-conflict', 'own server is not a lock-conflict');
    assert.equal(out, '', 'own server → silent');
  });

  it('live other-session server is not reported', async () => {
    const pf = spawnTree('other', LIVE_TREE);
    await sleep(600);
    otherSrv = readPids(pf).SRV;
    const out = runHook(otherSrv);
    hasNot(out, 'lock-conflict', 'live other server is no lock-conflict');
    hasNot(out, 'stale duplicate', 'live owner is never called stale');
    assert.equal(out, '', 'live other server → silent');
  });

  it('live other-session server is NOT killed in clean mode', async () => {
    runHook(otherSrv, true);
    await sleep(200);
    assert.ok(alive(otherSrv), 'live other server was killed in clean mode');
  });

  it('dead-owner server is flagged stale', async () => {
    const pf = spawnTree('dead', DEAD_OWNER_TREE);
    await sleep(800);
    deadSrv = readPids(pf).SRV;
    const out = runHook(deadSrv);
    has(out, 'stale duplicate trajectory-server', 'dead-owner server → stale');
    has(out, `pid ${deadSrv}`, 'stale report names the holder pid');
  });

  it('dead-owner server IS killed in clean mode', async () => {
    runHook(deadSrv, true);
    await sleep(300);
    assert.ok(!alive(deadSrv), 'dead-owner server survived clean mode');
  });
});

/**
 * resolveTaskIdForTarget worktree → task resolution: two tasks share a slug
 * under different types (the worktree's checked-out branch matches exactly; a
 * detached worktree gets the newest with a stderr warning naming both), `_`
 * and `%` in a slug match literally, db.ts exports no unsignedTasks.
 */
describe('resolveTaskIdForTarget and taskBySlug slug resolution l3', () => {
  let sb: Sandbox;
  let repo: string;
  let db: string;
  let detached: string;

  const env = () => ({ ...gateEnv(sb, sb.dir), TRAJECTORY_DB_PATH: db });
  const resolve = (target: string) => resolveInChild(target, db, env(), sb.dir);
  const bySlug = (slug: string, col?: string, statuses?: string) => cap(dbLib.taskBySlug(db, slug, col, statuses, env()));

  before(() => {
    sb = makeSandbox('query-task-slug');
    repo = join(sb.dir, 'repo');
    db = join(repo, '.claude/tmb/trajectory.db');
    git(sb.env, sb.dir, 'init', '-q', '-b', 'main', repo);
    git(sb.env, repo, 'config', 'user.email', 't@t.t');
    git(sb.env, repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git(sb.env, repo, 'add', 'README.md');
    git(sb.env, repo, 'commit', '-qm', 'init');
    schemaDb(db);
    execDb(
      db,
      `INSERT INTO issues (id, objective, description, status, created_at, updated_at)
         VALUES (1, 'o', 'd', 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
       INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at) VALUES
         (1, 1, 'feat/shared-slug', 't1', 'd', 'running', '', '', ''),
         (2, 1, 'fix/shared-slug',  't2', 'd', 'running', '', '', ''),
         (3, 1, 'feat/axb',         't3', 'd', 'running', '', '', ''),
         (4, 1, 'feat/50xoff',      't4', 'd', 'running', '', '', ''),
         (5, 1, 'feat/a_b',         't5', 'd', 'running', '', '', '');`,
    );
    git(sb.env, repo, 'branch', '-q', 'feat/shared-slug');
    git(sb.env, repo, 'worktree', 'add', '-q', join(repo, '.claude/worktrees/shared-slug'), 'feat/shared-slug');
    detached = join(sb.dir, 'other/.claude/worktrees/shared-slug');
    mkdirSync(dirname(detached), { recursive: true });
    git(sb.env, repo, 'worktree', 'add', '-q', '--detach', detached);
    git(sb.env, repo, 'worktree', 'add', '-q', '--detach', join(repo, '.claude/worktrees/a_b'));
    git(sb.env, repo, 'worktree', 'add', '-q', '--detach', join(repo, '.claude/worktrees/50%off'));
  });
  after(() => sb.remove());

  it('shared slug, worktree on its branch: the exact branch_id wins over the newer task', () => {
    const r = resolve(join(repo, '.claude/worktrees/shared-slug/x.txt'));
    assert.equal(r.stdout, '1', 'feat/shared-slug');
    assert.equal(r.stderr, '', 'no ambiguity warning on an exact match');
  });

  it('shared slug, detached worktree: newest task, warning names both', () => {
    const r = resolve(join(detached, 'x.txt'));
    assert.equal(r.stdout, '2', 'newest of the two');
    has(r.stderr, 'matches 2 tasks', 'stderr warning');
    has(r.stderr, 'feat/shared-slug', 'warning names the older match');
    has(r.stderr, 'fix/shared-slug', 'warning names the newer match');
  });

  it('_ in a slug is literal', () => {
    assert.equal(resolve(join(repo, '.claude/worktrees/a_b/x')).stdout, '5', 'a_b matches feat/a_b only, not feat/axb');
    sql(db, 'DELETE FROM tasks WHERE id = 5');
    assert.equal(resolve(join(repo, '.claude/worktrees/a_b/x')).stdout, '', 'with feat/a_b gone, feat/axb does not match');
  });

  it('% in a slug is literal', () => {
    assert.equal(resolve(join(repo, '.claude/worktrees/50%off/x')).stdout, '', '50%off does not match feat/50xoff');
  });

  it('taskBySlug: branch_id column and status filter', () => {
    assert.equal(bySlug('shared-slug', 'branch_id'), 'fix/shared-slug', 'branch_id of the newest');
    sql(db, "UPDATE tasks SET status = 'closed' WHERE id = 2");
    assert.equal(bySlug('shared-slug', 'id', "'pending','running'"), '1', 'status filter narrows to the open task');
    assert.equal(bySlug('shared-slug', 'id', "'running'); DROP TABLE tasks; --"), '', 'a status list outside the quoted-word shape is refused');
    const d = new DatabaseSync(db);
    try {
      assert.equal((d.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 4, 'tasks table intact');
    } finally {
      d.close();
    }
  });

  it('unsignedTasks is gone', () => {
    assert.equal('unsignedTasks' in dbLib, false, 'db.ts still exports unsignedTasks');
  });
});

/**
 * repoRemotes (src/hooks/lib/repo.ts) against the real schema.sql: the
 * repo_remotes rows of the repos row matching <git_root> (else the sole
 * registered repo) as a JSON array of {name,provider,url}, primary first; "[]"
 * for a registered repo with no rows; empty when no repo resolves or the DB
 * predates repo_remotes.
 */
describe('repoRemotes l3', () => {
  let sb: Sandbox;
  let db: string;

  const remotes = (path: string, root: string) => cap(repoRemotes(path, root, gateEnv(sb, sb.dir)));

  before(() => {
    sb = makeSandbox('resolve-repo-remotes');
    db = schemaDb(join(sb.dir, 'trajectory.db'));
    execDb(
      db,
      `INSERT INTO repos (name, path) VALUES ('app', '/ws/app'), ('lib', '/ws/lib'), ('bare', '/ws/bare');
       INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES
         ('app', 'upstream', 'github', 'https://github.com/up/app.git', 0),
         ('app', 'origin', 'gitlab', 'git@gitlab.com:me/app.git', 1),
         ('lib', 'origin', 'github', 'https://github.com/me/lib.git', 1);`,
    );
  });
  after(() => sb.remove());

  it('matching repo: JSON array of {name,provider,url}, primary first', () => {
    assert.equal(
      remotes(db, '/ws/app'),
      '[{"name":"origin","provider":"gitlab","url":"git@gitlab.com:me/app.git"},{"name":"upstream","provider":"github","url":"https://github.com/up/app.git"}]',
      'app remotes',
    );
  });

  it('each repo reads only its own rows', () => {
    assert.equal(remotes(db, '/ws/lib'), '[{"name":"origin","provider":"github","url":"https://github.com/me/lib.git"}]', 'lib remotes');
  });

  it('registered repo with no rows prints []', () => {
    assert.equal(remotes(db, '/ws/bare'), '[]', 'bare remotes');
  });

  it('unmatched root with several repos registered prints nothing', () => {
    assert.equal(remotes(db, '/ws/other'), '', 'no fallback in a multi-repo DB');
  });

  it('unmatched root falls back to the sole registered repo', () => {
    const sole = schemaDb(join(sb.dir, 'sole.db'));
    execDb(
      sole,
      `INSERT INTO repos (name, path) VALUES ('only', '/ws/only');
       INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('only', 'origin', 'github', 'https://github.com/me/only.git', 1);`,
    );
    assert.equal(remotes(sole, ''), '[{"name":"origin","provider":"github","url":"https://github.com/me/only.git"}]', 'sole-repo fallback');
  });

  it('a DB without repo_remotes prints nothing', () => {
    const old = join(sb.dir, 'old.db');
    execDb(old, "CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, remotes TEXT); INSERT INTO repos VALUES ('app', '/ws/app', '[]');");
    assert.equal(remotes(old, '/ws/app'), '', 'pre-v35 DB');
  });

  it('a missing DB prints nothing', () => {
    assert.equal(remotes(join(sb.dir, 'missing.db'), '/ws/app'), '', 'missing DB');
  });
});
