/**
 * One router decision (GH 1692 R1): the gates of the matching ROUTER_GROUPS
 * run on the payload, sync gates judged on return, async gates raced against
 * their budget. The first deny in group order is the answer, with that gate's
 * output; with none, the allowing gates' outputs merge as dispatch.sh's
 * run_chain merges a chain's context. Fail-closed as dispatch.sh is: an
 * enforcement gate that throws, exits other than 0 or 2 without a deny,
 * prints unparseable output, is unknown, or runs past its budget denies,
 * naming the gate; an advisory gate's failure is dropped and logged.
 */
import type { Gate, GateResult } from '../gate.js';
import { type RouterGate, type RouterGroup, ROUTER_GROUPS, findGate, routerGates } from '../registry.js';

export type GateOutcomeKind = 'allow' | 'deny' | 'skipped_budget' | 'error';

export interface GateOutcome {
  gate: string;
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

type Settled = { kind: 'result'; result: GateResult; ms: number } | { kind: 'threw'; error: string; ms: number } | { kind: 'late'; ms: number };

const LATE = Symbol('late');

async function settle(gate: RouterGate, fn: Gate, payload: string, env: NodeJS.ProcessEnv, budget: number, now: () => number): Promise<Settled> {
  const start = now();
  let out: GateResult | Promise<GateResult>;
  try {
    out = fn(payload, env);
  } catch (err) {
    return { kind: 'threw', error: err instanceof Error ? err.message : String(err), ms: now() - start };
  }
  if (!(out instanceof Promise)) return { kind: 'result', result: out, ms: now() - start };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), Math.max(0, budget - (now() - start)));
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

interface Judged {
  outcome: GateOutcomeKind;
  /** The output this gate contributes: its deny, or its context on allow. */
  stdout: string;
  code: number;
  reason: string;
  stderr: string;
}

function judge(gate: RouterGate, s: Settled, budget: number): Judged {
  const enforce = gate.kind === 'enforcement';
  const closed = (cause: string, stderr = ''): Judged =>
    enforce
      ? { outcome: 'deny', stdout: denyOutput(failClosedReason(gate.name, cause)), code: 0, reason: failClosedReason(gate.name, cause), stderr: `${stderr}TMB dispatch: gate ${gate.name} ${cause} — failing closed\n` }
      : { outcome: 'error', stdout: '', code: 0, reason: '', stderr: `${stderr}TMB router: advisory gate ${gate.name} ${cause} — output dropped\n` };
  if (s.kind === 'threw') return closed('exited 1', `TMB hooks: gate '${oneLine(gate.name)}' failed: ${oneLine(s.error)}\n`);
  const overBudget = s.ms > budget;
  if (s.kind === 'late' || (overBudget && !(s.result.code === 2 || DENY_PATTERN.test(s.result.stdout)))) {
    if (!enforce) return { outcome: 'skipped_budget', stdout: '', code: 0, reason: '', stderr: `TMB router: advisory gate ${gate.name} ran past its ${budget} ms budget — skipped, output dropped\n` };
    const reason = timeoutReason(gate.name, budget);
    return { outcome: 'deny', stdout: denyOutput(reason), code: 0, reason, stderr: `TMB dispatch: gate ${gate.name} ran past its ${budget} ms budget — failing closed\n` };
  }
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
  const gates = routerGates(event, tool, deps.groups ?? ROUTER_GROUPS);
  const runs = gates.map((gate) => {
    const budget = deps.budgetMs?.(gate) ?? gate.budgetMs;
    const fn = find(gate.name);
    const settled: Promise<Settled> = fn
      ? settle(gate, fn, payload, env, budget, now)
      : Promise.resolve({ kind: 'threw', error: `unknown gate '${oneLine(gate.name)}' — not run`, ms: 0 });
    return settled.then((s) => ({ gate, s, j: fn ? judge(gate, s, budget) : judgeUnknown(gate) }));
  });
  const done = await Promise.all(runs);
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
