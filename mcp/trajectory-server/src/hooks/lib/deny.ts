/**
 * The one place a hook builds a deny or a block (GH 1914). Every reason ends
 * with the agent's next move: ` Allowed form: <exact command or call>` when a
 * safe form of the action exists, else ` This is policy: stop and report.`.
 * `fix` is required, so a deny that states no next move does not compile, and
 * hook-deny-fix.test.ts admits deny JSON from no other file under src/hooks/.
 */
import type { GateResult } from '../gate.js';
import { jqCompact } from './jq.js';

export type DenyFix = { readonly allowed: string } | 'policy';

export const ALLOWED_FORM = ' Allowed form: ';
export const POLICY_ENDING = ' This is policy: stop and report.';

/** <reason> with its trailing whitespace dropped and the ending <fix> names. */
export function fixedReason(reason: string, fix: DenyFix): string {
  const text = reason.replace(/\s+$/, '');
  return fix === 'policy' ? `${text}${POLICY_ENDING}` : `${text}${ALLOWED_FORM}${fix.allowed}`;
}

/** Whether <reason> ends with one of the two endings. */
export function endsWithFix(reason: string): boolean {
  if (reason.endsWith(POLICY_ENDING)) return true;
  const at = reason.lastIndexOf(ALLOWED_FORM);
  return at >= 0 && reason.slice(at + ALLOWED_FORM.length).trim() !== '';
}

function preToolUseDeny(reason: string): unknown {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** The PreToolUse deny JSON line (no newline), as `jq -nc` prints it. */
export function denyJson(reason: string, fix: DenyFix): string {
  return jqCompact(preToolUseDeny(fixedReason(reason, fix)));
}

/** The PreToolUse deny as a gate result. */
export function denyResult(reason: string, fix: DenyFix): GateResult {
  return { stdout: `${denyJson(reason, fix)}\n`, code: 0 };
}

/** The `{decision: 'block', reason}` JSON line (no newline) of a Stop, SubagentStop or PostToolUse block. */
export function blockJson(reason: string, fix: DenyFix): string {
  return jqCompact({ decision: 'block', reason: fixedReason(reason, fix) });
}

export function blockResult(reason: string, fix: DenyFix): GateResult {
  return { stdout: `${blockJson(reason, fix)}\n`, code: 0 };
}

/**
 * A PreToolUse deny whose reason is machine-readable JSON: <failure> with a
 * `fix` key ({allowed} or "policy") in place of the text ending.
 */
export function structuredDenyResult(failure: object, fix: DenyFix): GateResult {
  return { stdout: `${jqCompact(preToolUseDeny(JSON.stringify({ ...failure, fix })))}\n`, code: 0 };
}

/**
 * The router's re-emit of a reason that already carries its ending: a deny
 * on PreToolUse, a block on any other event, as JSON.stringify prints it.
 */
export function passthroughDeny(reason: string, event: string): string {
  const output = event === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } } : { decision: 'block', reason };
  return `${JSON.stringify(output)}\n`;
}
