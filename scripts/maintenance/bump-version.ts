// Atomic plugin-version bump. Updates the four files that must stay in sync,
// assembles changelog.d/ fragments into the release's CHANGELOG section, or
// fails leaving every file unchanged. Idempotent — re-running with the same
// version and no fragments is a no-op.
//
// Usage:
//   node --experimental-strip-types scripts/maintenance/bump-version.ts [--dry-run] [--date YYYY-MM-DD] [--impact-db <path>] <new-version>
//   node --experimental-strip-types scripts/maintenance/bump-version.ts --version-only <new-version>
//
//   --dry-run       print the CHANGELOG section the release would get; change nothing
//   --date          release date in the section header (default: today, UTC)
//   --impact-db     trajectory DB to measure with: each fragment ending with a
//                   `Metric:` line maps to the PR whose squash commit added it
//                   (subject ending `(#N)`), mcp/trajectory-server/dist/change-impact/cli.js
//                   --source plugin_version --id <N> measures it, and a
//                   `### Measured impact` section closes the release section.
//                   A fragment with no such commit is skipped with a warning; an
//                   unknown change reads "not enough data"; a missing CLI or any
//                   other CLI failure changes nothing. Ignored with --version-only.
//   --version-only  update files 1-4 only; CHANGELOG.md and changelog.d/ are left
//                   alone, fragments are not validated (CI dev builds)
//
// Operates on the checkout holding this script, whatever the cwd.
//
// Touches:
//   1. .claude-plugin/plugin.json                         "version"
//   2. package.json                                       "version"
//   3. mcp/trajectory-server/package.json                 "version"
//   4. bun.lock                                           workspace "version"
//   5. CHANGELOG.md   `## Unreleased` (if any) + changelog.d/*.md → `## v<new-version> — <date>`
//   6. changelog.d/*.md (except README.md)                deleted once assembled
//
// Section order is Added, Changed, Fixed, Removed, Security, then any other
// heading the Unreleased block carries. Within a section the Unreleased entries
// come first, then fragments sorted by GH issue number. Same inputs → the same
// bytes. A malformed fragment (changelog.d/README.md) refuses the whole bump.
//
// mcp/trajectory-server/src/index.ts derives the version from package.json
// at runtime (readFileSync → packageVersion) and is not touched.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeRegExp, fragmentBody, fragmentList, fragmentMetric, fragmentSection, fragmentValidate, lines, SECTIONS, trimBlank } from './lib/changelog-fragments.ts';
import { measuredImpactBullets, type PrImpact } from './lib/measured-impact.ts';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SPACE = '[ \\t\\n\\v\\f\\r]';
const UNRELEASED = new RegExp(`^## Unreleased${SPACE}*$`);
const VERSION_LINE = new RegExp(`"version"${SPACE}*:${SPACE}*"`);
const CURRENT_VERSION = new RegExp(`.*"version"${SPACE}*:${SPACE}*"([^"]+)".*`, 's');
const FILES = ['.claude-plugin/plugin.json', 'package.json', 'mcp/trajectory-server/package.json', 'bun.lock'];
const USAGE = `Usage: ${process.argv[1] ?? 'bump-version.ts'} [--dry-run] [--date YYYY-MM-DD] [--impact-db <path>] [--version-only] <new-version>`;
const IMPACT_CLI = 'mcp/trajectory-server/dist/change-impact/cli.js';
const PR_SUBJECT = /\(#(\d+)\)\s*$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

class Exit extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(code: number, stderr: string) {
    super(stderr);
    this.code = code;
    this.stderr = stderr;
  }
}

const die = (message: string): never => {
  throw new Exit(1, message);
};

interface Options {
  dryRun: boolean;
  versionOnly: boolean;
  date: string;
  version: string;
  impactDb: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { dryRun: false, versionOnly: false, date: '', version: '', impactDb: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--version-only') o.versionOnly = true;
    else if (a === '--date') {
      if (i + 1 >= argv.length) die('Error: --date needs a value');
      o.date = argv[++i] ?? '';
    } else if (a === '--impact-db') {
      if (i + 1 >= argv.length || (argv[i + 1] ?? '') === '') die('Error: --impact-db needs a path');
      o.impactDb = resolve(argv[++i] ?? '');
    } else if (a.startsWith('-') || o.version !== '') die(USAGE);
    else o.version = a;
  }
  if (o.version === '') die(USAGE);
  if (o.versionOnly && (o.dryRun || o.date !== '')) die('Error: --version-only takes no --dry-run or --date');
  if (!SEMVER.test(o.version)) die(`Error: '${o.version}' is not valid SemVer (X.Y.Z or X.Y.Z-pre)`);
  if (o.date === '') o.date = new Date().toISOString().slice(0, 10);
  if (!DATE.test(o.date)) die(`Error: --date '${o.date}' is not YYYY-MM-DD`);
  return o;
}

