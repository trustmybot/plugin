import { createHash } from 'node:crypto';
import { concise } from './formats.ts';

type Rec = Record<string, unknown>;

export interface Question {
  text: string;
  kind: string;
  truth: string;
  /** Whether the concise shape still carries what the question needs (same truth on concise rows). */
  conciseAnswerable: boolean;
}

interface Cfg {
  id: string;
  cat: string[];
  lookup: string[];
  text: string[];
  time?: string;
}

const CFG: Record<string, Cfg> = {
  audit_list: { id: 'id', cat: ['event_type', 'from_node', 'branch_id'], lookup: ['event_type', 'branch_id', 'created_at', 'from_node'], text: ['summary', 'content_json'], time: 'created_at' },
  discussion_list: { id: 'id', cat: ['kind', 'author'], lookup: ['kind', 'author', 'created_at'], text: ['body'], time: 'created_at' },
  validation_history: { id: 'id', cat: ['verdict', 'agent'], lookup: ['verdict', 'created_at', 'verification_run.exit_code', 'verification_run.commit_sha'], text: ['feedback'], time: 'created_at' },
  issue_list: { id: 'id', cat: ['status'], lookup: ['status', 'updated_at', 'created_at'], text: ['objective'], time: 'updated_at' },
  world_model_get: { id: 'path', cat: ['summary_source', 'trust'], lookup: ['file_count', 'summary_source'], text: ['summary'] },
};

function get(r: Rec, path: string): unknown {
  let cur: unknown = r;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Rec)[k];
  }
  return cur;
}

function str(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function rng(seed: string): () => number {
  let h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 2 ** 32;
  };
}

function flattenTree(node: Rec, out: Rec[] = []): Rec[] {
  out.push(node);
  for (const k of (node['children'] as Rec[] | undefined) ?? []) flattenTree(k, out);
  return out;
}

function rowsOf(tool: string, data: unknown): Rec[] {
  if (tool === 'world_model_get') return flattenTree((data as Rec)['root'] as Rec);
  return data as Rec[];
}

type Compute = (rows: Rec[]) => string | undefined;

interface Draft {
  text: string;
  kind: string;
  compute: Compute;
}

function words(s: string): string[] {
  return s.match(/[A-Za-z][A-Za-z0-9_-]{6,}/g) ?? [];
}

function listDrafts(tool: string, rows: Rec[], seed: string): Draft[] {
  const c = CFG[tool]!;
  const r = rng(seed);
  const choice = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const idOf = (row: Rec): string => str(get(row, c.id))!;
  const drafts: Draft[] = [];

  drafts.push({
    kind: 'total',
    text: `How many rows (${tool === 'world_model_get' ? 'directory nodes, counting the root and every nested child' : 'top-level records'}) does the result contain?`,
    compute: (rs) => String(rs.length),
  });

  const catOptions: Array<{ field: string; value: string; n: number }> = [];
  for (const field of c.cat) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const v = str(get(row, field));
      if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size < 2) continue;
    for (const [value, n] of counts) catOptions.push({ field, value, n });
  }
  const countPick = catOptions.filter((o) => o.n >= 2);
  if (countPick.length) {
    const o = choice(countPick);
    drafts.push({
      kind: 'count',
      text: `How many records have ${o.field} equal to "${o.value}"?`,
      compute: (rs) => String(rs.filter((row) => str(get(row, o.field)) === o.value).length),
    });
  }
  const filterPick = catOptions.filter((o) => o.n >= 1 && o.n <= 5);
  if (filterPick.length) {
    const o = choice(filterPick);
    drafts.push({
      kind: 'filter',
      text: `List the ${c.id} of every record whose ${o.field} is "${o.value}".`,
      compute: (rs) => rs.filter((row) => str(get(row, o.field)) === o.value).map(idOf).sort().join(','),
    });
  }

  for (let k = 0; k < 2; k++) {
    const row = rows[1 + Math.floor(r() * Math.max(1, rows.length - 2))] ?? rows[0]!;
    const field = choice(c.lookup.filter((f) => get(row, f) !== undefined));
    const id = idOf(row);
    drafts.push({
      kind: 'lookup',
      text: `What is the ${field} of the record whose ${c.id} is "${id}"? Give the exact value.`,
      compute: (rs) => str(get(rs.find((x) => idOf(x) === id) ?? {}, field)),
    });
  }

  if (c.time) {
    const t = c.time;
    drafts.push({
      kind: 'extreme',
      text: `Which record has the earliest ${t}? Give its ${c.id}.`,
      compute: (rs) => {
        const s = [...rs].sort((a, b) => String(get(a, t)).localeCompare(String(get(b, t))));
        return s.length ? s.filter((x) => String(get(x, t)) === String(get(s[0]!, t))).map(idOf).sort().join(',') : undefined;
      },
    });
  } else {
    drafts.push({
      kind: 'extreme',
      text: `Which node has the largest file_count? Give its ${c.id}.`,
      compute: (rs) => {
        const s = [...rs].sort((a, b) => Number(get(b, 'file_count')) - Number(get(a, 'file_count')));
        return s.length ? s.filter((x) => get(x, 'file_count') === get(s[0]!, 'file_count')).map(idOf).sort().join(',') : undefined;
      },
    });
  }

  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const f of c.text) {
      for (const w of words(str(get(row, f)) ?? '')) {
        const key = w.toLowerCase();
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key)!.add(idOf(row));
      }
    }
  }
  const unique = [...owners.entries()].filter(([, s]) => s.size === 1).map(([w]) => w).sort();
  if (unique.length) {
    const w = choice(unique);
    drafts.push({
      kind: 'text',
      text: `Exactly one record's ${c.text.join(' or ')} contains the word "${w}" (case-insensitive). Give that record's ${c.id}.`,
      compute: (rs) => {
        const hits = rs.filter((row) => c.text.some((f) => (str(get(row, f)) ?? '').toLowerCase().includes(w)));
        return hits.length === 1 ? idOf(hits[0]!) : hits.length === 0 ? undefined : hits.map(idOf).sort().join(',');
      },
    });
  }
  return drafts;
}

