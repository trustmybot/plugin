/**
 * PreToolUse(Agent) gate (GH 1692), run by agent-spawn-dispatch: a code-reviewer spawn prompt must carry every
 * anchor of code-reviewer-spawn-note's ANCHORS, or every one of its
 * BATCH_ANCHORS for a grouped agile review, as name=value, and must not
 * carry a rubber-stamp shortcut. The first failing check denies: the missing
 * anchors of the closer set, else the first phrase matched. Other agent types
 * and tools are allowed.
 *
 * The prompt is matched line by line as macOS grep matches it in the hook's
 * locale: `[:alnum:]` is ASCII letters and digits on bytes, or Unicode letters
 * and decimal digits by character under a UTF-8 locale; `-i` folds ASCII
 * case only; `.` is one byte, or one character. It needs no jq. Bypass:
 * TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE=1.
 */
import { ALLOW, type SyncGate } from './gate.js';
import { ANCHORS, BATCH_ANCHORS } from './code-reviewer-spawn-note.js';
import { isCodeReviewerSpawn, spawnDeny, spawnField } from './code-reviewer-no-worktree.js';
import type { DenyFix } from './lib/deny.js';
import { grepAlnum, grepMultibyte } from './lib/lint-shell.js';

export const GATE_NAME = 'code-reviewer-spawn-prompt-shape';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE';

/** The `grep -i` patterns, in the order they are tried; `.` is any one character. */
export const RUBBER_STAMP_PHRASES = ['trust the prior verdict', 'fast-track if', 'rubber.stamp', 'prior verdict'] as const;

const anchorList = (anchors: readonly string[]): string => `${anchors.slice(0, -1).join(', ')}, and ${anchors[anchors.length - 1]}`;

/** The deny reason for <missing> anchors of <anchors>, the task set (ANCHORS) or a grouped review's (BATCH_ANCHORS). */
export function missingAnchorsReason(missing: readonly string[], anchors: readonly string[] = ANCHORS): string {
  const verdict = anchors === BATCH_ANCHORS ? 'review_batch_record' : 'validation_record';
  return (
    `BLOCKED: code-reviewer spawn prompt missing required anchors:${missing.map((a) => ` ${a}`).join('')}.\n\n` +
    `Per tmb_push-gate, the prompt MUST contain ${anchorList(anchors)}, each as name=value, so code-reviewer can load context ` +
    `independently and author its ${verdict} verdict. Do not pre-summarize findings.`
  );
}

export function missingAnchorsFix(missing: readonly string[]): DenyFix {
  return { allowed: `the same spawn with${missing.map((a) => ` ${a}=<value>`).join('')} in its prompt, plus only a one-line context summary` };
}

export const RUBBER_STAMP_FIX: DenyFix = { allowed: 'the same spawn with only the bare anchors and a one-line context summary in its prompt' };

export function rubberStampReason(phrase: string): string {
  return (
    `BLOCKED: code-reviewer spawn prompt contains a rubber-stamp shortcut (matched: "${phrase}").\n\n` +
    'Per tmb_push-gate, the prompt MUST NOT contain the prior verdict text or shortcuts that allow rubber-stamping. ' +
    'The reviewer must derive findings from the spec + diff itself.'
  );
}

/** The prompt's lines as grep reads them: by character under a UTF-8 locale, else by byte (one latin1 char each). */
function grepLines(prompt: string, multibyte: boolean): string[] {
  const text = multibyte ? prompt : Buffer.from(prompt, 'utf8').toString('latin1');
  return text.split('\n');
}

/** The anchors of <anchors> no line carries as `(^|[^[:alnum:]_])<anchor>=`, in their order. */
export function missingAnchors(prompt: string, multibyte: boolean, anchors: readonly string[] = ANCHORS): string[] {
  const lines = grepLines(prompt, multibyte);
  const flags = multibyte ? 'u' : '';
  return anchors.filter((anchor) => {
    const re = new RegExp(`(?:^|[^${grepAlnum(multibyte)}_])${anchor}=`, flags);
    return !lines.some((line) => re.test(line));
  });
}

/**
 * The anchor set the prompt is judged by: an allowlist of the task set and
 * the batch set. Complete in either, that set with nothing missing; else the
 * set it carries more anchors of (the task set on a tie), with its missing ones.
 */
export function closestAnchorSet(prompt: string, multibyte: boolean): { anchors: readonly string[]; missing: string[] } {
  const task = missingAnchors(prompt, multibyte, ANCHORS);
  if (task.length === 0) return { anchors: ANCHORS, missing: task };
  const batch = missingAnchors(prompt, multibyte, BATCH_ANCHORS);
  if (batch.length === 0) return { anchors: BATCH_ANCHORS, missing: batch };
  return BATCH_ANCHORS.length - batch.length > ANCHORS.length - task.length
    ? { anchors: BATCH_ANCHORS, missing: batch }
    : { anchors: ANCHORS, missing: task };
}

function phraseRegExp(phrase: string, multibyte: boolean): RegExp {
  const source = [...phrase].map((ch) => (ch === '.' ? '[^\\n]' : ch.replace(/[\\^$*+?()[\]{}|/]/g, '\\$&'))).join('');
  return new RegExp(source, multibyte ? 'u' : '');
}

/** The first RUBBER_STAMP_PHRASES pattern some line matches under `grep -i`, or null. */
export function rubberStampPhrase(prompt: string, multibyte: boolean): string | null {
  const lines = grepLines(prompt, multibyte).map((line) => line.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  return RUBBER_STAMP_PHRASES.find((phrase) => lines.some((line) => phraseRegExp(phrase, multibyte).test(line))) ?? null;
}

export const codeReviewerSpawnPromptShape: SyncGate = (payload, env) => {
  if (env[BYPASS_ENV] === '1') return ALLOW;
  if (!isCodeReviewerSpawn(payload)) return ALLOW;
  const prompt = spawnField(payload, 'tool_input', 'prompt');
  const multibyte = grepMultibyte(env);
  const { anchors, missing } = closestAnchorSet(prompt, multibyte);
  if (missing.length > 0) return spawnDeny(missingAnchorsReason(missing, anchors), missingAnchorsFix(missing));
  const phrase = rubberStampPhrase(prompt, multibyte);
  return phrase === null ? ALLOW : spawnDeny(rubberStampReason(phrase), RUBBER_STAMP_FIX);
};
