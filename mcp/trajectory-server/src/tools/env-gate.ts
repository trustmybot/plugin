// The environment gate task_provision, task_reopen and task_retry run before
// their DB transaction (GH 2866): it admits only an environment whose every
// stage proved ready, and on a refusal removes what this call created.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import type { TrajectoryDB } from '../db.js';
import type { WorldModelGraph } from '../graph.js';
import { joinToolchainPath, toolchainDirs } from '../hooks/swe-verification-gate.js';
import { revParseCommit } from '../utils/git-objects.js';
import { runGit } from '../utils/git-run.js';
import { BASE_FETCH_TIMEOUT_MS, WORKTREE_TIMEOUT_MS } from '../utils/timeouts.js';
import { prepareWorktreeDeps } from '../utils/worktree-deps.js';
import { runWorktreeSetup, type WorktreeSetupResult } from '../utils/worktree-setup.js';
import { ensureFresh } from '../world-model/freshness.js';

export type EnvStage = 'fetch' | 'branch' | 'worktree' | 'setup' | 'reindex';

export interface EnvStageReport {
  stage: EnvStage;
  status: 'pass' | 'skipped';
  detail?: string;
}

export interface EnvGateFailure {
  stage: EnvStage;
  detail: string;
  output_tail?: string;
}

export type FetchStageResult = { ok: true; report: EnvStageReport } | { ok: false; failure: EnvGateFailure };

export type BranchStageOutcome =
  | { ok: true; created: boolean; baseRef: string | null }
  | { ok: false; detail: string; payload?: Record<string, unknown> };

export interface EnvGateInput {
  db: TrajectoryDB;
  dbPath: string;
  graph: WorldModelGraph | null;
  repo: string | null;
  repoPath: string;
  branchId: string;
  worktreePath: string;
  fetched: EnvStageReport;
  ensureBranch: () => BranchStageOutcome;
}

export interface EnvGatePass {
  ok: true;
  base_ref: string | null;
  base_sha: string | null;
  wm_commit: string | null;
  stages: EnvStageReport[];
  branchCreated: boolean;
  worktreeReused: boolean;
  setup: WorktreeSetupResult;
  // A line for the decision body when the reindex stage was skipped.
  decisionNote: string | null;
  rollback: () => void;
}

export interface EnvGateRefusal {
  ok: false;
  failure: EnvGateFailure;
  payload?: Record<string, unknown>;
}

const NO_GRAPH_DETAIL = 'the server has no world-model graph (degraded mode)';

function firstLine(text: string | undefined, fallback: string): string {
  return text?.trim().split('\n')[0] || fallback;
}

function hasOrigin(repoPath: string): boolean {
  const res = runGit(repoPath, ['remote', 'get-url', 'origin']);
  return res.status === 0 && res.stdout.trim() !== '';
}

// Stage 1: fetch origin/<base> so the cut uses the remote's latest commit. A
// repo without an origin remote, or a base origin does not carry, is skipped:
// its local base is already its latest.
export function fetchBaseStage(repoPath: string, base: string): FetchStageResult {
  if (!hasOrigin(repoPath)) return { ok: true, report: { stage: 'fetch', status: 'skipped', detail: 'no origin remote' } };
  const res = runGit(repoPath, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', '-q', 'origin', base], {
    timeout: BASE_FETCH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status === 0 && !res.error) return { ok: true, report: { stage: 'fetch', status: 'pass' } };
  const stderr = res.stderr ?? '';
  if (res.status !== null && /couldn't find remote ref/i.test(stderr)) {
    return { ok: true, report: { stage: 'fetch', status: 'skipped', detail: `origin has no '${base}'` } };
  }
  const why = res.error
    ? res.error.message
    : res.status === null
      ? `ran past ${BASE_FETCH_TIMEOUT_MS / 1000}s`
      : firstLine(stderr, `exited ${res.status}`);
  return { ok: false, failure: { stage: 'fetch', detail: `git fetch origin ${base} failed: ${why}.` } };
}

// Worktree setup gets the user's toolchain PATH, as verification[] does.
export function setupEnv(worktreePath: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: joinToolchainPath(toolchainDirs(process.env, worktreePath), process.env.PATH ?? '') };
}

// `git worktree list --porcelain` emits canonicalized paths (/private/var/…
// for a /var/… symlink), so a match goes through realpath.
function isRegisteredWorktree(repoPath: string, worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const canonical = realpathSync(worktreePath);
  const res = runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return false;
  return res.stdout.split('\n').some((l) => l.startsWith('worktree ') && l.slice('worktree '.length) === canonical);
}

function addWorktree(repoPath: string, branchId: string, worktreePath: string): { reused: boolean } | { error: string } {
  if (isRegisteredWorktree(repoPath, worktreePath)) return { reused: true };
  const res = runGit(repoPath, ['worktree', 'add', worktreePath, branchId], { timeout: WORKTREE_TIMEOUT_MS });
  if (res.status !== 0 || res.error) {
    return { error: `git worktree add ${worktreePath} ${branchId} failed: ${firstLine(res.stderr, res.error?.message ?? 'git failed')}.` };
  }
  return { reused: false };
}

