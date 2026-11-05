#!/usr/bin/env node

import {
  CliExit,
  pyAbs,
  pyAdd,
  pyGet,
  pyLeft,
  pyMin,
  pySub,
  readJsonLines,
  requireFile,
  runCli,
  scriptLabel,
} from './python-compat.mjs';

export function* cacheStability(turnsA, turnsB) {
  const matched = Math.min(turnsA.length, turnsB.length);
  const header = `${pyLeft('TURN', 5)} ${pyLeft('CACHE_RD_A', 12)} ${pyLeft('CACHE_RD_B', 12)} ${pyLeft('SHARED_PFX', 12)} ${pyLeft('DRIFT', 10)}`;
  const rule = '-'.repeat(header.length);
  yield header;
  yield rule;
  let totalShared = 0;
  let totalDrift = 0;
  for (let index = 0; index < matched; index += 1) {
    const a = turnsA[index];
    const b = turnsB[index];
    const readA = pyGet(a, 'cache_read_tokens', 0);
    const readB = pyGet(b, 'cache_read_tokens', 0);
    const createdA = pyGet(a, 'cache_creation_tokens', 0);
    const createdB = pyGet(b, 'cache_creation_tokens', 0);
    const shared = pyMin(readA, readB);
    const drift = pyAbs(pySub(createdA, createdB));
    totalShared = pyAdd(totalShared, shared);
    totalDrift = pyAdd(totalDrift, drift);
    const turnIndex = pyGet(a, 'turn_index', index + 1);
    yield `${pyLeft(turnIndex, 5)} ${pyLeft(readA, 12)} ${pyLeft(readB, 12)} ${pyLeft(shared, 12)} ${pyLeft(drift, 10)}`;
  }
  yield rule;
  yield `${pyLeft('TOT', 5)} ${pyLeft('', 12)} ${pyLeft('', 12)} ${pyLeft(totalShared, 12)} ${pyLeft(totalDrift, 10)}`;
  if (matched < Math.max(turnsA.length, turnsB.length)) {
    const skipped = Math.abs(turnsA.length - turnsB.length);
    yield `Note: ${skipped} unmatched turn(s) skipped (session lengths differ)`;
  }
}

function* main(argv) {
  if (argv.length < 2) throw new CliExit(`Usage: ${scriptLabel()} <replay-A.jsonl> <replay-B.jsonl>`);
  const [fileA, fileB] = argv;
  requireFile(fileA);
  requireFile(fileB);
  const turnsA = readJsonLines(fileA);
  const turnsB = readJsonLines(fileB);
  if (Math.min(turnsA.length, turnsB.length) === 0) throw new CliExit('No matching turns found.');
  yield* cacheStability(turnsA, turnsB);
}

runCli(import.meta.url, main);
