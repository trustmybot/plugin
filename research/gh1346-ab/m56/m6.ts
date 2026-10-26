import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, runClaude } from '../lib/claude.ts';
import { RESULTS_DIR } from '../lib/paths.ts';
import { query } from '../lib/snapshot.ts';
import { fisherExact, fmtP } from '../lib/stats.ts';

const MODEL = process.env['GH1346_READER_MODEL'] ?? 'opus';
const EFFORT = process.env['GH1346_READER_EFFORT'] ?? 'low';
const CONCURRENCY = Number(process.env['GH1346_CONCURRENCY'] ?? 6);
const OUT = join(RESULTS_DIR, 'm6');

const CATEGORIES = ['report_gap', 'gate_failed', 'code_defect', 'spec_violation', 'other'] as const;
const CLASSIFY = [
  'You classify why a code reviewer failed a task. Pick the primary reason:',
  'report_gap = the swe report claimed something the diff or evidence does not back, omitted a success criterion, gave no or wrong evidence, or withheld a change, limitation or scope deviation;',
  'gate_failed = the verification run is missing, red or for the wrong sha;',
  'code_defect = a bug or broken behaviour found by inspecting or running the code;',
  'spec_violation = the diff does not do what a success criterion requires, or touches files outside scope;',
  'other = anything else.',
  'Then say whether a mechanical check on a typed completion report (every spec SC id present once, each with status met and a runnable evidence command, files changed listed against files[]) would have stopped this before review.',
].join(' ');
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['category', 'schema_catchable', 'why'],
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    schema_catchable: { type: 'boolean' },
    why: { type: 'string', description: 'At most 20 words.' },
  },
} as const;

interface Attempt { id: number; task_id: number; attempt_n: number; verdict: string; feedback: string | null; typed: number }

const attempts = query<Attempt>(`select va.id, va.task_id, va.attempt_n, va.verdict, va.feedback, (t.completion_report is not null) typed from validation_attempts va join tasks t on t.id=va.task_id order by va.task_id, va.attempt_n, va.id`);
const first = new Map<number, Attempt>();
for (const a of attempts) if (!first.has(a.task_id)) first.set(a.task_id, a);

const md: string[] = [];
md.push(`### M6 — typed completion report vs free text (natural experiment: the typed report shipped in GH 1744 on 2026-10-25; ${attempts.length} review attempts on ${first.size} tasks)`, '');

const era = (typed: number): Attempt[] => [...first.values()].filter((a) => a.typed === typed);
const [free, typed] = [era(0), era(1)];
const passes = (xs: Attempt[]): number => xs.filter((a) => a.verdict === 'pass').length;
const pFirst = fisherExact(passes(free), free.length - passes(free), passes(typed), typed.length - passes(typed));
md.push('| Era | Tasks reviewed | First-pass pass | Rate | Review attempts | Fails |', '|---|---|---|---|---|---|');
for (const [name, xs, t] of [['free text', free, 0], ['typed report', typed, 1]] as const) {
  const all = attempts.filter((a) => a.typed === t);
  md.push(`| ${name} | ${xs.length} | ${passes(xs)} | ${((100 * passes(xs)) / xs.length).toFixed(1)}% | ${all.length} | ${all.filter((a) => a.verdict === 'fail').length} |`);
}
md.push('', `Fisher exact on first-pass pass rate: p = ${fmtP(pFirst)}. The eras differ in time and in other prompt changes, so this is observational, not causal.`, '');

