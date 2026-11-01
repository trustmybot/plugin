/**
 * The running router gate's deadline (GH 1692 R1 and R-async, decisions 922 and
 * 937): the router runs each gate inside runWithDeadline, at the gate's start
 * plus the smaller of its budget and the group's time left. The scope follows
 * the gate through its awaits, so overlapping gates each read their own. An
 * async git takes the scope's AbortSignal and a sync spawn takes
 * max(1, deadline - now) as its timeout, so no child outlives the gate's budget;
 * a spawn the deadline cuts off (ETIMEDOUT or a signal) marks the gate over
 * budget whatever the gate then returns. Outside a scope there is no deadline.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

interface DeadlineScope {
  at: number;
  now: () => number;
  expired: boolean;
  signal: AbortSignal;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

const scopes = new AsyncLocalStorage<DeadlineScope>();

function msLeft(at: number, now: () => number): number {
  return Math.max(1, Math.ceil(at - now()));
}

/** Runs <body> under a deadline at <at>; `expired` is true when it cut a spawn off. */
export async function runWithDeadline<T>(at: number, body: () => T | Promise<T>, now: () => number = () => performance.now()): Promise<{ value: T; expired: boolean }> {
  const scope: DeadlineScope = { at, now, expired: false, signal: AbortSignal.timeout(Math.min(MAX_TIMER_MS, msLeft(at, now))) };
  const value = await scopes.run(scope, body);
  return { value, expired: scope.expired };
}

/** The running scope's signal, aborted at its deadline; undefined outside a scope. */
export function deadlineSignal(): AbortSignal | undefined {
  return scopes.getStore()?.signal;
}

export interface SpawnLimit {
  timeout: number;
  killSignal: NodeJS.Signals;
  byDeadline: boolean;
}

/**
 * A spawn's timeout: max(1, deadline - now) inside a deadline scope, or <ownMs>
 * when the caller has a sooner limit of its own; null with neither.
 */
export function spawnLimit(ownMs?: number, killSignal: NodeJS.Signals = 'SIGTERM'): SpawnLimit | null {
  const scope = scopes.getStore();
  const left = scope ? msLeft(scope.at, scope.now) : undefined;
  if (left === undefined || (ownMs !== undefined && ownMs < left)) {
    return ownMs === undefined ? null : { timeout: ownMs, killSignal, byDeadline: false };
  }
  return { timeout: left, killSignal, byDeadline: true };
}

export function spawnOptions(limit: SpawnLimit | null): { timeout?: number; killSignal?: NodeJS.Signals } {
  return limit ? { timeout: limit.timeout, killSignal: limit.killSignal } : {};
}

/** Whether the spawn was cut off (ETIMEDOUT or a signal); a cut the deadline set marks the gate over budget. */
export function noteSpawn(limit: SpawnLimit | null, r: { error?: Error; signal: NodeJS.Signals | null }): boolean {
  const cut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal !== null;
  const scope = scopes.getStore();
  if (cut && limit?.byDeadline && scope) scope.expired = true;
  return cut;
}
