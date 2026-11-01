/**
 * Decision parity (GH 1692): every corpus payload of each router gate,
 * materialized in its gate's parity sandbox, gets from the router the
 * decision the gates give one by one: the first deny in ROUTER_GROUPS order
 * with that gate's output, else the allowing gates' contexts merged; off
 * PreToolUse a deny keeps those contexts, and a sibling advisory gate failing in
 * another gate's sandbox has its output dropped, as the router drops it.
 * One router-parity.<gate>.test.ts per gate runs it as its own node --test process (GH 2118).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { eventHoldsEnforcement, findGate, ROUTER_GROUPS, routerGates, routerGroup } from '../hooks/registry.js';
import { decide, denyOutput, failClosedReason, payloadTool } from '../hooks/router/decide.js';
import { routerSandbox, underUid } from './router-sandboxes.js';
const DENY = /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/;
function parsed(stdout) {
    const t = stdout.trim();
    return t === '' ? null : JSON.parse(t);
}
function eventOf(gate) {
    const group = ROUTER_GROUPS.find((g) => g.gates.some((x) => x.name === gate));
    assert.ok(group, `${gate} is in a router group`);
    return group.event;
}
/** task-overrun-alert and liveness-alert print minutes elapsed, which can tick over between the two sides. */
function minutesMasked(output) {
    return JSON.parse(JSON.stringify(output).replace(/has been running \d+ min/g, 'has been running N min').replace(/silent \d+ min/g, 'silent N min'));
}
function isJson(text) {
    try {
        JSON.parse(text);
        return true;
    }
    catch {
        return false;
    }
}
async function oneByOne(c, event) {
    const tool = payloadTool(c.input);
    if (tool === null) {
        if (!eventHoldsEnforcement(event))
            return { decision: 'allow', gate: null, stdout: null, code: 0 };
        return { decision: 'deny', gate: 'router', stdout: parsed(denyOutput(failClosedReason('router', 'got an unparseable payload'), event)), code: 0 };
    }
    const contexts = [];
    let denied = null;
    for (const gate of routerGates(event, tool)) {
        const fn = findGate(gate.name);
        assert.ok(fn, `${gate.name} is registered`);
        const sibling = event !== 'PreToolUse' && gate.name !== c.gate && gate.kind === 'advisory';
        const r = await Promise.resolve()
            .then(() => fn(c.input, c.env))
            .catch((err) => {
            if (sibling)
                return { code: 1, stdout: '' };
            throw err;
        });
        if (r.code === 2 || DENY.test(r.stdout)) {
            denied ??= { decision: 'deny', gate: gate.name, stdout: parsed(r.stdout), code: r.code === 2 ? 2 : 0 };
            if (event === 'PreToolUse')
                return denied;
            continue;
        }
        if (sibling && (r.code !== 0 || !isJson(r.stdout.trim() || 'null')))
            continue;
        assert.equal(r.code, 0, `${gate.name} exits 0 or 2 on ${basename(c.file)}`);
        if (r.stdout.trim() !== '')
            contexts.push(JSON.parse(r.stdout));
    }
    if (denied) {
        if (denied.code === 2 || contexts.length === 0 || denied.stdout === null)
            return denied;
        const first = denied.stdout;
        return {
            ...denied,
            stdout: {
                ...first,
                hookSpecificOutput: {
                    hookEventName: [first, ...contexts].find((x) => x.hookSpecificOutput?.hookEventName)?.hookSpecificOutput?.hookEventName ?? event,
                    additionalContext: [first, ...contexts].map((x) => x.hookSpecificOutput?.additionalContext).filter((x) => x !== undefined && x !== null).join('\n\n'),
                },
            },
        };
    }
    if (contexts.length === 0)
        return { decision: 'allow', gate: null, stdout: null, code: 0 };
    if (contexts.length === 1)
        return { decision: 'allow', gate: null, stdout: contexts[0], code: 0 };
    const asks = contexts.find((x) => x.hookSpecificOutput?.permissionDecision === 'ask')?.hookSpecificOutput;
    return {
        decision: 'allow',
        gate: null,
        stdout: { hookSpecificOutput: { hookEventName: contexts.find((x) => x.hookSpecificOutput?.hookEventName)?.hookSpecificOutput?.hookEventName ?? event, additionalContext: contexts.map((x) => x.hookSpecificOutput?.additionalContext).filter((x) => x !== undefined && x !== null).join('\n\n'), ...(asks ? { permissionDecision: 'ask' } : {}), ...(asks?.permissionDecisionReason === undefined ? {} : { permissionDecisionReason: asks.permissionDecisionReason }) } },
        code: 0,
    };
}
async function inCase(c, fn) {
    const cwd = process.cwd();
    c.reset?.();
    process.chdir(c.cwd);
    try {
        return await underUid(c.fakeUid, fn);
    }
    finally {
        process.chdir(cwd);
    }
}
export function routerParityGate(gate) {
    describe('router decision parity over the gates corpora', () => {
        let sandbox;
        before(() => {
            sandbox = routerSandbox(mkdtempSync(join(tmpdir(), 'tmb-router-parity-')), [gate]);
        });
        after(() => sandbox.cleanup());
        it(`${gate}: the router decides as the gates do one by one`, async () => {
            const event = eventOf(gate);
            const cases = sandbox.cases.filter((c) => c.gate === gate);
            assert.ok(cases.length > 0, `${gate} has a corpus`);
            let ran = 0;
            for (const c of cases) {
                const want = await inCase(c, () => oneByOne(c, event));
                const got = await inCase(c, () => decide(event, c.input, c.env, { budgetMs: () => 120_000, groupBudgetMs: Number.POSITIVE_INFINITY }));
                const name = basename(c.file);
                assert.equal(got.denied === null ? 'allow' : 'deny', want.decision, `${name}: decision (${got.stderr})`);
                assert.equal(got.denied?.gate ?? null, want.gate, `${name}: denying gate`);
                assert.deepEqual(minutesMasked(parsed(got.stdout)), minutesMasked(want.stdout), `${name}: output`);
                assert.equal(got.code, want.code, `${name}: exit code`);
                const stopped = got.denied !== null && routerGroup(event, got.tool)?.stopAtFirstDeny === true;
                if (payloadTool(c.input) !== null && !stopped)
                    assert.equal(got.gates.length, routerGates(event, got.tool).length, `${name}: all of the group's gates ran`);
                if (got.gates.some((g) => g.gate === gate))
                    ran++;
            }
            assert.ok(ran > 0, `the router ran ${gate} on its corpus`);
        });
    });
}
//# sourceMappingURL=router-parity.suite.js.map