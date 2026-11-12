/**
 * PreToolUse lint (GH 1692): warns through additionalContext on the code-quality patterns a regex finds
 * in the new content of a Python or TS/JS source file (bare except, an
 * unbounded subprocess.run, string-built SQL, `catch (e: any)`, a TODO
 * marker, …). Bypass: TMB_SKIP_CQ_LINT=1. It needs no jq.
 */
import { ALLOW, type SyncGate } from './gate.js';
import {
  anyLine,
  grepMultibyte,
  grepSpace,
  jqEachOptional,
  jqIndex,
  jqJoinLines,
  jqPath,
  jqRawOr,
  preToolContext,
} from './lib/lint-shell.js';
import { pathInProject } from './lib/project-env.js';

export const GATE_NAME = 'code-quality-lint';

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const SOURCE_EXTS = ['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const SKIPPED_DIRS = ['/node_modules/', '/dist/', '/build/', '/__pycache__/', '/target/', '/fixtures/', '/__fixtures__/'];

type Check = { pattern: string; message: string };

const PY_CHECKS: Check[] = [
  { pattern: '^[S]*except[S]*:', message: "bare 'except:' — catch a specific exception or re-raise" },
  { pattern: '^[S]*except[S]+Exception[S]*[:as ]', message: "'except Exception' hides unrelated errors; catch the specific exception types the block handles." },
];
const PY_LATER_CHECKS: Check[] = [
  { pattern: `f['"](SELECT|INSERT|UPDATE|DELETE|MERGE)[S]`, message: 'f-string SQL — use parameterized queries to prevent injection' },
  { pattern: 'datetime\\.utcnow\\(\\)', message: 'datetime.utcnow() returns naive datetime — use datetime.now(timezone.utc)' },
  { pattern: 'def[S]+[A-Za-z_][A-Za-z0-9_]*\\([^)]*=\\[\\]', message: 'mutable default argument [] — use None and assign in body' },
  { pattern: 'def[S]+[A-Za-z_][A-Za-z0-9_]*\\([^)]*=\\{\\}', message: 'mutable default argument {} — use None and assign in body' },
];
const TS_CHECKS: Check[] = [
  {
    pattern: 'catch[S]*\\([S]*[A-Za-z_][A-Za-z0-9_]*[S]*:[S]*any[S]*\\)',
    message: "catch (e: any) — use 'unknown' and narrow with instanceof",
  },
  { pattern: '`(SELECT|INSERT|UPDATE|DELETE|MERGE)[^`]*[$][{]', message: 'template-string SQL with ${...} — use parameterized queries' },
  { pattern: `setTimeout\\([S]*['"]`, message: 'setTimeout with string argument — use a function reference' },
];
const MARKER_CHECK: Check = {
  pattern: '(TODO|FIXME|HACK|XXX)([S]|:|$)',
  message: "TODO/FIXME/HACK — finish the work or escalate; don't ship the marker",
};

/** `[S]` in a pattern stands for grep's `[[:space:]]` in the hook's locale. */
function regex(pattern: string, multibyte: boolean): RegExp {
  return new RegExp(pattern.replace(/\[S\]/g, `[${grepSpace(multibyte)}]`), 'u');
}

/** `.tool_input.content // .tool_input.new_string // ([.tool_input.edits[]?.new_string] | join("\n")) // ""`. */
function newContent(payload: string): string {
  return jqRawOr(payload, [
    jqPath('tool_input', 'content'),
    jqPath('tool_input', 'new_string'),
    (value) => jqJoinLines(jqEachOptional(jqPath('tool_input', 'edits')(value)).map((edit) => jqIndex(edit, 'new_string'))),
  ]);
}

const ARGV_OPERAND = String.raw`(?:(?:path\.)?resolve\(\s*)?process\.argv\[1\]\s*\)?`;
const MODULE_OPERAND = String.raw`(?:fileURLToPath\(\s*)?import\.meta\.url\s*\)?`;
const MAIN_GUARD = new RegExp(`${ARGV_OPERAND}\\s*[!=]==\\s*${MODULE_OPERAND}|${MODULE_OPERAND}\\s*[!=]==\\s*${ARGV_OPERAND}`);
const MAIN_GUARD_MESSAGE =
  'process.argv[1] compared with import.meta.url — an npm bin symlink or a symlinked checkout makes it false; compare realpathSync of both sides';

const SYNC_SPAWN_CALL = /\b(?:spawnSync|execSync|execFileSync)\(/g;
const SYNC_SPAWN_MESSAGE = 'spawnSync/execSync/execFileSync without a timeout option — a hung child blocks forever; pass { timeout: <ms> }';

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//;
const TEST_FILE_NAME = /(?:\.(?:test|spec)\.[^/]+|(?:^|\/)test_[^/]*\.py|_test\.py)$/;
const TEST_DIR = /\/tests?\//;
const HOME_PATH_MESSAGE = 'hardcoded home path (/Users/<name>/ or /home/<name>/) in a string — derive it from the home dir or config';

function hasUnsafeMainGuard(content: string): boolean {
  return content.split('\n').some((line) => MAIN_GUARD.test(line) && !line.includes('realpathSync'));
}

/** The text between the `(` at `open` and its matching `)`, skipping quoted strings; the rest of `content` when unclosed. */
function argumentList(content: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return content.slice(open + 1, i);
  }
  return content.slice(open + 1);
}

function hasUnboundedSyncSpawn(content: string): boolean {
  return [...content.matchAll(SYNC_SPAWN_CALL)].some((m) => !/\btimeout\b/.test(argumentList(content, m.index + m[0].length - 1)));
}

/** Directory names are judged below the project root only, so a checkout under a `tests/` folder still gets linted. */
function isTestFile(target: string, projectDir: string | undefined): boolean {
  return TEST_FILE_NAME.test(target) || TEST_DIR.test(pathInProject(target, projectDir));
}

/** Inside the project root only the path below it counts, so a checkout under a `build/` folder still gets linted. */
function isSkippedDir(target: string, projectDir: string | undefined): boolean {
  const judged = pathInProject(target, projectDir) || target;
  return SKIPPED_DIRS.some((d) => judged.includes(d));
}

function hasHomePath(content: string, target: string, projectDir: string | undefined): boolean {
  if (isTestFile(target, projectDir)) return false;
  return content.split('\n').some((line) => [...line.matchAll(STRING_LITERAL)].some((m) => HOME_PATH.test(m[2])));
}

function tsFindings(content: string, multibyte: boolean): string[] {
  const found = TS_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message);
  if (hasUnsafeMainGuard(content)) found.push(MAIN_GUARD_MESSAGE);
  if (hasUnboundedSyncSpawn(content)) found.push(SYNC_SPAWN_MESSAGE);
  return found;
}

