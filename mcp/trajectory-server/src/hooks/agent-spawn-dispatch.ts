/**
 * TypeScript port of scripts/hooks/agent-spawn-dispatch.sh (GH 1692), the
 * PreToolUse(Agent) dispatcher: it runs the nine spawn gates of CHAIN in
 * order, in-process through the gate lookup it is given, with their stderr
 * dropped. The first deny is printed verbatim and ends the run. Otherwise the
 * PREPARE steps (ensure-swe-worktree, record-swe-spawn) run fail-open, and
 * the gates' additionalContext parts, joined by a `---` line, come out as one
 * PreToolUse additionalContext. It always exits 0.
 *
 * Unlike the .sh, it needs no jq, so a machine without jq still runs the
 * chain where the .sh exited 1 with "agent-spawn-dispatch: jq not found"
 * (decision 703).
 */
import type { Gate, GateResult } from './gate.js';
import { ALLOW } from './gate.js';
import { jqCompact } from './lib/jq.js';
import { jqCapture, jqInput } from './lib/jq-raw.js';
import { commandSubstitution } from './lib/project-env.js';

export const GATE_NAME = 'agent-spawn-dispatch';

export const CHAIN: readonly string[] = [
  'require-task-spec',
  'require-spawn-effort',
  'require-feature-branch-active',
  'code-reviewer-no-worktree',
  'code-reviewer-spawn-prompt-shape',
  'code-reviewer-after-atomic-close',
  'code-reviewer-spawn-note',
  'code-reviewer-preflight',
  'rework-limit',
];

export const PREPARE: readonly string[] = ['ensure-swe-worktree', 'record-swe-spawn'];

export const CONTEXT_SEPARATOR = '\n\n---\n\n';

export type GateLookup = (name: string) => Gate | undefined;

/** `$(printf '%s' "$INPUT" | <gate> 2>/dev/null) || true`: the gate's stdout, "" when it is missing or throws. */
async function quietly(gate: Gate | undefined, input: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (gate === undefined) return '';
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return (await gate(input, env)).stdout;
  } catch {
    return '';
  } finally {
    process.stderr.write = write;
  }
}

export async function agentSpawnDispatch(payload: string, env: NodeJS.ProcessEnv, find: GateLookup): Promise<GateResult> {
  const input = commandSubstitution(payload);
  const parts: string[] = [];
  for (const name of CHAIN) {
    const out = commandSubstitution(await quietly(find(name), input, env));
    if (out === '') continue;
    const reply = jqInput(out);
    if (jqCapture(reply, ['hookSpecificOutput', 'permissionDecision']) === 'deny') return { stdout: `${out}\n`, code: 0 };
    const ctx = jqCapture(reply, ['hookSpecificOutput', 'additionalContext']);
    if (ctx !== '') parts.push(ctx);
  }
  for (const name of PREPARE) await quietly(find(name), input, env);
  if (parts.length === 0) return ALLOW;
  const merged = parts.join(CONTEXT_SEPARATOR);
  return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: merged } })}\n`, code: 0 };
}
