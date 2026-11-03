/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/remote-id-guard.sh:
 * a remote write carrying author text (gh pr create|edit, gh issue
 * create|edit|comment|close, glab mr create|update, glab issue
 * create|update|note|close, with a body, title or comment option or a heredoc)
 * is denied when a `#<n>` in it is a local trajectory issue id whose remote
 * iid differs: gh_iid for gh, gl_iid for glab, the other forge's iid when the
 * command's own is unset. The deny names the remote ref to cite instead.
 *
 * It fails open: no DB, no SQLite, no issues table, no offending token, a
 * `#<n>` that is no local id, and TMB_DISABLE_REMOTE_ID_GUARD=1 all allow.
 * The analysis runs within TMB_REMOTE_ID_GUARD_DEADLINE_S seconds (default 3,
 * GH 1821), an in-process time budget where the .sh kills a process group:
 * past it the gate allows, prints one stderr line and writes one
 * remote_id_guard_overrun audit row on issue -1. TMB_REMOTE_ID_GUARD_TEST_OVERRUN=1
 * makes the budget read as spent from the start, so a test reaches that path
 * without waiting on the clock.
 *
 * Unlike the .sh it needs neither jq nor the sqlite3 CLI, and a command
 * tree-sitter-bash cannot parse is allowed rather than read with the .sh's
 * awk skeleton (decision 703).
 */
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ALLOW, type Gate, type GateResult } from './gate.js';
import { cmdStatements } from './cmd-analysis/index.js';
import { auditAppend } from './lib/audit.js';
import { dbPath, haveSqlite, sqliteRo, stripTrailingNewlines } from './lib/db.js';
import { jqAlternatives, jqCompact, jqNumberLiteral } from './lib/jq.js';

export const GATE_NAME = 'remote-id-guard';

const DEFAULT_DEADLINE_S = '3';
const WRITE_RUN_BUDGET_MS = '1000';

type Provider = 'gh' | 'glab';

const REMOTE_WRITES: ReadonlyArray<readonly [string, Provider]> = [
  ...['pr create', 'pr edit', 'issue create', 'issue edit', 'issue comment', 'issue close'].map((s) => [`gh ${s}`, 'gh'] as const),
  ...['mr create', 'mr update', 'issue create', 'issue update', 'issue note', 'issue close'].map((s) => [`glab ${s}`, 'glab'] as const),
];

