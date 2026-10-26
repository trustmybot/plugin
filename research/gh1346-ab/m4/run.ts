import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, runClaude } from '../lib/claude.ts';
import { RESULTS_DIR } from '../lib/paths.ts';
import { fmt, fmtP, mcnemar, mean, median, paired, sd } from '../lib/stats.ts';
import type { Return } from './extract.ts';

const MODEL = process.env['GH1346_READER_MODEL'] ?? 'opus';
const EFFORT = process.env['GH1346_READER_EFFORT'] ?? 'low';
const CONCURRENCY = Number(process.env['GH1346_CONCURRENCY'] ?? 6);
const OUT = join(RESULTS_DIR, 'm4');

/** The GH 1959 return contract: a typed head bro can act on, with the full report left in the DB. */
const CONDENSE = [
  'You rewrite a subagent\'s final report into the condensed return its orchestrator (bro) will receive instead.',
  'The full report stays stored in the trajectory DB (tasks.completion_report or validation_attempts.feedback) and bro can fetch it on demand.',
  'Hard limit: 150 tokens. Output only the condensed return, in this shape:',
  'line 1: `status=<completed|blocked|failed|pass|fail|other> task=<id or ?> sha=<first 8 chars or none>`',
  'then at most 4 short lines: blocking findings or blockers (count and one line each, worst first), and verbatim any question or decision the report needs from bro or the Human.',
  'Drop narration, evidence, file lists, passed checks and anything bro does not need to choose its next move.',
].join(' ');

const READER = 'You read a subagent report handed back to an orchestrator and extract the decision facts. Use only what the report says; if it does not say, use null, "other" or false.';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'outcome', 'commit_sha8', 'blocking_count', 'needs_bro_action', 'needs_human_decision'],
  properties: {
    task_id: { type: ['integer', 'null'], description: 'Local task id the report is about.' },
    outcome: { type: 'string', enum: ['completed', 'blocked', 'failed', 'pass', 'fail', 'other'], description: 'swe: completed/blocked/failed; code-reviewer: the verdict pass/fail.' },
    commit_sha8: { type: ['string', 'null'], description: 'First 8 hex chars of the commit the report is about.' },
    blocking_count: { type: 'integer', description: 'Number of blocking findings or blockers (0 if none).' },
    needs_bro_action: { type: 'boolean', description: 'True if bro must do something other than proceed normally: unblock, rework, escalate, decide, or answer a question.' },
    needs_human_decision: { type: 'boolean', description: 'True if the report asks for a decision or answer only the Human can give.' },
  },
} as const;

type Facts = { task_id: number | null; outcome: string; commit_sha8: string | null; blocking_count: number; needs_bro_action: boolean; needs_human_decision: boolean };
const FIELDS = SCHEMA.required;

function readerPrompt(text: string, replicate = 1): string {
  return `${replicate > 1 ? `(independent read #${replicate})\n` : ''}<report>\n${text}\n</report>`;
}

async function read(text: string, replicate = 1): Promise<{ facts: Facts | null; totalIn: number }> {
  const r = await runClaude({ prompt: readerPrompt(text, replicate), system: READER, model: MODEL, effort: EFFORT, jsonSchema: SCHEMA, tag: 'm4-read' });
  return { facts: (r.structured as Facts | undefined) ?? null, totalIn: r.totalIn };
}

function same(field: string, a: Facts | null, b: Facts | null): boolean {
  if (!a || !b) return false;
  const x = (a as Record<string, unknown>)[field];
  const y = (b as Record<string, unknown>)[field];
  if (field === 'commit_sha8') return String(x ?? '').slice(0, 7).toLowerCase() === String(y ?? '').slice(0, 7).toLowerCase();
  return x === y;
}

const all = JSON.parse(readFileSync(join(OUT, 'returns.json'), 'utf8')) as Return[];
const seenText = new Set<string>();
const returns = all.filter((r) => !seenText.has(r.text) && seenText.add(r.text)).slice(0, Number(process.env['GH1346_LIMIT'] ?? Infinity));
console.error(`m4: ${returns.length} distinct returns (${all.length} extracted), reader ${MODEL}/${EFFORT}`);

const baseline = (await read('')).totalIn;
const condensed = await pool(returns, CONCURRENCY, async (r) => {
  const c = await runClaude({ prompt: `<report agent="${r.agent}">\n${r.text}\n</report>`, system: CONDENSE, model: MODEL, effort: EFFORT, tag: 'm4-condense' });
  return c.text.trim();
});
const reads = await pool(returns, CONCURRENCY, async (r, i) => {
  const [full, full2, cond] = await Promise.all([read(r.text), read(r.text, 2), read(condensed[i]!)]);
  console.error(`  ${r.agent.padEnd(13)} ${r.id.slice(0, 12)} full=${full.totalIn - baseline} cond=${cond.totalIn - baseline}`);
  return { full, full2, cond };
});

const rows = returns.map((r, i) => {
  const { full, full2, cond } = reads[i]!;
  return {
    id: r.id, session: r.session, agent: r.agent, rereads: r.rereads,
    sessionCacheRead: r.sessionCacheReadPerCall * r.sessionCalls,
    fullTokens: full.totalIn - baseline, condTokens: cond.totalIn - baseline,
    condensed: condensed[i]!, ref: full.facts, rep: full2.facts, cond: cond.facts,
  };
});
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'cells.json'), JSON.stringify(rows, null, 2));

