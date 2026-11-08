// TypeScript port of run-l6-chain.sh (GH 1692), the L6 chain runner. It drives every journey row
// of l6-chain/chain-manifest.json in order through ONE cumulative trajectory DB, a fresh
// `claude -p` per row; each row dir resolves as <here>/<row_dir>. See tests/EVALUATION.md for the
// journey spec.
//
// Usage:
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts                   # auto-resume (or fresh)
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --fresh           # fresh chain from row 1
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --from 7          # resume from row 7
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --halt-on-fail 0  # don't halt on first fail
//   node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts --self-test       # run-dir + HOME isolation, no model calls
//
// Auto-resume: with no flag, the runner reads the most recent prior run's _results.jsonl for the
// first non-passing step and resumes there, restoring step-(N-1)/checkpoint.db. `--fresh` overrides.
//
// Per-step logs land under $L6C_RUNS_DIR/<run-id>/ when set, else
// <project>/.claude/<plugin>/l6-chain-runs/<run-id>/ (<project> = CLAUDE_PROJECT_DIR, else this
// repo's root). The chain runs with HOME=<run-id>/home and fails at exit if that HOME holds
// anything but .cache/huggingface. Each step writes step-NN-name/ with pre-state.sql,
// user-input.txt, bro-response.txt, tool-uses.jsonl, post-state.sql, post-state.diff,
// scorers.json, checkpoint.db (passing rows only) and seed-applied.sql (when a seed_after ran).
// The env flows as an object; nothing here writes process.env.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { L5_DOGFOOD_DIR, l5InitStateDir, l5SeedDb, l5SetupScratchProject, LIB_DIR, PLUGIN_ROOT, stripTrailingNewlines } from './lib/flow-helpers.ts';
import {
  l6cApplySeed,
  l6cAssertHomeClean,
  l6cIsolateHome,
  l6cLaunchStep,
  l6cResolveRunsRoot,
  l6cRunStep,
  l6cSnapshotDb,
  l6cTrajectoryDoctor,
  l6cWriteChainSummary,
  lastAssistantText,
  type StepRunner,
} from './lib/l6-chain-helpers.ts';

const CLI_JS = join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'dist', 'cli.js');
const PASS = '✅ pass';
const FAIL = '❌ fail';

export type PreFlight = (pluginRoot: string, env: NodeJS.ProcessEnv) => boolean;
export type StepScorer = (project: string, step: string, rowDir: string, runId: string, env: NodeJS.ProcessEnv, logFile: string) => number;
export type Doctor = (db: string, report: string, env: NodeJS.ProcessEnv) => number;

export interface MainOptions {
  /** Base dir row_dir and seeds resolve under; default tests/l5-l6. */
  here?: string;
  /** Default <here>/l6-chain/chain-manifest.json. */
  manifest?: string;
  /** Default l6cResolveRunsRoot. */
  runsRoot?: string;
  /** Default process.env. */
  env?: NodeJS.ProcessEnv;
  preFlight?: PreFlight;
  stepRunner?: StepRunner;
  scoreStep?: StepScorer;
  doctor?: Doctor;
}

interface ManifestStep {
  id: number;
  name: string;
  row_dir: string;
  seed_before?: string | null;
  seed_after?: string | null;
  halt_on_fail?: boolean;
  chain_setup_command?: string | null;
  chain_post_command?: string | null;
}

interface Manifest {
  initial_fixture: string;
  steps: ManifestStep[];
}

interface Flags {
  startFrom: number | null;
  haltOnFail: string;
  fresh: boolean;
  selfTest: boolean;
}

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function readOr(path: string, fallback = ''): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function parseLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v !== null && typeof v === 'object') rows.push(v as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return rows;
}

