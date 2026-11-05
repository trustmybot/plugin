#!/usr/bin/env node

import {
  CliExit,
  isDict,
  pyDumps,
  pyGet,
  pyHashKey,
  pyIn,
  pyIter,
  pyJoin,
  pyLeft,
  pyLen,
  pyTruthy,
  readJsonLines,
  requireFile,
  runCli,
  scriptLabel,
} from './python-compat.mjs';

const SYSTEM_REMINDER = '<system-reminder>';

export function hookBytesByUuid(events) {
  const hookBytes = new Map();
  for (const event of events) {
    if (pyGet(event, 'type') !== 'user') continue;
    const uuid = pyGet(event, 'uuid', '');
    if (!pyTruthy(uuid)) continue;
    const content = pyGet(pyGet(event, 'message', {}), 'content', []);
    if (!Array.isArray(content)) continue;
    let total = 0;
    for (const item of content) {
      if (
        isDict(item) &&
        pyGet(item, 'type') === 'text' &&
        pyIn(SYSTEM_REMINDER, pyGet(item, 'text', ''))
      ) {
        total += pyLen(item.text);
      }
    }
    hookBytes.set(pyHashKey(uuid), total);
  }
  return hookBytes;
}

export function replayTurns(events) {
  const hookBytes = hookBytesByUuid(events);
  const turns = [];
  for (const event of events) {
    if (pyGet(event, 'type') !== 'assistant') continue;
    const message = pyGet(event, 'message', {});
    const usage = pyGet(message, 'usage');
    if (!pyTruthy(usage)) continue;
    const toolCalls = pyIter(pyGet(message, 'content', []))
      .filter((item) => isDict(item) && pyGet(item, 'type') === 'tool_use' && pyTruthy(pyGet(item, 'name')))
      .map((item) => item.name);
    const parentKey = pyHashKey(pyGet(event, 'parentUuid', ''));
    turns.push({
      turn_index: turns.length + 1,
      timestamp: pyGet(event, 'timestamp', ''),
      input_tokens: pyGet(usage, 'input_tokens', 0),
      output_tokens: pyGet(usage, 'output_tokens', 0),
      cache_read_tokens: pyGet(usage, 'cache_read_input_tokens', 0),
      cache_creation_tokens: pyGet(usage, 'cache_creation_input_tokens', 0),
      hook_injected_bytes: hookBytes.has(parentKey) ? hookBytes.get(parentKey) : 0,
      tool_calls: toolCalls,
    });
  }
  return turns;
}

export function* formatReplay(turns, mode = '--jsonl') {
  if (mode !== '--table') {
    for (const turn of turns) yield pyDumps(turn);
    return;
  }
  const header = `${pyLeft('TURN', 5)} ${pyLeft('IN_TOK', 8)} ${pyLeft('OUT_TOK', 8)} ${pyLeft('CACHE_RD', 10)} ${pyLeft('CACHE_CR', 10)} ${pyLeft('HOOK_B', 8)} TOOLS`;
  yield header;
  yield '-'.repeat(header.length);
  for (const turn of turns) {
    const tools = turn.tool_calls.length ? pyJoin('|', turn.tool_calls) : '-';
    yield `${pyLeft(turn.turn_index, 5)} ${pyLeft(turn.input_tokens, 8)} ${pyLeft(turn.output_tokens, 8)} ` +
      `${pyLeft(turn.cache_read_tokens, 10)} ${pyLeft(turn.cache_creation_tokens, 10)} ` +
      `${pyLeft(turn.hook_injected_bytes, 8)} ${tools}`;
  }
}

function* main(argv) {
  if (argv.length < 1) {
    throw new CliExit(`Usage: ${scriptLabel()} <session.jsonl> [--jsonl | --table]`);
  }
  const [sessionFile, mode] = argv;
  requireFile(sessionFile);
  const turns = replayTurns(readJsonLines(sessionFile));
  if (turns.length === 0) throw new CliExit('No assistant turns with usage data found.');
  yield* formatReplay(turns, mode || '--jsonl');
}

runCli(import.meta.url, main);
