/**
 * The corpus of every PreToolUse router gate, each payload materialized in its
 * gate's parity sandbox (the builders of the hooks-*-parity suites), with the
 * env and cwd its parity run uses, in-process. Shared by the router parity
 * tests and the router benches. swe-resume-gate has no hook-corpus directory
 * (it was born in TypeScript), so its cases are built here.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildTemplate as agentSpawnTemplate, caseEnv as agentSpawnEnv } from './hooks-agent-spawn-parity.suite.js';
import { buildSandbox as gitBranchSandbox, caseEnv as gitBranchEnv, GIT_BRANCH_GATES, materialize as gitBranchCase } from './hooks-git-branch-guards-parity.suite.js';
import { buildSandbox as gitGuardsSandbox, materialize as gitGuardsCase } from './hooks-git-guards-parity.suite.js';
import { buildSandbox as pushGuardSandbox, materialize as pushGuardCase } from './hooks-git-push-guard-parity.suite.js';
import { buildSourceEditSandbox, caseEnv as sourceEditEnv, materialize as sourceEditCase } from './hooks-no-source-edit-parity.suite.js';
import { containmentGuardSetup } from './hooks-parity.suite.js';
import { buildSandbox as remoteIdSandbox, materialize as remoteIdCase } from './hooks-remote-id-guard-parity.suite.js';
import { buildSandbox as roundtableSandbox, caseEnv as roundtableEnv, materialize as roundtableCase } from './hooks-roundtable-parity.suite.js';
import { buildSandbox as sessionSandbox, caseEnv as sessionEnv, materialize as sessionCase } from './hooks-session-parity.suite.js';
import { buildSandbox as sweBoundarySandbox, materialize as sweBoundaryCase, resetState as sweBoundaryReset } from './hooks-swe-boundary-parity.suite.js';
import { buildSandbox as sweRunSandbox, caseEnv as sweRunEnv, materialize as sweRunCase } from './hooks-swe-run-parity.suite.js';
import { buildScopeSandbox, caseEnv as scopeEnv } from './hooks-swe-scope-fence-parity.suite.js';
import { buildVerificationSandbox, caseEnv as verificationEnv, materialize as verificationCase } from './hooks-swe-verification-parity.suite.js';
import { buildSandbox as chainSandbox, caseEnv as chainEnv, materialize as chainCase, TRAJECTORY_CHAIN_GATES } from './hooks-trajectory-chain-parity.suite.js';
import { lintSandbox } from './lint-hooks-sandbox.js';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const LOCALE = 'C';
export const FAKE_UID = 4242424;

export const ROUTER_BASH_GATES = [
  'containment-guard',
  'git-guards',
  'git-push-guard',
  'swe-boundary',
  ...GIT_BRANCH_GATES,
  'commit-msg-lint',
  'remote-id-guard',
  'debug-trajectory',
] as const;

export const ROUTER_CORPUS_GATES = [
  ...ROUTER_BASH_GATES,
  'swe-brief-gate',
  'no-source-edit-from-main',
  'swe-scope-fence',
  'naming-lint',
  'code-quality-lint',
  'agent-spawn-dispatch',
  'swe-resume-gate',
  ...TRAJECTORY_CHAIN_GATES,
  'swe-verification-gate',
  'askuserquestion-length-lint',
  'roundtable-auq-shape',
] as const;

export type RouterCorpusGate = (typeof ROUTER_CORPUS_GATES)[number];

export interface RouterCase {
  gate: string;
  file: string;
  input: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** containment-guard's sandbox runs under a fake uid (process.getuid). */
  fakeUid: boolean;
  /** Resets the sandbox state the payload starts from. */
  reset?: () => void;
}

export interface RouterSandbox {
  cases: RouterCase[];
  cleanup(): void;
}

function files(gate: string): string[] {
  const dir = join(CORPUS_ROOT, gate);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(dir, f))
    : [];
}

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function clean(env: NodeJS.ProcessEnv, drop: readonly string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null && !drop.includes(k)) out[k] = v;
  return out;
}

