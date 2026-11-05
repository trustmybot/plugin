#!/usr/bin/env node

import {
  CliExit,
  isDict,
  pyFixed,
  pyGet,
  pyIter,
  pyTrueDivide,
  readJsonLines,
  requireFile,
  runCli,
  scriptLabel,
} from './python-compat.mjs';

export function countSpawnReads(events) {
  let spawns = 0;
  let reads = 0;
  for (const event of events) {
    if (pyGet(event, 'type') !== 'assistant') continue;
    for (const item of pyIter(pyGet(pyGet(event, 'message', {}), 'content', []))) {
      if (!isDict(item) || pyGet(item, 'type') !== 'tool_use') continue;
      const name = pyGet(item, 'name', '');
      if (name === 'TaskCreate') spawns += 1;
      else if (name === 'Read') reads += 1;
    }
  }
  return { spawns, reads };
}

export function formatSpawnReads({ spawns, reads }) {
  const mean = spawns === 0 ? 'N/A' : pyFixed(pyTrueDivide(reads, spawns), 2);
  return `spawns=${spawns} reads=${reads} mean_reads_per_spawn=${mean}`;
}

function* main(argv) {
  if (argv.length < 1) throw new CliExit(`Usage: ${scriptLabel()} <session.jsonl>`);
  const [sessionFile] = argv;
  requireFile(sessionFile);
  yield formatSpawnReads(countSpawnReads(readJsonLines(sessionFile)));
}

runCli(import.meta.url, main);
