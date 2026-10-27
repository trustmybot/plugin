/**
 * The TypeScript hook gates, by name. dispatch.sh runs a gate through
 * `node dist/hooks.js <gate>` only when its name is a line of
 * dist/hooks-gates.txt, which the build writes from gateNames().
 */
import type { Gate } from './gate.js';
import { askuserquestionLengthLint } from './askuserquestion-length-lint.js';
import { containmentGuard } from './containment-guard.js';
import { ensureMcpDepsInstalled } from './ensure-mcp-deps-installed.js';
import { GATE_NAME as GIT_GUARDS_GATE, gitGuards } from './git-guards.js';
import { GATE_NAME as PUSH_GUARD_GATE, gitPushGuard } from './git-push-guard.js';
import { GATE_NAME as PREFLIGHT_GATE, codeReviewerPreflight } from './code-reviewer-preflight.js';
import { GATE_NAME as SPAWN_NOTE_GATE, codeReviewerSpawnNote } from './code-reviewer-spawn-note.js';
import { GATE_NAME as REWORK_GATE, reworkLimit } from './rework-limit.js';
import { GATE_NAME as SWE_BOUNDARY_GATE, sweBoundary } from './swe-boundary.js';
import { GATE_NAME as SWE_RESUME_GATE, sweResumeGate } from './swe-resume-gate.js';
import { GATE_NAME as SWE_STOP_CAUSE_GATE, sweStopCause } from './swe-stop-cause.js';
import { GATE_NAME as OVERRUN_GATE, taskOverrunAlert } from './task-overrun-alert.js';
import { GATE_NAME as TOOL_OUTPUT_SIZE_GATE, toolOutputSize } from './tool-output-size.js';

const GATES: ReadonlyMap<string, Gate> = new Map<string, Gate>([
  ['askuserquestion-length-lint', askuserquestionLengthLint],
  ['containment-guard', containmentGuard],
  ['ensure-mcp-deps-installed', ensureMcpDepsInstalled],
  [GIT_GUARDS_GATE, gitGuards],
  [PUSH_GUARD_GATE, gitPushGuard],
  [PREFLIGHT_GATE, codeReviewerPreflight],
  [SPAWN_NOTE_GATE, codeReviewerSpawnNote],
  [REWORK_GATE, reworkLimit],
  [SWE_BOUNDARY_GATE, sweBoundary],
  [SWE_RESUME_GATE, sweResumeGate],
  [SWE_STOP_CAUSE_GATE, sweStopCause],
  [OVERRUN_GATE, taskOverrunAlert],
  [TOOL_OUTPUT_SIZE_GATE, toolOutputSize],
]);

export function findGate(name: string): Gate | undefined {
  return GATES.get(name);
}

export function gateNames(): string[] {
  return [...GATES.keys()].sort();
}
