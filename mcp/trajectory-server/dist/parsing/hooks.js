// hooks/hooks.json as L1 symbols (GH 1680): one kind='hook' row per
// registered hook, qualified '<Event>#<pos>:<gate>', with run_order = event
// rank * 100 + position so the Claude Code lifecycle order is queryable, and a
// 'runs' edge to the gate's TypeScript module, src/hooks/<gate>.ts (GH 1692:
// never to the bash script it was ported from). A router entry
// (`dist/hooks.js <Event>`) gets one 'runs' edge per gate dist/hooks-router.txt
// lists for it, named by its first gate (GH 2185); a single-gate entry
// (`dist/hooks.js <gate>`) is named by that gate with one 'runs' edge to it.
// Ported from the GH 1680 MVP
// enrich.mjs.
import { matcherOfColumn, rowHoldsPart } from '../hooks/router/table.js';
import { clip, GATE_MODULE_DIR, md5, oneLine } from './extract.js';
export const HOOKS_PATH = 'hooks/hooks.json';
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
// Lifecycle rank per event: EVENT_ORDER, with events it does not name placed
// right after Stop in the order the file lists them.
function eventRanks(events) {
    const unknown = events.filter((e) => !EVENT_ORDER.includes(e));
    const stop = EVENT_ORDER.indexOf('Stop');
    const order = [...EVENT_ORDER.slice(0, stop + 1), ...unknown, ...EVENT_ORDER.slice(stop + 1)];
    return new Map(order.map((e, i) => [e, i + 1]));
}
const gateModule = (gate) => `${GATE_MODULE_DIR}/${gate}.ts`;
// A router entry's gates in run order, each once, from dist/hooks-router.txt lines:
// <gate> <budget ms> <kind> <event> <matcher or -> <tool suffix|*> [<part>].
export function routerGatesOf(table, event, matcher, part) {
    const rows = table
        .split('\n')
        .map((line) => line.split(' '))
        .filter((f) => f[3] === event && f[4] !== undefined && matcherOfColumn(f[4]) === matcher && rowHoldsPart(f, part))
        .map((f) => f[0]);
    return [...new Set(rows)];
}
export function extractHooks(src, routerTable = '') {
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
                const tsGate = gate || direct || !routerCommand || routerCommand[1] === event ? null : routerCommand[1];
                const name = gate ?? direct?.split('/').pop() ?? routed[0] ?? tsGate ?? `hook${pos}`;
                const line = lineOf(gate ?? direct ?? (isRouted || tsGate ? 'dist/hooks.js' : cmd), cursor);
                cursor = line || cursor;
                const target = isRouted
                    ? `router gates ${routed.join(', ')}`
                    : tsGate
                        ? `gate ${tsGate}`
                        : gate
                            ? gateModule(gate)
                            : (direct ?? cmd);
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
                if (isRouted) {
                    routed.forEach((m, i) => out.edges.push({ src: at, kind: 'runs', dst_name: gateModule(m), line: i + 1, hint: null }));
                }
                else if (tsGate) {
                    out.edges.push({ src: at, kind: 'runs', dst_name: gateModule(tsGate), line, hint: null });
                }
                else if (gate || direct) {
                    out.edges.push({ src: at, kind: 'runs', dst_name: gate ? gateModule(gate) : direct, line, hint: null });
                }
            }
        }
    }
    return out;
}
//# sourceMappingURL=hooks.js.map