function pythonFindings(content: string, multibyte: boolean): string[] {
  const found = PY_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message);
  const call = regex('subprocess\\.run\\([^)]*\\)', multibyte);
  const timeout = regex('timeout[S]*=', multibyte);
  const unbounded = content.split('\n').some((line) => call.test(line) && !timeout.test(line));
  if (anyLine(content, /subprocess\.run\(/) && unbounded) found.push('subprocess.run without timeout= — risk of indefinite hang');
  return found.concat(PY_LATER_CHECKS.filter((c) => anyLine(content, regex(c.pattern, multibyte))).map((c) => c.message));
}

export const codeQualityLint: SyncGate = (payload, env) => {
  if ((env.TMB_SKIP_CQ_LINT ?? '0') === '1') return ALLOW;
  if (!TOOLS.has(jqRawOr(payload, [jqPath('tool_name')]))) return ALLOW;
  const target = jqRawOr(payload, [jqPath('tool_input', 'file_path')]);
  if (target === '' || !SOURCE_EXTS.some((ext) => target.endsWith(ext))) return ALLOW;
  if (isSkippedDir(target, env.CLAUDE_PROJECT_DIR)) return ALLOW;
  const content = newContent(payload);
  if (content === '') return ALLOW;

  const ext = target.slice(target.lastIndexOf('.') + 1);
  const multibyte = grepMultibyte(env);
  const findings: string[] = [];
  if (ext === 'py') findings.push(...pythonFindings(content, multibyte));
  else if (TS_EXTS.has(ext)) findings.push(...tsFindings(content, multibyte));
  if ((ext === 'py' || TS_EXTS.has(ext)) && hasHomePath(content, target, env.CLAUDE_PROJECT_DIR)) findings.push(HOME_PATH_MESSAGE);
  if (anyLine(content, regex(MARKER_CHECK.pattern, multibyte))) findings.push(MARKER_CHECK.message);
  if (findings.length === 0) return ALLOW;

  const ctx = `code-quality-lint: ${target}${findings.map((f) => `\n - ${f}`).join('')}\nSet TMB_SKIP_CQ_LINT=1 to bypass.`;
  return { stdout: preToolContext(ctx), code: 0 };
};