const TEXT_OPTION = /(--body|--title|--comment|--message|--description|--note)([ \t\n\v\f\r=]|$)/m;
const SHORT_TEXT_OPTION = /(^|[ \t\n\v\f\r])-[btm]([ \t\n\v\f\r]|$)/m;
const HEREDOC = /<<-?[ \t\v\f\r]*[A-Za-z_'"]/;
const REMOTE_MARKERS: readonly RegExp[] = [/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+/g, /[Gg][Hh]-[0-9]+/g, /[Gg][Ll]-[0-9]+/g, /[Rr][Ee][Mm][Oo][Tt][Ee]:[0-9]+/g];

const OVERRUN = Symbol('overrun');

/** TMB_REMOTE_ID_GUARD_DEADLINE_S when it is a positive decimal, else 3. */
export function deadlineSeconds(env: NodeJS.ProcessEnv): string {
  const d = env.TMB_REMOTE_ID_GUARD_DEADLINE_S || DEFAULT_DEADLINE_S;
  return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(d) && /[1-9]/.test(d) ? d : DEFAULT_DEADLINE_S;
}

function providerOf(stmt: string): Provider | null {
  for (const [prefix, provider] of REMOTE_WRITES) {
    if (stmt === prefix || stmt.startsWith(`${prefix} `)) return provider;
  }
  return null;
}

function carriesText(command: string): boolean {
  return TEXT_OPTION.test(command) || SHORT_TEXT_OPTION.test(command) || HEREDOC.test(command);
}

/** The distinct `#<n>` numbers of <command> outside explicit remote markers, in `sort -u` order. */
export function candidateTokens(command: string): string[] {
  const scan = REMOTE_MARKERS.reduce((text, marker) => text.replace(marker, ' '), command);
  const tokens = new Set([...scan.matchAll(/#([0-9]+)/g)].map((m) => m[1]));
  return [...tokens].sort();
}

/** `$(printf '%s' "$row" | cut -d'|' -f<from>[-])`, line by line as cut reads it. */
function cut(row: string, from: number, rest: boolean): string {
  const lines = row.split('\n').map((line) => {
    if (!line.includes('|')) return line;
    const fields = line.split('|');
    return rest ? fields.slice(from - 1).join('|') : (fields[from - 1] ?? '');
  });
  return stripTrailingNewlines(lines.join('\n'));
}

function unhex(hex: string): string {
  const text = Buffer.from(hex, 'hex').toString('utf8');
  const nul = text.indexOf('\0');
  return nul < 0 ? text : text.slice(0, nul);
}

/** Each token that is a local issue id, with the `gh|gl|objective` row the .sh's per-id SELECT prints; one read for all tokens. */
function localRows(db: string, tokens: readonly string[], env: NodeJS.ProcessEnv): Map<string, string> {
  const values = tokens.map((n) => `('${n}', ${n})`).join(', ');
  const out = sqliteRo(
    db,
    `WITH t(n, k) AS (VALUES ${values}) SELECT t.n || '|' || hex(COALESCE(i.gh_iid, '')) || '|' || hex(COALESCE(i.gl_iid, '')) || '|' || hex(COALESCE(i.objective, '')) FROM t JOIN issues i ON i.id = t.k;`,
    env,
  );
  const rows = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [n, gh, gl, objective] = line.split('|');
    if (objective === undefined) continue;
    rows.set(n, stripTrailingNewlines(`${unhex(gh)}|${unhex(gl)}|${unhex(objective)}`));
  }
  return rows;
}

const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ['a', 0x07],
  ['b', 0x08],
  ['e', 0x1b],
  ['E', 0x1b],
  ['f', 0x0c],
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
  ['v', 0x0b],
  ['\\', 0x5c],
]);

const isOctal = (b: number | undefined): b is number => b !== undefined && b >= 0x30 && b <= 0x37;
const hexValue = (b: number | undefined): number => {
  if (b === undefined) return -1;
  const c = String.fromCharCode(b);
  return /[0-9A-Fa-f]/.test(c) ? parseInt(c, 16) : -1;
};

/** `$(printf '%b' "$text")` of bash 3.2: its escapes expanded, NUL bytes and trailing newlines dropped. */
export function printfB(text: string): string {
  const src = Buffer.from(text, 'utf8');
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const b = src[i];
    if (b !== 0x5c || i + 1 >= src.length) {
      out.push(b);
      i += 1;
      continue;
    }
    const c = String.fromCharCode(src[i + 1]);
    i += 2;
    const simple = SIMPLE_ESCAPES.get(c);
    if (simple !== undefined) {
      out.push(simple);
    } else if (c === 'c') {
      break;
    } else if (c >= '0' && c <= '7') {
      let value = c.charCodeAt(0) - 0x30;
      for (let left = c === '0' ? 3 : 2; left > 0 && isOctal(src[i]); left -= 1, i += 1) value = value * 8 + (src[i] - 0x30);
      out.push(value & 0xff);
    } else if (c === 'x' && hexValue(src[i]) >= 0) {
      let value = hexValue(src[i]);
      i += 1;
      if (hexValue(src[i]) >= 0) {
        value = value * 16 + hexValue(src[i]);
        i += 1;
      }
      out.push(value);
    } else {
      out.push(0x5c, src[i - 1]);
    }
  }
  return stripTrailingNewlines(Buffer.from(out.filter((b) => b !== 0)).toString('utf8'));
}

function deny(reason: string): GateResult {
  const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { stdout: `${jqCompact(decision)}\n`, code: 0 };
}

function offense(n: string, row: string, provider: Provider): string {
  const gh = cut(row, 1, false);
  const gl = cut(row, 2, false);
  const objective = cut(row, 3, true);
  const [own, ownName, other, otherName] = provider === 'glab' ? [gl, 'GitLab', gh, 'GitHub'] : [gh, 'GitHub', gl, 'GitLab'];
  const line = (iid: string, forge: string): string => `#${n} → #${iid} (${forge})  local #${n}: "${objective}"\\n`;
  if (own !== '' && own !== n) return line(own, ownName);
  if (own === '' && other !== '' && other !== n) return line(other, otherName);
  return '';
}

