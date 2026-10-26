import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson, pool, runClaude, type ClaudeRun } from '../lib/claude.ts';
import { RESULTS_DIR } from '../lib/paths.ts';
import { fmt, fmtP, mcnemar, mean, paired, sd } from '../lib/stats.ts';
import { ARMS, render, type Arm } from './formats.ts';
import { isAbstain, makeQuestions, score, type Question } from './questions.ts';

const TOOLS = ['audit_list', 'discussion_list', 'validation_history', 'task_get', 'issue_list', 'world_model_get'];
const MODEL = process.env['GH1346_READER_MODEL'] ?? 'opus';
const EFFORT = process.env['GH1346_READER_EFFORT'] ?? 'low';
const CONCURRENCY = Number(process.env['GH1346_CONCURRENCY'] ?? 4);
const OUT = join(RESULTS_DIR, 'm1m2');

const SYSTEM = [
  'You read one MCP tool result and answer questions about it.',
  'Use only the data shown inside <result>. Do not guess.',
  'If the data shown does not contain what a question needs, answer exactly NEEDS_DETAIL.',
  'Reply with JSON only: {"answers": ["...", "..."]}, one string per question, in order.',
  'Lists are comma-separated. Copy values exactly as they appear.',
].join(' ');

interface Input {
  id: string;
  tool: string;
  data: unknown;
  questions: Question[];
}

function loadInputs(): Input[] {
  const dir = join(OUT, 'outputs');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const id = f.replace(/\.json$/, '');
      const tool = TOOLS.find((t) => id.startsWith(`${t}_`))!;
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
      return { id, tool, data, questions: makeQuestions(id, tool, data) };
    });
}

function prompt(input: Input, enc: string, payload: string): string {
  const qs = input.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  return `Tool: ${input.tool}\nFormat: ${enc.toUpperCase()}\n<result>\n${payload}\n</result>\n\nQuestions:\n${qs}`;
}

interface Cell {
  input: string;
  tool: string;
  arm: string;
  chars: number;
  totalIn: number;
  payloadTokens: number;
  output: number;
  costUsd: number;
  durationMs: number;
  answers: string[];
  correct: boolean[];
}

async function ask(input: Input, arm: Arm | null): Promise<{ run: ClaudeRun; payload: string }> {
  const payload = arm ? render(input.tool, input.data, arm) : '';
  const run = await runClaude({
    prompt: prompt(input, arm?.enc ?? 'json', payload),
    system: SYSTEM,
    model: MODEL,
    effort: EFFORT,
    tools: [],
    tag: `m1m2-${arm?.name ?? 'baseline'}`,
  });
  return { run, payload };
}

const inputs = loadInputs();
mkdirSync(OUT, { recursive: true });
console.error(`m1m2: ${inputs.length} inputs, ${inputs.reduce((n, i) => n + i.questions.length, 0)} questions, reader ${MODEL}/${EFFORT}`);

const jobs = inputs.flatMap((input) => [null, ...ARMS].map((arm) => ({ input, arm })));
const runs = await pool(jobs, CONCURRENCY, ({ input, arm }) => ask(input, arm));

const baseline = new Map<string, number>();
jobs.forEach((j, i) => {
  if (!j.arm) baseline.set(j.input.id, runs[i]!.run.totalIn);
});

const cells: Cell[] = [];
jobs.forEach((j, i) => {
  if (!j.arm) return;
  const { run, payload } = runs[i]!;
  const parsed = extractJson<{ answers?: unknown[] }>(run.text);
  const answers = (parsed?.answers ?? []).map((a) => String(a ?? ''));
  cells.push({
    input: j.input.id,
    tool: j.input.tool,
    arm: j.arm.name,
    chars: payload.length,
    totalIn: run.totalIn,
    payloadTokens: run.totalIn - baseline.get(j.input.id)!,
    output: run.usage.output,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    answers,
    correct: j.input.questions.map((q, k) => score(answers[k], q.truth)),
  });
});

const cell = (input: string, arm: string): Cell => cells.find((c) => c.input === input && c.arm === arm)!;
const ids = inputs.map((i) => i.id);
const tokens = (arm: string, subset = ids): number[] => subset.map((id) => cell(id, arm).payloadTokens);

const comparisons: Array<[string, string]> = [
  ['detailed-json', 'detailed-toon'],
  ['detailed-json', 'concise-json'],
  ['concise-json', 'concise-toon'],
  ['detailed-json', 'concise-toon'],
];

const tokenTests = comparisons.map(([a, b]) => ({ control: a, treatment: b, ...paired(tokens(a), tokens(b)) }));

const perTool = TOOLS.map((tool) => {
  const sub = inputs.filter((i) => i.tool === tool).map((i) => i.id);
  const row: Record<string, number | string> = { tool };
  for (const arm of ARMS) row[arm.name] = mean(tokens(arm.name, sub));
  return row;
});

interface QRow {
  input: string;
  q: Question;
  k: number;
}
const qrows: QRow[] = inputs.flatMap((input) => input.questions.map((q, k) => ({ input: input.id, q, k })));
const correctOf = (arm: string, rows: QRow[]): boolean[] => rows.map((r) => cell(r.input, arm).correct[r.k]!);
const answerable = qrows.filter((r) => r.q.conciseAnswerable);
const detailOnly = qrows.filter((r) => !r.q.conciseAnswerable);

