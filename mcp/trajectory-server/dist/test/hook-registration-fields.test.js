/**
 * Registration fields (GH 1692, router runtime rules 2 and 4): `mcp_tool` and
 * `prompt` hooks fail open, and `if` skips `bash -c` and absolute paths, so no
 * banned field sits on a hooks.json registration that can deny. The check is an
 * allowlist: a banned field is admitted only where every gate of the
 * registration is proven advisory in the registry. An unknown gate, an
 * unparseable command or a fail-closed `onFailure: block` counts as deny-capable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROUTER_GROUPS } from '../hooks/registry.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROUTER_ENTRY = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/mcp\/trajectory-server\/dist\/hooks\.js" ([A-Za-z]+)$/;
const DISPATCH_ENTRY = /^"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hooks\/dispatch\.sh" ([a-z0-9-]+)$/;
const BANNED_TYPES = ['mcp_tool', 'prompt', 'agent'];
function routerEntryAdvisory(event, matcher, routed, groups) {
    if (routed !== event)
        return false;
    const group = groups.find((g) => g.event === event && g.matcher === matcher);
    return group !== undefined && group.gates.length > 0 && group.gates.every((g) => g.kind === 'advisory');
}
/** Advisory wherever the registry lists it, and listed under this event. */
function dispatchEntryAdvisory(event, gate, groups) {
    const listed = groups.flatMap((g) => g.gates.filter((candidate) => candidate.name === gate).map((candidate) => ({ event: g.event, kind: candidate.kind })));
    return listed.some((l) => l.event === event) && listed.every((l) => l.kind === 'advisory');
}
function provenAdvisory(event, matcher, r, groups) {
    if (r.onFailure === 'block' || typeof r.command !== 'string')
        return false;
    const routed = ROUTER_ENTRY.exec(r.command);
    if (routed)
        return routerEntryAdvisory(event, matcher, routed[1], groups);
    const dispatched = DISPATCH_ENTRY.exec(r.command);
    return dispatched !== null && dispatchEntryAdvisory(event, dispatched[1], groups);
}
function bannedFields(r) {
    const out = BANNED_TYPES.filter((banned) => r.type === banned || banned in r).map((banned) => `'${banned}'`);
    return 'if' in r ? [...out, "'if'"] : out;
}
function registrationFieldViolations(json, groups) {
    const out = [];
    for (const [event, entries] of Object.entries(json.hooks)) {
        for (const { matcher = '', hooks } of entries) {
            for (const r of hooks) {
                const banned = bannedFields(r);
                if (banned.length === 0 || provenAdvisory(event, matcher, r, groups))
                    continue;
                for (const field of banned)
                    out.push(`${event} ${JSON.stringify(matcher)} ${String(r.command ?? r.type)}: ${field} on a registration not proven advisory`);
            }
        }
    }
    return out;
}
const ROUTER = (event) => `node "\${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" ${event}`;
const DISPATCH = (gate) => `"\${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" ${gate}`;
function single(event, matcher, r) {
    return { hooks: { [event]: [{ matcher, hooks: [r] }] } };
}
const gate = (name, kind) => ({ name, kind, budgetMs: 100 });
const GROUPS = [
    { event: 'PreToolUse', matcher: 'Deny', groupBudgetMs: 100, gates: [gate('notes', 'advisory'), gate('denies', 'enforcement')] },
    { event: 'PreToolUse', matcher: 'Notes', groupBudgetMs: 100, gates: [gate('notes', 'advisory')] },
    { event: 'PreToolUse', matcher: 'Empty', groupBudgetMs: 100, gates: [] },
    { event: 'Stop', matcher: '', groupBudgetMs: 100, gates: [gate('both', 'advisory')] },
    { event: 'PostToolUse', matcher: 'Bash', groupBudgetMs: 100, gates: [gate('both', 'enforcement')] },
];
const BANNED = [
    { type: 'mcp_tool', tool: 'x' },
    { type: 'prompt', prompt: 'x' },
    { type: 'agent', agent: 'x' },
    { type: 'command', if: 'Bash(git *)' },
];
describe('hooks.json registration fields', () => {
    it('the current hooks.json has no banned field on a registration not proven advisory', () => {
        const json = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8'));
        assert.deepEqual(registrationFieldViolations(json, ROUTER_GROUPS), []);
    });
    it('each banned type or `if` fails on a deny-capable router entry', () => {
        for (const fields of BANNED) {
            const found = registrationFieldViolations(single('PreToolUse', 'Deny', { ...fields, command: ROUTER('PreToolUse') }), GROUPS);
            assert.equal(found.length, 1, JSON.stringify(fields));
        }
    });
    it('each banned type or `if` fails on a deny-capable dispatch.sh entry', () => {
        for (const fields of BANNED) {
            const found = registrationFieldViolations(single('PreToolUse', 'Deny', { ...fields, command: DISPATCH('denies') }), GROUPS);
            assert.equal(found.length, 1, JSON.stringify(fields));
        }
    });
    it('each banned type or `if` fails on the live registry\'s enforcement gates, in both forms', () => {
        for (const fields of BANNED) {
            for (const command of [ROUTER('PreToolUse'), DISPATCH('git-guards')]) {
                const found = registrationFieldViolations(single('PreToolUse', 'Bash', { ...fields, command }), ROUTER_GROUPS);
                assert.equal(found.length, 1, `${JSON.stringify(fields)} on ${command}`);
            }
        }
    });
    it('a banned field fails where the gates are unknown or the command cannot be read', () => {
        const cases = [
            ['unknown gate through dispatch.sh', 'PreToolUse', 'Deny', { command: DISPATCH('no-such-gate') }],
            ['unknown router group', 'PreToolUse', 'NoSuchMatcher', { command: ROUTER('PreToolUse') }],
            ['router entry for another event', 'PreToolUse', 'Notes', { command: ROUTER('Stop') }],
            ['router group with no gates', 'PreToolUse', 'Empty', { command: ROUTER('PreToolUse') }],
            ['advisory gate listed only under another event', 'Stop', '', { command: DISPATCH('notes') }],
            ['gate advisory in one group and enforcement in another', 'Stop', '', { command: DISPATCH('both') }],
            ['chained command', 'PreToolUse', 'Notes', { command: `${DISPATCH('notes')} && other` }],
            ['unknown launcher', 'PreToolUse', 'Notes', { command: 'bash notes.sh' }],
            ['no command', 'PreToolUse', 'Notes', {}],
            ['advisory gates under onFailure: block', 'PreToolUse', 'Notes', { command: ROUTER('PreToolUse'), onFailure: 'block' }],
        ];
        for (const [what, event, matcher, r] of cases) {
            assert.equal(registrationFieldViolations(single(event, matcher, { type: 'command', if: 'x', ...r }), GROUPS).length, 1, what);
        }
    });
    it('an all-advisory registration may carry `if`, in both forms', () => {
        for (const command of [ROUTER('PreToolUse'), DISPATCH('notes')]) {
            assert.deepEqual(registrationFieldViolations(single('PreToolUse', 'Notes', { type: 'command', command, if: 'Read(*)' }), GROUPS), [], command);
        }
        assert.deepEqual(registrationFieldViolations(single('PreToolUse', 'Read|Skill', { type: 'command', command: ROUTER('PreToolUse'), if: 'Read(*)' }), ROUTER_GROUPS), []);
    });
    it('a deny-capable registration with no banned field passes', () => {
        assert.deepEqual(registrationFieldViolations(single('PreToolUse', 'Deny', { type: 'command', command: ROUTER('PreToolUse'), onFailure: 'block' }), GROUPS), []);
    });
});
//# sourceMappingURL=hook-registration-fields.test.js.map