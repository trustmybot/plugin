/**
 * PreToolUse hook on AskUserQuestion (#141, GH 1692), the port of
 * scripts/hooks/roundtable-auq-shape.sh: while a roundtable is awaiting_human
 * with no human vote, a ratification batch must be Q1 multiSelect
 * (agreements), Q2..Qn radios (disagreements), at most 4 questions; a batch
 * of another shape gets permissionDecision "ask" with the violations. Unlike
 * the .sh, it needs neither jq nor the sqlite3 CLI (decision 703).
 */
import { ALLOW, type GateResult } from './gate.js';
import { dbPath, haveSqlite, sqliteRo } from './lib/db.js';
import { jqCompact, jqFieldOr, jqIndex, jqMap, jqOr } from './lib/jq.js';
import { commandSubstitution } from './lib/project-env.js';

export const GATE_NAME = 'roundtable-auq-shape';
export const MAX_QUESTIONS = 4;

export const AWAITING_SQL = `
  SELECT r.id FROM roundtables r
  WHERE r.state = 'awaiting_human'
    AND NOT EXISTS (
      SELECT 1 FROM roundtable_votes v
      WHERE v.roundtable_id = r.id AND v.participant = 'human'
    )
  ORDER BY r.id DESC LIMIT 1;
`;

const LENGTH_ERROR = Symbol('length error');

/** jq's `length`: null 0, a number its absolute value, a string its code points, an array or object its size; a boolean errors. */
function jqLength(value: unknown): string | typeof LENGTH_ERROR {
  if (value === null) return '0';
  if (typeof value === 'number') return String(Math.abs(value));
  if (typeof value === 'string') return String([...value].length);
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'object') return String(Object.keys(value as object).length);
  return LENGTH_ERROR;
}

/** bash's `[ "$s" <op> n ]`: the comparison, or false when <s> is not an integer (the test errors). */
function bashIntTest(s: string, compare: (n: number) => boolean): boolean {
  return /^-?[0-9]+$/.test(s) && Number.isSafeInteger(Number(s)) && compare(Number(s));
}

/**
 * `jq '.[<i>].multiSelect // false'` over every questions value: "true" when
 * jq prints exactly the one line `true`. Indexing anything but null or an
 * array by number errors, so that value prints nothing.
 */
function multiSelectAt(questions: readonly unknown[], i: number): boolean {
  const lines: boolean[] = [];
  for (const q of questions) {
    if (q !== null && !Array.isArray(q)) continue;
    const element: unknown = q === null ? null : (q[i] ?? null);
    try {
      lines.push(jqOr(jqIndex(element, 'multiSelect'), false) === true);
    } catch {
      /* jq skips the value */
    }
  }
  return lines.length === 1 && lines[0];
}

/**
 * The violations of the batch's `.tool_input.questions` (one value per
 * payload value), as the .sh finds them; null when it passes the batch by
 * (no questions, or a count of 0).
 */
export function shapeViolations(echoed: string): string[] | null {
  const questions = jqMap(echoed, (value) => jqOr(jqIndex(jqIndex(value, 'tool_input'), 'questions'), []));
  const lengths = questions.map(jqLength).filter((n): n is string => n !== LENGTH_ERROR);
  const count = lengths.join('\n');
  if (count === '' || bashIntTest(count, (n) => n === 0)) return null;
  const violations: string[] = [];
  if (bashIntTest(count, (n) => n > MAX_QUESTIONS)) {
    violations.push(`AUQ has ${count} questions; max ${MAX_QUESTIONS} allowed during ratification`);
  }
  if (!multiSelectAt(questions, 0)) {
    violations.push('Q1 must have multiSelect:true (agreements checkbox) during ratification');
  }
  if (bashIntTest(count, (n) => n > 1)) {
    const longest = Math.max(0, ...questions.map((q) => (Array.isArray(q) ? q.length : 0)));
    const last = Math.min(Number(count), longest);
    for (let i = 1; i < last; i += 1) {
      if (multiSelectAt(questions, i)) {
        violations.push(`Q${i + 1} must not use multiSelect (disagreement radios only) during ratification`);
      }
    }
  }
  return violations;
}

export function shapeAsk(rtId: string, violations: readonly string[]): string {
  const message =
    `roundtable-auq-shape: AskUserQuestion shape is invalid for ratification (roundtable #${rtId} awaiting human).` +
    violations.map((v) => `\n  - ${v}`).join('') +
    '\n\nExpected shape: Q1 multiSelect=true (agreements); Q2..Qn radio (disagreements); total ≤4.';
  return `${jqCompact({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      additionalContext: message,
    },
  })}\n`;
}

export function roundtableAuqShape(payload: string, env: NodeJS.ProcessEnv): GateResult {
  try {
    const echoed = `${commandSubstitution(payload)}\n`;
    if (commandSubstitution(jqFieldOr(echoed, 'tool_name')) !== 'AskUserQuestion') return ALLOW;
    const db = dbPath(env);
    if (db === null || db === '' || !haveSqlite(env)) return ALLOW;
    const rtId = sqliteRo(db, AWAITING_SQL, env);
    if (rtId === '') return ALLOW;
    const violations = shapeViolations(echoed);
    if (violations === null || violations.length === 0) return ALLOW;
    return { stdout: shapeAsk(rtId, violations), code: 0 };
  } catch {
    return ALLOW;
  }
}