const accuracy = comparisons.map(([a, b]) => {
  const rows = b.startsWith('concise') ? answerable : qrows;
  return { control: a, treatment: b, scope: rows === qrows ? 'all' : 'concise-answerable', ...mcnemar(correctOf(a, rows), correctOf(b, rows)) };
});

const abstention = ARMS.filter((a) => a.shape === 'concise').map((arm) => {
  const outcome = detailOnly.map((r) => {
    const ans = cell(r.input, arm.name).answers[r.k];
    if (isAbstain(ans)) return 'abstain';
    return score(ans, r.q.truth) ? 'correct' : 'wrong';
  });
  return {
    arm: arm.name,
    n: outcome.length,
    abstain: outcome.filter((o) => o === 'abstain').length,
    correct: outcome.filter((o) => o === 'correct').length,
    wrong: outcome.filter((o) => o === 'wrong').length,
  };
});

const byKind = [...new Set(qrows.map((r) => r.q.kind))].map((kind) => {
  const rows = qrows.filter((r) => r.q.kind === kind);
  const row: Record<string, number | string> = { kind, n: rows.length, conciseAnswerable: rows.filter((r) => r.q.conciseAnswerable).length };
  for (const arm of ARMS) row[arm.name] = mean(correctOf(arm.name, rows).map(Number));
  return row;
});

const armTotals = ARMS.map((arm) => {
  const cs = cells.filter((c) => c.arm === arm.name);
  return {
    arm: arm.name,
    meanPayloadTokens: mean(cs.map((c) => c.payloadTokens)),
    sdPayloadTokens: sd(cs.map((c) => c.payloadTokens)),
    meanChars: mean(cs.map((c) => c.chars)),
    charsPerToken: mean(cs.map((c) => c.chars / Math.max(1, c.payloadTokens))),
    accuracyAll: mean(cs.flatMap((c) => c.correct.map(Number))),
    costUsd: cs.reduce((s, c) => s + c.costUsd, 0),
    unparsed: cs.filter((c) => c.answers.length === 0).length,
  };
});

const summary = { model: MODEL, effort: EFFORT, nInputs: inputs.length, nQuestions: qrows.length, nAnswerable: answerable.length, armTotals, tokenTests, perTool, accuracy, abstention, byKind };
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, 'cells.json'), JSON.stringify(cells, null, 2));
writeFileSync(join(OUT, 'questions.json'), JSON.stringify(inputs.map((i) => ({ id: i.id, questions: i.questions })), null, 2));

const md: string[] = [];
md.push(`### M1/M2 — encoding and response shape (${inputs.length} real tool outputs, ${qrows.length} questions, reader ${MODEL} effort ${EFFORT})`, '');
md.push('| Arm | Payload tokens, mean ± sd | Chars/token | Accuracy (all questions) | Unparsed |', '|---|---|---|---|---|');
for (const a of armTotals) md.push(`| ${a.arm} | ${fmt(a.meanPayloadTokens)} ± ${fmt(a.sdPayloadTokens)} | ${fmt(a.charsPerToken, 2)} | ${(100 * a.accuracyAll).toFixed(1)}% | ${a.unparsed} |`);
md.push('', '| Token comparison | Δ mean (95% CI) | Change | paired t p | Wilcoxon p |', '|---|---|---|---|---|');
for (const t of tokenTests) md.push(`| ${t.treatment} vs ${t.control} | ${fmt(t.meanDiff)} (${fmt(t.ci95[0])} … ${fmt(t.ci95[1])}) | ${t.pctChange.toFixed(1)}% | ${fmtP(t.p)} | ${fmtP(t.wilcoxonP)} |`);
md.push('', '| Accuracy comparison | Scope | n | Control | Treatment | Only control right | Only treatment right | McNemar p |', '|---|---|---|---|---|---|---|---|');
for (const a of accuracy) md.push(`| ${a.treatment} vs ${a.control} | ${a.scope} | ${a.n} | ${(100 * a.accA).toFixed(1)}% | ${(100 * a.accB).toFixed(1)}% | ${a.onlyA} | ${a.onlyB} | ${fmtP(a.p)} |`);
md.push('', '| Concise arm on detail-only questions | n | Abstained (NEEDS_DETAIL) | Correct anyway | Wrong (hallucinated) |', '|---|---|---|---|---|');
for (const a of abstention) md.push(`| ${a.arm} | ${a.n} | ${a.abstain} | ${a.correct} | ${a.wrong} |`);
md.push('', `| Tool | ${ARMS.map((a) => a.name).join(' | ')} |`, `|---|${ARMS.map(() => '---').join('|')}|`);
for (const r of perTool) md.push(`| ${r['tool']} | ${ARMS.map((a) => fmt(r[a.name] as number, 0)).join(' | ')} |`);
md.push('', `| Question kind | n | Concise-answerable | ${ARMS.map((a) => a.name).join(' | ')} |`, `|---|---|---|${ARMS.map(() => '---').join('|')}|`);
for (const r of byKind) md.push(`| ${r['kind']} | ${r['n']} | ${r['conciseAnswerable']} | ${ARMS.map((a) => `${(100 * (r[a.name] as number)).toFixed(0)}%`).join(' | ')} |`);
writeFileSync(join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
