// hooks/hooks.json as L1 symbols (GH 1680, ADR 0002): one kind='hook' row per
// registered hook, qualified '<Event>#<pos>:<gate>', with run_order = event
// rank * 100 + position so the Claude Code lifecycle order is queryable, and a
// 'runs' edge to the gate's scripts/hooks/<gate>.sh module. A gate that is a
// dispatch chain in registrations.sh gets one 'runs' edge per member instead,
// edges.line holding the chain position. A router entry (`dist/hooks.js <Event>`)
// takes its gates from dist/hooks-router.txt the same way, named by its first
// gate (GH 2185). Ported from the GH 1680 MVP enrich.mjs.
import { matcherOfColumn, rowHoldsPart } from '../hooks/router/table.js';
import { clip, md5, oneLine } from './extract.js';
export const HOOKS_PATH = 'hooks/hooks.json';
export const REGISTRATIONS_PATH = 'scripts/hooks/lib/registrations.sh';
export const ROUTER_TABLE_PATH = 'mcp/trajectory-server/dist/hooks-router.txt';
export const ROUTER_TABLE_SOURCE = 'mcp/trajectory-server/src/hooks/registry.ts';
const EVENT_ORDER = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'Notification',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'PreCompact',
    'WorktreeCreate',
    'WorktreeRemove',
    'SessionEnd',
];
// The members of every `<name>) printf '%s\n' 'gate …' …` chain, in order.
export function dispatchChains(registrations) {
    const chains = new Map();
    for (const m of registrations.matchAll(/^\s*([\w-]+)\)\s*\n\s*printf '%s\\n' \\\n((?:\s*'[^']*'\s*\\?\n)+)/gm)) {
        chains.set(m[1], [...m[2].matchAll(/'([\w-]+)\s/g)].map((x) => x[1]));
    }
    return chains;
}
// Lifecycle rank per event: EVENT_ORDER, with events it does not name placed
// right after Stop in the order the file lists them.
function eventRanks(events) {
    const unknown = events.filter((e) => !EVENT_ORDER.includes(e));
    const stop = EVENT_ORDER.indexOf('Stop');
    const order = [...EVENT_ORDER.slice(0, stop + 1), ...unknown, ...EVENT_ORDER.slice(stop + 1)];
    return new Map(order.map((e, i) => [e, i + 1]));
}
const scriptOf = (gate) => `scripts/hooks/${gate}.sh`;
// A router entry's gates in run order, each once, from dist/hooks-router.txt lines:
// <gate> <budget ms> <kind> <event> <matcher or -> <tool suffix|*> [<part>].
function routerGatesOf(table, event, matcher, part) {
    const rows = table
        .split('\n')
        .map((line) => line.split(' '))
        .filter((f) => f[3] === event && f[4] !== undefined && matcherOfColumn(f[4]) === matcher && rowHoldsPart(f, part))
        .map((f) => f[0]);
    return [...new Set(rows)];
}
export function extractHooks(src, chains, routerTable = '') {
    const out = { symbols: [], edges: [] };
    const parsed = JSON.parse(src);
    const hooks = parsed.hooks ?? {};
    const ranks = eventRanks(Object.keys(hooks));
    const lines = src.split('\n');
    const lineOf = (needle, from) => {
        for (let i = from; i < lines.length; i++)
            if (lines[i].includes(needle))
                return i + 1;
        return 0;
    };
    let cursor = 0;
    for (const [event, groups] of Object.entries(hooks)) {
        const rank = ranks.get(event);
        let pos = 0;
        for (const group of Array.isArray(groups) ? groups : []) {
            const matcher = group.matcher ?? '';
            for (const hook of group.hooks ?? []) {
                pos++;
                const cmd = hook.command ?? '';
                const gate = cmd.match(/dispatch\.sh"?\s+([\w.-]+)/)?.[1];
                const direct = gate ? null : (cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+\.sh)/)?.[1] ?? null);
                const routerCommand = cmd.match(/dist\/hooks\.js"?\s+(\S+)(?:\s+(\S+))?\s*$/);
                const routed = routerCommand?.[1] === event ? routerGatesOf(routerTable, event, matcher, routerCommand[2]) : [];
                const isRouted = routed.length > 0;
                const name = gate ?? direct?.split('/').pop() ?? routed[0] ?? `hook${pos}`;
                const line = lineOf(gate ?? direct ?? (isRouted ? 'dist/hooks.js' : cmd), cursor);
                cursor = line || cursor;
                const members = isRouted ? routed : gate ? chains.get(gate) : undefined;
                const target = isRouted ? `router gates ${routed.join(', ')}` : members ? `chain ${members.join(', ')}` : gate ? scriptOf(gate) : (direct ?? cmd);
                const qualifiedName = `${event}#${pos}:${name}`;
                out.symbols.push({
                    kind: 'hook',
                    qualified_name: qualifiedName,
                    signature: clip(oneLine(cmd), 200),
                    doc: `${event} hook #${pos}${matcher ? ` (matcher ${matcher})` : ''} runs ${target}`,
                    start_line: line,
                    end_line: line,
                    body_hash: md5(isRouted ? `${matcher}\u0000${cmd}\u0000${routed.join(' ')}` : `${matcher}\u0000${cmd}`),
                    exported: 1,
                    run_order: rank * 100 + pos,
                });
                const at = out.symbols.length - 1;
                if (members) {
                    members.forEach((m, i) => out.edges.push({ src: at, kind: 'runs', dst_name: scriptOf(m), line: i + 1, hint: null }));
                }
                else if (gate || direct) {
                    out.edges.push({ src: at, kind: 'runs', dst_name: gate ? scriptOf(gate) : direct, line, hint: null });
                }
            }
        }
    }
    return out;
}
//# sourceMappingURL=hooks.js.map