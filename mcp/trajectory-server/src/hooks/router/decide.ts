/**
 * One router decision (GH 1692): once the bash parser the Bash gates share is
 * loaded, the gates of the matching ROUTER_GROUPS entry run on the payload one
 * at a time, each on its own clock, so a gate's budget and recorded ms count only
 * its own work (decision 919): the gate bodies are synchronous on one event
 * loop, so running them together would only charge one gate's work to its
 * siblings. Each gate's deadline is its start plus the smaller of its budget
 * and the group budget left (decision 922); every sync spawn it makes times
 * out there, so a hung child ends the gate at its deadline. Sync gates are
 * judged on return, async gates raced against their deadline. A tool no group
 * matches runs nothing, and a group marked stopAtFirstDeny runs no gate after
 * a deny. The first deny in group order is the answer, with that gate's output; with none, the
 * allowing gates' outputs merge as dispatch.sh's run_chain merges a chain's
 * context. Fail-closed as dispatch.sh is: an enforcement gate that throws,
 * exits other than 0 or 2 without a deny, prints unparseable output, is
 * unknown, runs past its deadline, or is left no group budget denies, naming
 * the gate; an advisory gate's failure is dropped and logged.
 */
import { bashParser } from '../cmd-analysis/parser.js';
import type { Gate, GateResult } from '../gate.js';
import { armDeadline, disarmDeadline } from '../lib/deadline.js';
import { type RouterGate, type RouterGroup, ROUTER_GROUPS, findGate, routerGates, routerGroup } from '../registry.js';

export type GateOutcomeKind = 'allow' | 'deny' | 'skipped_budget' | 'error';

export interface GateOutcome {
  gate: string;
  /** Measured on this gate's own clock, from its start to its return or budget expiry: no sibling's work is in it. */
  ms: number;
  outcome: GateOutcomeKind;
}

export interface RouterDecision {
  stdout: string;
  stderr: string;
  code: number;
  tool: string;
  gates: GateOutcome[];
  /** The gate whose deny is returned and its reason; null on allow. */
  denied: { gate: string; reason: string } | null;
}

export interface DecideDeps {
  groups?: readonly RouterGroup[];
  findGate?: (name: string) => Gate | undefined;
  /** A budget in place of the gate's own (benches and parity tests). */
  budgetMs?: (gate: RouterGate) => number;
  /** The time the call's gates share, in place of the matched group's budget. */
  groupBudgetMs?: number;
  now?: () => number;
}

export const ROUTER_NAME = 'router';

const DENY_PATTERN = /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}

export function failClosedReason(gate: string, cause: string): string {
  return `BLOCKED: TMB gate ${gate} ${cause} without a decision, so the action is denied (fail-closed). The hook's stderr names the cause; fix the gate, then retry.`;
}

export function timeoutReason(gate: string, budgetMs: number): string {
  return `BLOCKED: TMB gate ${gate} timed out after ${budgetMs} ms (infrastructure load, not a policy decision), so the action is denied (fail-closed); retry the same call, and if it keeps timing out, report it.`;
}

export function groupBudgetReason(gate: string, groupBudgetMs: number, ran: boolean): string {
  const what = ran ? `ran out of the router's ${groupBudgetMs} ms group budget` : `was not run: the gates before it spent the router's ${groupBudgetMs} ms group budget`;
  return `BLOCKED: TMB gate ${gate} ${what} (infrastructure load, not a policy decision), so the action is denied (fail-closed); retry the same call, and if it keeps timing out, report it.`;
}

export function denyOutput(reason: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;
}

/** deny_reason: the first JSON object's permissionDecisionReason or reason, else <fallback>. */
export function denyReason(stdout: string, fallback: string): string {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
      const rec = o as { hookSpecificOutput?: { permissionDecisionReason?: unknown }; reason?: unknown };
      const r = rec.hookSpecificOutput?.permissionDecisionReason ?? rec.reason;
      if (typeof r === 'string' && r !== '') return r;
      if (r !== undefined && r !== null && r !== false) return JSON.stringify(r);
    } catch {
      /* not JSON: next line */
    }
  }
  return fallback;
}