function taskDrafts(): Draft[] {
  const one = (rs: Rec[], f: string): string | undefined => str(get(rs[0]!, f));
  const criteria = (rs: Rec[]): Array<{ id: string; status: string }> | undefined => {
    const v = rs[0]!['completion_report'];
    if (typeof v !== 'string') return undefined;
    try {
      return (JSON.parse(v) as { criteria: Array<{ id: string; status: string }> }).criteria;
    } catch {
      const m = [...v.matchAll(/\b(SC\d+):(\w+)/g)];
      return m.length ? m.map((x) => ({ id: x[1]!, status: x[2]! })) : undefined;
    }
  };
  return [
    { kind: 'lookup', text: 'What is the task status?', compute: (rs) => one(rs, 'status') },
    { kind: 'lookup', text: 'What effort level is the task set to?', compute: (rs) => one(rs, 'effort') },
    { kind: 'lookup', text: 'What is the full commit_sha?', compute: (rs) => one(rs, 'commit_sha') },
    { kind: 'count', text: 'How many success criteria does the completion report list?', compute: (rs) => (criteria(rs) ? String(criteria(rs)!.length) : undefined) },
    {
      kind: 'filter',
      text: 'List the ids of the success criteria whose status is not "met" (answer "none" if all are met).',
      compute: (rs) => {
        const cs = criteria(rs);
        if (!cs) return undefined;
        const bad = cs.filter((x) => x.status !== 'met').map((x) => x.id).sort();
        return bad.length ? bad.join(',') : 'none';
      },
    },
    {
      kind: 'count',
      text: 'How many files does the task list in its files field?',
      compute: (rs) => {
        const f = rs[0]!['files'];
        if (typeof f !== 'string') return undefined;
        try {
          return String((JSON.parse(f) as unknown[]).length);
        } catch {
          return undefined;
        }
      },
    },
  ];
}

export function makeQuestions(inputId: string, tool: string, data: unknown): Question[] {
  const detailRows = tool === 'task_get' ? [data as Rec] : rowsOf(tool, data);
  const conciseData = concise(tool, data);
  const conciseRows = tool === 'task_get' ? [conciseData as Rec] : rowsOf(tool, conciseData);
  const drafts = tool === 'task_get' ? taskDrafts() : listDrafts(tool, detailRows, inputId);
  const out: Question[] = [];
  for (const d of drafts) {
    const truth = d.compute(detailRows);
    if (truth === undefined || truth === '') continue;
    let conciseTruth: string | undefined;
    try {
      conciseTruth = d.compute(conciseRows);
    } catch {
      conciseTruth = undefined;
    }
    out.push({ text: d.text, kind: d.kind, truth, conciseAnswerable: conciseTruth === truth });
  }
  return out;
}

function norm(s: string): string {
  return s.trim().replace(/^["'`]+|["'`.]+$/g, '').trim().toLowerCase();
}

export function score(answer: unknown, truth: string): boolean {
  const a = norm(String(answer ?? ''));
  const t = norm(truth);
  if (a === t) return true;
  if (t.includes(',') || a.includes(',')) {
    const set = (x: string): string => x.split(/\s*,\s*/).map(norm).filter(Boolean).sort().join(',');
    return set(a) === set(t);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(a.replace(/[^\d.-]/g, '')) === Number(t);
  return false;
}

export function isAbstain(answer: unknown): boolean {
  return /needs_detail/i.test(String(answer ?? ''));
}
