/**
 * The leak scan of a commit against its merge base with the PR target (GH 2929), which
 * swe-verification-gate runs beside the doc checks before a swe completion. Only the lines
 * the diff adds are scanned; deletions and binary files never are.
 *
 *   leak_scan         an added line holds a secret (secretlint's recommended preset), an
 *                     email address (`email`) or a user's home directory (`home_path`)
 *                     that no allow entry admits; actual names each hit as
 *                     `<file>:<line> <rule>`, never the matched text
 *   leak_scan_config  LEAK_SCAN_FILE as committed at the checked commit is invalid
 *
 * The built-in allowlist always applies; the project file adds allow entries and turns
 * rules off, each with a reason. Inline `secretlint-disable` comments are not honored, so
 * the reasoned file is the only way past a hit. A git or scanner failure denies.
 */
import { extname } from 'node:path';
import { type DocCheckFailure, fileAtCommit, gitText } from './doc-checks.js';

export const LEAK_SCAN_FILE = '.config/tmb/leak-scan.json';
export const LEAK_SCAN_SHAPE =
  '{"version":1,"allow":[{"rule":"<rule, optional>","pattern":"<regex>","reason":"<why>"},...],"disable_rules":[{"rule":"<rule>","reason":"<why>"},...]}';
const CONFIG_KEYS = new Set(['version', 'allow', 'disable_rules']);
const ALLOW_KEYS = new Set(['rule', 'pattern', 'reason']);
const DISABLE_KEYS = new Set(['rule', 'reason']);

