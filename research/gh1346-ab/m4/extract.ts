import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, TRANSCRIPTS_DIR } from '../lib/paths.ts';

export interface Return {
  id: string;
  session: string;
  agent: 'swe' | 'code-reviewer';
  text: string;
  chars: number;
  /** bro API calls after the return landed and before the next compaction: how many times it is re-read. */
  rereads: number;
  /** Mean cache-read tokens per bro API call in that session. */
  sessionCacheReadPerCall: number;
  sessionCalls: number;
}

interface Line {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  attachment?: { type?: string; prompt?: string };
  message?: {
    id?: string;
    content?: unknown;
    usage?: { cache_read_input_tokens?: number };
  };
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: { subagent_type?: string };
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
  return '';
}

function agentOf(subagentType: string | undefined): Return['agent'] | null {
  if (!subagentType) return null;
  if (/(^|:)swe$/.test(subagentType)) return 'swe';
  if (/(^|:)(pr|code)-reviewer$/.test(subagentType)) return 'code-reviewer';
  return null;
}

/** Strips the harness trailer (agentId / usage lines) so only what the subagent wrote is measured. */
function stripTrailer(text: string): string {
  return text.replace(/\n*agentId: [\s\S]*$/, '').replace(/\n*<usage>[\s\S]*?<\/usage>\s*$/, '').trim();
}

/** A background agent's report, as delivered to bro: `<agent-message>` hand-back or a task-notification `<result>`. */
function handback(prompt: string): { agentId: string; text: string } | null {
  const msg = /^<agent-message from="([^"]+)">\n[\s\S]*?The report follows:\n([\s\S]*?)(?:\n<\/agent-message>\s*)?$/.exec(prompt);
  if (msg) return { agentId: msg[1]!, text: msg[2]!.replace(/^ {2}/gm, '').trim() };
  const note = /<task-id>([^<]+)<\/task-id>[\s\S]*?<result>([\s\S]*?)<\/result>/.exec(prompt);
  if (note && !/report was delivered to you as a message/.test(note[2]!)) return { agentId: note[1]!, text: note[2]!.trim() };
  return null;
}

function subagentTypes(session: string): Map<string, string> {
  const dir = join(TRANSCRIPTS_DIR, session, 'subagents');
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.meta.json'))) {
    const meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { agentType?: string };
    if (meta.agentType) out.set(f.replace(/^agent-|\.meta\.json$/g, ''), meta.agentType);
  }
  return out;
}

export function extractReturns(): Return[] {
  const out: Return[] = [];
  for (const file of readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.jsonl'))) {
    const session = file.replace(/\.jsonl$/, '');
    const lines = readFileSync(join(TRANSCRIPTS_DIR, file), 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l) as Line;
      } catch {
        return {} as Line;
      }
    }).filter((l) => !l.isSidechain);

    const calls: Array<{ idx: number; cacheRead: number }> = [];
    const seen = new Set<string>();
    const compactions: number[] = [];
    lines.forEach((l, idx) => {
      if (l.type === 'system' && l.subtype === 'compact_boundary') compactions.push(idx);
      if (l.type === 'assistant' && l.message?.id && !seen.has(l.message.id)) {
        seen.add(l.message.id);
        calls.push({ idx, cacheRead: l.message.usage?.cache_read_input_tokens ?? 0 });
      }
    });
    const perCall = calls.length ? calls.reduce((s, c) => s + c.cacheRead, 0) / calls.length : 0;
    const push = (id: string, agent: Return['agent'], text: string, idx: number): void => {
      const nextCompaction = compactions.find((c) => c > idx) ?? Infinity;
      out.push({
        id,
        session,
        agent,
        text,
        chars: text.length,
        rereads: calls.filter((c) => c.idx > idx && c.idx < nextCompaction).length,
        sessionCacheReadPerCall: perCall,
        sessionCalls: calls.length,
      });
    };

    const types = subagentTypes(session);
    const spawns = new Map<string, Return['agent']>();
    const delivered = new Set<string>();
    lines.forEach((l, idx) => {
      if (l.type === 'attachment' && l.attachment?.type === 'queued_command' && l.attachment.prompt) {
        const h = handback(l.attachment.prompt);
        const agent = h && agentOf(types.get(h.agentId));
        const key = h && `${h.agentId}\0${h.text}`;
        if (h && agent && h.text && !delivered.has(key!)) {
          delivered.add(key!);
          push(h.agentId, agent, h.text, idx);
        }
        return;
      }
      const blocks = Array.isArray(l.message?.content) ? (l.message!.content as Block[]) : [];
      for (const b of blocks) {
        if (l.type === 'assistant' && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
          const agent = agentOf(b.input?.subagent_type);
          if (agent && b.id) spawns.set(b.id, agent);
        }
        if (l.type === 'user' && b.type === 'tool_result' && b.tool_use_id && spawns.has(b.tool_use_id)) {
          const text = stripTrailer(textOf(b.content));
          if (!text || b.is_error || /^(Async agent launched|PreToolUse:|\[Request interrupted)/i.test(text)) continue;
          push(b.tool_use_id, spawns.get(b.tool_use_id)!, text, idx);
        }
      }
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rs = extractReturns();
  mkdirSync(join(RESULTS_DIR, 'm4'), { recursive: true });
  writeFileSync(join(RESULTS_DIR, 'm4', 'returns.json'), JSON.stringify(rs, null, 2));
  for (const agent of ['swe', 'code-reviewer'] as const) {
    const xs = rs.filter((r) => r.agent === agent).map((r) => r.chars).sort((a, b) => a - b);
    console.log(agent, 'n', xs.length, 'median chars', xs[xs.length >> 1], 'p90', xs[Math.floor(xs.length * 0.9)], 'max', xs.at(-1));
  }
  console.log('sessions', new Set(rs.map((r) => r.session)).size, 'mean rereads', rs.reduce((s, r) => s + r.rereads, 0) / rs.length);
}