type Analysis = GateResult | typeof OVERRUN;

async function analyze(payload: string, env: NodeJS.ProcessEnv, overran: () => boolean): Promise<Analysis> {
  if (overran()) return OVERRUN;
  const command = stripTrailingNewlines(jqAlternatives(payload, [['tool_input', 'command']]).replace(/\0/g, ''));
  if (command === '' || !carriesText(command)) return ALLOW;
  const tokens = candidateTokens(command);
  if (tokens.length === 0) return ALLOW;

  const listed = await cmdStatements(command, '/', env);
  if (overran()) return OVERRUN;
  if (!listed.ok) return ALLOW;
  let provider: Provider | null = null;
  for (const { stmt } of listed.statements) {
    provider = providerOf(stmt);
    if (provider) break;
  }
  if (!provider) return ALLOW;

  const db = dbPath(env) ?? '';
  if (db === '' || !haveSqlite(env)) return ALLOW;
  const rows = localRows(db, tokens, env);
  if (overran()) return OVERRUN;
  const offenses = tokens.map((n) => (rows.has(n) ? offense(n, rows.get(n) ?? '', provider) : '')).join('');
  if (offenses === '') return ALLOW;

  return deny(
    `BLOCKED: this remote-bound text cites LOCAL trajectory issue id(s) that resolve to a DIFFERENT issue on the remote. Re-issue with the remote iid:\n${printfB(offenses)}\nA bare #N in a PR body / gh issue comment resolves to remote issue N, not the local one. Use the remote id shown above. To cite a number that is already a remote id, write it as GH-<n>, remote:<n> or <owner>/<repo>#<n>. (Bypass: TMB_DISABLE_REMOTE_ID_GUARD=1.)`,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function auditOverrun(deadline: string, elapsed: string, env: NodeJS.ProcessEnv): void {
  const db = dbPath(env) ?? '';
  if (db === '' || !isFile(db) || !haveSqlite(env)) return;
  auditAppend(
    db,
    {
      issueId: '-1',
      branchId: '',
      fromNode: `hook:${GATE_NAME}`,
      eventType: 'remote_id_guard_overrun',
      summary: `${GATE_NAME} allowed a Bash command: its analysis passed the ${deadline}s deadline`,
      contentJson: `{"deadline_s":${jqNumberLiteral(deadline)},"elapsed_s":${jqNumberLiteral(elapsed)}}`,
    },
    { caller: GATE_NAME, env },
  );
}

function seconds(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  return `${Math.floor(whole / 1000)}.${String(whole % 1000).padStart(3, '0')}`;
}

export const remoteIdGuard: Gate = async (payload, processEnv) => {
  if (processEnv.TMB_DISABLE_REMOTE_ID_GUARD === '1') return ALLOW;
  const env: NodeJS.ProcessEnv = { ...processEnv, TMB_DB_WRITE_RUN_BUDGET_MS: WRITE_RUN_BUDGET_MS };
  const deadline = deadlineSeconds(env);
  const budgetMs = Number(deadline) * 1000;
  const start = performance.now();
  const skew = env.TMB_REMOTE_ID_GUARD_TEST_OVERRUN === '1' ? budgetMs : 0;
  const elapsedMs = (): number => performance.now() - start + skew;
  const overran = (): boolean => elapsedMs() >= budgetMs;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof OVERRUN>((resolve) => {
    timer = setTimeout(() => resolve(OVERRUN), budgetMs);
  });
  let result: Analysis;
  try {
    result = await Promise.race([analyze(payload, env, overran).catch((): Analysis => ALLOW), expired]);
  } finally {
    clearTimeout(timer);
  }
  if (result !== OVERRUN && !overran()) return result;

  const elapsed = seconds(elapsedMs());
  process.stderr.write(`${GATE_NAME}: analysis passed its ${deadline}s deadline (TMB_REMOTE_ID_GUARD_DEADLINE_S) after ${elapsed}s; allowing\n`);
  auditOverrun(deadline, elapsed, env);
  return ALLOW;
};
