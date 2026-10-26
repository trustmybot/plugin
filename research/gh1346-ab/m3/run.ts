import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, runClaude, type ClaudeRun } from '../lib/claude.ts';
import { RESULTS_DIR, SERVER_DIST, WORK_DIR } from '../lib/paths.ts';
import { query, scratchCopy } from '../lib/snapshot.ts';
import { fmt, fmtP, mcnemar, mean, median, paired, sd } from '../lib/stats.ts';
import { m3Questions, scoreM3, type M3Question } from './questions.ts';
import { exportSource } from './source.ts';

const MODEL = process.env['GH1346_AGENT_MODEL'] ?? 'opus';
const EFFORT = process.env['GH1346_AGENT_EFFORT'] ?? 'medium';
const CONCURRENCY = Number(process.env['GH1346_CONCURRENCY'] ?? 4);
const ONLY = process.env['GH1346_ONLY']?.split(',');
const OUT = join(RESULTS_DIR, 'm3');

const READ_TOOLS = [
  'issue_get', 'issue_list', 'issue_report_md', 'issue_get_with_discussions', 'issue_get_phase',
  'task_get', 'task_stats', 'validation_history', 'audit_list', 'audit_search',
  'discussion_list', 'discussion_search', 'world_model_get', 'world_model_search', 'world_model_symbol',
  'agent_list', 'branch_report_md',
];
const CORE_TABLES = ['issues', 'tasks', 'agent_runs', 'validation_attempts', 'verification_runs', 'review_findings', 'discussions', 'audit'];

const FINAL = 'Finish with one last line of the form `ANSWER: <value>` in the requested format, nothing after it.';

