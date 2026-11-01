/**
 * What a router call leaves behind, after its decision is printed: one
 * hook_call audit row (per-gate timings and outcomes), dispatch.sh's
 * hook_denied row on a deny, and its Bash deny records under
 * <state>/locks/boundary-denies for swe-boundary. Observes only: a missing DB
 * or a failed write records nothing and never changes the decision.
 */
import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { payloadCwd, writePaths } from '../cmd-analysis/index.js';
import { UNJUDGED_PHRASE } from '../containment-guard.js';
import { auditAppend } from '../lib/audit.js';
import { callerRun, dbPath, projectRoot, sqliteRo, sqlInt } from '../lib/db.js';
import { pathDigest } from '../lib/target-task.js';
import type { RouterDecision } from './decide.js';

const CALLER = 'router';

interface Payload {
  tool_name?: unknown;
  tool_input?: { command?: unknown; task_id?: unknown } | null;
  agent_type?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

function parse(payload: string): Payload {
  try {
    const o = JSON.parse(payload) as unknown;
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as Payload) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function taskAndIssue(payload: string, p: Payload, db: string, env: NodeJS.ProcessEnv): { taskId: string; issue: string } {
  const run = callerRun(payload, db, env);
  let taskId = sqlInt(run.split('|')[0]);
  if (taskId === '') {
    const t = p.tool_input?.task_id;
    taskId = sqlInt(typeof t === 'number' || typeof t === 'string' ? String(t) : '');
  }
  if (taskId === '') return { taskId, issue: '-1' };
  const issue = sqlInt(sqliteRo(db, `SELECT issue_id FROM tasks WHERE id = ${taskId};`, env).trim());
  return { taskId, issue: issue === '' ? '-1' : issue };
}

/** The hook_call row, and the hook_denied row when the call denied. */
export function auditCall(event: string, payload: string, d: RouterDecision, env: NodeJS.ProcessEnv): void {
  const writeEnv = { ...env, TMB_DB_WRITE_TIMEOUT_MS: '300', TMB_DB_WRITE_RUN_BUDGET_MS: '600' };
  const db = dbPath(writeEnv);
  if (db === null) return;
  const p = parse(payload);
  const { taskId, issue } = taskAndIssue(payload, p, db, writeEnv);
  const tool = str(p.tool_name);
  const decision = d.denied ? 'deny' : d.code === 0 ? 'allow' : 'failed';
  auditAppend(
    db,
    {
      issueId: issue,
      branchId: '',
      fromNode: 'hook:router',
      eventType: 'hook_call',
      summary: `${event}${tool ? ` ${tool}` : ''}: ${decision}${d.denied ? ` by ${d.denied.gate}` : ''}`,
      contentJson: JSON.stringify({
        event,
        tool,
        decision,
        denied_gate: d.denied?.gate ?? null,
        task_id: taskId === '' ? null : Number(taskId),
        gates: d.gates,
      }),
    },
    { caller: CALLER, env: writeEnv },
  );
  if (!d.denied) return;
  auditAppend(
    db,
    {
      issueId: issue,
      branchId: '',
      fromNode: 'hook:dispatch',
      eventType: 'hook_denied',
      summary: `${d.denied.gate} denied${tool ? ` ${tool}` : ''}`,
      contentJson: JSON.stringify({
        hook: d.denied.gate,
        rule: d.denied.reason.slice(0, 200),
        tool,
        agent_type: p.agent_type ?? null,
        task_id: taskId === '' ? null : Number(taskId),
        cwd: p.cwd ?? null,
      }),
    },
    { caller: CALLER, env: writeEnv },
  );
}

/** unjudged_deny: a deny that judged no path; <why> holds no double quote. */
export function unjudgedDeny(reason: string): boolean {
  const head = 'BLOCKED: write target "';
  const sep = `" ${UNJUDGED_PHRASE} `;
  if (!reason.startsWith(head)) return false;
  const at = reason.lastIndexOf(sep);
  if (at < head.length) return false;
  return !reason.slice(at + sep.length).includes('"');
}

function prune(dir: string, cutoffMs: number): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  let empty = true;
  for (const name of names) {
    const path = `${dir}/${name}`;
    try {
      const st = statSync(path);
      if (st.isDirectory()) {
        if (prune(path, cutoffMs)) rmdirSync(path);
        else empty = false;
      } else if (st.mtimeMs < cutoffMs) unlinkSync(path);
      else empty = false;
    } catch {
      empty = false;
    }
  }
  return empty;
}

/**
 * record_bash_deny: when the router denied a Bash command, one record per
 * absolute path the command writes, <base>/<session_id>/<digest> holding the
 * denying gate and epoch seconds; records older than TMB_BYPASS_WINDOW_MIN
 * (10) minutes are pruned first.
 */
export async function recordBashDeny(base: string, payload: string, d: RouterDecision, env: NodeJS.ProcessEnv): Promise<void> {
  if (!d.denied || d.tool !== 'Bash' || unjudgedDeny(d.denied.reason)) return;
  const p = parse(payload);
  const session = str(p.session_id) ?? '';
  if (session === '' || session.includes('/') || session.startsWith('.')) return;
  const cmd = str(p.tool_input?.command) ?? '';
  if (cmd === '') return;
  const w = env.TMB_BYPASS_WINDOW_MIN ?? '';
  const window = /^[0-9]+$/.test(w) && Number(w) > 0 ? Number(w) : 10;
  try {
    prune(base, Date.now() - window * 60_000);
    const dir = `${base}/${session}`;
    mkdirSync(dir, { recursive: true });
    const paths = await writePaths(cmd, { cwd: payloadCwd(payload, env), raw: false, root: projectRoot(env), env });
    const epoch = Math.floor(Date.now() / 1000);
    for (const path of paths) {
      if (path.startsWith('/')) writeFileSync(`${dir}/${pathDigest(path)}`, `${d.denied.gate}\n${epoch}\n`);
    }
  } catch {
    /* observes only */
  }
}
