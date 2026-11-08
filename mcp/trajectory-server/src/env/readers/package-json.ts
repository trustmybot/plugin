// package.json reader: `scripts` as runner targets and `devDependencies` as dev dependencies, each with its line.
import { splitLines } from '../text.js';
import type { DevDependency, ReaderOutput, RunnerTarget } from '../types.js';

function stringMap(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
}

function keyLine(lines: string[], key: string, from: number): number {
  const needle = JSON.stringify(key);
  for (let i = from; i < lines.length; i++) {
    const at = lines[i]!.indexOf(needle);
    if (at >= 0 && /^\s*:/.test(lines[i]!.slice(at + needle.length))) return i;
  }
  return -1;
}

// Each entry of the top-level object `section`, with the 1-based line of its key.
function sectionEntries(lines: string[], parsed: Record<string, unknown>, section: string): Array<{ key: string; value: string; line: number }> {
  const entries = stringMap(parsed[section]);
  if (entries.length === 0) return [];
  const start = keyLine(lines, section, 0);
  let cursor = start < 0 ? 0 : start + 1;
  return entries.map(([key, value]) => {
    const at = keyLine(lines, key, cursor);
    if (at >= 0) cursor = at + 1;
    return { key, value, line: at >= 0 ? at + 1 : start + 1 };
  });
}

export function readPackageJson(file: string, text: string): ReaderOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const lines = splitLines(text);
  const obj = parsed as Record<string, unknown>;
  const runner_targets: RunnerTarget[] = sectionEntries(lines, obj, 'scripts').map((e) => ({
    file,
    line: e.line,
    name: e.key,
    command: e.value,
  }));
  const dev_dependencies: DevDependency[] = sectionEntries(lines, obj, 'devDependencies').map((e) => ({
    file,
    line: e.line,
    name: e.key,
    group: 'devDependencies',
  }));
  return { runner_targets, dev_dependencies };
}