function removeWorktree(repoPath: string, worktreePath: string): void {
  runGit(repoPath, ['worktree', 'remove', '--force', worktreePath], { timeout: WORKTREE_TIMEOUT_MS });
  if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  runGit(repoPath, ['worktree', 'prune']);
}

function removeBranch(repoPath: string, branchId: string): void {
  runGit(repoPath, ['branch', '-D', branchId]);
}

async function reindexStage(
  input: EnvGateInput,
  baseRef: string | null,
  baseSha: string | null,
): Promise<{ ok: true; report: EnvStageReport; wmCommit: string | null } | { ok: false; failure: EnvGateFailure }> {
  if (!input.graph) return { ok: true, report: { stage: 'reindex', status: 'skipped', detail: NO_GRAPH_DETAIL }, wmCommit: null };
  const fail = (detail: string) => ({ ok: false as const, failure: { stage: 'reindex' as const, detail } });
  if (!input.repo) return fail('no registered repo to index the world model for.');
  if (!baseSha) return fail('the base resolves to no commit to index the world model at.');
  let indexed: string | null;
  try {
    const fresh = await ensureFresh(input.db, input.graph, input.repo, {
      dbPath: input.dbPath,
      trigger: 'spawn',
      target: baseSha,
      targetRef: baseRef,
      wait: true,
    });
    indexed = fresh.indexed_commit;
  } catch (e) {
    return fail(`world-model reindex failed: ${firstLine((e as Error).message, 'reindex error')}.`);
  }
  if (indexed !== baseSha) {
    return fail(`the world model of '${input.repo}' is indexed at ${indexed ?? 'no commit'}, not the base commit ${baseSha}.`);
  }
  return { ok: true, report: { stage: 'reindex', status: 'pass' }, wmCommit: indexed };
}

// Stages 2–5 (branch, worktree, setup, reindex) after fetchBaseStage passed.
export async function runEnvGate(input: EnvGateInput): Promise<EnvGatePass | EnvGateRefusal> {
  const { repoPath, branchId, worktreePath } = input;
  const stages: EnvStageReport[] = [input.fetched];
  let branchCreated = false;
  let worktreeCreated = false;
  const rollback = (): void => {
    if (worktreeCreated) removeWorktree(repoPath, worktreePath);
    if (branchCreated) removeBranch(repoPath, branchId);
  };
  const refuse = (failure: EnvGateFailure, payload?: Record<string, unknown>): EnvGateRefusal => {
    rollback();
    return { ok: false, failure, ...(payload ? { payload } : {}) };
  };

  const branch = input.ensureBranch();
  if (!branch.ok) return refuse({ stage: 'branch', detail: branch.detail }, branch.payload);
  branchCreated = branch.created;
  stages.push({ stage: 'branch', status: 'pass' });

  const worktree = addWorktree(repoPath, branchId, worktreePath);
  if ('error' in worktree) return refuse({ stage: 'worktree', detail: worktree.error });
  worktreeCreated = !worktree.reused;
  const env = setupEnv(worktreePath);
  // Best-effort, install_error included: the setup stage is where a project proves its deps.
  await prepareWorktreeDeps(repoPath, worktreePath, { env });
  stages.push({ stage: 'worktree', status: 'pass' });

  const setup = await runWorktreeSetup(worktreePath, { env });
  if (setup.error !== undefined) {
    return refuse({ stage: 'setup', detail: setup.error, ...(setup.output_tail ? { output_tail: setup.output_tail } : {}) });
  }
  stages.push(setup.ran ? { stage: 'setup', status: 'pass' } : { stage: 'setup', status: 'skipped', detail: 'no setup file' });

  const baseSha = branch.baseRef ? revParseCommit(repoPath, branch.baseRef) : null;
  const reindex = await reindexStage(input, branch.baseRef, baseSha);
  if (!reindex.ok) return refuse(reindex.failure);
  stages.push(reindex.report);

  return {
    ok: true,
    base_ref: branch.baseRef,
    base_sha: baseSha,
    wm_commit: reindex.wmCommit,
    stages,
    branchCreated,
    worktreeReused: worktree.reused,
    setup,
    decisionNote:
      reindex.report.status === 'skipped'
        ? `Environment gate: reindex skipped because ${NO_GRAPH_DETAIL}; wm_commit is null.`
        : null,
    rollback,
  };
}

// The refusal a gated tool returns. A branch refusal keeps the payload its
// tool returned before the gate (branch_exists_diverged); every refusal names
// the stage in env_gate_failed.
export function envGateFailedResult(tool: string, refusal: Omit<EnvGateRefusal, 'ok'>, nothingWritten: string): CallToolResult {
  const { failure, payload } = refusal;
  const detail = /[.!?]$/.test(failure.detail) ? failure.detail : `${failure.detail}.`;
  const error =
    failure.stage === 'branch'
      ? `${tool}: ${detail} ${nothingWritten}`
      : `${tool}: environment gate refused at stage '${failure.stage}': ${detail} ${nothingWritten}`;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ ...(payload ?? { error }), env_gate_failed: failure }) }],
  };
}

// The env_gate block of a gated tool's success result.
export function envGateField(stages: EnvStageReport[]): { env_gate: { stages: EnvStageReport[] } } {
  return { env_gate: { stages } };
}
