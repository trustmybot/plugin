// hooks/hooks.json as L1 symbols (GH 1680, ADR 0002): one kind='hook' row per
// registered hook, qualified '<Event>#<pos>:<gate>', with run_order = event
// rank * 100 + position so the Claude Code lifecycle order is queryable, and a
// 'runs' edge to the gate's scripts/hooks/<gate>.sh module. A gate that is a
// dispatch chain in registrations.sh gets one 'runs' edge per member instead,
// edges.line holding the chain position. Ported from the GH 1680 MVP enrich.mjs.
import { clip, md5, oneLine, type Extraction } from './extract.js';

export const HOOKS_PATH = 'hooks/hooks.json';
export const REGISTRATIONS_PATH = 'scripts/hooks/lib/registrations.sh';

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

interface HookEntry {
  command?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

// The members of every `<name>) printf '%s\n' 'gate …' …` chain, in order.
export function dispatchChains(registrations: string): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  for (const m of registrations.matchAll(/^\s*([\w-]+)\)\s*\n\s*printf '%s\\n' \\\n((?:\s*'[^']*'\s*\\?\n)+)/gm)) {
    chains.set(m[1]!, [...m[2]!.matchAll(/'([\w-]+)\s/g)].map((x) => x[1]!));
  }
  return chains;
}

// Lifecycle rank per event: EVENT_ORDER, with events it does not name placed
// right after Stop in the order the file lists them.
function eventRanks(events: string[]): Map<string, number> {
  const unknown = events.filter((e) => !EVENT_ORDER.includes(e));
  const stop = EVENT_ORDER.indexOf('Stop');
  const order = [...EVENT_ORDER.slice(0, stop + 1), ...unknown, ...EVENT_ORDER.slice(stop + 1)];
  return new Map(order.map((e, i) => [e, i + 1]));
}

const scriptOf = (gate: string): string => `scripts/hooks/${gate}.sh`;

export function extractHooks(src: string, chains: Map<string, string[]>): Extraction {
  const out: Extraction = { symbols: [], edges: [] };
  const parsed = JSON.parse(src) as { hooks?: Record<string, HookGroup[]> };
  const hooks = parsed.hooks ?? {};
  const ranks = eventRanks(Object.keys(hooks));
  const lines = src.split('\n');
  const lineOf = (needle: string, from: number): number => {
    for (let i = from; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
    return 0;
  };
  let cursor = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    const rank = ranks.get(event)!;
    let pos = 0;
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = group.matcher ?? '';
      for (const hook of group.hooks ?? []) {
        pos++;
        const cmd = hook.command ?? '';
        const gate = cmd.match(/dispatch\.sh"?\s+([\w.-]+)/)?.[1];
        const direct = gate ? null : (cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+\.sh)/)?.[1] ?? null);
        const name = gate ?? direct?.split('/').pop() ?? `hook${pos}`;
        const line = lineOf(gate ?? direct ?? cmd, cursor);
        cursor = line || cursor;
        const members = gate ? chains.get(gate) : undefined;
        const target = members ? `chain ${members.join(', ')}` : gate ? scriptOf(gate) : (direct ?? cmd);
        const qualifiedName = `${event}#${pos}:${name}`;
        out.symbols.push({
          kind: 'hook',
          qualified_name: qualifiedName,
          signature: clip(oneLine(cmd), 200),
          doc: `${event} hook #${pos}${matcher ? ` (matcher ${matcher})` : ''} runs ${target}`,
          start_line: line,
          end_line: line,
          body_hash: md5(`${matcher}\u0000${cmd}`),
          exported: 1,
          run_order: rank * 100 + pos,
        });
        const at = out.symbols.length - 1;
        if (members) {
          members.forEach((m, i) => out.edges.push({ src: at, kind: 'runs', dst_name: scriptOf(m), line: i + 1, hint: null }));
        } else if (gate || direct) {
          out.edges.push({ src: at, kind: 'runs', dst_name: gate ? scriptOf(gate) : direct!, line, hint: null });
        }
      }
    }
  }
  return out;
}
