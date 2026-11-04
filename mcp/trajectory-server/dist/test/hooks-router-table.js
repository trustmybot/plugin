/**
 * Reads a plugin tree's hooks/hooks.json registrations and its
 * dist/hooks-router.txt table for the hook lints (hook-timeout-budget,
 * hooks-doc-fresh, hook-caller-identity), with no shell helper (GH 1692).
 * A table row is `<gate> <budget ms> <kind> <event> <matcher or -> <tool suffix|*> [<part>]`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROUTER_PREFIX = 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" ';
const NODE_GUARD = /^command -v node >\/dev\/null 2>&1 \|\| \{ [^}]*\}; /;
export function routerTable(root) {
    return readFileSync(join(root, 'mcp/trajectory-server/dist/hooks-router.txt'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
        const f = line.split(' ');
        return { gate: f[0], budgetMs: Number(f[1]), event: f[3], matcher: f[4], toolSuffix: f[5], part: f[6] };
    });
}
export function hookRegistrations(root) {
    const json = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
    return Object.entries(json.hooks).flatMap(([event, entries]) => entries.flatMap((entry) => (entry.hooks ?? []).map((h) => ({ event, matcher: entry.matcher ?? '', command: h.command ?? '', timeout: h.timeout }))));
}
/** The router's <Event> and [part] when <command> runs the router, the leading node guard dropped; else null. */
export function routerCommand(command, dropNodeGuard = true) {
    const cmd = dropNodeGuard ? command.replace(NODE_GUARD, '') : command;
    if (!cmd.startsWith(ROUTER_PREFIX))
        return null;
    const m = /^([A-Za-z]+)(?: ([a-z-]+))?$/.exec(cmd.slice(ROUTER_PREFIX.length));
    return m === null ? null : { event: m[1], part: m[2] };
}
/**
 * The gates the table lists for <event>, once each in run order: every
 * group's, or <matcher>'s; only the ones serving <tool> when given (a row whose
 * suffix is not `*` serves a tool ending in `trajectory-server__<suffix>`); only
 * <part>'s when given, `-` naming the default group.
 */
export function routerGates(table, event, opts = {}) {
    const { matcher = '', tool = '', part = '' } = opts;
    const serves = (r) => r.toolSuffix === '*' || tool === '' || tool.endsWith(`trajectory-server__${r.toolSuffix}`);
    const holds = (r) => part === '' || (r.part ?? '-') === part;
    const rows = table.filter((r) => r.event === event && (matcher === '' || r.matcher === matcher) && holds(r) && serves(r));
    return [...new Set(rows.map((r) => r.gate))];
}
/** The largest gate budget (ms) of the group <event> <matcher> [<part>]; undefined when it has none. */
export function routerBudgetMax(table, event, matcher, part) {
    const column = matcher === '' ? '-' : matcher;
    const budgets = table.filter((r) => r.event === event && r.matcher === column && (r.part ?? '') === (part ?? '')).map((r) => r.budgetMs);
    const max = Math.max(0, ...budgets);
    return max > 0 ? max : undefined;
}
/** A gate's budget in whole seconds, rounded up: the smallest of its router budgets; undefined when the table lacks it. */
export function gateBudgetS(table, gate) {
    const budgets = table.filter((r) => r.gate === gate).map((r) => Math.floor((r.budgetMs + 999) / 1000));
    return budgets.length === 0 ? undefined : Math.min(...budgets);
}
//# sourceMappingURL=hooks-router-table.js.map