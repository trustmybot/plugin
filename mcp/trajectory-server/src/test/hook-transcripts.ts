/**
 * Hook durations from Claude Code session transcripts (GH 1861): every JSONL
 * line under <dir> whose attachment is a hook_success, hook_blocking_error or
 * hook_non_blocking_error of a dispatch.sh gate, with its durationMs and
 * timedOut, for the files and lines of the last <days> days.
 */
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const TRANSCRIPT_TYPES: ReadonlySet<string> = new Set(['hook_success', 'hook_blocking_error', 'hook_non_blocking_error']);
export const DEFAULT_TRANSCRIPTS = join(homedir(), '.claude/projects');
export const DEFAULT_DAYS = 14;

export interface GateTimes {
  ms: number[];
  timedOut: number;
}

export interface TranscriptStats {
  files: number;
  gates: Map<string, GateTimes>;
}

const GATE = /dispatch\.sh"?\s+([A-Za-z0-9_.-]+)/;

export function gateOf(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  return GATE.exec(command)?.[1] ?? null;
}

function jsonlFiles(dir: string, since: number, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, since, out);
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

interface Attachment {
  type?: unknown;
  hookEvent?: unknown;
  command?: unknown;
  durationMs?: unknown;
  timedOut?: unknown;
}

export async function transcriptStats(dir = DEFAULT_TRANSCRIPTS, days = DEFAULT_DAYS, event = 'PreToolUse', now = Date.now()): Promise<TranscriptStats> {
  const since = now - days * 864e5;
  const files = jsonlFiles(dir, since);
  const gates = new Map<string, GateTimes>();
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"attachment"')) continue;
      let o: { timestamp?: unknown; attachment?: Attachment };
      try {
        o = JSON.parse(line) as typeof o;
      } catch {
        continue;
      }
      if (typeof o.timestamp === 'string' && Date.parse(o.timestamp) < since) continue;
      const a = o.attachment;
      if (!a || typeof a.type !== 'string' || !TRANSCRIPT_TYPES.has(a.type) || a.hookEvent !== event) continue;
      if (typeof a.durationMs !== 'number') continue;
      const gate = gateOf(a.command);
      if (gate === null) continue;
      const g = gates.get(gate) ?? { ms: [], timedOut: 0 };
      g.ms.push(a.durationMs);
      if (a.timedOut === true) g.timedOut++;
      gates.set(gate, g);
    }
  }
  return { files: files.length, gates };
}

/** The reference parser's percentile: sorted[min(n - 1, floor(p * n))]. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