function parseFlags(argv: readonly string[]): Flags | string {
  const flags: Flags = { startFrom: null, haltOnFail: '1', fresh: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' || arg === '--halt-on-fail') {
      const value = argv[i + 1];
      if (value === undefined) return `missing value for ${arg}`;
      i++;
      if (arg === '--halt-on-fail') {
        flags.haltOnFail = value;
      } else {
        if (!/^\d+$/.test(value)) return `--from needs an integer: ${value}`;
        flags.startFrom = Number(value);
      }
    } else if (arg === '--fresh') {
      flags.fresh = true;
    } else if (arg === '--self-test') {
      flags.selfTest = true;
    } else {
      return `unknown arg: ${arg}`;
    }
  }
  return flags;
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && isFile(join(dir, cmd))) return true;
  }
  return false;
}

function runId(env: NodeJS.ProcessEnv): string {
  if (env.RUN_ID) return env.RUN_ID;
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${stamp}-${process.pid}`;
}

/** l5_pre_flight_or_abort in a child process, so its process.exit stays out of this run (the .sh ran it in a subshell). */
export const defaultPreFlight: PreFlight = (pluginRoot, env) => {
  const smoke = pathToFileURL(join(LIB_DIR, 'smoke-helpers.ts')).href;
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--experimental-sqlite',
      '--no-warnings',
      '--input-type=module',
      '-e',
      'const m = await import(process.argv[1]); m.l5PreFlightOrAbort(process.argv[2]);',
      smoke,
      pluginRoot,
    ],
    { env, stdio: 'inherit' },
  );
  return r.status === 0;
};

/** l6c_score_step with the scorer output in <logFile> (the .sh's `> scorers.txt 2>&1`). */
export const defaultScoreStep: StepScorer = (project, step, rowDir, id, env, logFile) => {
  const fd = openSync(logFile, 'w');
  try {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--experimental-sqlite', join(LIB_DIR, 'scorers.ts'), 'score-all', project, step, rowDir, id],
      { env, stdio: ['ignore', fd, fd] },
    );
    return r.status ?? 1;
  } finally {
    closeSync(fd);
  }
};

const defaultStepRunner: StepRunner = (project, rowDir, outJsonl, env) => l6cRunStep(project, rowDir, outJsonl, { env });

/** Prior run dirs under <runsRoot>, newest mtime first, <runDir> excluded. */
export function findRecentPriorRuns(runsRoot: string, runDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(runsRoot);
  } catch {
    return [];
  }
  const dirs: { path: string; mtime: number }[] = [];
  for (const name of names) {
    const path = join(runsRoot, name);
    if (path === runDir) continue;
    try {
      const st = statSync(path);
      if (st.isDirectory()) dirs.push({ path, mtime: st.mtimeMs });
    } catch {
      continue;
    }
  }
  return dirs.sort((a, b) => b.mtime - a.mtime).map((d) => d.path);
}

/**
 * The id of the first step to re-run: the first logged step whose status is not a pass, else the
 * first manifest id the log lacks; null when every manifest step is logged and passed.
 */
export function firstNonpassingStep(resultsFile: string, manifest: Manifest): number | null {
  if (!isFile(resultsFile)) return null;
  const rows = parseLines(readOr(resultsFile));
  const failed = rows.find((r) => r.status !== PASS);
  if (failed !== undefined) return Number(failed.id);
  const logged = new Set(rows.map((r) => Number(r.id)));
  const missing = manifest.steps.map((s) => Number(s.id)).sort((a, b) => a - b).find((id) => !logged.has(id));
  return missing ?? null;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status ?? 1, stdout: stripTrailingNewlines(r.stdout ?? '') };
}

function initProjectRepo(project: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(project, { recursive: true });
  git(project, ['init', '-q', '-b', 'main'], env);
  git(project, ['config', 'user.email', 'l6@l6.test'], env);
  git(project, ['config', 'user.name', 'L6 Test'], env);
  writeFileSync(join(project, 'README.md'), 'init\n');
  writeFileSync(join(project, '.gitignore'), '.claude/\n');
  if (git(project, ['add', '.'], env).status === 0) git(project, ['commit', '-qm', 'init'], env);
}

function trajectoryDb(project: string): string {
  return join(project, '.claude', 'tmb', 'trajectory.db');
}

function runShellIn(project: string, cmd: string, logFile: string, env: NodeJS.ProcessEnv): number {
  const fd = openSync(logFile, 'a');
  try {
    return spawnSync('bash', ['-c', cmd], { cwd: project, env, stdio: ['ignore', fd, fd] }).status ?? 1;
  } finally {
    closeSync(fd);
  }
}

function configPrTarget(db: string): string {
  let value = '';
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const row = conn.prepare("SELECT json_extract(value_json, '$') AS v FROM plugin_config WHERE key='pr_target'").get() as { v?: unknown } | undefined;
      if (row?.v !== undefined && row.v !== null) value = String(row.v);
    } finally {
      conn.close();
    }
  } catch {
    value = '';
  }
  return value || 'main';
}

/** repos.path, the schema's one absolute-path column, rewritten from the prior run's project to this run's; false on a DB error. */
function rewriteReposPath(db: string, oldProject: string, project: string): boolean {
  try {
    const conn = new DatabaseSync(db, { timeout: 3000 });
    try {
      const has = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get();
      if (has !== undefined) {
        conn.prepare('UPDATE repos SET path = REPLACE(path, ?, ?) WHERE path LIKE ?').run(oldProject, project, `${oldProject}%`);
      }
    } finally {
      conn.close();
    }
    return true;
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function turnStats(events: Record<string, unknown>[]): { tokens: number; durationMs: number } {
  let tokens = 0;
  let durationMs = 0;
  for (const ev of events) {
    if (ev.type !== 'result') continue;
    const usage = (ev.usage ?? {}) as Record<string, unknown>;
    tokens += (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    durationMs += Number(ev.duration_ms) || 0;
  }
  return { tokens, durationMs };
}

function toolUses(events: Record<string, unknown>[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as { type?: unknown } | null)?.type === 'tool_use') lines.push(`${JSON.stringify(block)}\n`);
    }
  }
  return lines.join('');
}

interface ChainContext {
  here: string;
  manifest: Manifest;
  runsRoot: string;
  runDir: string;
  runId: string;
  flags: Flags;
  env: NodeJS.ProcessEnv;
  stepRunner: StepRunner;
  scoreStep: StepScorer;
  doctor: Doctor;
}

/** Resolves the start step and lays down <runDir>/project; returns the start step, or null on a failed resume. */
function prepareProject(c: ChainContext, project: string): number | null {
  const { env, flags, manifest, runsRoot, runDir } = c;
  let startFrom: number;
  if (flags.fresh) {
    startFrom = 1;
  } else if (flags.startFrom !== null) {
    startFrom = flags.startFrom;
  } else {
    startFrom = 1;
    for (const prior of findRecentPriorRuns(runsRoot, runDir)) {
      if (!isFile(join(prior, '_results.jsonl'))) continue;
      const first = firstNonpassingStep(join(prior, '_results.jsonl'), manifest);
      if (first !== null) {
        out(`  auto-resume: prior run ${basename(prior)} halted at step ${first}; resuming from there\n`);
        startFrom = first;
      }
      break;
    }
  }

  if (startFrom > 1) {
    const priorRun = findRecentPriorRuns(runsRoot, runDir)[0] ?? '';
    const prevStep = startFrom - 1;
    let checkpointDir = '';
    if (priorRun !== '') {
      const prefix = `step-${pad2(prevStep)}-`;
      const match = readdirSync(priorRun)
        .sort()
        .find((name) => name.startsWith(prefix) && isDir(join(priorRun, name)));
      if (match !== undefined) checkpointDir = join(priorRun, match);
    }
    const checkpointDb = checkpointDir !== '' && isFile(join(checkpointDir, 'checkpoint.db')) ? join(checkpointDir, 'checkpoint.db') : '';
    const checkpointTar =
      checkpointDir !== '' && isFile(join(checkpointDir, 'checkpoint-project.tar')) ? join(checkpointDir, 'checkpoint-project.tar') : '';
    const priorName = basename(priorRun);

    if (checkpointDb !== '' && checkpointTar !== '') {
      out(`  resume:   --from ${startFrom} restoring step-${pad2(prevStep)} checkpoint (db + project tree) from ${priorName}\n`);
      mkdirSync(dirname(project), { recursive: true });
      spawnSync('tar', ['-C', dirname(project), '-xf', checkpointTar], { env, stdio: 'inherit' });
      mkdirSync(dirname(trajectoryDb(project)), { recursive: true });
      copyFileSync(checkpointDb, trajectoryDb(project));
    } else if (checkpointDb !== '') {
      out(
        `  resume:   --from ${startFrom} restoring step-${pad2(prevStep)} checkpoint (db only — no project tar; git-dependent steps may fail) from ${priorName}\n`,
      );
      l5InitStateDir(project);
      initProjectRepo(project, env);
      copyFileSync(checkpointDb, trajectoryDb(project));
    } else if (priorRun !== '' && isDir(join(priorRun, 'project'))) {
      out(`  resume:   --from ${startFrom} no checkpoint for step-${pad2(prevStep)}; falling back to live project from ${priorName}\n`);
      cpSync(join(priorRun, 'project'), project, { recursive: true, verbatimSymlinks: true });
    } else {
      err(`  ⚠ --from ${startFrom} but no prior run with checkpoint or project found; starting from empty state (standalone-row mode)\n`);
      moveDir(l5SetupScratchProject(env), project);
    }

    const inherited = trajectoryDb(project);
    const oldProject = join(priorRun, 'project');
    if (priorRun !== '' && isFile(inherited) && oldProject !== project) {
      out(`  path-rewrite: repos.path ${oldProject} → ${project}\n`);
      if (!rewriteReposPath(inherited, oldProject, project)) {
        err(`❌ resume path-rewrite failed for repos.path in ${inherited}\n`);
        return null;
      }
    }
  } else {
    initProjectRepo(project, env);
  }
  l5InitStateDir(project);
  return startFrom;
}

function runChain(c: ChainContext): number {
  const { env, flags, here, manifest, runDir } = c;
  const resultsJsonl = join(runDir, '_results.jsonl');
  writeFileSync(resultsJsonl, '');
  const project = join(runDir, 'project');

  const startFrom = prepareProject(c, project);
  if (startFrom === null) return 1;

  out(`  fixture:  ${manifest.initial_fixture}\n`);
  if (startFrom === 1 && l5SeedDb(project, manifest.initial_fixture, { env }) !== 0) {
    err('❌ fixture seed failed\n');
    return 1;
  }
  out('  mode:     fresh `claude -p` per row (DB-driven resume)\n\n');

  const chainTrajectory = join(runDir, 'chain-trajectory.jsonl');
  writeFileSync(chainTrajectory, '');
  let chainPass = 0;
  let chainFail = 0;

  for (const step of manifest.steps) {
    const stepId = Number(step.id);
    const stepName = step.name;
    const haltStep = step.halt_on_fail === true;
    const halts = flags.haltOnFail === '1' && haltStep;

    if (stepId < startFrom) {
      out(`── step ${stepId} (${stepName}): SKIP (before --from)\n`);
      continue;
    }

    const rowDir = join(here, step.row_dir);
    if (!isDir(rowDir)) {
      err(`  ✗ step ${stepId}: row dir missing: ${rowDir}\n`);
      chainFail++;
      if (halts) break;
      continue;
    }

    const stepDir = join(runDir, `step-${pad2(stepId)}-${stepName.replace(/^[0-9][0-9]-/, '')}`);
    mkdirSync(stepDir, { recursive: true });
    out(`\n── step ${stepId} (${stepName}) ──\n`);

    if (step.seed_before) {
      const seed = join(here, 'l6-chain', step.seed_before);
      out(`  seed_before: ${step.seed_before}\n`);
      l6cApplySeed(project, seed, env);
      if (isFile(seed)) copyFileSync(seed, join(stepDir, 'seed-before.sql'));
    }

    if (step.chain_setup_command) {
      out(`  chain_setup_command: ${step.chain_setup_command}\n`);
      if (runShellIn(project, step.chain_setup_command, join(stepDir, 'chain-setup.log'), env) !== 0) {
        err('  ⚠ chain_setup_command exited non-zero (continuing)\n');
      }
    }

    const db = trajectoryDb(project);
    l6cSnapshotDb(project, join(stepDir, 'pre-state.sql'), env);
    if (isFile(db)) copyFileSync(db, join(project, '.claude', 'tmb', '_l6_pre_step.db'));
    if (isFile(join(rowDir, 'prompt.txt'))) copyFileSync(join(rowDir, 'prompt.txt'), join(stepDir, 'user-input.txt'));

    const prTarget = configPrTarget(db);
    if (git(project, ['rev-parse', '--verify', prTarget], env).status !== 0 && git(project, ['rev-parse', '--verify', 'main'], env).status === 0) {
      git(project, ['branch', prTarget, 'main'], env);
      out(`  ensured branch '${prTarget}' exists (from main)\n`);
    }

    if (git(project, ['rev-parse', 'HEAD'], env).status === 0) {
      const target = git(project, ['rev-parse', prTarget], env);
      const head = target.status === 0 ? target : git(project, ['rev-parse', 'HEAD'], env);
      l5InitStateDir(project);
      writeFileSync(
        join(project, '.claude', 'tmb', '_l5_pre_run_git.json'),
        `${JSON.stringify({ head: head.status === 0 ? head.stdout : '', branch: prTarget })}\n`,
      );
    }

    const turnJsonl = join(stepDir, 'turn.jsonl');
    out('  step: fresh session, multi-turn within step (DB-driven across steps)\n');
    l6cLaunchStep(c.stepRunner, project, rowDir, turnJsonl, env);

    const turnText = readOr(turnJsonl);
    appendFileSync(chainTrajectory, turnText);
    writeFileSync(join(project, 'trajectory.jsonl'), turnText);

    const events = parseLines(turnText);
    const broText = lastAssistantText(turnJsonl);
    writeFileSync(join(stepDir, 'bro-response.txt'), broText === '' ? '' : `${broText}\n`);
    writeFileSync(join(stepDir, 'tool-uses.jsonl'), toolUses(events));

    l6cSnapshotDb(project, join(stepDir, 'post-state.sql'), env);
    const diffFd = openSync(join(stepDir, 'post-state.diff'), 'w');
    try {
      spawnSync('diff', ['-u', join(stepDir, 'pre-state.sql'), join(stepDir, 'post-state.sql')], { env, stdio: ['ignore', diffFd, 'ignore'] });
    } finally {
      closeSync(diffFd);
    }

    const { tokens, durationMs } = turnStats(events);
    env.SCENARIO_NAME = stepName;
    const stepFails = c.scoreStep(project, stepName, rowDir, c.runId, env, join(stepDir, 'scorers.txt'));

    const summary = { id: stepId, name: stepName, scorer_fails: stepFails, tokens, duration_ms: durationMs };
    writeFileSync(join(stepDir, 'scorers.json'), `${JSON.stringify(summary, null, 2)}\n`);

    let status: string;
    if (stepFails === 0) {
      status = PASS;
      chainPass++;
      out(`  ✓ step ${stepId} passed (tokens=${tokens} duration=${durationMs}ms)\n`);
    } else {
      status = FAIL;
      chainFail++;
      out(`  ✗ step ${stepId} failed (${stepFails} scorer fails)\n`);
    }
    appendFileSync(
      resultsJsonl,
      `${JSON.stringify({ id: stepId, name: stepName, status, scorer_fails: stepFails, tokens, duration_ms: durationMs })}\n`,
    );

    if (stepFails !== 0 && halts) {
      out('  ── halting chain at first failure (per step manifest halt_on_fail) ──\n');
      break;
    }

    if (step.seed_after) {
      const seed = join(here, 'l6-chain', step.seed_after);
      out(`  seed_after: ${step.seed_after}\n`);
      l6cApplySeed(project, seed, env);
      if (isFile(seed)) copyFileSync(seed, join(stepDir, 'seed-applied.sql'));
    }

    if (step.chain_post_command) {
      out(`  chain_post_command: ${step.chain_post_command}\n`);
      if (runShellIn(project, step.chain_post_command, join(stepDir, 'chain-post.log'), env) !== 0) {
        err('  ⚠ chain_post_command exited non-zero (continuing)\n');
      }
    }

    if (stepFails === 0) {
      if (isFile(db)) copyFileSync(db, join(stepDir, 'checkpoint.db'));
      spawnSync('tar', ['-C', dirname(project), '-cf', join(stepDir, 'checkpoint-project.tar'), basename(project)], { env, stdio: 'ignore' });
    }
  }

  l6cWriteChainSummary(runDir, resultsJsonl);

  out('\n=== trajectory_doctor (run DB) ===\n');
  let doctorFail = false;
  if (c.doctor(trajectoryDb(project), join(runDir, 'trajectory-doctor.json'), env) === 0) {
    out('  ✓ trajectory DB healthy\n');
  } else {
    doctorFail = true;
  }

  out('\n========================================\n');
  out(`L6 chain: ${chainPass} passed, ${chainFail} failed\n`);
  if (doctorFail) out(`Trajectory DB: unhealthy — see ${runDir}/trajectory-doctor.json\n`);
  out(`Logs:     ${runDir}\n`);
  out(`Summary:  ${runDir}/chain-summary.md\n`);
  return chainFail === 0 && !doctorFail ? 0 : 1;
}

export interface SelfTestCheck {
  name: string;
  got: string;
  want: string;
}

function captureStderr<T>(fn: () => T): { value: T; stderr: string } {
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

function withoutVars(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

function createTasksDb(path: string): void {
  const conn = new DatabaseSync(path);
  try {
    conn.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);');
  } finally {
    conn.close();
  }
}

/**
 * The --self-test checks (no model calls): run-dir resolution, the isolated HOME and its
 * end-of-run assertion with a stub step runner, and DB resolution for a scratch project nested in
 * a workspace.
 */
export function selfTestChecks(baseEnv: NodeJS.ProcessEnv = process.env): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  const check = (name: string, got: string, want: string) => checks.push({ name, got, want });
  const here = L5_DOGFOOD_DIR;

  const common = git(here, ['rev-parse', '--path-format=absolute', '--git-common-dir'], baseEnv).stdout;
  const repo = dirname(common);
  const noRuns = withoutVars(baseEnv, ['L6C_RUNS_DIR']);
  check('runs root under CLAUDE_PROJECT_DIR', String(l6cResolveRunsRoot(PLUGIN_ROOT, { ...noRuns, CLAUDE_PROJECT_DIR: '/proj/x' })), '/proj/x/.claude/tmb/l6-chain-runs');
  check(
    'runs root under the main checkout',
    String(captureStderr(() => l6cResolveRunsRoot(PLUGIN_ROOT, withoutVars(noRuns, ['CLAUDE_PROJECT_DIR']))).value),
    `${repo}/.claude/tmb/l6-chain-runs`,
  );
  check('L6C_RUNS_DIR overrides', String(l6cResolveRunsRoot(PLUGIN_ROOT, { ...baseEnv, L6C_RUNS_DIR: '/override/runs', CLAUDE_PROJECT_DIR: '/proj/x' })), '/override/runs');

  const st = join(git(here, ['rev-parse', '--show-toplevel'], baseEnv).stdout, '.claude', 'tmb', 'l6-chain-runs', `self-test-${process.pid}`);
  rmSync(st, { recursive: true, force: true });
  try {
    mkdirSync(join(st, 'real-home', '.cache', 'huggingface'), { recursive: true });
    mkdirSync(join(st, 'row'), { recursive: true });
    const stubStep: StepRunner = (_project, _rowDir, outJsonl, env) => {
      writeFileSync(outJsonl, `${env.HOME ?? ''}\n${env.TMB_SANDBOX_ORIG_HOME ?? ''}\n`);
    };
    const realEnv = { ...withoutVars(baseEnv, ['TMB_MODEL_CACHE_DIR', 'HF_HOME', 'TRANSFORMERS_CACHE']), HOME: join(st, 'real-home') };
    const chainEnv = l6cIsolateHome(join(st, 'run'), realEnv);
    mkdirSync(join(st, 'run', 'project'), { recursive: true });
    l6cLaunchStep(stubStep, join(st, 'run', 'project'), join(st, 'row'), join(st, 'run', 'turn.jsonl'), chainEnv);
    const [stepHome = '', origHome = ''] = readOr(join(st, 'run', 'turn.jsonl')).split('\n');
    check(
      'chain HOME is <run-dir>/home, HF cache routed, step sandboxed under the run dir',
      `${chainEnv.HOME}|${chainEnv.HF_HOME ?? ''}|${stepHome}|${origHome}`,
      `${st}/run/home|${st}/real-home/.cache/huggingface|${st}/run/project/_home|${st}/run/home`,
    );
    check('isolated HOME mode is 0700', (statSync(join(st, 'run', 'home')).mode & 0o777).toString(8), '700');

    const home = join(st, 'run', 'home');
    const clean = () => {
      const r = captureStderr(() => l6cAssertHomeClean(home));
      return { pass: r.value === 0, stderr: r.stderr };
    };
    check('empty isolated HOME passes', clean().pass ? 'pass' : 'fail', 'pass');
    mkdirSync(join(home, '.cache', 'huggingface', 'models'), { recursive: true });
    writeFileSync(join(home, '.cache', 'huggingface', 'models', 'weights.bin'), '');
    check('.cache/huggingface alone passes', clean().pass ? 'pass' : 'fail', 'pass');
    writeFileSync(join(home, '.claude.json'), '');
    const stray = clean();
    check(
      'a stray file fails the run, listing it',
      stray.pass ? 'pass' : String(stray.stderr.split('\n').filter((line) => line.includes('$HOME/.claude.json')).length),
      '1',
    );
    rmSync(join(home, '.claude.json'), { force: true });
    mkdirSync(join(home, '.cache', 'pip'), { recursive: true });
    check('another .cache entry fails', clean().pass ? 'pass' : 'fail', 'fail');
  } finally {
    rmSync(st, { recursive: true, force: true });
  }

  // GH 1553: a scratch project nested in a workspace resolves its own DB only because
  // l5InitStateDir writes the standalone marker. Everything sits under a temp HOME, so the walk
  // can never reach a live DB.
  const nest = realpathSync(mkdtempSync(`${(baseEnv.TMPDIR || '/tmp').replace(/\/+$/, '')}/l6-nest.`));
  try {
    const ws = join(nest, 'home', 'ws');
    const nested = join(ws, '.claude', 'tmb', 'l6-chain-runs', 'run', 'project');
    mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    createTasksDb(join(ws, '.claude', 'tmb', 'trajectory.db'));
    l5InitStateDir(nested);
    createTasksDb(join(nested, '.claude', 'tmb', 'trajectory.db'));
    const dbPathEnv = {
      ...withoutVars(baseEnv, ['TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TRAJECTORY_DB_PATH', 'CLAUDE_PLUGIN_ROOT']),
      HOME: join(nest, 'home'),
      CLAUDE_PROJECT_DIR: nested,
    };
    const resolvedDb = () => {
      const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', CLI_JS, 'hook-lib', 'db-path'], {
        cwd: '/',
        env: dbPathEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return stripTrailingNewlines(r.stdout ?? '');
    };
    check('l5_init_state_dir writes the standalone marker', existsSync(join(nested, '.claude', 'tmb', 'standalone')) ? 'present' : 'missing', 'present');
    check('nested scratch project with the marker resolves its own DB', resolvedDb(), join(nested, '.claude', 'tmb', 'trajectory.db'));
    rmSync(join(nested, '.claude', 'tmb', 'standalone'), { force: true });
    check('nested scratch project without the marker resolves the workspace DB', resolvedDb(), join(ws, '.claude', 'tmb', 'trajectory.db'));
  } finally {
    rmSync(nest, { recursive: true, force: true });
  }
  return checks;
}

/** l6c_self_test: prints an ok/FAIL line per check; 0 when all pass, else 1. */
export function selfTest(baseEnv: NodeJS.ProcessEnv = process.env): number {
  out('=== run-l6-chain.ts --self-test ===\n');
  let fails = 0;
  for (const { name, got, want } of selfTestChecks(baseEnv)) {
    if (got === want) {
      out(`  ok   ${name}\n`);
    } else {
      out(`  FAIL ${name}\n       want: ${want}\n       got:  ${got}\n`);
      fails++;
    }
  }
  if (fails === 0) {
    out('run-l6-chain self-test: PASS\n');
    return 0;
  }
  out(`run-l6-chain self-test: FAIL (${fails})\n`);
  return 1;
}

/** The runner: parses argv, runs the chain (or --self-test) and returns the exit code. */
export function main(argv: readonly string[], opts: MainOptions = {}): number {
  const flags = parseFlags(argv);
  if (typeof flags === 'string') {
    err(`${flags}\n`);
    return 2;
  }
  const baseEnv: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), PLUGIN_ROOT };
  if (flags.selfTest) return selfTest(baseEnv);

  const here = opts.here ?? L5_DOGFOOD_DIR;
  const manifestPath = opts.manifest ?? join(here, 'l6-chain', 'chain-manifest.json');

  if (!baseEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    err('❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n');
    return 1;
  }
  for (const cmd of ['claude', 'sqlite3', 'jq', 'git', 'diff']) {
    if (!onPath(cmd, baseEnv)) {
      err(`❌ ${cmd} not found in PATH.\n`);
      return 1;
    }
  }
  if (!isFile(manifestPath)) {
    err(`❌ manifest not found: ${manifestPath}\n`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  const id = runId(baseEnv);
  const runsRoot = opts.runsRoot ?? l6cResolveRunsRoot(PLUGIN_ROOT, baseEnv);
  if (runsRoot === null) return 1;
  mkdirSync(runsRoot, { recursive: true });
  chmodSync(runsRoot, 0o700);
  const runDir = join(runsRoot, id);
  mkdirSync(runDir, { recursive: true });

  out(`=== L6 chain run ${id} ===\n`);
  out(`  runs:     ${runsRoot}\n`);
  out(`  manifest: ${manifestPath}\n`);
  out(`  logs:     ${runDir}\n`);

  // The pre-flight's own `claude -p` calls run under a HOME of their own, so their state stays out
  // of the asserted chain HOME. A failed pre-flight removes the run dir so auto-resume skips it.
  const preflightHome = join(runDir, 'preflight-home');
  mkdirSync(preflightHome, { recursive: true });
  if (!(opts.preFlight ?? defaultPreFlight)(PLUGIN_ROOT, { ...baseEnv, HOME: preflightHome })) {
    rmSync(runDir, { recursive: true, force: true });
    return 1;
  }

  const env = l6cIsolateHome(runDir, baseEnv);
  const chainHome = env.HOME ?? '';
  out(`  HOME:     ${chainHome} (must end holding only .cache/huggingface)\n`);

  let rc = 1;
  try {
    rc = runChain({
      here,
      manifest,
      runsRoot,
      runDir,
      runId: id,
      flags,
      env,
      stepRunner: opts.stepRunner ?? defaultStepRunner,
      scoreStep: opts.scoreStep ?? defaultScoreStep,
      doctor: opts.doctor ?? l6cTrajectoryDoctor,
    });
  } finally {
    out('\n=== isolated HOME ===\n');
    if (l6cAssertHomeClean(chainHome) === 0) {
      out(`  ✓ ${chainHome} holds nothing but .cache/huggingface\n`);
    } else {
      rc = 1;
    }
  }
  return rc;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
