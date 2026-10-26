import { encode as toonEncode } from '@toon-format/toon';

type Json = unknown;
type Rec = Record<string, Json>;

export function oneLine(v: Json, max = 120): Json {
  if (typeof v !== 'string') return v;
  const first = v.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

function pick(r: Rec, keys: string[], short: string[] = []): Rec {
  const out: Rec = {};
  for (const k of keys) if (k in r) out[k] = short.includes(k) ? oneLine(r[k]) : r[k];
  return out;
}

function conciseTree(node: Rec): Rec {
  const out = pick(node, ['path', 'file_count', 'summary'], ['summary']);
  const kids = node['children'];
  if (Array.isArray(kids) && kids.length) out['children'] = kids.map((k) => conciseTree(k as Rec));
  return out;
}

function conciseCriteria(report: Json): Json {
  if (typeof report !== 'string') return report;
  try {
    const parsed = JSON.parse(report) as { criteria?: Array<{ id?: string; status?: string }> };
    if (Array.isArray(parsed.criteria)) return parsed.criteria.map((c) => `${c.id}:${c.status}`).join(' ');
  } catch {
    // free-text report: fall through to its first line
  }
  return oneLine(report);
}

/**
 * The `concise` shape GH 1958 proposes: ids plus one-line fields. Long text keeps its first
 * line (≤120 chars); bulky nested JSON is dropped or reduced to ids and statuses.
 */
export function concise(tool: string, data: Json): Json {
  const rows = data as Rec[];
  switch (tool) {
    case 'audit_list':
      return rows.map((r) => pick(r, ['id', 'event_type', 'from_node', 'branch_id', 'created_at', 'summary'], ['summary']));
    case 'discussion_list':
      return rows.map((r) => pick(r, ['id', 'kind', 'author', 'task_id', 'created_at', 'body'], ['body']));
    case 'validation_history':
      return rows.map((r) => {
        const run = r['verification_run'] as Rec | null;
        return {
          ...pick(r, ['id', 'attempt_n', 'agent', 'verdict', 'created_at', 'feedback'], ['feedback']),
          verification_run: run ? pick(run, ['run_id', 'exit_code']) : null,
        };
      });
    case 'issue_list':
      return rows.map((r) => pick(r, ['id', 'status', 'updated_at', 'objective'], ['objective']));
    case 'task_get': {
      const t = data as Rec;
      return {
        ...pick(t, ['id', 'issue_id', 'branch_id', 'title', 'status', 'effort', 'commit_sha', 'completed_at']),
        completion_report: conciseCriteria(t['completion_report']),
      };
    }
    case 'world_model_get': {
      const w = data as Rec;
      return { repo: w['repo'], root: conciseTree(w['root'] as Rec) };
    }
    default:
      throw new Error(`no concise shape for ${tool}`);
  }
}

export type Encoding = 'json' | 'toon';

export function encode(data: Json, enc: Encoding): string {
  return enc === 'json' ? JSON.stringify(data) : toonEncode(data);
}

export interface Arm {
  name: string;
  shape: 'detailed' | 'concise';
  enc: Encoding;
}

export const ARMS: Arm[] = [
  { name: 'detailed-json', shape: 'detailed', enc: 'json' },
  { name: 'detailed-toon', shape: 'detailed', enc: 'toon' },
  { name: 'concise-json', shape: 'concise', enc: 'json' },
  { name: 'concise-toon', shape: 'concise', enc: 'toon' },
];

export function render(tool: string, data: Json, arm: Arm): string {
  return encode(arm.shape === 'concise' ? concise(tool, data) : data, arm.enc);
}
