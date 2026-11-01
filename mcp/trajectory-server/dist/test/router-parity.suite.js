/**
 * Decision parity (GH 1692): every corpus payload of each router gate,
 * materialized in its gate's parity sandbox, gets from the router the
 * decision the gates give one by one: the first deny in ROUTER_GROUPS order
 * with that gate's output, else the allowing gates' contexts merged; off
 * PreToolUse a deny keeps those contexts, and a sibling advisory gate failing in
 * another gate's sandbox has its output dropped, as the router drops it.
 * A gate with bash recordings answers alone as its recording did: the plain text
 * of a context event byte for byte, the bare path of WorktreeCreate or, for a
 * failure there, an empty stdout and exit 1.
 * One router-parity.<gate>.test.ts per gate runs it as its own node --test process (GH 2118).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { eventHoldsEnforcement, findGate, ROUTER_GROUPS, routerGates, routerGroup } from '../hooks/registry.js';
import { decide, denyOutput, failClosedReason, payloadTool, stdoutIsPath } from '../hooks/router/decide.js';
import { goldenRecording } from './golden.js';
import { routerSandbox, underUid } from './router-sandboxes.js';
const DENY = /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/;
function parsed(stdout) {
    const t = stdout.trim();
    if (t === '')
        return null;
    return isJson(t) ? JSON.parse(t) : t;
}
const textIsContext = (event) => event === 'SessionStart' || event === 'UserPromptSubmit';
function groupOf(gate) {
    const group = ROUTER_GROUPS.find((g) => g.gates.some((x) => x.name === gate));
    assert.ok(group, `${gate} is in a router group`);
    return group;
}
/** Every key but hookSpecificOutput, its first value winning, as the router's merge keeps them. */
function otherKeys(outputs) {
    const kept = {};
    for (const output of outputs) {
        for (const [key, value] of Object.entries(output))
            if (key !== 'hookSpecificOutput' && !(key in kept))
                kept[key] = value;
    }
    return kept;
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
async function oneByOne(c, event, part) {
    const tool = payloadTool(c.input);
    if (tool === null) {
        if (stdoutIsPath(event))
            return { decision: 'allow', gate: null, stdout: null, code: 1 };
        if (!eventHoldsEnforcement(event))
            return { decision: 'allow', gate: null, stdout: null, code: 0 };
        return { decision: 'deny', gate: 'router', stdout: parsed(denyOutput(failClosedReason('router', 'got an unparseable payload'), event)), code: 0 };
    }
    const outputs = [];
    let denied = null;
    for (const gate of routerGates(event, tool, ROUTER_GROUPS, part)) {
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
        if (stdoutIsPath(event))
            return r.code === 0 && r.stdout.trim() !== '' ? { decision: 'allow', gate: null, stdout: r.stdout.trim(), code: 0 } : { decision: 'allow', gate: null, stdout: null, code: 1 };
        const text = r.stdout.trim();
        const brokenJson = text !== '' && !isJson(text) && (!textIsContext(event) || text.startsWith('{'));
        const plain = textIsContext(event) && text !== '' && !isJson(text) && !text.startsWith('{');
        if (r.code === 2 || (!plain && DENY.test(r.stdout))) {
            denied ??= { decision: 'deny', gate: gate.name, stdout: parsed(r.stdout), code: r.code === 2 ? 2 : 0 };
            if (event === 'PreToolUse')
                return denied;
            continue;
        }
        if ((sibling || textIsContext(event)) && (r.code !== 0 || brokenJson))
            continue;
        assert.equal(r.code, 0, `${gate.name} exits 0 or 2 on ${basename(c.file)}`);
        if (text !== '')
            outputs.push(parsed(r.stdout));
    }
    const contexts = outputs.map((o) => (typeof o === 'string' ? { hookSpecificOutput: { additionalContext: o } } : o));
    if (denied) {
        if (denied.code === 2 || contexts.length === 0 || denied.stdout === null)
            return denied;
        const first = denied.stdout;
        return {
            ...denied,
            stdout: {
                ...otherKeys([first, ...contexts]),
                hookSpecificOutput: {
                    hookEventName: [first, ...contexts].find((x) => x.hookSpecificOutput?.hookEventName)?.hookSpecificOutput?.hookEventName ?? event,
                    additionalContext: [first, ...contexts].map((x) => x.hookSpecificOutput?.additionalContext).filter((x) => x !== undefined && x !== null).join('\n\n'),
                },
            },
        };
    }
    if (contexts.length === 0)
        return { decision: 'allow', gate: null, stdout: null, code: 0 };
    if (outputs.length === 1)
        return { decision: 'allow', gate: null, stdout: outputs[0], code: 0 };
    const asks = contexts.find((x) => x.hookSpecificOutput?.permissionDecision === 'ask')?.hookSpecificOutput;
    return {
        decision: 'allow',
        gate: null,
        stdout: { ...otherKeys(contexts), hookSpecificOutput: { hookEventName: contexts.find((x) => x.hookSpecificOutput?.hookEventName)?.hookSpecificOutput?.hookEventName ?? event, additionalContext: contexts.map((x) => x.hookSpecificOutput?.additionalContext).filter((x) => x !== undefined && x !== null).join('\n\n'), ...(asks ? { permissionDecision: 'ask' } : {}), ...(asks?.permissionDecisionReason === undefined ? {} : { permissionDecisionReason: asks.permissionDecisionReason }) } },
        code: 0,
    };
}
/** The gate alone through the router, against its bash recording; on an unparseable payload the router runs no gate, where dispatch.sh ran it. */
async function matchesRecording(c, group) {
    if (c.golden === undefined || c.golden.divergent || payloadTool(c.input) === null)
        return;
    const { event, part } = group;
    const recorded = goldenRecording(c.gate, c.golden.key, 'C', c.golden.roots);
    const alone = { event, matcher: '', part, gates: [{ name: c.gate, kind: 'advisory', budgetMs: 120_000 }], groupBudgetMs: Number.POSITIVE_INFINITY };
    const got = await inCase(c, () => decide(event, c.input, c.env, { groups: [alone], part, budgetMs: () => 120_000, groupBudgetMs: Number.POSITIVE_INFINITY }));
    const name = `${basename(c.file)} against its recording`;
    if (stdoutIsPath(event)) {
        assert.equal(got.code, recorded.code === 0 ? 0 : 1, `${name}: exit (${got.stderr})`);
        assert.equal(got.stdout, recorded.code === 0 ? recorded.stdout : '', `${name}: bare path`);
        return;
    }
    if (recorded.code !== 0 && recorded.code !== 2) {
        assert.equal(got.stdout, '', `${name}: a failed gate's output is dropped`);
        return;
    }
    const isText = recorded.stdout.trim() !== '' && !isJson(recorded.stdout.trim());
    if (isText)
        assert.equal(got.stdout, recorded.stdout, `${name}: plain text unchanged`);
    else
        assert.deepEqual(parsed(got.stdout), parsed(recorded.stdout), `${name}: output`);
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
            const group = groupOf(gate);
            const { event, part } = group;
            const cases = sandbox.cases.filter((c) => c.gate === gate);
            assert.ok(cases.length > 0, `${gate} has a corpus`);
            let ran = 0;
            for (const c of cases) {
                await matchesRecording(c, group);
                const want = await inCase(c, () => oneByOne(c, event, part));
                const got = await inCase(c, () => decide(event, c.input, c.env, { part, budgetMs: () => 120_000, groupBudgetMs: Number.POSITIVE_INFINITY }));
                const name = basename(c.file);
                assert.equal(got.denied === null ? 'allow' : 'deny', want.decision, `${name}: decision (${got.stderr})`);
                assert.equal(got.denied?.gate ?? null, want.gate, `${name}: denying gate`);
                assert.deepEqual(minutesMasked(parsed(got.stdout)), minutesMasked(want.stdout), `${name}: output`);
                assert.equal(got.code, want.code, `${name}: exit code`);
                const stopped = got.denied !== null && routerGroup(event, got.tool, ROUTER_GROUPS, part)?.stopAtFirstDeny === true;
                if (payloadTool(c.input) !== null && !stopped)
                    assert.equal(got.gates.length, routerGates(event, got.tool, ROUTER_GROUPS, part).length, `${name}: all of the group's gates ran`);
                if (got.gates.some((g) => g.gate === gate))
                    ran++;
            }
            assert.ok(ran > 0, `the router ran ${gate} on its corpus`);
        });
    });
}
//# sourceMappingURL=router-parity.suite.js.map