const EMAIL_RULE = 'email';
const HOME_PATH_RULE = 'home_path';
const SECRETLINT_FILTER_COMMENTS = '@secretlint/secretlint-rule-filter-comments';

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;
// A name holding $, %, {, } or * is a variable or glob ($USER, %USERNAME%, *), not a user.
const UNIX_HOME = /(?<![\w.-])\/(?:Users|home)\/[^\s/\\"'`$%{}*]+\//g;
const WINDOWS_HOME = /(?<![\w])[A-Za-z]:\\{1,2}Users\\{1,2}[^\s/\\"'`$%{}*]+\\{1,2}/g;

interface AllowEntry {
  rule: string | null;
  pattern: RegExp;
}

const DEFAULT_ALLOW: readonly AllowEntry[] = [
  { rule: EMAIL_RULE, pattern: /^noreply@/i },
  { rule: EMAIL_RULE, pattern: /@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)$/i },
  { rule: HOME_PATH_RULE, pattern: /^(?:\/(?:Users|home)\/|[A-Za-z]:\\{1,2}Users\\{1,2})(?:<[^<>]+>|user|me|you|runner)(?:\/|\\{1,2})$/i },
];

export interface LeakScanConfig {
  allow: AllowEntry[];
  disabled: Set<string>;
}

interface AddedLines {
  lines: string[];
  lineNumbers: number[];
}

interface Hit {
  file: string;
  line: number;
  rule: string;
}

type LintSource = typeof import('@secretlint/core').lintSource;
type SecretRule = (typeof import('@secretlint/secretlint-rule-preset-recommend').rules)[number];

interface Scanner {
  lintSource: LintSource;
  rules: SecretRule[];
}

async function loadScanner(): Promise<Scanner> {
  const [core, preset] = await Promise.all([import('@secretlint/core'), import('@secretlint/secretlint-rule-preset-recommend')]);
  return { lintSource: core.lintSource, rules: preset.rules.filter((r) => r.meta.id !== SECRETLINT_FILTER_COMMENTS) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasReason(entry: Record<string, unknown>): boolean {
  return typeof entry.reason === 'string' && entry.reason.trim() !== '';
}

/** The allow entries and disabled rules <text> configures over <ruleNames>, or why it is invalid. */
export function parseLeakScanConfig(text: string, ruleNames: ReadonlySet<string>): LeakScanConfig | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isObject(parsed)) return { error: 'not a JSON object' };
  const unknownKeys = Object.keys(parsed).filter((k) => !CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) return { error: `unknown key(s) ${unknownKeys.join(', ')}` };
  if (parsed.version !== 1) return { error: `version must be 1, got ${JSON.stringify(parsed.version) ?? 'none'}` };
  const unknownRule = (rule: unknown) => `unknown rule ${JSON.stringify(rule)}; rules are ${[...ruleNames].join(', ')}`;

  const allow: AllowEntry[] = [];
  if (parsed.allow !== undefined) {
    if (!Array.isArray(parsed.allow)) return { error: 'allow must be an array' };
    for (const [i, entry] of parsed.allow.entries()) {
      const at = `allow[${i}]`;
      if (!isObject(entry)) return { error: `${at} must be an object` };
      const extra = Object.keys(entry).filter((k) => !ALLOW_KEYS.has(k));
      if (extra.length > 0) return { error: `${at} has unknown key(s) ${extra.join(', ')}` };
      if (!hasReason(entry)) return { error: `${at} needs a non-empty reason` };
      if (entry.rule !== undefined && (typeof entry.rule !== 'string' || !ruleNames.has(entry.rule))) return { error: `${at}: ${unknownRule(entry.rule)}` };
      if (typeof entry.pattern !== 'string' || entry.pattern === '') return { error: `${at}.pattern must be a non-empty regex string` };
      let pattern: RegExp;
      try {
        pattern = new RegExp(entry.pattern);
      } catch (e) {
        return { error: `${at}.pattern is not a valid regex: ${(e as Error).message}` };
      }
      allow.push({ rule: entry.rule ?? null, pattern });
    }
  }

  const disabled = new Set<string>();
  if (parsed.disable_rules !== undefined) {
    if (!Array.isArray(parsed.disable_rules)) return { error: 'disable_rules must be an array' };
    for (const [i, entry] of parsed.disable_rules.entries()) {
      const at = `disable_rules[${i}]`;
      if (!isObject(entry)) return { error: `${at} must be an object` };
      const extra = Object.keys(entry).filter((k) => !DISABLE_KEYS.has(k));
      if (extra.length > 0) return { error: `${at} has unknown key(s) ${extra.join(', ')}` };
      if (!hasReason(entry)) return { error: `${at} needs a non-empty reason` };
      if (typeof entry.rule !== 'string' || !ruleNames.has(entry.rule)) return { error: `${at}: ${unknownRule(entry.rule)}` };
      disabled.add(entry.rule);
    }
  }
  return { allow, disabled };
}

const GIT_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git prints it in a diff header, C-quoted when it holds a control character, quote or backslash. */
function unquoteGitPath(printed: string): string {
  if (!printed.startsWith('"') || !printed.endsWith('"')) return printed;
  const chars = [...printed.slice(1, -1)];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] !== '\\') {
      bytes.push(...Buffer.from(chars[i], 'utf8'));
    } else if (/[0-7]/.test(chars[i + 1] ?? '')) {
      bytes.push(parseInt(chars.slice(i + 1, i + 4).join(''), 8));
      i += 3;
    } else {
      bytes.push(GIT_ESCAPES[chars[i + 1]] ?? chars[i + 1].charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The new-side path of a `+++ ` header line, or null for a deleted file. git ends the line with
 * a tab when the path holds a space; a path that itself ends in a tab is always quoted.
 */
function newSidePath(header: string): string | null {
  const printed = header.slice(4).replace(/\t$/, '');
  if (printed === '/dev/null') return null;
  const path = unquoteGitPath(printed);
  return path.startsWith('b/') ? path.slice(2) : path;
}

/** Each file's added lines with their line numbers, from a `-U0` patch. */
export function addedLines(patch: string): Map<string, AddedLines> {
  const files = new Map<string, AddedLines>();
  let file: AddedLines | null = null;
  let inHeader = false;
  let next = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHeader = true;
    } else if (inHeader && line.startsWith('+++ ')) {
      const path = newSidePath(line);
      file = path === null ? null : { lines: [], lineNumbers: [] };
      if (path !== null && file !== null) files.set(path, file);
    } else if (line.startsWith('@@ ')) {
      inHeader = false;
      next = Number(/^@@ -\S+ \+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (!inHeader && file !== null && line.startsWith('+')) {
      file.lines.push(line.slice(1));
      file.lineNumbers.push(next);
      next += 1;
    } else if (!inHeader && line.startsWith(' ')) {
      next += 1;
    }
  }
  for (const [path, added] of files) if (added.lines.length === 0) files.delete(path);
  return files;
}

function admitted(allow: readonly AllowEntry[], rule: string, text: string): boolean {
  return allow.some((a) => (a.rule === null || a.rule === rule) && a.pattern.test(text));
}

function builtInHits(file: string, added: AddedLines, config: LeakScanConfig, allow: readonly AllowEntry[]): Hit[] {
  const rules: [string, RegExp[]][] = [
    [EMAIL_RULE, [EMAIL]],
    [HOME_PATH_RULE, [UNIX_HOME, WINDOWS_HOME]],
  ];
  const hits: Hit[] = [];
  for (const [rule, patterns] of rules) {
    if (config.disabled.has(rule)) continue;
    added.lines.forEach((text, i) => {
      for (const pattern of patterns) {
        for (const m of text.matchAll(pattern)) {
          if (!admitted(allow, rule, m[0])) hits.push({ file, line: added.lineNumbers[i], rule });
        }
      }
    });
  }
  return hits;
}

async function secretHits(scanner: Scanner, file: string, added: AddedLines, config: LeakScanConfig, allow: readonly AllowEntry[]): Promise<Hit[]> {
  const rules = scanner.rules.filter((r) => !config.disabled.has(r.meta.id)).map((r) => ({ id: r.meta.id, rule: r }));
  if (rules.length === 0) return [];
  const content = added.lines.join('\n');
  const result = await scanner.lintSource({
    source: { content, filePath: file, ext: extname(file), contentType: 'text' },
    options: { config: { rules }, maskSecrets: true, noPhysicFilePath: true },
  });
  return result.messages
    .filter((m) => !admitted(allow, m.ruleId, content.slice(m.range[0], m.range[1])))
    .map((m) => ({ file, line: added.lineNumbers[m.loc.start.line - 1], rule: m.ruleId }));
}

function hitOrder(a: Hit, b: Hit): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

/** The leak_scan or leak_scan_config failure of <base>..<commit> in <repo>, or null when it is clean. */
export async function leakScan(repo: string, base: string, commit: string, env: NodeJS.ProcessEnv): Promise<DocCheckFailure | null> {
  const invalid = (actual: string): DocCheckFailure => ({
    check: 'leak_scan_config',
    expected: `${LEAK_SCAN_FILE} at ${commit} is absent or matches ${LEAK_SCAN_SHAPE}, every entry with a non-empty reason`,
    actual,
  });
  const failed = (actual: string): DocCheckFailure => ({
    check: 'leak_scan',
    expected: `no line ${base}..${commit} adds holds a secret, an email address or a home path that no allow entry admits; admit an intended one in ${LEAK_SCAN_FILE} with a reason`,
    actual,
  });

  const file = await fileAtCommit(repo, commit, LEAK_SCAN_FILE, env);
  if ('error' in file) return invalid(file.error);
  let scanner: Scanner;
  try {
    scanner = await loadScanner();
  } catch (e) {
    return failed(`secretlint failed to load: ${(e as Error).message}`);
  }
  const ruleNames = new Set([EMAIL_RULE, HOME_PATH_RULE, ...scanner.rules.map((r) => r.meta.id)]);
  const parsed = file.text === null ? { allow: [], disabled: new Set<string>() } : parseLeakScanConfig(file.text, ruleNames);
  if ('error' in parsed) return invalid(parsed.error);
  const allow = [...DEFAULT_ALLOW, ...parsed.allow];

  const diff = await gitText(
    repo,
    ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/', base, commit],
    env,
  );
  if (diff.code !== 0) return failed(`git diff ${base}..${commit} failed: ${diff.stderr.trim()}`);

  const hits: Hit[] = [];
  try {
    for (const [path, added] of addedLines(diff.stdout)) {
      hits.push(...builtInHits(path, added, parsed, allow), ...(await secretHits(scanner, path, added, parsed, allow)));
    }
  } catch (e) {
    return failed(`secretlint failed: ${(e as Error).message}`);
  }
  if (hits.length === 0) return null;
  const listed = [...new Set(hits.sort(hitOrder).map((h) => `${h.file}:${h.line} ${h.rule}`))];
  return failed(listed.join('; '));
}
