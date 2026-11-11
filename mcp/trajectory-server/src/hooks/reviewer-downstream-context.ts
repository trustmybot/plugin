/**
 * SubagentStart(^tmb:code-reviewer$) gate (GH 1990), born in TypeScript: at a
 * code-reviewer's start, for a task the downstream-context A/B has in its `on`
 * arm, it answers with additionalContext naming the diff's changed symbols and
 * their direct downstream (lib/downstream.ts), under the same caps as
 * swe-downstream-context, and writes one downstream_context_injected row. The
 * first call for a task enrolls it while the A/B is on.
 *
 * A probe on Claude Code 2.1.311 showed SubagentStart additionalContext reaches
 * the subagent's own conversation and that the payload carries agent_id,
 * agent_type and the parent's transcript_path but no prompt; the subagent's
 * transcript does not exist yet. So the task is, in order: the open
 * code-reviewer agent_runs row bound to agent_id, a task_id=<N> in the payload,
 * else the one task_id=<N> of the parent transcript's code-reviewer Agent calls
 * that have no result yet (none when they name several).
 *
 * The diff is the task's commit (tasks.commit_sha, else refs/heads/<branch>)
 * against its merge-base with the PR target, read with -U0; each hunk's old
 * side meets the wm_symbols line ranges, since the index tracks the base. Any
 * miss or error is silent: it never denies and always exits 0.
 */
import { open, stat } from 'node:fs/promises';
import { ALLOW, type GateResult, type Gate } from './gate.js';
import { prTargetRef } from './lib/git-refs.js';
import { taskLocation } from './lib/agent-context.js';
import { dbPath, gateRead, GATE_READ_ERROR, haveSqlite, sqlQuote } from './lib/db.js';
import { capSections, directDownstream, downstreamArm, downstreamLines, recordInjected, symbolLine, symbolsInRanges } from './lib/downstream.js';
import { gitSpawn } from './lib/git.js';
import { jqCompact } from './lib/jq.js';
import { CODE_REVIEWER_ROLE, normalizeRole } from './lib/role.js';

export const GATE_NAME = 'reviewer-downstream-context';

const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const TASK_ID = /\btask_id=(\d+)/;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function openRunTask(db: string, agentId: string, env: NodeJS.ProcessEnv): number | null {
  if (agentId === '') return null;
  const out = gateRead(
    db,
    `SELECT task_id FROM agent_runs WHERE agent_type = '${CODE_REVIEWER_ROLE}' AND spawn_id = '${sqlQuote(agentId)}' AND completed_at IS NULL AND task_id IS NOT NULL ORDER BY id DESC LIMIT 1;`,
    env,
  );
  return out === GATE_READ_ERROR || !/^[0-9]+$/.test(out) ? null : Number(out);
}

async function transcriptTail(path: string): Promise<string> {
  const size = (await stat(path)).size;
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}

/** The one task_id=<N> of the transcript's code-reviewer Agent calls that have no tool_result yet; null when none or several. */
export function pendingReviewerTask(transcript: string): number | null {
  const pending = new Map<string, number | null>();
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as Record<string, unknown>[]) {
      if (item?.type === 'tool_use' && (item.name === 'Agent' || item.name === 'Task')) {
        const input = (item.input ?? {}) as Record<string, unknown>;
        if (normalizeRole(str(input.subagent_type)) !== CODE_REVIEWER_ROLE) continue;
        const m = TASK_ID.exec(str(input.prompt));
        pending.set(str(item.id), m ? Number(m[1]) : null);
      } else if (item?.type === 'tool_result') {
        pending.delete(str(item.tool_use_id));
      }
    }
  }
  const tasks = new Set(pending.values());
  if (tasks.size !== 1) return null;
  const [only] = tasks;
  return only ?? null;
}

async function reviewerTask(db: string, input: Record<string, unknown>, payload: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  const run = openRunTask(db, str(input.agent_id), env);
  if (run !== null) return run;
  const named = TASK_ID.exec(payload);
  if (named) return Number(named[1]);
  const transcript = str(input.transcript_path);
  if (transcript === '') return null;
  try {
    return pendingReviewerTask(await transcriptTail(transcript));
  } catch {
    return null;
  }
}

