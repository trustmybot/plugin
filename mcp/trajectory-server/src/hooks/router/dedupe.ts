/**
 * dispatch.sh's per-call dedupe, ported for the router: one run per (event,
 * session_id, tool_name, tool_input, tool_use_id), per (SessionStart,
 * session_id) as dispatch.sh keys that event, or per whole payload when it has
 * no tool_name, the gate left out of the key since the router runs them all and
 * the part in it, so parts of one event never answer for each other. The first
 * call creates <state>/locks/events/<key>/ (mkdir is the lock), writes its
 * deadline, decides, and stores result, stderr and rc; a duplicate waits up to
 * the router's timeout minus 1 s and replays only a deny, or the whole outcome
 * when the event's answer is its stdout and exit (replayAll). A result answers
 * duplicates for TMB_DISPATCH_WINDOW_S (5 s); expired locks are reclaimed
 * under <lock>.reclaim, and a sweep at most every TMB_DISPATCH_SWEEP_S (60 s)
 * prunes results older than TMB_DISPATCH_TTL_MIN (10 min) and dead locks.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Emitted {
  stdout: string;
  stderr: string;
  code: number;
}

export type Claim = { kind: 'hold'; lock: string } | { kind: 'replay'; out: Emitted } | { kind: 'none' };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function callMaterial(p: Record<string, unknown>, event: string | undefined): unknown {
  if ('tool_name' in p) return [p.hook_event_name ?? '', p.session_id ?? '', p.tool_name, p.tool_input ?? null, p.tool_use_id ?? ''];
  return event === 'SessionStart' ? [event, p.session_id ?? ''] : p;
}

/** The lock key of a payload for <event> and <part>; null when the payload is not an object. */
export function dedupeKey(payload: string, event?: string, part?: string): string | null {
  let o: unknown;
  try {
    o = JSON.parse(payload);
  } catch {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const p = o as Record<string, unknown>;
  const call = callMaterial(p, event);
  return createHash('sha256').update(canonicalJson(part === undefined ? call : [call, part])).digest('hex');
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name] ?? '';
  return /^[0-9]+$/.test(v) ? Number(v) : fallback;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function stamp(file: string): number | null {
  try {
    const line = readFileSync(file, 'utf8').split('\n')[0];
    return /^[0-9]+$/.test(line) ? Number(line) : null;
  } catch {
    return null;
  }
}

function ageS(path: string): number | null {
  try {
    return nowS() - Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return null;
  }
}

export class Dedupe {
  readonly base: string;
  private readonly ttlMin: number;
  private readonly windowS: number;
  private readonly sweepS: number;

  constructor(
    base: string,
    private readonly timeoutS: number,
    env: NodeJS.ProcessEnv,
    private readonly replayAll: boolean = false,
  ) {
    this.base = base;
    this.ttlMin = intEnv(env, 'TMB_DISPATCH_TTL_MIN', 10);
    this.windowS = intEnv(env, 'TMB_DISPATCH_WINDOW_S', 5);
    this.sweepS = intEnv(env, 'TMB_DISPATCH_SWEEP_S', 60);
  }

  private expired(lock: string): boolean {
    const done = existsSync(`${lock}/rc`);
    if (!done) {
      const deadline = stamp(`${lock}/deadline`);
      if (deadline !== null) return nowS() > deadline;
    }
    const age = ageS(lock);
    if (age === null) return false;
    return done ? age > this.windowS : age > this.timeoutS;
  }

  private sweep(): void {
    const stampFile = `${this.base}.sweep`;
    const now = nowS();
    const last = stamp(stampFile);
    if (last !== null && last <= now && now - last < this.sweepS) return;
    try {
      writeFileSync(stampFile, `${now}\n`);
    } catch {
      /* the sweep still runs */
    }
    let names: string[];
    try {
      names = readdirSync(this.base);
    } catch {
      return;
    }
    for (const name of names) {
      const d = `${this.base}/${name}`;
      let st;
      try {
        st = statSync(d);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const ageMin = (Date.now() - st.mtimeMs) / 60_000;
      const done = existsSync(`${d}/rc`);
      const deadline = done ? null : stamp(`${d}/deadline`);
      const gone =
        (done && ageMin > this.ttlMin) || (!done && deadline === null && ageMin > this.ttlMin * 3) || (!done && deadline !== null && now > deadline);
      if (gone) rmSync(d, { recursive: true, force: true });
    }
  }

  private take(lock: string): boolean {
    try {
      mkdirSync(lock);
    } catch {
      return false;
    }
    try {
      writeFileSync(`${lock}/deadline`, `${nowS() + this.timeoutS + 5}\n`);
    } catch {
      /* without a deadline the lock expires by age */
    }
    return true;
  }

  private replay(lock: string): Emitted | null {
    let rc: number;
    try {
      const text = readFileSync(`${lock}/rc`, 'utf8').trim();
      if (!/^[0-9]+$/.test(text)) return null;
      rc = Number(text);
    } catch {
      return null;
    }
    const read = (f: string) => {
      try {
        return readFileSync(`${lock}/${f}`, 'utf8');
      } catch {
        return '';
      }
    };
    const result = read('result');
    if (this.replayAll) return { stdout: result, stderr: read('stderr'), code: rc };
    if (rc === 2) return { stdout: result, stderr: read('stderr'), code: 2 };
    const denies = result.split('\n').some((line) => {
      try {
        return (JSON.parse(line) as { hookSpecificOutput?: { permissionDecision?: unknown } }).hookSpecificOutput?.permissionDecision === 'deny';
      } catch {
        return false;
      }
    });
    return denies ? { stdout: result, stderr: '', code: rc } : { stdout: '', stderr: '', code: 0 };
  }

  private reclaim(lock: string): boolean {
    const mutex = `${lock}.reclaim`;
    try {
      mkdirSync(mutex);
    } catch {
      const age = ageS(mutex);
      if (age !== null && age > 30) rmSync(mutex, { recursive: true, force: true });
      return false;
    }
    try {
      if (!existsSync(lock) || this.expired(lock)) {
        rmSync(lock, { recursive: true, force: true });
        return this.take(lock);
      }
      return false;
    } finally {
      rmSync(mutex, { recursive: true, force: true });
    }
  }

  /** hold: this call decides and stores; replay: a duplicate's answer; none: a duplicate that gave up. */
  async claim(key: string): Promise<Claim> {
    this.sweep();
    const lock = `${this.base}/${key}`;
    const giveUp = nowS() + Math.max(1, this.timeoutS - 1);
    for (;;) {
      if (this.take(lock)) return { kind: 'hold', lock };
      if (existsSync(`${lock}/rc`) && !this.expired(lock)) {
        const out = this.replay(lock);
        return out === null ? { kind: 'none' } : { kind: 'replay', out };
      }
      if (this.expired(lock) && this.reclaim(lock)) return { kind: 'hold', lock };
      if (nowS() >= giveUp) return { kind: 'none' };
      await sleep(100);
    }
  }

  static store(lock: string, out: Emitted): void {
    try {
      writeFileSync(`${lock}/result`, out.stdout);
      writeFileSync(`${lock}/stderr`, out.stderr);
      writeFileSync(`${lock}/rc.tmp`, `${out.code}\n`);
      renameSync(`${lock}/rc.tmp`, `${lock}/rc`);
    } catch {
      /* duplicates fall back to their wait */
    }
  }
}