/** The corpus of <gates> (default: every router gate), materialized under <root> (an existing, real dir); only those gates' sandboxes are built. */
export function routerSandbox(rootDir: string, gates?: readonly RouterCorpusGate[]): RouterSandbox {
  const want = (gate: RouterCorpusGate): boolean => gates === undefined || gates.includes(gate);
  const root = realpathSync(rootDir);
  const cases: RouterCase[] = [];
  const cleanups: (() => void)[] = [];
  const emptyProject = join(root, 'empty-project');
  mkdirSync(emptyProject, { recursive: true });
  const path = process.env.PATH ?? '';

  if (want('containment-guard')) {
    const cg = containmentGuardSetup(join(root, 'cg'));
    for (const file of files('containment-guard')) {
      const { input, env } = cg.materialize?.(readFileSync(file)) ?? { input: readFileSync(file), env: {} };
      cases.push({
        gate: 'containment-guard',
        file,
        input: input.toString('utf8'),
        env: clean({ ...process.env, CLAUDE_PROJECT_DIR: emptyProject, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: LOCALE, ...cg.env, ...env }, ['NODE_OPTIONS']),
        cwd: cg.cwd ?? emptyProject,
        fakeUid: true,
      });
    }
  }

  for (const [gate, build, materialize] of [
    ['git-guards', gitGuardsSandbox, gitGuardsCase],
    ['git-push-guard', pushGuardSandbox, pushGuardCase],
  ] as const) {
    if (!want(gate)) continue;
    const sb = join(root, gate);
    mkdirSync(sb, { recursive: true });
    build(sb);
    for (const file of files(gate)) {
      const c = materialize(file, sb);
      cases.push({
        gate,
        file,
        input: c.input,
        env: clean(
          {
            ...process.env,
            ...GIT_ENV,
            CLAUDE_PROJECT_DIR: join(sb, 'project'),
            CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
            TRAJECTORY_DB_PATH: join(sb, 'db/trajectory.db'),
            LC_ALL: LOCALE,
            ...c.env,
          },
          ['TMB_HOOKS_SQLITE'],
        ),
        cwd: join(sb, 'project'),
        fakeUid: false,
      });
    }
  }

  if (want('swe-boundary')) {
    const sbDir = join(root, 'swe-boundary');
    mkdirSync(sbDir, { recursive: true });
    const sb = sweBoundarySandbox(sbDir);
    cleanups.push(() => rmSync(sb.scratchProject, { recursive: true, force: true }));
    for (const file of files('swe-boundary')) {
      const c = sweBoundaryCase(file, sb);
      cases.push({
        gate: 'swe-boundary',
        file,
        input: c.input,
        env: clean(
          { ...process.env, CLAUDE_PROJECT_DIR: join(sb.dir, 'project'), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TRAJECTORY_DB_PATH: sb.db, LC_ALL: LOCALE, ...c.env },
          ['TMB_HOOKS_SQLITE', 'NODE_OPTIONS'],
        ),
        cwd: join(sb.dir, 'project'),
        fakeUid: false,
        reset: () => sweBoundaryReset(sb, c.record, Math.floor(Date.now() / 1000)),
      });
    }
  }

  const branchGates = GIT_BRANCH_GATES.filter(want);
  if (branchGates.length > 0) {
    const gb = join(root, 'git-branch/sandbox');
    mkdirSync(gb, { recursive: true });
    gitBranchSandbox(gb);
    for (const gate of branchGates) {
      for (const file of files(gate)) {
        const c = gitBranchCase(file, gb, { noJq: path, noSqlite: path });
        cases.push({ gate, file, input: c.input.toString('utf8'), env: clean(gitBranchEnv(gb, LOCALE, c.env, c.cwd)), cwd: c.cwd, fakeUid: false });
      }
    }
  }

  const lintGates = (['commit-msg-lint', 'naming-lint', 'code-quality-lint'] as const).filter(want);
  if (lintGates.length > 0) {
    const lint = lintSandbox(join(root, 'lint'));
    for (const file of lintGates.flatMap((gate) => files(gate).map((f) => [gate, f] as const))) {
      const c = lint.materialize(readFileSync(file[1]));
      cases.push({
        gate: file[0],
        file: file[1],
        input: c.input.toString('utf8'),
        env: clean({ ...process.env, CLAUDE_PROJECT_DIR: emptyProject, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: LOCALE, ...lint.env, ...c.env }),
        cwd: emptyProject,
        fakeUid: false,
      });
    }
  }

  if (want('remote-id-guard')) {
    const rid = join(root, 'remote-id/sandbox');
    remoteIdSandbox(rid);
    for (const file of files('remote-id-guard')) {
      const c = remoteIdCase(file, rid, { noJq: path, noSqlite: path });
      cases.push({
        gate: 'remote-id-guard',
        file,
        input: c.input,
        env: clean(
          {
            ...process.env,
            CLAUDE_PROJECT_DIR: join(rid, 'project'),
            CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
            TRAJECTORY_DB_PATH: join(rid, 'db/trajectory.db'),
            LC_ALL: LOCALE,
            ...c.env,
          },
          ['TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE'],
        ),
        cwd: join(rid, 'project'),
        fakeUid: false,
      });
    }
  }

  if (want('debug-trajectory')) {
    const ss = join(root, 'session/sandbox');
    sessionSandbox(ss);
    for (const file of files('debug-trajectory')) {
      const c = sessionCase(file, ss, path);
      cases.push({
        gate: 'debug-trajectory',
        file,
        input: c.input.toString('utf8'),
        env: clean(sessionEnv(ss, LOCALE, c.env, c.cwd)),
        cwd: c.cwd,
        fakeUid: false,
        reset: () => sessionSandbox(ss),
      });
    }
  }

  if (want('askuserquestion-length-lint')) {
    for (const file of files('askuserquestion-length-lint')) {
      cases.push({
        gate: 'askuserquestion-length-lint',
        file,
        input: readFileSync(file, 'utf8'),
        env: clean({ ...process.env, CLAUDE_PROJECT_DIR: emptyProject, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LC_ALL: LOCALE }),
        cwd: emptyProject,
        fakeUid: false,
      });
    }
  }

  const paths = { noJq: path, noSqlite: path };
  const rebuilt = (gate: RouterCorpusGate, dir: string, build: (s: string) => void, one: (file: string) => { input: Buffer; env: NodeJS.ProcessEnv; cwd: string }, fakeUid = false): void => {
    if (!want(gate)) return;
    mkdirSync(dirname(dir), { recursive: true });
    build(dir);
    for (const file of files(gate)) {
      const c = one(file);
      cases.push({ gate, file, input: c.input.toString('utf8'), env: clean(c.env, ['NODE_OPTIONS']), cwd: c.cwd, fakeUid, reset: () => build(dir) });
    }
  };

  const briefDir = join(root, 'swe-brief/sandbox');
  rebuilt('swe-brief-gate', briefDir, sweRunSandbox, (file) => {
    const c = sweRunCase(file, briefDir, paths);
    return { input: c.input, env: sweRunEnv(briefDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
  });

  const fenceDir = join(root, 'swe-scope-fence/sandbox');
  rebuilt('swe-scope-fence', fenceDir, buildScopeSandbox, (file) => {
    const c = sweRunCase(file, fenceDir, paths);
    return { input: c.input, env: scopeEnv(fenceDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
  });

  const sourceDir = join(root, 'no-source-edit/sandbox');
  rebuilt(
    'no-source-edit-from-main',
    sourceDir,
    buildSourceEditSandbox,
    (file) => {
      const c = sourceEditCase(file, { sandbox: sourceDir, harnessTmp: `${realpathSync('/tmp')}/claude-${FAKE_UID}`, ...paths });
      return { input: c.input, env: sourceEditEnv(sourceDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
    },
    true,
  );

  for (const gate of TRAJECTORY_CHAIN_GATES) {
    const dir = join(root, `chain-${gate}/sandbox`);
    rebuilt(gate, dir, chainSandbox, (file) => {
      const c = chainCase(file, dir, paths);
      return { input: c.input, env: chainEnv(dir, LOCALE, c.env, c.cwd), cwd: c.cwd };
    });
  }

  const verificationBase = join(root, 'swe-verification');
  const verificationDir = join(verificationBase, 'sandbox');
  rebuilt('swe-verification-gate', verificationDir, buildVerificationSandbox, (file) => {
    const c = verificationCase(file, verificationDir, paths);
    return { input: c.input, env: verificationEnv(verificationDir, verificationBase, LOCALE, c.env, c.cwd), cwd: c.cwd };
  });

  const roundtableDir = join(root, 'roundtable/sandbox');
  rebuilt('roundtable-auq-shape', roundtableDir, roundtableSandbox, (file) => {
    const c = roundtableCase(file, roundtableDir, paths);
    return { input: c.input, env: roundtableEnv(roundtableDir, LOCALE, c.env, c.cwd), cwd: c.cwd };
  });

  if (want('agent-spawn-dispatch')) {
    const dir = join(root, 'agent-spawn/sandbox');
    const template = join(root, 'agent-spawn/template');
    mkdirSync(dirname(dir), { recursive: true });
    agentSpawnTemplate(dir);
    cpSync(dir, template, { recursive: true });
    for (const file of files('agent-spawn-dispatch')) {
      const c = sweRunCase(file, dir, paths);
      cases.push({
        gate: 'agent-spawn-dispatch',
        file,
        input: c.input.toString('utf8'),
        env: clean(agentSpawnEnv(dir, LOCALE, c.env, c.cwd)),
        cwd: c.cwd,
        fakeUid: false,
        reset: () => {
          rmSync(dir, { recursive: true, force: true });
          cpSync(template, dir, { recursive: true });
        },
      });
    }
  }

  if (want('swe-resume-gate')) cases.push(...sweResumeCases(join(root, 'swe-resume'), emptyProject));

  return {
    cases,
    cleanup: () => {
      for (const f of cleanups) f();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const SWE_RESUME_T0 = '2026-10-25T09:00:00.000Z';

/** swe-resume-gate's cases, on a DB holding one swe and one code-reviewer of task 3, rebuilt per case. */
function sweResumeCases(dir: string, cwd: string): RouterCase[] {
  const db = join(dir, 'trajectory.db');
  mkdirSync(dir, { recursive: true });
  const schema = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
  const build = (runEffort: string, fails: number): void => {
    rmSync(db, { force: true });
    const d = new DatabaseSync(db);
    d.exec(schema);
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
    d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, effort, created_at, updated_at) VALUES (3, 9, 'feat/3-x', 'd', 'running', 'medium', ?, ?)").run(SWE_RESUME_T0, SWE_RESUME_T0);
    d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, spawn_id, effort, exit_reason) VALUES (3, 9, 'swe', ?, ?, 'agent-swe-1', ?, 'completed')").run(SWE_RESUME_T0, SWE_RESUME_T0, runEffort);
    d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id) VALUES (3, 9, 'code-reviewer', ?, 'agent-reviewer-1')").run(SWE_RESUME_T0);
    for (let i = 1; i <= fails; i++) {
      d.prepare("INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (3, ?, 'code-reviewer', 'fail', 'f', 1, ?)").run(i, `2026-10-25T10:0${i}:00.000Z`);
    }
    d.close();
  };
  const env = clean({ PATH: process.env.PATH, HOME: join(dir, 'home'), TRAJECTORY_DB_PATH: db, LC_ALL: LOCALE });
  const scenarios: readonly (readonly [string, string, string, number])[] = [
    ['resume-allowed', 'agent-swe-1', 'medium', 0],
    ['resume-at-rework-limit', 'agent-swe-1', 'medium', 2],
    ['resume-effort-mismatch', 'agent-swe-1', 'high', 0],
    ['not-a-swe', 'agent-reviewer-1', 'medium', 2],
  ];
  return scenarios.map(([file, to, effort, fails]) => ({
    gate: 'swe-resume-gate',
    file,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to, message: 'fix the FAIL findings' } }),
    env,
    cwd,
    fakeUid: false,
    reset: () => build(effort, fails),
  }));
}

/** Runs <fn> under the case's uid (containment-guard's fake one, or the real one). */
export async function underUid<T>(fake: boolean, fn: () => Promise<T>): Promise<T> {
  if (!fake) return fn();
  const real = process.getuid;
  process.getuid = () => FAKE_UID;
  try {
    return await fn();
  } finally {
    process.getuid = real;
  }
}