async function git(repo: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await gitSpawn(repo, args, { env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 ? r.stdout.toString('utf8') : null;
}

/**
 * The old-side line spans of a `git diff -U0` per old path: a hunk `-a,b`
 * covers lines a..a+b-1, and a pure insertion (b = 0) after line a is the
 * span (a+1, a), which meets a symbol only when the symbol encloses the gap.
 */
export function oldSideSpans(diff: string): Map<string, Array<[number, number]>> {
  const spans = new Map<string, Array<[number, number]>>();
  let path: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      path = p.startsWith('a/') ? p.slice(2) : null;
      continue;
    }
    if (path === null || !line.startsWith('@@ ')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (!m) continue;
    const from = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const span: [number, number] = count === 0 ? [from + 1, from] : [from, from + count - 1];
    spans.set(path, [...(spans.get(path) ?? []), span]);
  }
  return spans;
}

interface TaskRow {
  commit_sha: string | null;
  branch_id: string;
  parent_branch_id: string | null;
}

async function changedSpans(db: string, taskId: number, env: NodeJS.ProcessEnv): Promise<{ repo: string; spans: Map<string, Array<[number, number]>> } | null> {
  const loc = taskLocation(db, String(taskId), env);
  if (loc.code !== 0) return null;
  const raw = gateRead(
    db,
    `SELECT json_object('commit_sha', commit_sha, 'branch_id', branch_id, 'parent_branch_id', parent_branch_id) FROM tasks WHERE id = ${taskId};`,
    env,
  );
  if (raw === GATE_READ_ERROR || raw === '') return null;
  const task = JSON.parse(raw) as TaskRow;
  const target = gateRead(db, `SELECT COALESCE(target_branch, '') FROM repos WHERE name = '${sqlQuote(loc.repo)}';`, env);
  if (target === GATE_READ_ERROR) return null;
  const commitRev = task.commit_sha || `refs/heads/${task.branch_id}`;
  const commit = (await git(loc.repoRoot, ['rev-parse', '--verify', '--quiet', `${commitRev}^{commit}`], env))?.trim();
  if (!commit) return null;
  const targetRef = await prTargetRef(loc.repoRoot, target.split('\n')[0] ?? '', task.parent_branch_id ?? '', env);
  if (targetRef === null) return null;
  const base = (await git(loc.repoRoot, ['merge-base', targetRef, commit], env))?.trim();
  if (!base) return null;
  const diff = await git(loc.repoRoot, ['diff', '-U0', '--no-color', '--no-ext-diff', base, commit], env);
  return diff === null ? null : { repo: loc.repo, spans: oldSideSpans(diff) };
}

async function decideContext(payload: string, env: NodeJS.ProcessEnv): Promise<GateResult> {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ALLOW;
    input = parsed as Record<string, unknown>;
  } catch {
    return ALLOW;
  }
  if (normalizeRole(str(input.agent_type)) !== CODE_REVIEWER_ROLE) return ALLOW;
  const db = dbPath(env);
  if (db === null || !haveSqlite(env)) return ALLOW;
  const taskId = await reviewerTask(db, input, payload, env);
  if (taskId === null) return ALLOW;
  if (downstreamArm(db, GATE_NAME, taskId, env) !== 'on') return ALLOW;

  const changed = await changedSpans(db, taskId, env);
  if (!changed) return ALLOW;
  const symbols = symbolsInRanges(db, changed.repo, changed.spans, env);
  if (!symbols || symbols.length === 0) return ALLOW;
  const ds = directDownstream(db, changed.repo, symbols.map((s) => s.id), env);
  if (!ds) return ALLOW;

  const { text, shown } = capSections(
    `TMB: task ${taskId}'s diff in the world model (GH 1990). For each changed symbol, check that its callers and table readers still agree with it:`,
    [
      { title: 'Changed symbols', lines: symbols.map(symbolLine) },
      { title: 'Direct downstream: callers and table readers, tests excluded', lines: downstreamLines(ds) },
    ],
  );
  recordInjected(
    db,
    GATE_NAME,
    taskId,
    { role: CODE_REVIEWER_ROLE, agent_id: str(input.agent_id), symbols: symbols.map((s) => s.id), refs_shown: shown[1] ?? 0, refs_total: ds.total },
    ['task_id', 'agent_id'],
    env,
  );
  return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } })}\n`, code: 0 };
}

export const reviewerDownstreamContext: Gate = async (payload, env) => {
  try {
    return await decideContext(payload, env);
  } catch {
    return ALLOW;
  }
};
