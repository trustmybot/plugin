#!/usr/bin/env node

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVISION_TOOL = 'task_provision';
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const READING_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'sed',
  'awk',
  'grep',
  'rg',
  'find',
  'ls',
  'wc',
]);
const READING_GIT_SUBCOMMANDS = new Set(['show', 'diff', 'log', 'grep']);
const WM_TOOLS = new Set(['task_brief', 'scope_suggest']);
const CHARS_PER_TOKEN = 4;

export function parseArguments(argv) {
  let json = false;
  const inputs = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--')) throw new Error(usage());
    else inputs.push(arg);
  }
  if (inputs.length === 0) throw new Error(usage());
  return { json, inputs };
}

export function toolSuffix(name) {
  return String(name ?? '').split('__').pop();
}

export function isWorldModelTool(name) {
  const suffix = toolSuffix(name);
  return suffix.startsWith('world_model_') || WM_TOOLS.has(suffix);
}

export function commandSegments(command) {
  return String(command ?? '')
    .split(/\|\||&&|[|;\n]/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .map((words) => {
      let start = 0;
      while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start += 1;
      return words.slice(start);
    })
    .filter((words) => words.length > 0);
}

function readingSegmentArgs(words) {
  const [head, ...rest] = words;
  if (READING_COMMANDS.has(head)) return rest;
  if (head !== 'git') return null;
  let index = 0;
  while (index < rest.length && rest[index].startsWith('-')) {
    index += rest[index] === '-C' || rest[index] === '-c' ? 2 : 1;
  }
  return READING_GIT_SUBCOMMANDS.has(rest[index]) ? rest.slice(index + 1) : null;
}

function isPathLike(word) {
  if (word.startsWith('-')) return false;
  const bare = word.replace(/^['"]|['"]$/g, '');
  return bare.includes('/') || /\.[A-Za-z0-9]+$/.test(bare);
}

function namesSourceFile(word) {
  return isPathLike(word) && !/\.md['"]?$/i.test(word);
}

export function classifyBash(command) {
  let read = false;
  let source = false;
  for (const words of commandSegments(command)) {
    const args = readingSegmentArgs(words);
    if (args === null) continue;
    read = true;
    if (args.some(namesSourceFile)) source = true;
  }
  return { read, source };
}

export function classifyToolUse(name, input = {}) {
  const suffix = toolSuffix(name);
  if (FILE_TOOLS.has(suffix)) {
    const source =
      suffix === 'Read' ? !/\.md$/i.test(String(input.file_path ?? '')) : true;
    return { read: true, source };
  }
  if (suffix === 'Bash') return classifyBash(input.command);
  return { read: false, source: false };
}

export function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : ''))
    .join('');
}

function provisionIds(text) {
  if (text === undefined) return { task_id: null, branch_id: null };
  try {
    const parsed = JSON.parse(text);
    return {
      task_id: parsed?.task_id ?? null,
      branch_id: parsed?.branch_id ?? null,
    };
  } catch {
    return { task_id: null, branch_id: null };
  }
}

function contentItems(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

function parseLines(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries.filter((entry) => entry && entry.isSidechain !== true);
}

function emptyWindow() {
  return { reads: 0, source_reads: 0, read_result_chars: 0, wm_calls: 0, readIds: [] };
}

export function analyzeSession(text, session) {
  const entries = parseLines(text);
  const results = new Map();
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    for (const item of contentItems(entry)) {
      if (item?.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        results.set(item.tool_use_id, resultText(item.content));
      }
    }
  }

  const provisions = [];
  let window = emptyWindow();
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    for (const item of contentItems(entry)) {
      if (item?.type !== 'tool_use') continue;
      const suffix = toolSuffix(item.name);
      if (suffix === PROVISION_TOOL) {
        const chars = window.readIds.reduce(
          (sum, id) => sum + (results.get(id)?.length ?? 0),
          0,
        );
        provisions.push({
          session,
          timestamp: entry.timestamp ?? null,
          ...provisionIds(results.get(item.id)),
          reads: window.reads,
          source_reads: window.source_reads,
          read_result_chars: chars,
          est_read_tokens: Math.ceil(chars / CHARS_PER_TOKEN),
          wm_calls: window.wm_calls,
        });
        window = emptyWindow();
        continue;
      }
      if (isWorldModelTool(item.name)) window.wm_calls += 1;
      const { read, source } = classifyToolUse(item.name, item.input ?? {});
      if (!read) continue;
      window.reads += 1;
      if (source) window.source_reads += 1;
      window.readIds.push(item.id);
    }
  }
  return provisions;
}

export function summarize(provisions) {
  const sum = (key) => provisions.reduce((total, row) => total + row[key], 0);
  const sourceReads = sum('source_reads');
  return {
    provisions: provisions.length,
    reads: sum('reads'),
    source_reads: sourceReads,
    est_read_tokens: sum('est_read_tokens'),
    mean_source_reads_per_provision:
      provisions.length === 0 ? null : sourceReads / provisions.length,
  };
}

export function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    if (statSync(input).isDirectory()) {
      for (const name of readdirSync(input).sort()) {
        const path = join(input, name);
        if (name.endsWith('.jsonl') && statSync(path).isFile()) files.push(path);
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

export function analyzeInputs(inputs) {
  const provisions = expandInputs(inputs).flatMap((path) =>
    analyzeSession(readFileSync(path, 'utf8'), basename(path, '.jsonl')),
  );
  return { provisions, totals: summarize(provisions) };
}

export function formatTable(report) {
  const header = ['SESSION', 'TIMESTAMP', 'TASK', 'BRANCH', 'READS', 'SRC', 'CHARS', 'EST_TOK', 'WM'];
  const rows = report.provisions.map((row) => [
    row.session,
    row.timestamp ?? '-',
    row.task_id ?? '-',
    row.branch_id ?? '-',
    row.reads,
    row.source_reads,
    row.read_result_chars,
    row.est_read_tokens,
    row.wm_calls,
  ].map(String));
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
  const { totals } = report;
  const mean =
    totals.mean_source_reads_per_provision === null
      ? 'N/A'
      : totals.mean_source_reads_per_provision.toFixed(2);
  return [
    line(header),
    ...rows.map(line),
    '',
    `provisions=${totals.provisions} reads=${totals.reads} source_reads=${totals.source_reads} ` +
      `est_read_tokens=${totals.est_read_tokens} mean_source_reads_per_provision=${mean}`,
  ].join('\n');
}

function main() {
  const { json, inputs } = parseArguments(process.argv.slice(2));
  const report = analyzeInputs(inputs);
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatTable(report)}\n`);
}

function usage() {
  return [
    'Usage:',
    'node tests/benchmarks/bro-provision-reads.mjs [--json] <session.jsonl|dir> [...]',
  ].join('\n');
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : '';
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