const fails = attempts.filter((a) => a.verdict === 'fail' && a.feedback);
const labels = await pool(fails, CONCURRENCY, async (a) => {
  const r = await runClaude({ prompt: `<review_feedback task="${a.task_id}" attempt="${a.attempt_n}">\n${a.feedback}\n</review_feedback>`, system: CLASSIFY, model: MODEL, effort: EFFORT, jsonSchema: SCHEMA, tag: 'm6-classify' });
  return (r.structured as { category: string; schema_catchable: boolean; why: string } | undefined) ?? { category: 'other', schema_catchable: false, why: 'unparsed' };
});
const rows = fails.map((a, i) => ({ task: a.task_id, attempt: a.attempt_n, typed: a.typed, ...labels[i]! }));
md.push('| Fail reason | Free-text era | Typed era |', '|---|---|---|');
for (const c of CATEGORIES) md.push(`| ${c} | ${rows.filter((r) => !r.typed && r.category === c).length} | ${rows.filter((r) => r.typed && r.category === c).length} |`);
const catchF = rows.filter((r) => !r.typed && r.schema_catchable).length;
const catchT = rows.filter((r) => r.typed && r.schema_catchable).length;
const nF = rows.filter((r) => !r.typed).length;
const nT = rows.filter((r) => r.typed).length;
md.push(`| **schema-catchable** | ${catchF}/${nF} | ${catchT}/${nT} |`, '', `Fisher exact on the schema-catchable share of fails: p = ${fmtP(fisherExact(catchF, nF - catchF, catchT, nT - catchT))}.`, '');

const reports = query<{ id: number; spec: string | null; cr: string; files: string | null }>(`select id, spec_body spec, completion_report cr, files from tasks where completion_report is not null`);
const specIds = (spec: string | null): string[] => [...new Set([...(spec ?? '').matchAll(/^\s*-\s*\**(SC\d+)\**:/gm)].map((m) => m[1]!))];
let missingSc = 0, notMet = 0, noEvidence = 0, criteria = 0;
const violators = new Set<number>();
for (const r of reports) {
  const rep = JSON.parse(r.cr) as { criteria?: Array<{ id: string; status: string; evidence_cmd?: string }> };
  const got = new Set((rep.criteria ?? []).map((c) => c.id));
  const miss = specIds(r.spec).filter((id) => !got.has(id)).length;
  missingSc += miss;
  for (const c of rep.criteria ?? []) {
    criteria++;
    if (c.status !== 'met') notMet++;
    if (!c.evidence_cmd?.trim()) noEvidence++;
    if (c.status !== 'met' || !c.evidence_cmd?.trim()) violators.add(r.id);
  }
  if (miss) violators.add(r.id);
}
md.push(`Stored typed reports (${reports.length} tasks, ${criteria} criteria): ${missingSc} spec SC ids missing, ${notMet} criteria not "met", ${noEvidence} without an evidence command; ${violators.size} reports would fail a stricter GH 1961 check.`);

const m4 = join(RESULTS_DIR, 'm4', 'cells.json');
if (existsSync(m4)) {
  const cells = JSON.parse(readFileSync(m4, 'utf8')) as Array<{ agent: string; ref: { task_id: number | null; outcome: string } | null; id: string }>;
  const returns = JSON.parse(readFileSync(join(RESULTS_DIR, 'm4', 'returns.json'), 'utf8')) as Array<{ id: string; text: string }>;
  const textOf = new Map(returns.map((r) => [r.id, r.text]));
  const freeDone = cells.filter((c) => c.agent === 'swe' && c.ref?.outcome === 'completed' && c.ref.task_id != null && c.ref.task_id < 114);
  let ids = 0, cited = 0, full = 0, numbered = 0;
  for (const c of freeDone) {
    const spec = query<{ spec: string | null }>(`select spec_body spec from tasks where id=?`, c.ref!.task_id!)[0]?.spec ?? null;
    const want = specIds(spec);
    const text = textOf.get(c.id) ?? '';
    const hit = want.filter((id) => new RegExp(`\\b${id}\\b`).test(text)).length;
    if (want.length) numbered++;
    ids += want.length;
    cited += hit;
    if (want.length && hit === want.length) full++;
  }
  md.push('', `Free-text era swe returns that report completion: ${freeDone.length}, of which ${numbered} are for specs with numbered SC ids (older specs list criteria as unnumbered bullets, so coverage cannot be checked mechanically). Those cite ${cited} of ${ids} SC ids by name, and ${full} cover every SC id. The typed report enforces 100% coverage at close.`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'cells.json'), JSON.stringify(rows, null, 2));
writeFileSync(join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
