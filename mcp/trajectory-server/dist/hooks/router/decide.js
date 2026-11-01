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
 * context; a block on any event but PreToolUse keeps the allowing gates' context
 * in its one output, since as separate registrations each of them reached Claude
 * Code. A deny reads as its event wants, as dispatch.sh's fail_closed_decision
 * prints it, and an unparseable payload blocks only on an event an enforcement
 * gate serves. Fail-closed as dispatch.sh is: an enforcement gate that throws,
 * exits other than 0 or 2 without a deny, prints unparseable output, is
 * unknown, runs past its deadline, or is left no group budget denies, naming
 * the gate; an advisory gate's failure is dropped and logged. Under the
 * TMB_HOOKS_IMPL=bash kill switch each gate runs as its .sh (router/sh-gate.ts).
 * Claude Code adds a SessionStart or UserPromptSubmit gate's plain stdout as
 * context, so plain text is an output there, kept as is; only text shaped as JSON
 * that fails to parse is dropped. WorktreeCreate reads stdout as the path and
 * fails creation on any non-zero exit, so it prints the gate's bare path or
 * nothing, and every failure there exits 1 naming the cause.
 */
import { bashParser } from '../cmd-analysis/parser.js';
import { armDeadline, disarmDeadline } from '../lib/deadline.js';
import { ROUTER_GROUPS, eventHoldsEnforcement, findGate, routerGates, routerGroup } from '../registry.js';
import { shGate } from './sh-gate.js';
export const ROUTER_NAME = 'router';
const DENY_PATTERN = /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/;
const PLAIN_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
/** An object, or an array opening as one: `[Persona loaded by …` is prose. */
const JSON_SHAPED = /^\s*(\{|\[\s*([[{"\]\d-]|true\b|false\b|null\b))/;
const PATH_EVENT = 'WorktreeCreate';
export function stdoutIsPath(event) {
    return event === PATH_EVENT;
}
export function isBarePath(stdout) {
    const path = trimNewlines(stdout);
    return path.trim() !== '' && !path.includes('\n') && !path.startsWith('{');
}
export function pathFailure(event, cause) {
    return `TMB router: ${event} failed: ${cause}\n`;
}
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function trimNewlines(text) {
    return text.replace(/\n+$/, '');
}
export function failClosedReason(gate, cause) {
    return `BLOCKED: TMB gate ${gate} ${cause} without a decision, so the action is denied (fail-closed). The hook's stderr names the cause; fix the gate, then retry.`;
}
export function timeoutReason(gate, budgetMs) {
    return `BLOCKED: TMB gate ${gate} timed out after ${budgetMs} ms (infrastructure load, not a policy decision), so the action is denied (fail-closed); retry the same call, and if it keeps timing out, report it.`;
}
export function groupBudgetReason(gate, groupBudgetMs, ran) {
    const what = ran ? `ran out of the router's ${groupBudgetMs} ms group budget` : `was not run: the gates before it spent the router's ${groupBudgetMs} ms group budget`;
    return `BLOCKED: TMB gate ${gate} ${what} (infrastructure load, not a policy decision), so the action is denied (fail-closed); retry the same call, and if it keeps timing out, report it.`;
}
export function denyOutput(reason, event) {
    const output = event === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } } : { decision: 'block', reason };
    return `${JSON.stringify(output)}\n`;
}
/** deny_reason: the first JSON object's permissionDecisionReason or reason, else <fallback>. */
export function denyReason(stdout, fallback) {
    for (const line of stdout.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const o = JSON.parse(line);
            if (o === null || typeof o !== 'object' || Array.isArray(o))
                continue;
            const rec = o;
            const r = rec.hookSpecificOutput?.permissionDecisionReason ?? rec.reason;
            if (typeof r === 'string' && r !== '')
                return r;
            if (r !== undefined && r !== null && r !== false)
                return JSON.stringify(r);
        }
        catch {
            /* not JSON: next line */
        }
    }
    return fallback;
}
function isObjectText(stdout) {
    try {
        const o = JSON.parse(stdout);
        return o !== null && typeof o === 'object' && !Array.isArray(o);
    }
    catch {
        return false;
    }
}
/** Whether Claude Code takes <out> on <event> as text, not as its JSON output. */
function readsAsText(out, event) {
    if (stdoutIsPath(event))
        return true;
    if (!PLAIN_CONTEXT_EVENTS.has(event))
        return false;
    return !JSON_SHAPED.test(out) || (parses(out) && !isObjectText(out));
}
function parses(stdout) {
    try {
        JSON.parse(stdout);
        return true;
    }
    catch {
        return false;
    }
}
const asRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const DECISION_KEYS = new Set(['permissionDecision', 'permissionDecisionReason']);
const SPECIFIC_KEY = new Set(['hookSpecificOutput']);
function firstWins(records, into, skip) {
    for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
            if (!skip.has(key) && !(key in into))
                into[key] = value;
        }
    }
    return into;
}
/**
 * run_chain's merge of the gates that did not deny: one output as is, more
 * joined into one additionalContext in group order, plain text as its own text.
 * No gate's decision is lost: the first permissionDecision other than allow, with
 * its own reason, beats an allow, as in Claude Code's own precedence; every other
 * key keeps its first value.
 */
export function mergeContext(outputs, event) {
    if (outputs.length === 0)
        return '';
    if (outputs.length === 1)
        return readsAsText(outputs[0], event) ? outputs[0] : `${outputs[0]}\n`;
    const parsed = outputs.map((o) => (readsAsText(o, event) ? { hookSpecificOutput: { additionalContext: trimNewlines(o) } } : asRecord(JSON.parse(o))));
    const specifics = parsed.map((p) => asRecord(p.hookSpecificOutput));
    const eventName = specifics.map((p) => p.hookEventName).find((e) => typeof e === 'string' && e !== '') ?? event;
    const context = specifics
        .map((p) => p.additionalContext)
        .filter((c) => c !== undefined && c !== null && c !== false)
        .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
        .join('\n\n');
    const specific = firstWins(specifics, { hookEventName: eventName, additionalContext: context }, DECISION_KEYS);
    const decided = specifics.filter((p) => p.permissionDecision !== undefined);
    const winner = decided.find((p) => p.permissionDecision !== 'allow') ?? decided[0];
    if (winner) {
        specific.permissionDecision = winner.permissionDecision;
        if (winner.permissionDecisionReason !== undefined)
            specific.permissionDecisionReason = winner.permissionDecisionReason;
    }
    return `${JSON.stringify({ ...firstWins(parsed, {}, SPECIFIC_KEY), hookSpecificOutput: specific })}\n`;
}
/** A deny's output with the allowing gates' context in it: the deny goes first, so its decision and reason win. Claude Code ignores stdout on exit 2. */
function blockKeepingContext(event, deny, contexts) {
    const out = trimNewlines(deny.stdout);
    if (event === 'PreToolUse' || deny.code === 2 || contexts.length === 0 || !parses(out))
        return deny.stdout;
    return mergeContext([out, ...contexts], event);
}
const LATE = Symbol('late');
/** Runs the gate under a deadline <limit> ms from its start; `cut` when the deadline ended one of its spawns. */
async function settle(fn, payload, env, limit, now) {
    const start = now();
    armDeadline(start + limit, now);
    const s = await run(fn, payload, env, limit, now, start);
    return { s, cut: disarmDeadline() };
}
async function run(fn, payload, env, limit, now, start) {
    let out;
    try {
        out = fn(payload, env);
    }
    catch (err) {
        return { kind: 'threw', error: err instanceof Error ? err.message : String(err), ms: now() - start };
    }
    if (!(out instanceof Promise))
        return { kind: 'result', result: out, ms: now() - start };
    let timer;
    const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(LATE), Math.max(0, limit - (now() - start)));
        timer.unref();
    });
    try {
        const r = await Promise.race([out, late]);
        if (r === LATE)
            return { kind: 'late', ms: now() - start };
        return { kind: 'result', result: r, ms: now() - start };
    }
    catch (err) {
        return { kind: 'threw', error: err instanceof Error ? err.message : String(err), ms: now() - start };
    }
    finally {
        clearTimeout(timer);
    }
}
function overBudget(gate, b, ran) {
    const what = !ran ? `got no time: the ${b.groupBudgetMs} ms group budget was spent` : b.byGroup ? `ran out of the ${b.groupBudgetMs} ms group budget` : `ran past its ${b.budget} ms budget`;
    if (gate.kind !== 'enforcement')
        return { outcome: 'skipped_budget', stdout: '', code: 0, reason: '', stderr: `TMB router: advisory gate ${gate.name} ${what} — skipped, output dropped\n` };
    const reason = b.byGroup || !ran ? groupBudgetReason(gate.name, b.groupBudgetMs, ran) : timeoutReason(gate.name, b.budget);
    return { outcome: 'deny', stdout: denyOutput(reason, b.event), code: 0, reason, stderr: `TMB dispatch: gate ${gate.name} ${what} — failing closed\n` };
}
function judge(gate, s, cut, b) {
    const enforce = gate.kind === 'enforcement';
    const closed = (cause, stderr = '') => enforce
        ? { outcome: 'deny', stdout: denyOutput(failClosedReason(gate.name, cause), b.event), code: 0, reason: failClosedReason(gate.name, cause), stderr: `${stderr}TMB dispatch: gate ${gate.name} ${cause} — failing closed\n` }
        : { outcome: 'error', stdout: '', code: 0, reason: '', stderr: `${stderr}TMB router: advisory gate ${gate.name} ${cause} — output dropped\n` };
    if (s.kind === 'unrun')
        return overBudget(gate, b, false);
    if (cut || s.kind === 'late')
        return overBudget(gate, b, true);
    if (s.kind === 'threw')
        return closed('exited 1', `TMB hooks: gate '${oneLine(gate.name)}' failed: ${oneLine(s.error)}\n`);
    const { code } = s.result;
    const out = trimNewlines(s.result.stdout);
    const text = out !== '' && readsAsText(out, b.event);
    const denies = !text && DENY_PATTERN.test(out);
    if (s.ms > b.limit && !(code === 2 || denies))
        return overBudget(gate, b, true);
    if (code === 2 || denies) {
        if (code === 0 || code === 2 || enforce) {
            return { outcome: 'deny', stdout: out === '' ? '' : `${out}\n`, code: code === 2 ? 2 : 0, reason: denyReason(out, `exit ${code}`), stderr: '' };
        }
    }
    if (code !== 0)
        return closed(`exited ${code}`);
    if (out !== '' && !text && !parses(out))
        return closed('printed unparseable output');
    const context = !text ? out : out.trim() === '' ? '' : s.result.stdout;
    return { outcome: 'allow', stdout: context, code: 0, reason: '', stderr: '' };
}
/** The tool_name of a payload that is a JSON object, else null (unparseable). */
export function payloadTool(payload) {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    const tool = parsed.tool_name;
    return typeof tool === 'string' ? tool : '';
}
export async function decide(event, payload, env, deps = {}) {
    const now = deps.now ?? (() => performance.now());
    const tool = payloadTool(payload);
    const groups = deps.groups ?? ROUTER_GROUPS;
    if (tool === null) {
        if (stdoutIsPath(event))
            return { stdout: '', stderr: pathFailure(event, 'an unparseable payload'), code: 1, tool: '', gates: [], denied: null };
        if (!eventHoldsEnforcement(event, groups)) {
            return { stdout: '', stderr: `TMB router: ${event} got an unparseable payload — no gate run\n`, code: 0, tool: '', gates: [], denied: null };
        }
        const reason = failClosedReason(ROUTER_NAME, 'got an unparseable payload');
        return {
            stdout: denyOutput(reason, event),
            stderr: `TMB dispatch: gate ${ROUTER_NAME} got an unparseable payload — failing closed\n`,
            code: 0,
            tool: '',
            gates: [],
            denied: { gate: ROUTER_NAME, reason },
        };
    }
    const bashImpl = env.TMB_HOOKS_IMPL === 'bash';
    const find = deps.findGate ?? (bashImpl ? shGate : findGate);
    const group = routerGroup(event, tool, groups, deps.part);
    const gates = routerGates(event, tool, groups, deps.part);
    if (event === 'PreToolUse' && tool === 'Bash' && gates.length > 0 && !bashImpl)
        await bashParser().catch(() => undefined);
    const groupBudgetMs = deps.groupBudgetMs ?? group?.groupBudgetMs ?? 0;
    const groupStart = now();
    const done = [];
    let spent = false;
    for (const gate of gates) {
        const budget = deps.budgetMs?.(gate) ?? gate.budgetMs;
        const left = groupBudgetMs - (now() - groupStart);
        const b = { event, limit: Math.min(budget, left), budget, groupBudgetMs, byGroup: left < budget };
        const fn = find(gate.name);
        if (!fn) {
            done.push({ gate, s: { kind: 'threw', error: `unknown gate '${oneLine(gate.name)}' — not run`, ms: 0 }, j: judgeUnknown(gate, event) });
            continue;
        }
        if (spent || left <= 0) {
            const s = { kind: 'unrun', ms: 0 };
            done.push({ gate, s, j: judge(gate, s, false, b) });
            continue;
        }
        const { s, cut } = await settle(fn, payload, env, b.limit, now);
        spent = b.byGroup && (cut || s.kind === 'late' || s.ms >= b.limit);
        const j = judge(gate, s, cut, b);
        done.push({ gate, s, j });
        if (group?.stopAtFirstDeny && j.outcome === 'deny')
            break;
    }
    const outcomes = done.map(({ gate, s, j }) => ({ gate: gate.name, ms: Math.round(s.ms * 1000) / 1000, outcome: j.outcome }));
    const stderr = done.map(({ j }) => j.stderr).join('');
    const deny = done.find(({ j }) => j.outcome === 'deny');
    const context = done.filter(({ j }) => j.outcome === 'allow' && j.stdout !== '').map(({ j }) => j.stdout);
    if (stdoutIsPath(event)) {
        const notAllowed = done.find(({ j }) => j.outcome !== 'allow');
        if (!notAllowed && context.length === 1 && isBarePath(context[0]))
            return { stdout: context[0], stderr, code: 0, tool, gates: outcomes, denied: null };
        const cause = notAllowed ? `gate ${notAllowed.gate.name} ended in ${notAllowed.j.outcome}` : done.length === 0 ? 'no gate serves it' : 'no bare path printed';
        return { stdout: '', stderr: `${stderr}${pathFailure(event, cause)}`, code: 1, tool, gates: outcomes, denied: null };
    }
    if (deny) {
        return { stdout: blockKeepingContext(event, deny.j, context), stderr, code: deny.j.code, tool, gates: outcomes, denied: { gate: deny.gate.name, reason: deny.j.reason } };
    }
    return { stdout: mergeContext(context, event), stderr, code: 0, tool, gates: outcomes, denied: null };
}
function judgeUnknown(gate, event) {
    const note = `TMB hooks: unknown gate '${oneLine(gate.name)}' — not run\n`;
    if (gate.kind !== 'enforcement')
        return { outcome: 'error', stdout: '', code: 0, reason: '', stderr: `${note}TMB router: advisory gate ${gate.name} exited 1 — output dropped\n` };
    const reason = failClosedReason(gate.name, 'exited 1');
    return { outcome: 'deny', stdout: denyOutput(reason, event), code: 0, reason, stderr: `${note}TMB dispatch: gate ${gate.name} exited 1 — failing closed\n` };
}
//# sourceMappingURL=decide.js.map