/** The Unreleased block of CHANGELOG.md split into a preamble and the lines under each section heading, in heading order. */
function splitUnreleased(changelog: string[]): { preamble: string[]; order: string[]; sections: Map<string, string[]> } {
  const preamble: string[] = [];
  const order: string[] = [];
  const sections = new Map<string, string[]>();
  let inBlock = false;
  let out: string[] | null = null;
  for (const line of changelog) {
    if (line.startsWith('## ')) {
      inBlock = UNRELEASED.test(line);
      continue;
    }
    if (!inBlock) continue;
    if (line.startsWith('### ')) {
      const name = line.slice(4).replace(new RegExp(`${SPACE}+$`), '');
      if (!sections.has(name)) {
        sections.set(name, []);
        order.push(name);
      }
      out = sections.get(name) ?? null;
      continue;
    }
    (out ?? preamble).push(line);
  }
  return { preamble, order, sections };
}

/** The release section, or '' when there are neither fragments nor Unreleased entries. */
function assembleBlock(changelog: string[], fragments: string[], o: Options, impact: string[] = []): string {
  const { preamble, order, sections } = splitUnreleased(changelog);
  const fromFragments = new Map<string, string[]>();
  for (const f of fragments) {
    const s = fragmentSection(f);
    fromFragments.set(s, [...(fromFragments.get(s) ?? []), ...fragmentBody(f)]);
  }
  const sectionOrder = [...SECTIONS, ...order.filter((s) => !SECTIONS.includes(s))];
  let body = '';
  const intro = trimBlank(preamble);
  if (intro.length > 0) body += `${intro.join('\n')}\n\n`;
  for (const s of sectionOrder) {
    const entries = [...trimBlank(sections.get(s) ?? []), ...(fromFragments.get(s) ?? [])];
    if (entries.length === 0) continue;
    body += `### ${s}\n${entries.join('\n')}\n\n`;
  }
  if (body !== '' && impact.length > 0) body += `### Measured impact\n${impact.join('\n')}\n\n`;
  return body === '' ? '' : `## v${o.version} — ${o.date}\n\n${body}`;
}

/** The PR whose commit added <fragment>: the newest adding commit whose subject ends `(#N)`, else null. */
function fragmentPr(fragment: string): number | null {
  const r = spawnSync('git', ['log', '--diff-filter=A', '--format=%s', '--', fragment], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) die(`Error: git log failed for ${fragment}: ${r.error?.message ?? r.stderr.trim()}`);
  for (const subject of lines(r.stdout)) {
    const m = PR_SUBJECT.exec(subject);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseObject(text: string): Partial<PrImpact> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<PrImpact>) : null;
  } catch {
    return null;
  }
}

/** The `### Measured impact` bullets for the fragments that declare a metric; [] when none does. */
function measuredImpact(fragments: string[], db: string): string[] {
  const declaredByPr = new Map<number, { metric: string; direction: 'lower' | 'higher' }[]>();
  for (const f of fragments) {
    const declared = fragmentMetric(f);
    if (!declared) continue;
    const pr = fragmentPr(f);
    if (pr === null) {
      process.stderr.write(`Measured impact: skipping ${f} — no commit adding it has a subject ending (#N)\n`);
      continue;
    }
    declaredByPr.set(pr, [...(declaredByPr.get(pr) ?? []), declared]);
  }
  if (declaredByPr.size === 0) return [];
  if (!isFile(IMPACT_CLI)) die(`Error: --impact-db needs ${IMPACT_CLI}; build it (npm run build in mcp/trajectory-server); nothing was changed`);
  const impacts: PrImpact[] = [];
  for (const [pr, declared] of declaredByPr) {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', IMPACT_CLI, '--db', db, '--source', 'plugin_version', '--id', String(pr)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (r.error) die(`Error: change-impact CLI failed for #${pr}: ${r.error.message}; nothing was changed`);
    if (r.status !== 0) {
      if (r.stderr.includes('unknown change')) {
        impacts.push({ pr, declared: declared.map((d) => ({ ...d, outcome: 'not_enough_data' })), metrics: [] });
        continue;
      }
      die(`Error: change-impact CLI failed for #${pr} (exit ${r.status ?? r.signal}): ${r.stderr.trim()}; nothing was changed`);
    }
    const result = parseObject(r.stdout) ?? die(`Error: change-impact CLI printed no JSON object for #${pr}; nothing was changed`);
    impacts.push({ pr, declared: Array.isArray(result.declared) ? result.declared : [], metrics: Array.isArray(result.metrics) ? result.metrics : [] });
  }
  return measuredImpactBullets(impacts);
}

