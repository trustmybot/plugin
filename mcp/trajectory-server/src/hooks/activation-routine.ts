/**
 * UserPromptSubmit hook (GH 1692): on a bro turn (the prompt says "bro" as a word and is not a harness turn,
 * or the transcript holds sticky bro mode) it pre-fetches the onboarded flag
 * and the newest open issue and injects them as additionalContext, prefixed
 * by a HALT notice when pgrep finds no trajectory-server. Once per session, when
 * the last main-thread call's context passes bro_compact_nudge_tokens, it
 * appends a /compact nudge (GH 3029). Never blocks.
 *
 * The word test is grep's: `\b` and -i under the locale grep would run in
 * (ASCII word bytes in C; letters, digits and _ under UTF-8, where a
 * transcript line with invalid UTF-8 never matches). It needs neither jq nor
 * the sqlite3 CLI.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { BRO_COMPACT_NUDGE_TOKENS_KEY, parseBroCompactNudgeTokens } from '../tools/config.js';
import { isHarnessTurn } from './cmd-analysis/harness-turn.js';
import { ALLOW, type GateResult } from './gate.js';
import { auditAppend } from './lib/audit.js';
import { dbPathAdvisory, haveSqlite, sqliteRo } from './lib/db.js';
import { jqCompact, jqFieldOr } from './lib/jq.js';
import { commandOnPath } from './lib/persona.js';
import { commandSubstitution, setlocaleUtf8 } from './lib/project-env.js';

export const GATE_NAME = 'activation-routine';

export const HALT_TEXT =
  '⛔ MCP trajectory-server is not running at this prompt — trajectory tools (state reads and writes) are unreachable. Bro: HALT. Do not dispatch work; load tmb_recovery §B and follow it. The read-only sqlite3 fallback (`node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" bro-sqlite-readonly`) stays available for emergency reads.';
const FIRST_RUN_LINE = 'onboarded=<no — FIRST CONTACT, auto-fire /onboard before any reply>';
export const SESSION_ID_LINE = /^[A-Za-z0-9_-]{8,64}$/;
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');
const NEWLINE = 0x0a;
const SYNTHETIC_MODEL = '<synthetic>';

/** A grep -E pattern run line by line under C (bytes) or UTF-8 (code points). */
export class LocaleGrep {
  private readonly word: string;
  private readonly flags: string;

  constructor(readonly utf8: boolean) {
    this.word = utf8 ? '[\\p{L}\\p{Nd}_]' : '[A-Za-z0-9_]';
    this.flags = utf8 ? 'u' : '';
  }

  /** <source> with `\b` as grep's word boundary under this locale. */
  regex(source: string, ignoreCase = false): RegExp {
    const w = this.word;
    const boundary = `(?:(?<!${w})(?=${w})|(?<=${w})(?!${w}))`;
    const body = source.replace(/\\b/g, boundary).replace(/(^|[^\\])\./g, '$1[^\\n]');
    return new RegExp(body, `${this.flags}${ignoreCase ? 'i' : ''}`);
  }

  /** The lines of <bytes> as grep sees them: undefined for a line it cannot match. */
  lines(bytes: Buffer): (string | undefined)[] {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const out: (string | undefined)[] = [];
    let start = 0;
    while (start <= bytes.length) {
      let end = bytes.indexOf(0x0a, start);
      if (end < 0) end = bytes.length;
      if (end === bytes.length && start === end && start > 0) break;
      const line = bytes.subarray(start, end);
      if (!this.utf8) out.push(line.toString('latin1'));
      else {
        try {
          out.push(decoder.decode(line));
        } catch {
          out.push(undefined);
        }
      }
      start = end + 1;
    }
    return out;
  }

  test(bytes: Buffer, re: RegExp): boolean {
    return this.lines(bytes).some((line) => line !== undefined && re.test(line));
  }
}

export function readTranscript(path: string): Buffer | null {
  if (path === '') return null;
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function isStickyBro(transcript: Buffer | null, grep: LocaleGrep): boolean {
  if (transcript === null) return false;
  if (grep.test(transcript, grep.regex('exit bro mode|stop being bro', true))) return false;
  return grep.test(transcript, grep.regex('Entering bro mode.')) || grep.test(transcript, grep.regex('@bro\\b', true));
}

export function saysBro(prompt: string, grep: LocaleGrep): boolean {
  return !isHarnessTurn(prompt) && grep.test(Buffer.from(`${prompt}\n`, 'utf8'), grep.regex('\\bbro\\b', true));
}

function serverDown(env: NodeJS.ProcessEnv): boolean {
  if (!commandOnPath('pgrep', env)) return false;
  try {
    return spawnSync('pgrep', ['-f', 'trajectory-server/dist/index.js'], { env, stdio: 'ignore' }).status === 1;
  } catch {
    return false;
  }
}

const emit = (context: string): GateResult => ({
  stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })}\n`,
  code: 0,
});

export function activationContext(onboardedCount: string, pending: string): string {
  let pendingLine = 'pending=<none>';
  if (pending !== '') {
    const bar = pending.indexOf('|');
    const id = bar < 0 ? pending : pending.slice(0, bar);
    const objective = bar < 0 ? pending : pending.slice(bar + 1);
    pendingLine = `pending=#${id}: ${objective}`;
  }
  if (onboardedCount === '0') {
    return `[tmb activation routine — pre-fetched by hook] ${FIRST_RUN_LINE}. ACTION: this is the user's first contact in this project — call \`onboard_state_get(agent='bro')\` and run the \`/onboard\` slash command flow IMMEDIATELY before any reply (auto-fire doctrine, no permission gate). Do not greet, do not answer the user's prompt, do not call issue_resume separately — onboard_state_get returns everything you need. ${pendingLine}`;
  }
  return `[tmb activation routine — pre-fetched by hook] onboarded=yes. Use this to compose the welcome banner; do NOT also call issue_resume — they would be redundant duplicate reads. ${pendingLine}`;
}

