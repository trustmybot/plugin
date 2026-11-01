/**
 * PreToolUse(Agent) gate (GH 1740), run by agent-spawn-dispatch.sh after
 * code-reviewer-after-atomic-close: before a code-reviewer spawn for task_id=<N>,
 * five deterministic checks on the task's commit, in order. The first that
 * fails denies with the JSON reason {check, expected, actual}, so no reviewer
 * is spent on a commit a machine could have refused:
 *
 *   sha_mismatch       refs/heads/<branch_id> in the task repo is tasks.commit_sha
 *   no_passing_run     a verification_runs row for (task, commit) with exit 0, not timed out
 *   base_conflict      `git merge-tree --write-tree <pr_target tip> <commit>` exits 0, or exits 1
 *                      with every conflicted path `merge=tmb-regen` per `git check-attr
 *                      --source=<commit>` (regenerated at integrate, GH 2005)
 *   stale_doc_ref      no path the diff (merge-base..commit) deletes or renames, and no MCP
 *                      tool name it drops from mcp/<server>/src/tools/, appears in the
 *                      agents/, skills/, docs/ *.md, CLAUDE.md or README.md at the commit
 *   missing_changelog  with a changelog.d/, the diff adds a file under it
 *
 * Only code-reviewer spawns naming task_id=<N> are judged; a missing task_id is
 * the prompt-shape gate's. No resolvable DB or no tasks row allows, a DB read
 * failure denies. Bypass: TMB_SKIP_CODE_REVIEWER_PREFLIGHT=1.
 */
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { taskLocation } from './lib/agent-context.js';
import { dbPath, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, sqlInt, sqlQuote } from './lib/db.js';
import { gitSpawn } from './lib/git.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { normalizeRole } from './lib/role.js';
import { resolveBaseRef, resolveRepoDefaultBranch } from '../utils/git-refs.js';

export const GATE_NAME = 'code-reviewer-preflight';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_PREFLIGHT';

export type PreflightCheck = 'sha_mismatch' | 'no_passing_run' | 'base_conflict' | 'stale_doc_ref' | 'missing_changelog';

export interface PreflightFailure {
  check: PreflightCheck;
  expected: string | null;
  actual: string | null;
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_LISTED = 10;
const DOC_PATH = /^(?:(?:agents|skills|docs)\/.*\.md|CLAUDE\.md|README\.md)$/;
const TOOL_SOURCE = /^mcp\/[^/]+\/src\/tools\/(?:[^/]+\/)*[^/]+\.ts$/;
const TOOL_NAME = /^\s*name:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]\s*,?\s*$/gm;
const CHANGELOG_DIR = 'changelog.d';
const REGEN_DRIVER = 'tmb-regen';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(repo: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  const r = await gitSpawn(repo, args, { env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, stderr: 'pipe', timeoutMs: GIT_TIMEOUT_MS });
  return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') || (r.error?.message ?? '') };
}

async function revParse(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], env);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== '' ? sha : null;
}

function nulFields(text: string): string[] {
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; (+${items.length - MAX_LISTED} more)` : shown;
}

function deny(failure: PreflightFailure): GateResult {
  return {
    stdout: `${jqCompact({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: JSON.stringify(failure),
      },
    })}\n`,
    code: 0,
  };
}

function dbUnavailable(env: NodeJS.ProcessEnv): GateResult {
  return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
}

/** Tracked blobs of <rev>: path → object id. */
async function treeBlobs(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<Map<string, string> | null> {
  const r = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', rev], env);
  if (r.code !== 0) return null;
  const blobs = new Map<string, string>();
  for (const entry of nulFields(r.stdout)) {
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

/** The contents of <oids>, read through one `git cat-file --batch`. */
async function readBlobs(repo: string, oids: readonly string[], env: NodeJS.ProcessEnv): Promise<Map<string, string> | null> {
  const contents = new Map<string, string>();
  if (oids.length === 0) return contents;
  const r = await gitSpawn(repo, ['cat-file', '--batch'], {
    input: `${oids.join('\n')}\n`,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
    stderr: 'pipe',
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.code !== 0) return null;
  const out = r.stdout;
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) return null;
    const [oid, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
    if (type === undefined || size === undefined) return null;
    const start = eol + 1;
    const end = start + Number(size);
    contents.set(oid, out.subarray(start, end).toString('utf8'));
    at = end + 1;
  }
  return contents;
}

function toolNames(blobs: Map<string, string>, contents: Map<string, string>): Set<string> {
  const names = new Set<string>();
  for (const [path, oid] of blobs) {
    if (!TOOL_SOURCE.test(path) || path.includes('/test/')) continue;
    for (const m of (contents.get(oid) ?? '').matchAll(TOOL_NAME)) names.add(m[1]);
  }
  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A repo path as a doc mentions it: bare or after ./ or ../, never inside a longer path or name. */
function pathPattern(path: string): RegExp {
  return new RegExp(`(?:^|(?<=\\./)|(?<![A-Za-z0-9_./-]))${escapeRegExp(path)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'm');
}

