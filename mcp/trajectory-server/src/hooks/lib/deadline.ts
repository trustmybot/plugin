/**
 * The running router gate's deadline (GH 1692 R1, decision 922): the router
 * arms it before each gate, at the gate's start plus the smaller of its
 * budget and the group's time left, and disarms it after. Every sync spawn a
 * gate makes takes max(1, deadline - now) as its timeout, so no child outlives
 * the gate's budget; a spawn the deadline cuts off (ETIMEDOUT or a signal)
 * marks the gate over budget whatever the gate then returns.
 */
import { performance } from 'node:perf_hooks';

interface Armed {
  at: number;
  now: () => number;
  expired: boolean;
}

let armed: Armed | null = null;

export function armDeadline(at: number, now: () => number = () => performance.now()): void {
  armed = { at, now, expired: false };
}

/** Disarms the deadline; true when it cut a spawn off. */
export function disarmDeadline(): boolean {
  const expired = armed?.expired ?? false;
  armed = null;
  return expired;
}

export interface SpawnLimit {
  timeout: number;
  killSignal: NodeJS.Signals;
  byDeadline: boolean;
}

/**
 * A sync spawn's timeout: max(1, deadline - now) while a deadline is armed,
 * or <ownMs> when the caller has a sooner limit of its own; null with neither.
 */
export function spawnLimit(ownMs?: number, killSignal: NodeJS.Signals = 'SIGTERM'): SpawnLimit | null {
  const left = armed ? Math.max(1, Math.ceil(armed.at - armed.now())) : undefined;
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
  if (cut && limit?.byDeadline && armed) armed.expired = true;
  return cut;
}
