// Atomic plugin-version bump. Updates the five files that must stay in sync,
// assembles changelog.d/ fragments into the release's CHANGELOG section, or
// fails leaving every file unchanged. Idempotent — re-running with the same
// version and no fragments is a no-op.
//
// Usage:
//   node --experimental-strip-types scripts/maintenance/bump-version.ts [--dry-run] [--date YYYY-MM-DD] <new-version>
//   node --experimental-strip-types scripts/maintenance/bump-version.ts --version-only <new-version>
//
//   --dry-run       print the CHANGELOG section the release would get; change nothing
//   --date          release date in the section header (default: today, UTC)
//   --version-only  update files 1-5 only; CHANGELOG.md and changelog.d/ are left
//                   alone, fragments are not validated (CI dev builds)
//
// Operates on the checkout holding this script, whatever the cwd.
//
// Touches:
//   1. .claude-plugin/plugin.json                         "version"
//   2. .codex-plugin/plugin.json                          "version"
//   3. package.json                                       "version"
//   4. mcp/trajectory-server/package.json                 "version"
//   5. bun.lock                                           workspace "version"
//   6. CHANGELOG.md   `## Unreleased` (if any) + changelog.d/*.md → `## v<new-version> — <date>`
//   7. changelog.d/*.md (except README.md)                deleted once assembled
//
// Section order is Added, Changed, Fixed, Removed, Security, then any other
// heading the Unreleased block carries. Within a section the Unreleased entries
// come first, then fragments sorted by GH issue number. Same inputs → the same
// bytes. A malformed fragment (changelog.d/README.md) refuses the whole bump.
//
// mcp/trajectory-server/src/index.ts derives the version from package.json
// at runtime (readFileSync → packageVersion) and is not touched.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fragmentBody, fragmentList, fragmentSection, fragmentValidate, lines, SECTIONS, trimBlank } from './lib/changelog-fragments.ts';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SPACE = '[ \\t\\n\\v\\f\\r]';
const UNRELEASED = new RegExp(`^## Unreleased${SPACE}*$`);
const VERSION_LINE = new RegExp(`"version"${SPACE}*:${SPACE}*"`);
const CURRENT_VERSION = new RegExp(`.*"version"${SPACE}*:${SPACE}*"([^"]+)".*`, 's');
const FILES = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json', 'mcp/trajectory-server/package.json', 'bun.lock'];
const USAGE = `Usage: ${process.argv[1] ?? 'bump-version.ts'} [--dry-run] [--date YYYY-MM-DD] [--version-only] <new-version>`;

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
}

function parseArgs(argv: string[]): Options {
  const o: Options = { dryRun: false, versionOnly: false, date: '', version: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--version-only') o.versionOnly = true;
    else if (a === '--date') {
      if (i + 1 >= argv.length) die('Error: --date needs a value');
      o.date = argv[++i] ?? '';
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
function assembleBlock(changelog: string[], fragments: string[], o: Options): string {
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
  return body === '' ? '' : `## v${o.version} — ${o.date}\n\n${body}`;
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
  const field = new RegExp(`"version"${SPACE}*:${SPACE}*"${current}"`, 's');
  const candidates = lines(text).filter((line) => field.test(line)).length;
  if (candidates !== 1) die(`Error: failed to bump ${src} — expected exactly one "version": "${current}" line, found ${candidates}`);
  const bumped = text
    .split('\n')
    .map((line) => line.replace(field, `"version": "${next}"`))
    .join('\n');
  if (!new RegExp(`"version": "${next}"`).test(bumped)) die(`Error: failed to bump ${src} — no version line matched`);
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
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

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
    block = assembleBlock(changelog, fragments, o);

    if (o.dryRun) {
      if (block !== '') process.stdout.write(block);
      else process.stderr.write('Nothing to assemble: no changelog.d/ fragments and no Unreleased entries.\n');
      return;
    }

    if (block !== '') {
      const existing = new RegExp(`^## v${o.version} `, 's');
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
    process.stdout.write(`Bumped ${current} → ${o.version} across 5 files.\n`);
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
