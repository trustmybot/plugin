/**
 * The hot path as Claude Code pays for it (GH 3232), the before/after check of
 * every perf slice:
 * 1. Hook wall time per event: every hooks.json command whose matcher matches
 *    the scenario's tool is spawned concurrently, as Claude Code does, with a
 *    realistic payload on stdin; wall time runs until the last one exits.
 * 2. MCP tool latency under a concurrent gh call: the real server over stdio,
 *    a cheap tool timed alone and then while a gh-calling tool waits on a fake
 *    `gh` that sleeps --gh-delay-ms.
 * --json writes the result, --baseline exits 1 when a hook p50 or the cheap
 * tool's latency during gh regresses by more than max(20%, 15 ms). At a 1-minute
 * load of 30 or more it prints `skipped: load <n>` and exits 0.
 *
 *   node --experimental-sqlite dist/test/hot-path.bench.js [--rounds 10] [--gh-delay-ms 1000] [--json out.json] [--baseline before.json]
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { percentile } from './hook-transcripts.js';
import { type BenchResult, compareToBaseline, formatComparison, type HookStats, type McpStats, parseBenchResult } from './hot-path-compare.js';

// A bare `node --test` collects every .js under a test/ dir, this bench too; it is no test, so it ends at once there (GH 3249).
if (process.env.NODE_TEST_CONTEXT !== undefined) process.exit(0);

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/index.js');
const LOAD_LIMIT = 30;
const BENCH_REPO = 'bench';
const BENCH_ISSUE_IID = 3232;
// The server child must reach the fake gh: these make defaultSpawnFn refuse or skip it.
const SYNC_BLOCKING_ENV = ['TMB_FORBID_LIVE_SYNC', 'NODE_TEST_CONTEXT', 'TMB_DISABLE_REMOTE_SYNC', 'TRAJECTORY_DB_PATH'];

interface Scenario {
  name: string;
  event: string;
  // The value hooks.json matchers are tested against: the tool name, or the SessionStart source.
  target: string;
  payload: (project: string, n: number) => Record<string, unknown>;
}

interface HookCommand {
  command: string;
  timeoutS: number;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'PreToolUse Bash', event: 'PreToolUse', target: 'Bash', payload: () => ({ tool_name: 'Bash', tool_input: { command: 'git status --short', description: 'Show working tree status' } }) },
  { name: 'PreToolUse Edit', event: 'PreToolUse', target: 'Edit', payload: (p) => ({ tool_name: 'Edit', tool_input: { file_path: join(p, 'src/app.ts'), old_string: 'const a = 1;', new_string: 'const a = 2;' } }) },
  { name: 'PreToolUse Read', event: 'PreToolUse', target: 'Read', payload: (p) => ({ tool_name: 'Read', tool_input: { file_path: join(p, 'src/app.ts') } }) },
  { name: 'PostToolUse Bash', event: 'PostToolUse', target: 'Bash', payload: () => ({ tool_name: 'Bash', tool_input: { command: 'git status --short', description: 'Show working tree status' }, tool_response: { stdout: ' M src/app.ts\n', stderr: '', interrupted: false } }) },
  { name: 'UserPromptSubmit', event: 'UserPromptSubmit', target: '', payload: () => ({ prompt: 'bro, what is left on the open issue?' }) },
  { name: 'SessionStart', event: 'SessionStart', target: 'startup', payload: () => ({ source: 'startup' }) },
];

// Claude Code's matcher rule: empty or `*` matches everything, else the matcher is a regex over the whole value.
function matcherMatches(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  return new RegExp(`^(?:${matcher})$`).test(target);
}

function matchingCommands(hooksJson: unknown, event: string, target: string): HookCommand[] {
  const groups = ((hooksJson as { hooks?: Record<string, unknown> }).hooks?.[event] ?? []) as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>;
  const out: HookCommand[] = [];
  for (const g of groups) {
    if (!matcherMatches(g.matcher, target)) continue;
    for (const h of g.hooks ?? []) {
      if (h.type === 'command' && typeof h.command === 'string') out.push({ command: h.command, timeoutS: h.timeout ?? 60 });
    }
  }
  return out;
}

function runHook(cmd: HookCommand, stdin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('/bin/sh', ['-c', cmd.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT)], { env, cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), cmd.timeoutS * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function stats(ms: number[], procs: number): HookStats {
  const round = (q: number): number => Number((percentile(ms, q) as number).toFixed(1));
  return { procs, p50: round(0.5), p95: round(0.95), max: Number(Math.max(...ms).toFixed(1)) };
}

// A gh/glab that logs each call, sleeps, then answers like the real CLI.
function writeFakeCli(dir: string, delayMs: number, log: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['gh', 'glab']) {
    const path = join(dir, name);
    writeFileSync(
      path,
      `#!/bin/sh\necho "start ${name} $*" >> '${log}'\nsleep ${(delayMs / 1000).toFixed(3)}\n` +
        `case "$1 $2" in\n  "issue edit"|"issue update") echo "https://github.com/bench-owner/bench-repo/issues/$3" ;;\n  *) echo '{}' ;;\nesac\n` +
        `echo "done ${name} $*" >> '${log}'\n`,
    );
    chmodSync(path, 0o755);
  }
}

function createProject(base: string): string {
  const project = join(base, 'project');
  mkdirSync(join(project, '.claude/tmb'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src/app.ts'), 'const a = 1;\nexport default a;\n');
  const d = new DatabaseSync(join(project, '.claude/tmb/trajectory.db'));
  d.exec(readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
  d.close();
  return project;
}

// What issue_update needs to reach defaultSpawnFn: a synced github remote on the repo and an issue with a gh_iid.
function seedGhIssue(project: string): number {
  const d = new DatabaseSync(join(project, '.claude/tmb/trajectory.db'));
  try {
    const now = new Date().toISOString();
    d.prepare(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')`).run();
    d.prepare(`INSERT INTO repos (name, path) VALUES (?, ?)`).run(BENCH_REPO, project);
    d.prepare(`INSERT INTO repo_remotes (repo, name, provider, url, is_primary, sync) VALUES (?, 'origin', 'github', 'https://github.com/bench-owner/bench-repo.git', 1, 1)`).run(BENCH_REPO);
    const r = d.prepare(`INSERT INTO issues (objective, created_at, updated_at, remote_kind, gh_iid, repo) VALUES ('hot-path bench issue', ?, ?, 'github', ?, ?)`).run(now, now, BENCH_ISSUE_IID, BENCH_REPO);
    return Number(r.lastInsertRowid);
  } finally {
    d.close();
  }
}

async function benchHooks(rounds: number, env: NodeJS.ProcessEnv, project: string): Promise<Record<string, HookStats>> {
  const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as unknown;
  const out: Record<string, HookStats> = {};
  let n = 0;
  for (const s of SCENARIOS) {
    const cmds = matchingCommands(hooksJson, s.event, s.target);
    if (cmds.length === 0) throw new Error(`hooks.json registers no command for ${s.name}`);
    const ms: number[] = [];
    for (let round = -1; round < rounds; round++) {
      const payload = JSON.stringify({ session_id: s.event === 'SessionStart' ? `hot-path-session-${n}` : 'hot-path-bench', transcript_path: join(project, 'transcript.jsonl'), cwd: project, hook_event_name: s.event, tool_use_id: `hot-path-${n++}`, ...s.payload(project, n) });
      const start = performance.now();
      await Promise.all(cmds.map((c) => runHook(c, payload, env, project)));
      if (round >= 0) ms.push(performance.now() - start);
    }
    out[s.name] = stats(ms, cmds.length);
  }
  return out;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const start = performance.now();
  const value = await fn();
  return [performance.now() - start, value];
}

function ghEditStarts(log: string): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start gh issue edit')).length;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function benchMcp(rounds: number, ghDelayMs: number, env: NodeJS.ProcessEnv, project: string, ghLog: string): Promise<McpStats> {
  const issueId = seedGhIssue(project);
  const client = new Client({ name: 'tmb-hot-path-bench', version: '1.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-sqlite', SERVER], env: env as Record<string, string>, cwd: project, stderr: 'ignore' }));
  const cheap = (): Promise<Record<string, unknown>> => callTool(client, 'config_get', { agent: 'bro', key: 'issue_sync' });
  try {
    const alone: number[] = [];
    const during: number[] = [];
    const gh: number[] = [];
    for (let round = -1; round < rounds; round++) {
      const [ms] = await timed(cheap);
      if (round >= 0) alone.push(ms);
    }
    for (let round = -1; round < rounds; round++) {
      const before = ghEditStarts(ghLog);
      const ghCall = timed(() => callTool(client, 'issue_update', { agent: 'bro', issue_id: String(issueId), objective: `hot-path bench issue ${round + 1}` }));
      await waitFor(() => ghEditStarts(ghLog) > before, 30_000, `the fake gh to log "issue edit" in ${ghLog} (did issue_update reach gh?)`);
      const [cheapMs] = await timed(cheap);
      const [ghMs, updated] = await ghCall;
      const sync = updated['_sync'] as Record<string, unknown> | undefined;
      if (sync?.['synced'] !== true) throw new Error(`issue_update did not sync through the fake gh: _sync=${JSON.stringify(sync)}`);
      if (ghMs < ghDelayMs) throw new Error(`gh-calling tool took ${ghMs.toFixed(1)} ms, under the fake gh delay ${ghDelayMs} ms: the call did not wait on gh`);
      if (round >= 0) {
        during.push(cheapMs);
        gh.push(ghMs);
      }
    }
    const p50 = (ms: number[]): number => Number((percentile(ms, 0.5) as number).toFixed(1));
    return { cheap_alone_ms: p50(alone), cheap_during_gh_ms: p50(during), gh_call_ms: p50(gh) };
  } finally {
    await client.close();
  }
}

function printTable(r: BenchResult): void {
  console.log(`hot-path bench: node ${r.env.node}, 1-min load ${r.env.load}, ${r.env.rounds} rounds`);
  console.log(`${'scenario'.padEnd(20)} ${'procs'.padStart(5)} ${'p50 ms'.padStart(9)} ${'p95 ms'.padStart(9)} ${'max ms'.padStart(9)}`);
  for (const [name, s] of Object.entries(r.hooks)) {
    console.log(`${name.padEnd(20)} ${String(s.procs).padStart(5)} ${s.p50.toFixed(1).padStart(9)} ${s.p95.toFixed(1).padStart(9)} ${s.max.toFixed(1).padStart(9)}`);
  }
  console.log(`mcp config_get alone          ${r.mcp.cheap_alone_ms.toFixed(1)} ms`);
  console.log(`mcp config_get during gh call ${r.mcp.cheap_during_gh_ms.toFixed(1)} ms`);
  console.log(`mcp issue_update (gh call)    ${r.mcp.gh_call_ms.toFixed(1)} ms`);
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rounds: { type: 'string', default: '10' },
      'gh-delay-ms': { type: 'string', default: '1000' },
      json: { type: 'string' },
      baseline: { type: 'string' },
    },
  });
  const rounds = positiveInt(values.rounds, '--rounds');
  const ghDelayMs = positiveInt(values['gh-delay-ms'], '--gh-delay-ms');
  const baseline = values.baseline === undefined ? undefined : parseBenchResult(readFileSync(values.baseline, 'utf8'), values.baseline);
  const load = loadavg()[0] ?? 0;
  if (load >= LOAD_LIMIT) {
    console.log(`skipped: load ${load.toFixed(2)}`);
    return 0;
  }
  if (!existsSync(SERVER)) throw new Error(`${SERVER} is missing: build the trajectory-server first`);
  const base = mkdtempSync(join(tmpdir(), 'tmb-hot-path-'));
  try {
    const project = createProject(base);
    const ghLog = join(base, 'gh-calls.log');
    const fakeBin = join(base, 'fake-bin');
    const instantBin = join(base, 'instant-bin');
    writeFakeCli(fakeBin, ghDelayMs, ghLog);
    // Hooks get a gh that answers at once, so a hook's own gh call cannot reach a remote or charge the MCP delay.
    writeFakeCli(instantBin, 0, join(base, 'hook-gh-calls.log'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      PWD: project,
      TMPDIR: join(base, 'tmp'),
      TMB_SYNC_LOG_DIR: join(base, 'sync-log'),
      TMB_TEST_RUN_ID: 'hot-path-bench',
    };
    mkdirSync(join(base, 'tmp'));
    for (const k of SYNC_BLOCKING_ENV) delete env[k];
    const hooks = await benchHooks(rounds, { ...env, PATH: `${instantBin}:${process.env.PATH ?? ''}` }, project);
    const mcp = await benchMcp(rounds, ghDelayMs, env, project, ghLog);
    const result: BenchResult = { hooks, mcp, env: { node: process.version, load: Number(load.toFixed(2)), rounds } };
    printTable(result);
    if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
    if (baseline === undefined) return 0;
    const cmp = compareToBaseline(baseline, result);
    console.log(`\nagainst ${values.baseline}:\n${formatComparison(cmp)}`);
    return cmp.regressed ? 1 : 0;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

process.exitCode = await main();
