// Shared rules for changelog.d/ fragments, imported by bump-version.ts (assembly)
// and run by tests/l1-lint/changelog-current.test.mjs (validation). Format: changelog.d/README.md.
//
//   node --experimental-strip-types scripts/maintenance/lib/changelog-fragments.ts list <dir>
//   node --experimental-strip-types scripts/maintenance/lib/changelog-fragments.ts validate <fragment>...
//
// `list` prints every fragment of <dir>, one per line, sorted by GH issue number
// then name. `validate` prints one line per problem and exits 1 when any
// fragment is malformed.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTIONS: readonly string[] = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'];

const FILENAME = /^[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*\.md$/;
const LEADING_NUMBER = /^[ \t\n\v\f\r]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const BLANK = /^[ \t\n\v\f\r]*$/;
const HAS_FIELD = /[^ \t\n]/;
const HASH_ID = /(^|[^&A-Za-z0-9])#[0-9]+/;

/** The change-impact METRICS registry ids (mcp/trajectory-server/src/change-impact/metrics.ts); a test keeps the two equal. */
export const METRIC_IDS: readonly string[] = [
  'swe_rework_ratio',
  'tokens_per_task',
  'reworks_per_task',
  'review_fail_rate',
  'verification_pass_rate',
  'hook_block_tokens_per_run',
  'bro_tokens_per_session',
];
export const METRIC_LINE = /^Metric: ([a-z][a-z0-9_]{0,47}) (lower|higher)$/;
const METRIC_LIKE = /^[ \t]*metric[ \t]*:/i;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file's lines as awk and sed read them: a final newline ends the last line rather than opening an empty one. */
export function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** awk's `n + 0` on a fragment's issue prefix, as printf %012d prints it. */
function sortKey(name: string): string {
  const prefix = name.replace(/-.*/s, '');
  const match = LEADING_NUMBER.exec(prefix);
  const n = match ? Math.trunc(Number(match[0].trim())) : 0;
  const digits = String(Math.abs(n));
  return n < 0 ? `-${digits.padStart(11, '0')}` : digits.padStart(12, '0');
}

/** Every fragment file under <dir>, sorted by GH issue number then name. */
export function fragmentList(dir: string): string[] {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.md') && !name.startsWith('.') && name !== 'README.md')
    .map((name) => `${dir}/${name}`)
    .filter(isFile)
    .map((path) => Buffer.from(`${sortKey(basename(path))}\t${path}`))
    .sort(Buffer.compare)
    .map((key) => key.toString().replace(/^[^\t]*\t/, ''));
}

export function fragmentIssue(path: string): string {
  return basename(path).replace(/-.*/s, '');
}

function firstLine(path: string): string {
  return lines(readFileSync(path, 'utf8'))[0] ?? '';
}

export function fragmentSection(path: string): string {
  return firstLine(path).replace(/^### /, '');
}

/** Leading lines with no field and trailing blank lines dropped, as the .sh's awk did. */
export function trimBlank(input: string[]): string[] {
  const start = input.findIndex((line) => HAS_FIELD.test(line));
  if (start < 0) return [];
  let end = input.length;
  while (end > start && BLANK.test(input[end - 1] ?? '')) end--;
  return input.slice(start, end);
}

/** Body: every line after the section line, leading and trailing blank lines dropped, without a final `Metric:` line. */
export function fragmentBody(path: string): string[] {
  const body = trimBlank(lines(readFileSync(path, 'utf8')).slice(1));
  return METRIC_LINE.test(body.at(-1) ?? '') ? trimBlank(body.slice(0, -1)) : body;
}

/** The fragment's final `Metric:` line as {metric, direction}, or null when it declares none. */
export function fragmentMetric(path: string): { metric: string; direction: 'lower' | 'higher' } | null {
  const m = METRIC_LINE.exec(trimBlank(lines(readFileSync(path, 'utf8')).slice(1)).at(-1) ?? '');
  return m ? { metric: m[1] ?? '', direction: m[2] as 'lower' | 'higher' } : null;
}

function metricProblems(path: string, raw: string[]): string[] {
  let last = raw.length - 1;
  while (last > 0 && BLANK.test(raw[last] ?? '')) last--;
  const metricAt = raw.flatMap((line, i) => (i > 0 && METRIC_LIKE.test(line) ? [i] : []));
  return metricAt.flatMap((i) => {
    const where = `${path}:${i + 1}`;
    if (i !== last) {
      return [
        metricAt.length > 1
          ? `${where}: a second Metric: line; a fragment declares at most one, as its last line`
          : `${where}: the Metric: line must be the last line of the entry`,
      ];
    }
    const m = METRIC_LINE.exec(raw[i] ?? '');
    if (!m) return [`${where}: the Metric: line must be exactly "Metric: <metric id> lower|higher" (got "${raw[i]}")`];
    if (!METRIC_IDS.includes(m[1] ?? '')) return [`${where}: unknown metric "${m[1]}"; one of ${METRIC_IDS.join(', ')}`];
    return [];
  });
}

/** One line per problem; empty when the fragment is well formed. */
export function fragmentValidate(path: string): string[] {
  const name = basename(path);
  if (!FILENAME.test(name)) return [`${path}: filename must be <gh-issue>-<slug>.md (lowercase slug, hyphens)`];
  const problems: string[] = [];
  const issue = fragmentIssue(path);
  const first = firstLine(path);
  if (!SECTIONS.some((s) => first === `### ${s}`)) {
    problems.push(`${path}: first line must be one of: ${SECTIONS.map((s) => `### ${s}`).join(', ')} (got "${first}")`);
  }
  const raw = lines(readFileSync(path, 'utf8'));
  raw.forEach((line, i) => {
    if (i > 0 && line.startsWith('### ')) {
      problems.push(`${path}:${i + 1}: a second section line "${line}"; one section per fragment, so split it into two fragments (changelog.d/README.md)`);
    }
  });
  problems.push(...metricProblems(path, raw));
  const body = fragmentBody(path);
  if (body.length === 0) return [...problems, `${path}: no entry text after the section line`];
  if (!(body[0] ?? '').startsWith('- ')) problems.push(`${path}: the entry must start with "- " (one bullet)`);
  const cite = new RegExp(`GH ${escapeRegExp(issue)}([^0-9]|$)`);
  if (!body.some((line) => cite.test(line))) problems.push(`${path}: the entry must cite GH ${issue}`);
  if (body.some((line) => HASH_ID.test(line))) problems.push(`${path}: cite issues as "GH <n>", not "#<n>"`);
  return problems;
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  if (command === 'list' && args.length === 1) {
    for (const path of fragmentList(args[0] ?? '')) process.stdout.write(`${path}\n`);
    return 0;
  }
  if (command === 'validate') {
    let malformed = false;
    for (const path of args) {
      const problems = fragmentValidate(path);
      for (const p of problems) process.stdout.write(`${p}\n`);
      if (problems.length > 0) malformed = true;
    }
    return malformed ? 1 : 0;
  }
  process.stderr.write('Usage: changelog-fragments.ts list <dir> | validate <fragment>...\n');
  return 2;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
