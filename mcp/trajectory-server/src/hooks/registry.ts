/**
 * The TypeScript hook gates, by name. dispatch.sh runs a gate through
 * `node dist/hooks.js <gate>` only when its name is a line of
 * dist/hooks-gates.txt, which the build writes from gateNames().
 */
import type { Gate } from './gate.js';
import { askuserquestionLengthLint } from './askuserquestion-length-lint.js';
import { ensureMcpDepsInstalled } from './ensure-mcp-deps-installed.js';

const GATES: ReadonlyMap<string, Gate> = new Map<string, Gate>([
  ['askuserquestion-length-lint', askuserquestionLengthLint],
  ['ensure-mcp-deps-installed', ensureMcpDepsInstalled],
]);

export function findGate(name: string): Gate | undefined {
  return GATES.get(name);
}

export function gateNames(): string[] {
  return [...GATES.keys()].sort();
}