function parses(stdout: string): boolean {
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

/** run_chain's merge: one output as is, more joined into one additionalContext. */
export function mergeContext(outputs: readonly string[]): string {
  if (outputs.length === 0) return '';
  if (outputs.length === 1) return `${outputs[0]}\n`;
  const parsed = outputs.map((o) => JSON.parse(o) as { hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown } });
  const event = parsed.map((p) => p.hookSpecificOutput?.hookEventName).find((e) => typeof e === 'string' && e !== '') ?? 'PreToolUse';
  const context = parsed
    .map((p) => p.hookSpecificOutput?.additionalContext)
    .filter((c) => c !== undefined && c !== null && c !== false)
    .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
    .join('\n\n');
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`;
}

type Settled =
  | { kind: 'result'; result: GateResult; ms: number }
  | { kind: 'threw'; error: string; ms: number }
  | { kind: 'late'; ms: number }
  | { kind: 'unrun'; ms: number };

const LATE = Symbol('late');

/** Runs the gate under a deadline <limit> ms from its start; `cut` when the deadline ended one of its spawns. */
async function settle(fn: Gate, payload: string, env: NodeJS.ProcessEnv, limit: number, now: () => number): Promise<{ s: Settled; cut: boolean }> {
  const start = now();
  armDeadline(start + limit, now);
  const s = await run(fn, payload, env, limit, now, start);
  return { s, cut: disarmDeadline() };
}

async function run(fn: Gate, payload: string, env: NodeJS.ProcessEnv, limit: number, now: () => number, start: number): Promise<Settled> {
  let out: GateResult | Promise<GateResult>;
  try {
    out = fn(payload, env);
  } catch (err) {
    return { kind: 'threw', error: err instanceof Error ? err.message : String(err), ms: now() - start };
  }
  if (!(out instanceof Promise)) return { kind: 'result', result: out, ms: now() - start };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), Math.max(0, limit - (now() - start)));
    timer.unref();
  });
  try {
    const r = await Promise.race([out, late]);
    if (r === LATE) return { kind: 'late', ms: now() - start };
    return { kind: 'result', result: r, ms: now() - start };
  } catch (err) {
    return { kind: 'threw', error: err instanceof Error ? err.message : String(err), ms: now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** What bounded the gate: its own budget, or the group budget left when that was smaller. */
interface Bound {
  limit: number;
  budget: number;
  groupBudgetMs: number;
  byGroup: boolean;
}

interface Judged {
  outcome: GateOutcomeKind;
  /** The output this gate contributes: its deny, or its context on allow. */
  stdout: string;
  code: number;
  reason: string;
  stderr: string;
}

function overBudget(gate: RouterGate, b: Bound, ran: boolean): Judged {
  const what = !ran ? `got no time: the ${b.groupBudgetMs} ms group budget was spent` : b.byGroup ? `ran out of the ${b.groupBudgetMs} ms group budget` : `ran past its ${b.budget} ms budget`;
  if (gate.kind !== 'enforcement') return { outcome: 'skipped_budget', stdout: '', code: 0, reason: '', stderr: `TMB router: advisory gate ${gate.name} ${what} — skipped, output dropped\n` };
  const reason = b.byGroup || !ran ? groupBudgetReason(gate.name, b.groupBudgetMs, ran) : timeoutReason(gate.name, b.budget);
  return { outcome: 'deny', stdout: denyOutput(reason), code: 0, reason, stderr: `TMB dispatch: gate ${gate.name} ${what} — failing closed\n` };
}

function judge(gate: RouterGate, s: Settled, cut: boolean, b: Bound): Judged {
  const enforce = gate.kind === 'enforcement';
  const closed = (cause: string, stderr = ''): Judged =>
    enforce
      ? { outcome: 'deny', stdout: denyOutput(failClosedReason(gate.name, cause)), code: 0, reason: failClosedReason(gate.name, cause), stderr: `${stderr}TMB dispatch: gate ${gate.name} ${cause} — failing closed\n` }
      : { outcome: 'error', stdout: '', code: 0, reason: '', stderr: `${stderr}TMB router: advisory gate ${gate.name} ${cause} — output dropped\n` };
  if (s.kind === 'unrun') return overBudget(gate, b, false);
  if (cut || s.kind === 'late') return overBudget(gate, b, true);
  if (s.kind === 'threw') return closed('exited 1', `TMB hooks: gate '${oneLine(gate.name)}' failed: ${oneLine(s.error)}\n`);
  if (s.ms > b.limit && !(s.result.code === 2 || DENY_PATTERN.test(s.result.stdout))) return overBudget(gate, b, true);
  const { code } = s.result;
  const out = trimNewlines(s.result.stdout);
  const denies = DENY_PATTERN.test(out);
  if (code === 2 || denies) {
    if (code === 0 || code === 2 || enforce) {
      return { outcome: 'deny', stdout: out === '' ? '' : `${out}\n`, code: code === 2 ? 2 : 0, reason: denyReason(out, `exit ${code}`), stderr: '' };
    }
  }
  if (code !== 0) return closed(`exited ${code}`);
  if (out !== '' && !parses(out)) return closed('printed unparseable output');
  return { outcome: 'allow', stdout: out, code: 0, reason: '', stderr: '' };
}

/** The tool_name of a payload that is a JSON object, else null (unparseable). */
export function payloadTool(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const tool = (parsed as { tool_name?: unknown }).tool_name;
  return typeof tool === 'string' ? tool : '';
}

export async function decide(event: string, payload: string, env: NodeJS.ProcessEnv, deps: DecideDeps = {}): Promise<RouterDecision> {
  const now = deps.now ?? (() => performance.now());
  const tool = payloadTool(payload);
  if (tool === null) {
    const reason = failClosedReason(ROUTER_NAME, 'got an unparseable payload');
    return {
      stdout: denyOutput(reason),
      stderr: `TMB dispatch: gate ${ROUTER_NAME} got an unparseable payload — failing closed\n`,
      code: 0,
      tool: '',
      gates: [],
      denied: { gate: ROUTER_NAME, reason },
    };
  }
  const find = deps.findGate ?? findGate;
  const groups = deps.groups ?? ROUTER_GROUPS;
  const group = routerGroup(event, tool, groups);
  const gates = routerGates(event, tool, groups);
  if (tool === 'Bash' && gates.length > 0) await bashParser().catch(() => undefined);
  const groupBudgetMs = deps.groupBudgetMs ?? group?.groupBudgetMs ?? 0;
  const groupStart = now();
  const done: { gate: RouterGate; s: Settled; j: Judged }[] = [];
  let spent = false;
  for (const gate of gates) {
    const budget = deps.budgetMs?.(gate) ?? gate.budgetMs;
    const left = groupBudgetMs - (now() - groupStart);
    const b: Bound = { limit: Math.min(budget, left), budget, groupBudgetMs, byGroup: left < budget };
    const fn = find(gate.name);
    if (!fn) {
      done.push({ gate, s: { kind: 'threw', error: `unknown gate '${oneLine(gate.name)}' — not run`, ms: 0 }, j: judgeUnknown(gate) });
      continue;
    }
    if (spent || left <= 0) {
      const s: Settled = { kind: 'unrun', ms: 0 };
      done.push({ gate, s, j: judge(gate, s, false, b) });
      continue;
    }
    const { s, cut } = await settle(fn, payload, env, b.limit, now);
    spent = b.byGroup && (cut || s.kind === 'late' || s.ms >= b.limit);
    const j = judge(gate, s, cut, b);
    done.push({ gate, s, j });
    if (group?.stopAtFirstDeny && j.outcome === 'deny') break;
  }
  const outcomes = done.map(({ gate, s, j }) => ({ gate: gate.name, ms: Math.round(s.ms * 1000) / 1000, outcome: j.outcome }));
  const stderr = done.map(({ j }) => j.stderr).join('');
  const deny = done.find(({ j }) => j.outcome === 'deny');
  if (deny) {
    return { stdout: deny.j.stdout, stderr, code: deny.j.code, tool, gates: outcomes, denied: { gate: deny.gate.name, reason: deny.j.reason } };
  }
  const context = done.filter(({ j }) => j.outcome === 'allow' && j.stdout !== '').map(({ j }) => j.stdout);
  return { stdout: mergeContext(context), stderr, code: 0, tool, gates: outcomes, denied: null };
}

function judgeUnknown(gate: RouterGate): Judged {
  const note = `TMB hooks: unknown gate '${oneLine(gate.name)}' — not run\n`;
  if (gate.kind !== 'enforcement') return { outcome: 'error', stdout: '', code: 0, reason: '', stderr: `${note}TMB router: advisory gate ${gate.name} exited 1 — output dropped\n` };
  const reason = failClosedReason(gate.name, 'exited 1');
  return { outcome: 'deny', stdout: denyOutput(reason), code: 0, reason, stderr: `${note}TMB dispatch: gate ${gate.name} exited 1 — failing closed\n` };
}