/** The input context of one main-thread, non-synthetic assistant transcript line; null for any other line. */
function callContext(line: string): number | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== 'object') return null;
  const { type, isSidechain, message } = entry as Record<string, unknown>;
  if (type !== 'assistant' || isSidechain === true || message === null || typeof message !== 'object') return null;
  const { model, usage } = message as Record<string, unknown>;
  if (model === SYNTHETIC_MODEL || usage === null || typeof usage !== 'object') return null;
  const count = (key: string): number => {
    const value = (usage as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens');
}

/** The input context of the last main-thread assistant call in <transcript>; null with none. */
export function lastCallContext(transcript: Buffer | null): number | null {
  if (transcript === null) return null;
  let end = transcript.length;
  while (end > 0) {
    const hit = transcript.lastIndexOf(ASSISTANT_MARKER, end - 1);
    if (hit === -1) return null;
    const start = transcript.lastIndexOf(NEWLINE, hit) + 1;
    const newline = transcript.indexOf(NEWLINE, hit);
    const context = callContext(transcript.toString('utf8', start, newline === -1 ? transcript.length : newline));
    if (context !== null) return context;
    end = start - 1;
  }
  return null;
}

export function compactNudgeLine(contextTokens: number, threshold: number): string {
  return `TMB: this bro session's context is ${contextTokens} tokens, past ${BRO_COMPACT_NUDGE_TOKENS_KEY} (${threshold}). At the next natural break, ask the Human to run /compact; the PreCompact state note restores the issue, its tasks and the newest decision.`;
}

/** The /compact nudge for session <sessionId> the first time its context passes the threshold, recorded by its once-marker audit row; '' otherwise. */
function compactNudge(db: string, sessionId: string, transcript: Buffer | null, env: NodeJS.ProcessEnv): string {
  if (!SESSION_ID_LINE.test(sessionId)) return '';
  const contextTokens = lastCallContext(transcript);
  if (contextTokens === null) return '';
  const threshold = parseBroCompactNudgeTokens(
    sqliteRo(db, `SELECT value_json FROM plugin_config WHERE key='${BRO_COMPACT_NUDGE_TOKENS_KEY}';`, env),
  );
  if (threshold === 0 || contextTokens <= threshold) return '';
  const nudged = sqliteRo(
    db,
    `SELECT COUNT(*) FROM audit WHERE event_type='bro_compact_nudged' AND json_valid(content_json) AND json_extract(content_json, '$.session_id')='${sessionId}';`,
    env,
  );
  if (nudged !== '0') return '';
  const written = auditAppend(
    db,
    {
      issueId: '-1',
      branchId: '',
      fromNode: `hook:${GATE_NAME}`,
      eventType: 'bro_compact_nudged',
      summary: `Compact nudge: bro session ${sessionId} at ${contextTokens} context tokens (threshold ${threshold})`,
      contentJson: JSON.stringify({ session_id: sessionId, context_tokens: contextTokens, threshold }),
      dedupePaths: ['$.session_id'],
    },
    { caller: GATE_NAME, env },
  );
  if (!written.ok) {
    if (written.error !== '') process.stderr.write(`${written.error}\n`);
    return '';
  }
  return compactNudgeLine(contextTokens, threshold);
}

/** The issue of the handoff <sessionId> consumed, while that issue is open; '' otherwise. */
function handoffPending(db: string, sessionId: string, env: NodeJS.ProcessEnv): string {
  if (!SESSION_ID_LINE.test(sessionId)) return '';
  return sqliteRo(
    db,
    `SELECT i.id, COALESCE(i.objective, '') FROM session_handoffs h JOIN issues i ON i.id = h.issue_id WHERE h.consumed_by_session = '${sessionId}' AND i.status = 'open' AND i.id > 0 ORDER BY h.consumed_at DESC LIMIT 1;`,
    env,
  );
}

export function activationRoutine(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    const echoed = `${commandSubstitution(payload)}\n`;
    const field = (key: string): string => commandSubstitution(jqFieldOr(echoed, key));
    const prompt = field('prompt');
    const grep = new LocaleGrep(setlocaleUtf8(env));
    const transcript = readTranscript(field('transcript_path'));
    if (!saysBro(prompt, grep) && !isStickyBro(transcript, grep)) return ALLOW;
    const halt = serverDown(env) ? HALT_TEXT : '';
    const haltOnly = (): GateResult => (halt !== '' ? emit(halt) : ALLOW);
    const db = dbPathAdvisory(GATE_NAME, env, (line) => process.stderr.write(`${line}\n`));
    if (db === null || !haveSqlite(env)) return haltOnly();
    const onboarded = sqliteRo(db, "SELECT COUNT(*) FROM plugin_config WHERE key='onboarded' AND value_json='true';", env);
    const sessionId = field('session_id');
    const pending =
      handoffPending(db, sessionId, env) ||
      sqliteRo(db, "SELECT id, COALESCE(objective, '') FROM issues WHERE status='open' AND id > 0 ORDER BY id DESC LIMIT 1;", env);
    let context = activationContext(onboarded, pending);
    if (halt !== '') context = `${halt} ${context}`;
    if (sessionId.split('\n').some((line) => SESSION_ID_LINE.test(line))) context = `${context} session_id=${sessionId}`;
    const nudge = compactNudge(db, sessionId, transcript, env);
    if (nudge !== '') context = `${context}\n${nudge}`;
    return emit(context);
  } catch {
    return ALLOW;
  }
}
