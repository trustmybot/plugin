import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, runClaude } from '../lib/claude.ts';
import { RESULTS_DIR } from '../lib/paths.ts';
import { query } from '../lib/snapshot.ts';
import { fmt, fmtP, mean, median, paired } from '../lib/stats.ts';

const MODEL = process.env['GH1346_READER_MODEL'] ?? 'opus';
const EFFORT = process.env['GH1346_READER_EFFORT'] ?? 'low';
const CONCURRENCY = Number(process.env['GH1346_CONCURRENCY'] ?? 6);
const OUT = join(RESULTS_DIR, 'm5');

interface Item {
  id: string;
  kind: 'completion_report' | 'spawn_note';
  text: string;
  nQuestions: number;
}

const TERSE = [
  'Rewrite the text below in Chain-of-Draft style: the minimum words per point, like a terse engineer\'s draft (aim for 5 words or fewer per clause).',
  'Keep every identifier, number, file path, command, test name, SC id, finding id, sha and status exactly. Drop filler, connectives and restated context.',
  'If the input is JSON, return JSON of the same shape with only the prose fields (note, and any free-text values) shortened. Output only the rewrite.',
].join(' ');

const QGEN = 'You write factual quiz questions about a short engineering report. Each question must have one short, specific answer stated in the report (an id, number, path, command, test name, status or a named decision), not a judgement. Prefer facts a reviewer or orchestrator would need.';
const QSCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string', description: 'Short exact answer, at most 8 words.' } } } } },
} as const;

const READER = 'Answer each question from the report only, as short as possible (at most 8 words). If the report does not say, answer NOT_STATED.';
const ASCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: { answers: { type: 'array', items: { type: 'string' } } },
} as const;

const JUDGE = 'For each item, decide whether the given answer states the same fact as the reference answer (wording may differ; a missing or NOT_STATED answer is wrong). Return one boolean per item, in order.';
const JSCHEMA = {
  type: 'object', additionalProperties: false, required: ['correct'],
  properties: { correct: { type: 'array', items: { type: 'boolean' } } },
} as const;

function items(): Item[] {
  const rows = query<{ id: number; cr: string | null; sn: string | null }>(`select id, completion_report cr, spawn_note sn from tasks where completion_report is not null or spawn_note is not null order by id`);
  return [
    ...rows.filter((r) => r.cr).map((r): Item => ({ id: `report-${r.id}`, kind: 'completion_report', text: r.cr!, nQuestions: 5 })),
    ...rows.filter((r) => r.sn).map((r): Item => ({ id: `note-${r.id}`, kind: 'spawn_note', text: r.sn!, nQuestions: 3 })),
  ];
}

async function answer(text: string, questions: string[]): Promise<{ answers: string[]; totalIn: number }> {
  const r = await runClaude({ prompt: `<report>\n${text}\n</report>\n<questions>\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n</questions>`, system: READER, model: MODEL, effort: EFFORT, jsonSchema: ASCHEMA, tag: 'm5-read' });
  return { answers: (r.structured as { answers?: string[] } | undefined)?.answers ?? [], totalIn: r.totalIn };
}

async function judge(qa: Array<{ q: string; a: string }>, answers: string[]): Promise<boolean[]> {
  const r = await runClaude({ prompt: qa.map((x, i) => `${i + 1}. Q: ${x.q}\n   reference: ${x.a}\n   given: ${answers[i] ?? ''}`).join('\n'), system: JUDGE, model: MODEL, effort: EFFORT, jsonSchema: JSCHEMA, tag: 'm5-judge' });
  const c = (r.structured as { correct?: boolean[] } | undefined)?.correct ?? [];
  return qa.map((_, i) => c[i] === true);
}

const list = items().filter((_, i, a) => !process.env['GH1346_LIMIT'] || i % Math.ceil(a.length / Number(process.env['GH1346_LIMIT'])) === 0);
console.error(`m5: ${list.length} items, model ${MODEL}/${EFFORT}`);

