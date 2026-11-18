/**
 * The named groups readers test tasks.status by (GH 3224). The states
 * themselves are TASK_STATUSES in task-status.ts; the moves between them are
 * the stateDiagram in docs/architecture/TASKS.md "Task lifecycle".
 *
 * Each group lists its member states explicitly, so a state outside every
 * group matches none and a new state never slips into a reader by default.
 * A group is reader meaning, not storage: groups may overlap.
 *
 * An agile task closed into the review queue is `closed` with its queue audit
 * row, so DONE covers it and no group names it apart.
 */
import { TASK_STATUSES, type TaskStatus } from './task-status.js';

export { TASK_STATUSES, type TaskStatus };

export type TaskStateGroup = readonly TaskStatus[];

/** One state by name, for a site that means exactly that state. */
export const TASK_STATE: { readonly [S in TaskStatus]: S } = {
  pending: 'pending',
  running: 'running',
  submitted: 'submitted',
  failed: 'failed',
  closed: 'closed',
  superseded: 'superseded',
  cancelled: 'cancelled',
};

/** Work not yet finished: provisioned or with its author. */
export const IN_PROGRESS: TaskStateGroup = ['pending', 'running'];

/** Provisioned or with its author now. */
export const ACTIVE: TaskStateGroup = ['pending', 'running'];

/** What bro dispatches next: a provisioned task, or a failed one to retry. */
export const ACTIONABLE: TaskStateGroup = ['pending', 'failed'];

/** The author submitted the work and the task waits on review or bro's close. */
export const AWAITING_CLOSE: TaskStateGroup = ['submitted'];

/** Still on its way to a close: in progress or awaiting close. */
export const LIVE: TaskStateGroup = ['pending', 'running', 'submitted'];

/** Closed by bro, agile-queued closes included. */
export const DONE: TaskStateGroup = ['closed'];

/** Final: retried as a new task, or its work stopped with no task picking it up. No move leaves either. */
export const FINAL: TaskStateGroup = ['superseded', 'cancelled'];

/** Stopped short of a close: failed, retried as a new task, or cancelled. */
export const TERMINAL_FAILED: TaskStateGroup = ['failed', ...FINAL];

/** No more work is expected on the task as it stands: done or stopped. */
export const TERMINAL: TaskStateGroup = [...DONE, ...TERMINAL_FAILED];

/** Every state of the given groups, each once, in TASK_STATUSES order. */
export function unionOf(...groups: TaskStateGroup[]): TaskStateGroup {
  const members = new Set<TaskStatus>(groups.flat());
  return TASK_STATUSES.filter((s) => members.has(s));
}

/** True when `status` is a member of `group`; an unknown or missing status is in no group. */
export function inGroup(group: TaskStateGroup, status: string | null | undefined): boolean {
  return (group as readonly string[]).includes(status ?? '');
}

/** The group as a SQL list of quoted literals: `'a', 'b'`. */
export function sqlList(group: TaskStateGroup): string {
  return group.map((s) => `'${s}'`).join(', ');
}

/** `<alias>.status IN (...)`, or `status IN (...)` with an empty alias. */
export function statusIn(alias: string, group: TaskStateGroup): string {
  return `${alias === '' ? '' : `${alias}.`}status IN (${sqlList(group)})`;
}

/** The two states of an issue row. */
export const ISSUE_STATE = { open: 'open', closed: 'closed' } as const;
