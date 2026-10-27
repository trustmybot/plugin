/**
 * PreToolUse(Agent) gate (GH 1692), the port of
 * scripts/hooks/code-reviewer-spawn-prompt-shape.sh, run by
 * agent-spawn-dispatch.sh: a code-reviewer spawn prompt must carry every
 * anchor of code-reviewer-spawn-note's ANCHORS as name=value, and must not
 * carry a rubber-stamp shortcut. The first failing check denies: the missing
 * anchors, else the first phrase matched. Other agent types and tools are
 * allowed.
 *
 * The prompt is matched line by line as macOS grep matches it in the hook's
 * locale: `[:alnum:]` is ASCII letters and digits on bytes, or Unicode letters
 * and decimal digits by character under a UTF-8 locale; `-i` folds ASCII
 * case only; `.` is one byte, or one character. Unlike the .sh, it needs no
 * jq, so it denies on a machine without jq where the .sh let the spawn
 * through (decision 703). Bypass: TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE=1.
 */
import { ALLOW, type SyncGate } from './gate.js';
import { ANCHORS } from './code-reviewer-spawn-note.js';
import { isCodeReviewerSpawn, spawnDeny, spawnField } from './code-reviewer-no-worktree.js';
import { grepAlnum, grepMultibyte } from './lib/lint-shell.js';

export const GATE_NAME = 'code-reviewer-spawn-prompt-shape';
export const BYPASS_ENV = 'TMB_SKIP_CODE_REVIEWER_PROMPT_SHAPE';

/** The `grep -i` patterns, in the order the .sh tries them; `.` is any one character. */
export const RUBBER_STAMP_PHRASES = ['trust the prior verdict', 'fast-track if', 'rubber.stamp', 'prior verdict'] as const;

const ANCHOR_LIST = `${ANCHORS.slice(0, -1).join(', ')}, and ${ANCHORS[ANCHORS.length - 1]}`;

export function missingAnchorsReason(missing: readonly string[]): string {
  return (
    `BLOCKED: code-reviewer spawn prompt missing required anchors:${missing.map((a) => ` ${a}`).join('')}.\n\n` +
    `Per tmb_push-gate, the prompt MUST contain ${ANCHOR_LIST}, each as name=value, so code-reviewer can load context ` +
    'independently and author its validation_record verdict. Do not pre-summarize findings — pass only the bare anchors plus a one-line context summary.'
  );
}

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

/** The anchors no line carries as `(^|[^[:alnum:]_])<anchor>=`, in ANCHORS order. */
export function missingAnchors(prompt: string, multibyte: boolean): string[] {
  const lines = grepLines(prompt, multibyte);
  const flags = multibyte ? 'u' : '';
  return ANCHORS.filter((anchor) => {
    const re = new RegExp(`(?:^|[^${grepAlnum(multibyte)}_])${anchor}=`, flags);
    return !lines.some((line) => re.test(line));
  });
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
  const missing = missingAnchors(prompt, multibyte);
  if (missing.length > 0) return spawnDeny(missingAnchorsReason(missing));
  const phrase = rubberStampPhrase(prompt, multibyte);
  return phrase === null ? ALLOW : spawnDeny(rubberStampReason(phrase));
};