/** A tool name as a word, or as the tail of an mcp__<server>__<tool> id. */
function toolPattern(name: string): RegExp {
  return new RegExp(`(?:(?<=__)|(?<![A-Za-z0-9_]))${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'm');
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

interface Removed {
  paths: string[];
  tools: string[];
}

async function removedInDiff(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<Removed | string> {
  const diff = await git(repo, ['diff', '--no-ext-diff', '--name-status', '-z', '-M', base, commit], env);
  if (diff.code !== 0) return `git diff ${base}..${commit} failed: ${diff.stderr.trim()}`;
  const fields = nulFields(diff.stdout);
  const paths: string[] = [];
  let touchesTools = false;
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const from = fields[i + 1];
    const to = renamed ? fields[i + 2] : from;
    i += renamed ? 3 : 2;
    if (TOOL_SOURCE.test(from) || TOOL_SOURCE.test(to)) touchesTools = true;
    if (status === 'D' || status.startsWith('R')) paths.push(from);
  }
  if (!touchesTools) return { paths, tools: [] };
  const before = await treeBlobs(repo, base, env);
  const after = await treeBlobs(repo, commit, env);
  if (!before || !after) return `git ls-tree of ${base} or ${commit} failed`;
  const sources = (blobs: Map<string, string>) =>
    [...blobs].filter(([p]) => TOOL_SOURCE.test(p) && !p.includes('/test/')).map(([, oid]) => oid);
  const contents = await readBlobs(repo, [...new Set([...sources(before), ...sources(after)])], env);
  if (!contents) return 'git cat-file of the tool sources failed';
  const kept = toolNames(after, contents);
  return { paths, tools: [...toolNames(before, contents)].filter((t) => !kept.has(t)).sort() };
}

async function staleDocRefs(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<string[] | string> {
  const removed = await removedInDiff(repo, base, commit, env);
  if (typeof removed === 'string') return removed;
  if (removed.paths.length === 0 && removed.tools.length === 0) return [];
  const blobs = await treeBlobs(repo, commit, env);
  if (!blobs) return `git ls-tree of ${commit} failed`;
  const docs = [...blobs].filter(([p]) => DOC_PATH.test(p)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const contents = await readBlobs(repo, docs.map(([, oid]) => oid), env);
  if (!contents) return 'git cat-file of the docs failed';
  const tools = removed.tools.map((t) => ({ t, re: toolPattern(t) }));
  const paths = removed.paths.map((p) => ({ p, re: pathPattern(p) }));
  const hits: string[] = [];
  for (const [doc, oid] of docs) {
    const text = contents.get(oid) ?? '';
    const dir = dirOf(doc);
    for (const { p, re } of paths) {
      const local = dir !== '' && p.startsWith(`${dir}/`) ? pathPattern(p.slice(dir.length + 1)) : null;
      if (re.test(text) || local?.test(text)) hits.push(`${doc} mentions removed path '${p}'`);
    }
    for (const { t, re } of tools) {
      if (re.test(text)) hits.push(`${doc} mentions removed MCP tool '${t}'`);
    }
  }
  return hits;
}

async function hasChangelogDir(repo: string, rev: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await git(repo, ['ls-tree', '-d', '--name-only', rev, '--', CHANGELOG_DIR], env);
  return r.code === 0 && r.stdout.trim() !== '';
}

/** The <paths> whose `merge` attribute at <rev> is not tmb-regen, or null when git check-attr fails. */
async function nonRegenPaths(repo: string, rev: string, paths: readonly string[], env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const r = await git(repo, ['check-attr', `--source=${rev}`, '-z', 'merge', '--', ...paths], env);
  if (r.code !== 0) return null;
  const fields = nulFields(r.stdout);
  if (fields.length % 3 !== 0) return null;
  const regen = new Set<string>();
  for (let i = 0; i < fields.length; i += 3) {
    if (fields[i + 1] === 'merge' && fields[i + 2] === REGEN_DRIVER) regen.add(fields[i]);
  }
  return paths.filter((p) => !regen.has(p));
}

interface TaskRow {
  commitSha: string;
  parentBranch: string;
  branch: string;
}

function readTask(db: string, taskId: string, env: NodeJS.ProcessEnv): TaskRow | null | typeof GATE_READ_ERROR {
  const row = gateRead(
    db,
    `SELECT 'row|' || COALESCE(commit_sha, '') || '|' || COALESCE(parent_branch_id, '') || '|' || branch_id FROM tasks WHERE id = ${taskId};`,
    env,
  );
  if (row === GATE_READ_ERROR) return GATE_READ_ERROR;
  if (row === '') return null;
  const [, commitSha = '', parentBranch = '', ...branch] = row.split('\n')[0].split('|');
  return { commitSha, parentBranch, branch: branch.join('|') };
}

/** The ref of the task's PR target, as bro_atomic_close resolves it: repos.target_branch, parent_branch_id, the repo default. */
function prTargetRef(repo: string, targetBranch: string, parentBranch: string): string | null {
  for (const candidate of [targetBranch, parentBranch, resolveRepoDefaultBranch(repo)]) {
    if (candidate === '') continue;
    const ref = resolveBaseRef(repo, candidate);
    if (ref) return ref;
  }
  return null;
}

async function preflight(db: string, taskId: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  const task = readTask(db, taskId, env);
  if (task === GATE_READ_ERROR) return dbUnavailable(env);
  if (task === null) return ALLOW;
  const location = taskLocation(db, taskId, env);
  if (location.code === 2) return dbUnavailable(env);

  const recorded = task.commitSha;
  if (location.code !== 0) {
    return deny({ check: 'sha_mismatch', expected: recorded || null, actual: `branch tip unresolvable: ${location.missing}` });
  }
  const repo = location.repoRoot;
  const branch = task.branch;
  const tip = await revParse(repo, `refs/heads/${branch}`, env);
  const commit = recorded === '' ? null : await revParse(repo, recorded, env);
  if (commit === null || tip !== commit) {
    return deny({
      check: 'sha_mismatch',
      expected: recorded === '' ? null : commit ?? recorded,
      actual: tip ?? `refs/heads/${branch} does not resolve in ${repo}`,
    });
  }

  const shaIn = `commit_sha IN ('${sqlQuote(recorded)}', '${sqlQuote(commit)}')`;
  const runs = gateRead(
    db,
    `SELECT COUNT(*) FROM verification_runs WHERE task_id = ${taskId} AND ${shaIn} AND exit_code = 0 AND timed_out = 0;`,
    env,
  );
  if (runs === GATE_READ_ERROR) return dbUnavailable(env);
  if (Number(runs) === 0) {
    const latest = gateRead(
      db,
      `SELECT 'run ' || id || ': exit_code=' || COALESCE(exit_code, 'null') || ', timed_out=' || timed_out
         FROM verification_runs WHERE task_id = ${taskId} AND ${shaIn} ORDER BY id DESC LIMIT 1;`,
      env,
    );
    return deny({
      check: 'no_passing_run',
      expected: `a verification_runs row for task ${taskId} at ${commit} with exit_code=0 and timed_out=0`,
      actual: latest === GATE_READ_ERROR || latest === '' ? `no verification_runs row for task ${taskId} at ${commit}` : latest,
    });
  }

  const targetRow = gateRead(
    db,
    `SELECT COALESCE(target_branch, '') FROM repos WHERE name = '${sqlQuote(location.repo)}';`,
    env,
  );
  if (targetRow === GATE_READ_ERROR) return dbUnavailable(env);
  const targetRef = prTargetRef(repo, targetRow.split('\n')[0], task.parentBranch);
  const targetTip = targetRef === null ? null : await revParse(repo, targetRef, env);
  if (targetRef === null || targetTip === null) {
    return deny({
      check: 'base_conflict',
      expected: `${commit} merges cleanly into the PR target`,
      actual: `no PR target ref resolves in ${repo}`,
    });
  }
  const merge = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', targetTip, commit], env);
  if (merge.code !== 0) {
    const conflicted = [...new Set(nulFields(merge.stdout).slice(1).filter((p) => p !== ''))];
    const blocking = merge.code === 1 && conflicted.length > 0 ? await nonRegenPaths(repo, commit, conflicted, env) : null;
    if (blocking === null || blocking.length > 0) {
      return deny({
        check: 'base_conflict',
        expected: `${commit} merges cleanly into ${targetRef} (${targetTip})`,
        actual:
          merge.code !== 1 || conflicted.length === 0
            ? `git merge-tree exited ${merge.code}: ${merge.stderr.trim()}`
            : blocking === null
              ? `conflicts in ${listed(conflicted)}; git check-attr of their merge attribute failed`
              : `conflicts in ${listed(blocking)}`,
      });
    }
  }

  const mergeBase = (await git(repo, ['merge-base', targetTip, commit], env)).stdout.trim();
  if (mergeBase === '') {
    return deny({
      check: 'base_conflict',
      expected: `${commit} shares history with ${targetRef} (${targetTip})`,
      actual: 'no merge-base',
    });
  }
  const stale = await staleDocRefs(repo, mergeBase, commit, env);
  if (typeof stale === 'string' || stale.length > 0) {
    return deny({
      check: 'stale_doc_ref',
      expected: `no agents/, skills/, docs/ *.md, CLAUDE.md or README.md at ${commit} mentions a path or MCP tool that ${mergeBase}..${commit} removes`,
      actual: typeof stale === 'string' ? stale : listed(stale),
    });
  }

  if (await hasChangelogDir(repo, commit, env) || await hasChangelogDir(repo, mergeBase, env)) {
    const added = await git(repo, ['diff', '--no-ext-diff', '--name-only', '--no-renames', '--diff-filter=A', mergeBase, commit, '--', `${CHANGELOG_DIR}/`], env);
    if (added.code !== 0 || added.stdout.trim() === '') {
      return deny({
        check: 'missing_changelog',
        expected: `${mergeBase}..${commit} adds a file under ${CHANGELOG_DIR}/`,
        actual: added.code !== 0 ? `git diff failed: ${added.stderr.trim()}` : `no file added under ${CHANGELOG_DIR}/`,
      });
    }
  }
  return ALLOW;
}

export const codeReviewerPreflight: Gate = async (payload, env) => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (jqAlternatives(payload, [['tool_name']]) !== 'Agent') return ALLOW;
  if (normalizeRole(jqAlternatives(payload, [['tool_input', 'subagent_type']])) !== 'code-reviewer') return ALLOW;
  const m = /task_id\s*=\s*([0-9]+)/.exec(jqAlternatives(payload, [['tool_input', 'prompt']]));
  const taskId = sqlInt(m?.[1] ?? '');
  if (taskId === '') return ALLOW;
  const db = dbPath(env);
  if (db === null) return ALLOW;
  if (!haveSqlite(env)) return dbUnavailable(env);
  return await preflight(db, taskId, env);
};
