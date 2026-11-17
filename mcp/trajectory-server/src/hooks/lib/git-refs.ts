/**
 * The hooks' async twins of the sync base-ref resolvers under src/utils (GH 1692
 * R-async, decision 937), which stay sync for the MCP tools: the same answers over
 * gitSpawn, so a base-ref lookup on a gate's path never blocks the event loop. They
 * take the gate's env and no timeout of their own, since the gate's deadline
 * bounds them.
 */
import { parseWorkflowMode, WORKFLOW_MODE_KEY, type WorkflowMode } from '../../tools/config.js';
import { GATE_READ_ERROR, gateRead, sqlQuote } from './db.js';
import { gitOk, gitRun } from './git.js';

async function refResolves(repoPath: string, ref: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', ref], env);
}

async function gitOutput(repoPath: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await gitRun(repoPath, args, env);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/** A base passed as 'origin/<branch>' names <branch>, unless a local branch is literally called 'origin/<branch>'. */
export async function normalizeBase(repoPath: string, base: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!base.startsWith('origin/') || await refResolves(repoPath, `refs/heads/${base}`, env)) return base;
  return base.slice('origin/'.length);
}

/** `origin/<base>` when it resolves, else the local `<base>`, else null. */
export async function resolveBaseRef(repoPath: string, rawBase: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const base = await normalizeBase(repoPath, rawBase, env);
  if (await refResolves(repoPath, `origin/${base}`, env)) return `origin/${base}`;
  if (await refResolves(repoPath, `refs/heads/${base}`, env)) return base;
  return null;
}

/** origin/HEAD, else the first of main/master/dev that exists locally, else the checked-out branch, else 'main'. */
export async function resolveRepoDefaultBranch(repoPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const originHead = await gitOutput(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env);
  if (originHead) return originHead.replace(/^origin\//, '');
  for (const candidate of ['main', 'master', 'dev']) {
    if (await refResolves(repoPath, `refs/heads/${candidate}`, env)) return candidate;
  }
  return await gitOutput(repoPath, ['symbolic-ref', '--short', 'HEAD'], env) ?? 'main';
}

/** The project's workflow mode as readWorkflowMode reads it (unset or unknown reads as truest), or GATE_READ_ERROR. */
export function gateWorkflowMode(db: string, env: NodeJS.ProcessEnv): WorkflowMode | typeof GATE_READ_ERROR {
  const out = gateRead(db, `SELECT value_json FROM plugin_config WHERE key = '${WORKFLOW_MODE_KEY}';`, env);
  return out === GATE_READ_ERROR ? GATE_READ_ERROR : parseWorkflowMode(out);
}

/**
 * Whether the DB records <branch> as an agile feature branch of the repo <quotedRepo> (GH 2225):
 * an agile task's parent_branch_id, or the feature_branch of a bro feature_branch_merged row,
 * either written as <branch> or origin/<branch>. GATE_READ_ERROR when the DB does not read.
 */
export function recordedFeatureBranch(db: string, quotedRepo: string, branch: string, env: NodeJS.ProcessEnv): boolean | typeof GATE_READ_ERROR {
  const names = `('${sqlQuote(branch)}', '${sqlQuote(`origin/${branch}`)}')`;
  const out = gateRead(
    db,
    `SELECT EXISTS (SELECT 1 FROM tasks
        WHERE workflow_mode = 'agile' AND parent_branch_id IN ${names} AND (repo = '${quotedRepo}' OR COALESCE(repo, '') = ''))
      OR EXISTS (SELECT 1 FROM audit
        WHERE event_type = 'feature_branch_merged' AND from_node = 'bro' AND (repo = '${quotedRepo}' OR COALESCE(repo, '') = '')
          AND CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.feature_branch') END IN ${names});`,
    env,
  );
  return out === GATE_READ_ERROR ? GATE_READ_ERROR : out === '1';
}

/**
 * An agile task's base (GH 2225): its parent feature branch's ref (origin/<parent>, else the
 * local branch) when the workflow mode is agile and parent_branch_id is set, names a branch other
 * than target_branch and resolves. null for every other task, which keeps prTargetRef's order.
 */
export async function agileParentRef(
  repoPath: string,
  targetBranch: string,
  parentBranch: string,
  workflowMode: WorkflowMode,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (workflowMode !== 'agile' || parentBranch === '') return null;
  const parent = await normalizeBase(repoPath, parentBranch, env);
  if (targetBranch !== '' && parent === await normalizeBase(repoPath, targetBranch, env)) return null;
  return await resolveBaseRef(repoPath, parent, env);
}

/**
 * The ref of a task's base for freshness, merge-base and scope checks: an agile task's parent
 * feature branch (agileParentRef), else its PR target as bro_atomic_close resolves it:
 * repos.target_branch, parent_branch_id, the repo default.
 */
export async function prTargetRef(
  repoPath: string,
  targetBranch: string,
  parentBranch: string,
  workflowMode: WorkflowMode,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const agileBase = await agileParentRef(repoPath, targetBranch, parentBranch, workflowMode, env);
  if (agileBase !== null) return agileBase;
  for (const candidate of [targetBranch, parentBranch]) {
    if (candidate === '') continue;
    const ref = await resolveBaseRef(repoPath, candidate, env);
    if (ref) return ref;
  }
  return await resolveBaseRef(repoPath, await resolveRepoDefaultBranch(repoPath, env), env);
}