/** CHANGELOG.md with <block> in place of `## Unreleased`, else before the first release section, else at the end. */
function insertBlock(changelog: string[], block: string): string {
  let out = '';
  let done = false;
  let skip = false;
  const emit = (): void => {
    out += block;
    done = true;
  };
  for (const line of changelog) {
    if (!done && UNRELEASED.test(line)) {
      emit();
      skip = true;
      continue;
    }
    if (line.startsWith('## ')) {
      skip = false;
      if (!done) emit();
    }
    if (!skip) out += `${line}\n`;
  }
  if (!done) {
    out += '\n';
    emit();
  }
  return out;
}

/** <src> with its one `"version": "<current>"` line set to <next>. */
function bumpJson(src: string, current: string, next: string): string {
  const text = readFileSync(src, 'utf8');
  const field = new RegExp(`"version"${SPACE}*:${SPACE}*"${escapeRegExp(current)}"`, 's');
  const candidates = lines(text).filter((line) => field.test(line)).length;
  if (candidates !== 1) die(`Error: failed to bump ${src} — expected exactly one "version": "${current}" line, found ${candidates}`);
  const bumped = text
    .split('\n')
    .map((line) => line.replace(field, `"version": "${next}"`))
    .join('\n');
  if (!new RegExp(`"version": "${escapeRegExp(next)}"`).test(bumped)) die(`Error: failed to bump ${src} — no version line matched`);
  return bumped;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function main(argv: string[]): void {
  const o = parseArgs(argv);
  process.chdir(ROOT);

  let fragments: string[] = [];
  let block = '';
  let newChangelog = '';
  if (!o.versionOnly) {
    fragments = fragmentList('changelog.d');
    const problems = fragments.flatMap(fragmentValidate);
    if (problems.length > 0) {
      process.stderr.write(problems.map((p) => `${p}\n`).join(''));
      die('Error: malformed changelog.d/ fragment(s) above — fix them (changelog.d/README.md); nothing was changed');
    }
    if (!isFile('CHANGELOG.md')) die('Error: missing CHANGELOG.md');
    const changelog = lines(readFileSync('CHANGELOG.md', 'utf8'));
    block = assembleBlock(changelog, fragments, o, o.impactDb === '' ? [] : measuredImpact(fragments, o.impactDb));

    if (o.dryRun) {
      if (block !== '') process.stdout.write(block);
      else process.stderr.write('Nothing to assemble: no changelog.d/ fragments and no Unreleased entries.\n');
      return;
    }

    if (block !== '') {
      const existing = new RegExp(`^## v${escapeRegExp(o.version)} `, 's');
      if (changelog.some((line) => existing.test(line))) {
        die(`Error: CHANGELOG.md already has a '## v${o.version}' section; refusing to add a second one`);
      }
      newChangelog = insertBlock(changelog, block);
    }
  }

  for (const f of FILES) if (!isFile(f)) die(`Error: missing ${f}`);

  const versionLine = lines(readFileSync('.claude-plugin/plugin.json', 'utf8')).find((line) => VERSION_LINE.test(line));
  const current = versionLine === undefined ? '' : versionLine.replace(CURRENT_VERSION, '$1');
  if (current === '') die('Error: could not read current version from .claude-plugin/plugin.json');

  if (current === o.version && block === '') {
    process.stdout.write(`Already at ${o.version} — no changes needed.\n`);
    return;
  }

  if (current !== o.version) {
    const bumped = FILES.map((f) => [f, bumpJson(f, current, o.version)] as const);
    for (const [f, text] of bumped) writeFileSync(f, text);
    process.stdout.write(`Bumped ${current} → ${o.version} across ${FILES.length} files.\n`);
  }
  if (block !== '') {
    writeFileSync('CHANGELOG.md', newChangelog);
    for (const f of fragments) rmSync(f, { force: true });
    process.stdout.write(`Assembled ${fragments.length} changelog.d/ fragment(s) into '## v${o.version} — ${o.date}'.\n`);
  }
  process.stdout.write('Next: rebuild MCP server, run tests, commit.\n');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof Exit)) throw err;
  if (err.stderr !== '') process.stderr.write(`${err.stderr}\n`);
  process.exitCode = err.code;
}
