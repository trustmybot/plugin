#!/usr/bin/env node

import {
  CliExit,
  pyAdd,
  pyFixed,
  pyGet,
  pyLess,
  pyNumber,
  pySub,
  pySum,
  pyTrueDivide,
  readJsonLines,
  requireFile,
  runCli,
  scriptLabel,
} from './python-compat.mjs';

export function turnTotals(rows) {
  return rows.map((row) => pyAdd(pyGet(row, 'input_tokens', 0), pyGet(row, 'output_tokens', 0)));
}

export function percentile(sorted, pct) {
  if (sorted.length === 1) return sorted[0];
  const index = (pct / 100) * (sorted.length - 1);
  const lo = Math.trunc(index);
  const hi = lo + 1;
  if (hi >= sorted.length) return sorted.at(-1);
  const fraction = index - lo;
  return pyNumber(sorted[lo]) + fraction * pyNumber(pySub(sorted[hi], sorted[lo]));
}

export function tokenStats(totals) {
  const sorted = [...totals].sort((a, b) => (pyLess(a, b) ? -1 : pyLess(b, a) ? 1 : 0));
  return {
    avg: pyTrueDivide(pySum(totals), totals.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    turns: totals.length,
  };
}

export function formatStats({ avg, p50, p95, turns }) {
  return `avg=${pyFixed(avg, 0)} p50=${pyFixed(p50, 0)} p95=${pyFixed(p95, 0)} (over ${turns} turns)`;
}

function* main(argv) {
  if (argv.length < 1) throw new CliExit(`Usage: ${scriptLabel()} <replay-output.jsonl>`);
  const [inputFile] = argv;
  requireFile(inputFile);
  const totals = turnTotals(readJsonLines(inputFile));
  if (totals.length === 0) throw new CliExit('No turn data found.');
  yield formatStats(tokenStats(totals));
}

runCli(import.meta.url, main);
