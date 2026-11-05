/**
 * The opt-in downstream-context A/B (GH 1990). The world-model tools ship to
 * every swe and code-reviewer; the A/B turns the two context hooks
 * (swe-downstream-context, reviewer-downstream-context) on or off per task.
 * With plugin_config.downstream_context_ab set to {label, target,
 * tools_shipped_at}, the first hook call for a task enrolls it while fewer
 * than `target` tasks carry the label: its arm is `on` when floor(id / 2) is
 * odd, else `off`, which is orthogonal to the effort A/B's id parity
 * (effort-ab.ts), recorded by one downstream_context_ab_enrolled audit row.
 * A task already enrolled keeps its recorded arm. Unset, `{}` or malformed is
 * off, and so is a task left out once the target is reached.
 */
import type { DownstreamContextAbConfig } from './tools/config.js';

export const DOWNSTREAM_AB_EVENT = 'downstream_context_ab_enrolled';
export const DOWNSTREAM_INJECTED_EVENT = 'downstream_context_injected';
export const DOWNSTREAM_AB_ARMS = ['on', 'off'] as const;

export type DownstreamArm = (typeof DOWNSTREAM_AB_ARMS)[number];

export function downstreamContextArm(taskId: number): DownstreamArm {
  return Math.floor(taskId / 2) % 2 === 1 ? 'on' : 'off';
}

export function isDownstreamArm(value: unknown): value is DownstreamArm {
  return (DOWNSTREAM_AB_ARMS as readonly unknown[]).includes(value);
}

/** The reads and the one write enrollment needs; null from a read means it failed. */
export interface DownstreamAbStore {
  config(): DownstreamContextAbConfig | null;
  enrolledArm(label: string, taskId: number): DownstreamArm | 'none' | null;
  enrolledCount(label: string): number | null;
  enroll(label: string, arm: DownstreamArm, taskId: number): boolean;
}

/**
 * The task's arm, enrolling it on the way when the A/B is on and the target
 * is not reached; null when the A/B is off, the task stays out, or a read or
 * the write fails.
 */
export function enrollDownstreamContextAb(store: DownstreamAbStore, taskId: number): DownstreamArm | null {
  if (!Number.isInteger(taskId) || taskId <= 0) return null;
  const ab = store.config();
  if (!ab) return null;
  const recorded = store.enrolledArm(ab.label, taskId);
  if (recorded === null) return null;
  if (recorded !== 'none') return recorded;
  const count = store.enrolledCount(ab.label);
  if (count === null || count >= ab.target) return null;
  const arm = downstreamContextArm(taskId);
  return store.enroll(ab.label, arm, taskId) ? arm : null;
}