function mcpConfig(): string {
  const path = join(WORK_DIR, 'm3-mcp.json');
  const config = {
    mcpServers: {
      'trajectory-server': {
        command: process.execPath,
        args: ['--experimental-sqlite', join(SERVER_DIST, 'index.js')],
        env: { TRAJECTORY_DB_PATH: scratchCopy('m3-mcp') },
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function schemaSummary(): string {
  return CORE_TABLES.map((t) => `${t}(${query<{ name: string }>(`select name from pragma_table_info(?)`, t).map((c) => c.name).join(', ')})`).join('\n');
}

interface Arm {
  name: 'tool-per-step' | 'code-as-action';
  system: string;
  tools: string[];
  allowedTools: string[];
  mcpConfig?: string;
}

/** Both arms load the same MCP server, as bro does in production; they differ only in which actions they may take. */
function arms(): Arm[] {
  const sqlDb = scratchCopy('m3-sql');
  const mcp = mcpConfig();
  return [
    {
      name: 'tool-per-step',
      system: [
        'You answer questions about the TMB plugin project. The current directory is its source tree.',
        "For project history (issues, tasks, agent runs, reviews, discussions, audit) use the trajectory-server MCP tools; pass agent: 'bro' on every call.",
        'For source code use Read, Grep and Glob. Local issue ids are the trajectory DB ids, not GitHub numbers.',
        FINAL,
      ].join(' '),
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob', ...READ_TOOLS.map((t) => `mcp__trajectory-server__${t}`)],
      mcpConfig: mcp,
    },
    {
      name: 'code-as-action',
      system: [
        'You answer questions about the TMB plugin project. The current directory is its source tree.',
        'Write one read-only script per question and run it with Bash: query the project history with',
        `\`sqlite3 -readonly ${sqlDb}\` and search code with grep or rg. Batch every lookup the question needs into that one script;`,
        'only run a second script if the first fails. Never write to the DB or the tree.',
        'Local issue ids are the DB ids (issues.id), not GitHub numbers (issues.gh_iid). issues.labels is a JSON array string.',
        `Core tables:\n${schemaSummary()}\n`,
        FINAL,
      ].join(' '),
      tools: ['Bash'],
      allowedTools: ['Bash'],
      mcpConfig: mcp,
    },
  ];
}

function answerOf(text: string): string {
  const m = [...text.matchAll(/^\s*\**ANSWER:?\**:?\s*(.+?)\s*$/gim)].at(-1);
  return (m?.[1] ?? '').replace(/^`|`$/g, '');
}

interface Cell {
  q: string;
  kind: string;
  arm: string;
  answer: string;
  truth: string;
  correct: boolean;
  totalIn: number;
  cacheRead: number;
  output: number;
  toolCalls: number;
  toolResultChars: number;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
  toolNames: string[];
}

const src = exportSource();
const questions = m3Questions(src).filter((q) => !ONLY || ONLY.includes(q.id));
const armList = arms();
mkdirSync(OUT, { recursive: true });
console.error(`m3: ${questions.length} questions x ${armList.length} arms, agent ${MODEL}/${EFFORT}, src ${src}`);

const jobs = questions.flatMap((q) => armList.map((arm) => ({ q, arm })));
const runs = await pool(jobs, CONCURRENCY, async ({ q, arm }): Promise<ClaudeRun> => {
  const run = await runClaude({
    prompt: `${q.text}\nAnswer format: ${q.format}.`,
    system: arm.system,
    model: MODEL,
    effort: EFFORT,
    tools: arm.tools,
    allowedTools: arm.allowedTools,
    mcpConfig: arm.mcpConfig,
    cwd: src,
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    tag: `m3-${arm.name}`,
  });
  console.error(`  ${arm.name.padEnd(14)} ${q.id.padEnd(22)} calls=${run.toolCalls} in=${run.totalIn} ${scoreM3(q, answerOf(run.text)) ? 'ok' : `MISS ${answerOf(run.text).slice(0, 60)}`}`);
  return run;
});

const cells: Cell[] = jobs.map(({ q, arm }, i) => {
  const r = runs[i]!;
  const answer = answerOf(r.text);
  return {
    q: q.id, kind: q.kind, arm: arm.name, answer, truth: q.truth, correct: scoreM3(q, answer),
    totalIn: r.totalIn, cacheRead: r.usage.cacheRead, output: r.usage.output, toolCalls: r.toolCalls,
    toolResultChars: r.toolResultChars, durationMs: r.durationMs, costUsd: r.costUsd, numTurns: r.numTurns,
    isError: r.isError, toolNames: r.toolNames,
  };
});

const [A, B] = armList.map((a) => a.name) as [string, string];
const of = (arm: string, qs: M3Question[] = questions): Cell[] => qs.map((q) => cells.find((c) => c.q === q.id && c.arm === arm)!);
const metrics: Array<[string, (c: Cell) => number]> = [
  ['Input tokens (total)', (c) => c.totalIn],
  ['Cache read tokens', (c) => c.cacheRead],
  ['Output tokens', (c) => c.output],
  ['Tool calls', (c) => c.toolCalls],
  ['Tool result chars', (c) => c.toolResultChars],
  ['Wall time (s)', (c) => c.durationMs / 1000],
  ['Cost (USD)', (c) => c.costUsd],
];
const scopes: Array<[string, M3Question[]]> = [
  ['all', questions],
  ...(['single', 'cross', 'code'] as const).map((k): [string, M3Question[]] => [k, questions.filter((q) => q.kind === k)]),
].filter((s): s is [string, M3Question[]] => s[1].length > 0);

const tests = scopes.flatMap(([scope, qs]) => metrics.map(([name, f]) => ({ scope, metric: name, ...paired(of(A, qs).map(f), of(B, qs).map(f)) })));
const accuracy = scopes.map(([scope, qs]) => ({ scope, ...mcnemar(of(A, qs).map((c) => c.correct), of(B, qs).map((c) => c.correct)) }));
const medians = scopes.map(([scope, qs]) => ({ scope, inA: median(of(A, qs).map((c) => c.totalIn)), inB: median(of(B, qs).map((c) => c.totalIn)), callsA: median(of(A, qs).map((c) => c.toolCalls)), callsB: median(of(B, qs).map((c) => c.toolCalls)) }));

writeFileSync(join(OUT, 'cells.json'), JSON.stringify(cells, null, 2));
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ model: MODEL, effort: EFFORT, n: questions.length, tests, accuracy, medians }, null, 2));

const md: string[] = [];
md.push(`### M3 — code as the action language (${questions.length} lookup questions, agent ${MODEL} effort ${EFFORT}; A = ${A}, B = ${B})`, '');
md.push('| Metric (all questions) | A mean ± sd | B mean ± sd | Δ B−A (95% CI) | Change | paired t p | Wilcoxon p |', '|---|---|---|---|---|---|---|');
for (const t of tests.filter((x) => x.scope === 'all')) {
  const d = t.metric === 'Cost (USD)' ? 3 : 1;
  md.push(`| ${t.metric} | ${fmt(t.meanA, d)} ± ${fmt(t.sdA, d)} | ${fmt(t.meanB, d)} ± ${fmt(t.sdB, d)} | ${fmt(t.meanDiff, d)} (${fmt(t.ci95[0], d)} … ${fmt(t.ci95[1], d)}) | ${t.pctChange.toFixed(1)}% | ${fmtP(t.p)} | ${fmtP(t.wilcoxonP)} |`);
}
md.push('', '| Scope | n | Median input tokens A / B | Input change (mean) | Wilcoxon p | Median tool calls A / B | Accuracy A | Accuracy B | McNemar p |', '|---|---|---|---|---|---|---|---|---|');
for (const [scope, qs] of scopes) {
  const t = tests.find((x) => x.scope === scope && x.metric === 'Input tokens (total)')!;
  const a = accuracy.find((x) => x.scope === scope)!;
  const m = medians.find((x) => x.scope === scope)!;
  md.push(`| ${scope} | ${qs.length} | ${fmt(m.inA, 0)} / ${fmt(m.inB, 0)} | ${t.pctChange.toFixed(1)}% | ${fmtP(t.wilcoxonP)} | ${m.callsA} / ${m.callsB} | ${(100 * a.accA).toFixed(0)}% | ${(100 * a.accB).toFixed(0)}% | ${fmtP(a.p)} |`);
}
md.push('', '| Question | Kind | Truth | A calls | A in | A ok | B calls | B in | B ok |', '|---|---|---|---|---|---|---|---|---|');
for (const q of questions) {
  const [a, b] = [of(A, [q])[0]!, of(B, [q])[0]!];
  md.push(`| ${q.id} | ${q.kind} | \`${q.truth.length > 40 ? `${q.truth.slice(0, 40)}…` : q.truth}\` | ${a.toolCalls} | ${fmt(a.totalIn, 0)} | ${a.correct ? '✓' : `✗ ${a.answer.slice(0, 30)}`} | ${b.toolCalls} | ${fmt(b.totalIn, 0)} | ${b.correct ? '✓' : `✗ ${b.answer.slice(0, 30)}`} |`);
}
md.push('', `Mean input tokens/question: A ${fmt(mean(of(A).map((c) => c.totalIn)), 0)} (sd ${fmt(sd(of(A).map((c) => c.totalIn)), 0)}), B ${fmt(mean(of(B).map((c) => c.totalIn)), 0)} (sd ${fmt(sd(of(B).map((c) => c.totalIn)), 0)}).`);
writeFileSync(join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