const md: string[] = [];
md.push(`### M4 — condensed vs full subagent returns (${rows.length} real swe / code-reviewer returns from bro transcripts; condenser and reader ${MODEL} effort ${EFFORT})`, '');
md.push('| Agent | n | Full tokens mean ± sd (median) | Condensed tokens mean ± sd (median) | Change | paired t p | Wilcoxon p | Condensed ≤150 tok |', '|---|---|---|---|---|---|---|---|');
for (const agent of ['all', 'swe', 'code-reviewer']) {
  const xs = rows.filter((r) => agent === 'all' || r.agent === agent);
  const t = paired(xs.map((r) => r.fullTokens), xs.map((r) => r.condTokens));
  md.push(`| ${agent} | ${xs.length} | ${fmt(t.meanA, 0)} ± ${fmt(t.sdA, 0)} (${fmt(median(xs.map((r) => r.fullTokens)), 0)}) | ${fmt(t.meanB, 0)} ± ${fmt(t.sdB, 0)} (${fmt(median(xs.map((r) => r.condTokens)), 0)}) | ${t.pctChange.toFixed(1)}% | ${fmtP(t.p)} | ${fmtP(t.wilcoxonP)} | ${xs.filter((r) => r.condTokens <= 150).length}/${xs.length} |`);
}

md.push('', 'Decision-fact agreement with a reader on the full text (reference). The noise floor is a second independent read of the full text; McNemar compares condensed against that floor on the same items.', '');
md.push('| Field | Full re-read agrees | Condensed agrees | McNemar p |', '|---|---|---|---|');
const valid = rows.filter((r) => r.ref && r.rep && r.cond);
for (const f of FIELDS) {
  const m = mcnemar(valid.map((r) => same(f, r.ref, r.rep)), valid.map((r) => same(f, r.ref, r.cond)));
  md.push(`| ${f} | ${(100 * m.accA).toFixed(1)}% | ${(100 * m.accB).toFixed(1)}% | ${fmtP(m.p)} |`);
}
const allA = valid.map((r) => FIELDS.every((f) => same(f, r.ref, r.rep)));
const allB = valid.map((r) => FIELDS.every((f) => same(f, r.ref, r.cond)));
const mAll = mcnemar(allA, allB);
md.push(`| all six | ${(100 * mAll.accA).toFixed(1)}% | ${(100 * mAll.accB).toFixed(1)}% | ${fmtP(mAll.p)} |`);

const esc = valid.filter((r) => r.ref!.needs_bro_action);
const missed = esc.filter((r) => !r.cond!.needs_bro_action);
const missedRep = esc.filter((r) => !r.rep!.needs_bro_action);
const hum = valid.filter((r) => r.ref!.needs_human_decision);
const humMissed = hum.filter((r) => !r.cond!.needs_human_decision);
const fails = valid.filter((r) => ['fail', 'blocked', 'failed'].includes(r.ref!.outcome));
const failsLost = fails.filter((r) => !['fail', 'blocked', 'failed'].includes(r.cond!.outcome));
md.push('', `Missed escalations: reference says bro must act on ${esc.length}; condensed drops ${missed.length} (full re-read drops ${missedRep.length}). Human decisions: ${hum.length}, condensed drops ${humMissed.length}. Fail/blocked outcomes: ${fails.length}, condensed turns ${failsLost.length} into a non-failure.`);

const saved = rows.map((r) => (r.fullTokens - r.condTokens) * r.rereads);
const bySession = new Map<string, { saved: number; cache: number }>();
rows.forEach((r, i) => {
  const s = bySession.get(r.session) ?? { saved: 0, cache: r.sessionCacheRead };
  s.saved += saved[i]!;
  bySession.set(r.session, s);
});
const shares = [...bySession.values()].map((s) => (s.cache ? s.saved / s.cache : 0));
md.push('', `Bro context simulation: each return is re-read on every later bro API call until the next compaction (mean ${fmt(mean(rows.map((r) => r.rereads)), 1)}, median ${fmt(median(rows.map((r) => r.rereads)), 0)} re-reads). Cache-read tokens saved per return: mean ${fmt(mean(saved), 0)} (sd ${fmt(sd(saved), 0)}, median ${fmt(median(saved), 0)}). Across ${bySession.size} sessions that is ${fmt(saved.reduce((a, b) => a + b, 0) / 1e6, 2)}M of ${fmt([...bySession.values()].reduce((a, s) => a + s.cache, 0) / 1e6, 1)}M bro cache-read tokens: ${(100 * mean(shares)).toFixed(2)}% per session on average (median ${(100 * median(shares)).toFixed(2)}%, max ${(100 * Math.max(...shares)).toFixed(2)}%).`);

writeFileSync(join(OUT, 'summary.md'), md.join('\n') + '\n');
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ n: rows.length, baseline, missed: missed.map((r) => r.id), humMissed: humMissed.map((r) => r.id), failsLost: failsLost.map((r) => r.id), sessions: [...bySession] }, null, 2));
console.log(md.join('\n'));