const baseline = (await answer('', ['What is the task id?'])).totalIn;
const rows = await pool(list, CONCURRENCY, async (it) => {
  const [terse, gen] = await Promise.all([
    runClaude({ prompt: it.text, system: TERSE, model: MODEL, effort: EFFORT, tag: 'm5-terse' }),
    runClaude({ prompt: `Write exactly ${it.nQuestions} questions.\n<report>\n${it.text}\n</report>`, system: QGEN, model: MODEL, effort: EFFORT, jsonSchema: QSCHEMA, tag: 'm5-qgen' }),
  ]);
  const qa = ((gen.structured as { questions?: Array<{ q: string; a: string }> } | undefined)?.questions ?? []).slice(0, it.nQuestions);
  const questions = qa.map((x) => x.q);
  const terseText = terse.text.trim();
  const [normalA, terseA, normalSize, terseSize] = await Promise.all([
    answer(it.text, questions), answer(terseText, questions),
    answer(it.text, ['What is the task id?']), answer(terseText, ['What is the task id?']),
  ]);
  const [normalOk, terseOk] = await Promise.all([judge(qa, normalA.answers), judge(qa, terseA.answers)]);
  console.error(`  ${it.id.padEnd(12)} tok ${normalSize.totalIn - baseline} -> ${terseSize.totalIn - baseline}  ok ${normalOk.filter(Boolean).length}/${terseOk.filter(Boolean).length} of ${qa.length}`);
  return {
    id: it.id, kind: it.kind, qa, terse: terseText,
    normalTokens: normalSize.totalIn - baseline, terseTokens: terseSize.totalIn - baseline,
    normalAnswers: normalA.answers, terseAnswers: terseA.answers, normalOk, terseOk,
  };
});

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'cells.json'), JSON.stringify(rows, null, 2));

const acc = (oks: boolean[]): number => (oks.length ? oks.filter(Boolean).length / oks.length : NaN);
const md: string[] = [];
md.push(`### M5 — terse (Chain of Draft) vs normal prose (${rows.length} real completion reports and spawn notes; rewrite, quiz, reader and judge ${MODEL} effort ${EFFORT})`, '');
md.push('| Kind | n | Normal tokens mean (median) | Terse tokens mean (median) | Change | paired t p | Wilcoxon p | Retention normal | Retention terse | Δ retention (95% CI) | paired t p | Wilcoxon p |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const kind of ['all', 'completion_report', 'spawn_note']) {
  const xs = rows.filter((r) => (kind === 'all' || r.kind === kind) && r.qa.length > 0);
  const t = paired(xs.map((r) => r.normalTokens), xs.map((r) => r.terseTokens));
  const a = paired(xs.map((r) => acc(r.normalOk)), xs.map((r) => acc(r.terseOk)));
  md.push(`| ${kind} | ${xs.length} | ${fmt(t.meanA, 0)} (${fmt(median(xs.map((r) => r.normalTokens)), 0)}) | ${fmt(t.meanB, 0)} (${fmt(median(xs.map((r) => r.terseTokens)), 0)}) | ${t.pctChange.toFixed(1)}% | ${fmtP(t.p)} | ${fmtP(t.wilcoxonP)} | ${(100 * a.meanA).toFixed(1)}% | ${(100 * a.meanB).toFixed(1)}% | ${(100 * a.meanDiff).toFixed(1)} pp (${(100 * a.ci95[0]).toFixed(1)} … ${(100 * a.ci95[1]).toFixed(1)}) | ${fmtP(a.p)} | ${fmtP(a.wilcoxonP)} |`);
}
const lost = rows.flatMap((r) => r.qa.map((x, i) => ({ id: r.id, q: x.q, a: x.a, terse: r.terseAnswers[i], n: r.normalOk[i], t: r.terseOk[i] }))).filter((x) => x.n && !x.t);
md.push('', `Questions answered from the normal text but not from the terse one: ${lost.length} of ${rows.reduce((s, r) => s + r.qa.length, 0)}. Mean per-item retention gap ${(100 * mean(rows.map((r) => acc(r.normalOk) - acc(r.terseOk)).filter((x) => !Number.isNaN(x)))).toFixed(1)} pp.`);
for (const x of lost.slice(0, 12)) md.push(`- ${x.id}: "${x.q}" — reference \`${x.a}\`, terse reader \`${x.terse}\``);
writeFileSync(join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
