/**
 * The suite-slot lock (GH 2092): isFullSuite's denylist, the slot count, the
 * lock root rule, reclaim of a dead holder's slot under the reclaim mutex,
 * nesting through TMB_SUITE_LOCK_HELD, and dist/test-run.js serializing full
 * suites while a targeted command runs straight away. Then the waiter queue
 * (GH 2297): waiters take the slot first come first served, a stale ticket is
 * skipped and removed, and a waiter that can't write a ticket still acquires.
 * Every case points TMB_SUITE_LOCK_DIR at its own temp dir.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSuiteSlot, isFullSuite, readHolder, SUITE_LOCK_HELD_ENV, suiteLockRoot, suiteSlots, type SlotResult } from '../suite-lock.js';

const WRAPPER = resolve(dirname(fileURLToPath(import.meta.url)), '../test-run.js');
const RUN_ALL = `#!/usr/bin/env bash
stamp() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
printf 'start %s %s\\n' "$1" "$(stamp)" >> "$MARKS"
if [ -n "\${RENDEZVOUS:-}" ]; then
  i=0
  until [ "$(grep -c '^start' "$MARKS")" -ge 2 ] || [ "$i" -ge 200 ]; do sleep 0.05; i=$((i + 1)); done
fi
sleep "\${HOLD_S:-0.5}"
printf 'end %s %s\\n' "$1" "$(stamp)" >> "$MARKS"
`;

let base: string;
let n = 0;

function freshDir(name: string): string {
  const dir = join(base, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lockEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMB_SUITE_LOCK_DIR: root, TMB_TEST_SUITE_SLOTS: '1' };
  delete env[SUITE_LOCK_HELD_ENV];
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function held(r: SlotResult): Extract<SlotResult, { kind: 'held' }> {
  assert.equal(r.kind, 'held');
  return r as Extract<SlotResult, { kind: 'held' }>;
}

function deadPid(): number {
  const r = spawnSync('true');
  assert.equal(typeof r.pid, 'number');
  return r.pid as number;
}

function ago(path: string, seconds: number): void {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(path, t, t);
}

async function waitFor(what: string, ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface Wrapped {
  child: ChildProcess;
  stderr: () => string;
  done: Promise<number>;
}

function testRun(work: string, command: string, env: NodeJS.ProcessEnv, detached = false): Wrapped {
  const child = spawn(process.execPath, [WRAPPER, '--log', join(work, `run-${n++}.log`), '--', command], {
    cwd: work,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached,
  });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const done = new Promise<number>((ok) => child.on('exit', (code, signal) => ok(code ?? (signal !== null ? 128 : 1))));
  return { child, stderr: () => err, done };
}

function workDir(): string {
  const work = freshDir('work');
  mkdirSync(join(work, 'tests'));
  writeFileSync(join(work, 'tests/run-all.sh'), RUN_ALL);
  writeFileSync(join(work, 'probe.test.js'), "import test from 'node:test';\ntest('probe', () => {});\n");
  return work;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function marks(work: string): Map<string, number> {
  const out = new Map<string, number>();
  const file = join(work, 'marks');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [kind, id, ms] = line.split(' ');
    if (ms !== undefined) out.set(`${kind} ${id}`, Number(ms));
  }
  return out;
}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-suite-lock-')));
});
after(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('isFullSuite', () => {
  const full = [
    'bun run test',
    'npm test',
    'npm run test',
    'pnpm test',
    'pnpm run test',
    'cd mcp/trajectory-server && npm test',
    'bash tests/run-all.sh',
    './tests/run-all.sh --fast',
    'cd mcp/trajectory-server && bun run build && node --experimental-sqlite --test dist/test/*.test.js',
    "node --test 'dist/test/hooks-*.test.js'",
    'node --test',
    'node --experimental-sqlite --test --test-reporter spec',
    'FOO=1 node --test dist/test/x?.test.js',
    'node --test dist/test/[ab].test.js',
  ];
  const targeted = [
    'node --test dist/test/x.test.js',
    'cd mcp/trajectory-server && bun run build && node --experimental-sqlite --test dist/test/suite-lock.test.js dist/test/test-run.test.js',
    'node --test --test-name-pattern "suite*" dist/test/x.test.js',
    'node scripts/maintenance/gen-enums-doc.mjs --doc',
    'node --test tests/l1-lint/changelog-current.test.mjs',
    "grep -q 'suite-lock' mcp/trajectory-server/src/test-run.ts",
    'npm run test:unit',
    'node dist/test/x.js',
    'bun run build',
    '',
  ];
  for (const cmd of full) it(`is true for ${cmd}`, () => assert.equal(isFullSuite(cmd), true));
  for (const cmd of targeted) it(`is false for ${JSON.stringify(cmd)}`, () => assert.equal(isFullSuite(cmd), false));
});

describe('suiteSlots and the lock root', () => {
  it('reads TMB_TEST_SUITE_SLOTS as a positive integer, else 1', () => {
    assert.equal(suiteSlots({}), 1);
    assert.equal(suiteSlots({ TMB_TEST_SUITE_SLOTS: '2' }), 2);
    for (const bad of ['0', '-1', 'abc', '1.5', '']) assert.equal(suiteSlots({ TMB_TEST_SUITE_SLOTS: bad }), 1);
  });
  it('creates TMB_SUITE_LOCK_DIR and refuses a symlinked root', () => {
    const root = join(freshDir('root'), 'a/b');
    assert.equal(suiteLockRoot({ TMB_SUITE_LOCK_DIR: root }), root);
    const link = join(freshDir('root'), 'link');
    symlinkSync(root, link);
    assert.equal(suiteLockRoot({ TMB_SUITE_LOCK_DIR: link }), null);
  });
  it('runs unlocked on an unusable root and warns once', async () => {
    const link = join(freshDir('root'), 'link');
    symlinkSync(freshDir('target'), link);
    let err = '';
    const opts = { command: 'npm test', worktree: base, env: lockEnv(link), stderr: (t: string) => (err += t) };
    assert.deepEqual(await acquireSuiteSlot(opts), { kind: 'unlocked' });
    assert.deepEqual(await acquireSuiteSlot(opts), { kind: 'unlocked' });
    assert.equal(err.match(/running unlocked/g)?.length, 1);
  });
});

describe('acquireSuiteSlot', () => {
  it('writes a holder naming this process and the worktree, and releases only its own slot', async () => {
    const root = freshDir('lock');
    const a = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root) }));
    assert.equal(a.slot, join(root, 'slot-0'));
    const h = readHolder(a.slot);
    assert.equal(h?.pid, process.pid);
    assert.equal(h?.worktree, '/w/a');
    assert.equal(h?.command, 'npm test');
    a.release();
    assert.equal(existsSync(a.slot), false);

    const b = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root) }));
    writeFileSync(join(b.slot, 'holder'), JSON.stringify({ pid: process.pid, worktree: '/w/other', command: 'npm test', started: new Date().toISOString() }));
    b.release();
    assert.equal(readHolder(b.slot)?.worktree, '/w/other');
  });
  it('waits for a live holder, printing the waiting line, then reports busy at maxWaitS', async () => {
    const root = freshDir('lock');
    const a = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root) }));
    let err = '';
    const r = await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 1, stderr: (t) => (err += t) });
    assert.equal(r.kind, 'busy');
    assert.equal(r.kind === 'busy' ? r.holder?.pid : 0, process.pid);
    assert.match(err, new RegExp(`^waiting for a suite slot: held by pid ${process.pid} \\(worktree /w/a\\) for \\d+s\\n$`));
    a.release();
  });
  it('takes the second slot when TMB_TEST_SUITE_SLOTS=2', async () => {
    const root = freshDir('lock');
    const a = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root, { TMB_TEST_SUITE_SLOTS: '2' }) }));
    const b = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root, { TMB_TEST_SUITE_SLOTS: '2' }), maxWaitS: 0 }));
    assert.equal(b.slot, join(root, 'slot-1'));
    a.release();
    b.release();
  });
  it('reclaims a dead holder at once and leaves a stale-looking live holder in place', async () => {
    const root = freshDir('lock');
    const slot = join(root, 'slot-0');
    mkdirSync(slot);
    const live = JSON.stringify({ pid: process.pid, pgid: null, worktree: '/w/live', command: 'npm test', started: '2000-01-01T00:00:00.000Z' });
    writeFileSync(join(slot, 'holder'), live);
    ago(slot, 3600);
    assert.equal((await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 1, stderr: () => {} })).kind, 'busy');
    assert.equal(readFileSync(join(slot, 'holder'), 'utf8'), live);

    writeFileSync(join(slot, 'holder'), JSON.stringify({ pid: deadPid(), worktree: '/w/dead', command: 'npm test', started: new Date().toISOString() }));
    const b = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 0 }));
    assert.equal(readHolder(b.slot)?.worktree, '/w/b');
    b.release();
  });
  it('reclaims nothing while a fresh reclaim mutex is held, and breaks one older than 10 s', async () => {
    const root = freshDir('lock');
    const slot = join(root, 'slot-0');
    mkdirSync(slot);
    writeFileSync(join(slot, 'holder'), JSON.stringify({ pid: deadPid(), worktree: '/w/dead', command: 'npm test', started: new Date().toISOString() }));
    mkdirSync(`${slot}.reclaim`);
    assert.equal((await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 0, stderr: () => {} })).kind, 'busy');
    ago(`${slot}.reclaim`, 60);
    const r = await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 2, stderr: () => {} });
    held(r).release();
  });
  it('treats a slot with no holder file as live for 10 s, then reclaims it', async () => {
    const root = freshDir('lock');
    const slot = join(root, 'slot-0');
    mkdirSync(slot);
    assert.equal((await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 0, stderr: () => {} })).kind, 'busy');
    assert.equal(existsSync(slot), true);
    ago(slot, 60);
    held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 0 })).release();
  });
  it('skips the lock when TMB_SUITE_LOCK_HELD names a live holder, and not a dead one', async () => {
    const root = freshDir('lock');
    const a = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root) }));
    assert.deepEqual(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root, { [SUITE_LOCK_HELD_ENV]: a.slot }), maxWaitS: 0 }), {
      kind: 'nested',
      slot: a.slot,
    });
    writeFileSync(join(a.slot, 'holder'), JSON.stringify({ pid: deadPid(), worktree: '/w/dead', command: 'npm test', started: new Date().toISOString() }));
    held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root, { [SUITE_LOCK_HELD_ENV]: a.slot }), maxWaitS: 0 })).release();
  });
});

describe('the suite-slot waiter queue (GH 2297)', { timeout: 60_000 }, () => {
  const tickets = (root: string): string[] => {
    const queue = join(root, 'queue');
    return existsSync(queue) ? readdirSync(queue).sort().map((name) => join(queue, name)) : [];
  };
  const mtime = (path: string): number => statSync(path).mtimeMs;
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  it('gives the slot to the earlier waiter when the holder releases, even though the later one polls first', async () => {
    const root = freshDir('lock');
    const holder = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/holder', env: lockEnv(root) }));
    const order: string[] = [];
    let ticketB = '';
    let bPolledAt = 0;
    const a = acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root), stderr: () => {} }).then((r) => {
      order.push('A');
      bPolledAt = mtime(ticketB);
      return r;
    });
    await waitFor('A to queue', () => tickets(root).length === 1, 5_000);
    const [ticketA] = tickets(root);
    await sleep(250);
    const b = acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), stderr: () => {} }).then((r) => {
      order.push('B');
      return r;
    });
    await waitFor('B to queue', () => tickets(root).length === 2, 5_000);
    ticketB = tickets(root)[1];
    assert.notEqual(ticketB, ticketA);
    const aBefore = mtime(ticketA);
    await waitFor('A to poll', () => mtime(ticketA) > aBefore, 5_000);
    const releasedAt = Date.now();
    holder.release();
    const first = held(await a);
    assert.ok(bPolledAt >= releasedAt, `B did not poll between the release and A taking the slot: ${bPolledAt} < ${releasedAt}`);
    assert.deepEqual(order, ['A']);
    assert.equal(readHolder(first.slot)?.worktree, '/w/a');
    assert.equal(existsSync(ticketA), false);
    first.release();
    const second = held(await b);
    assert.equal(readHolder(second.slot)?.worktree, '/w/b');
    second.release();
    assert.deepEqual(tickets(root), []);
  });
  it('waits behind a live ticket ahead of it, and skips and removes one unrefreshed for 10 s', async () => {
    const root = freshDir('lock');
    mkdirSync(join(root, 'queue'));
    const ahead = join(root, 'queue', '000000000000001-0000000001-000000');
    writeFileSync(ahead, '{}\n');
    assert.equal((await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 1, stderr: () => {} })).kind, 'busy');
    assert.equal(existsSync(join(root, 'slot-0')), false);
    assert.deepEqual(tickets(root), [ahead]);
    ago(ahead, 60);
    held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 0 })).release();
    assert.deepEqual(tickets(root), []);
  });
  it('removes its ticket when it returns busy', async () => {
    const root = freshDir('lock');
    const holder = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/holder', env: lockEnv(root) }));
    assert.equal((await acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), maxWaitS: 1, stderr: () => {} })).kind, 'busy');
    assert.deepEqual(tickets(root), []);
    holder.release();
  });
  it('acquires by unordered polling, with one stderr line, when it cannot write a ticket', async () => {
    const root = freshDir('lock');
    writeFileSync(join(root, 'queue'), 'not a dir\n');
    const holder = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/holder', env: lockEnv(root) }));
    let err = '';
    const waiter = acquireSuiteSlot({ command: 'npm test', worktree: '/w/b', env: lockEnv(root), stderr: (t) => (err += t) });
    await waitFor('the waiter to wait', () => err.includes('waiting for a suite slot'), 5_000);
    await sleep(1_100);
    holder.release();
    const got = held(await waiter);
    assert.equal(readHolder(got.slot)?.worktree, '/w/b');
    got.release();
    assert.equal(err.match(/could not write a queue ticket/g)?.length, 1);
  });
});

describe('dist/test-run.js under the suite-slot lock', { timeout: 60_000 }, () => {
  it('serializes two full suites on one slot; the holder names a live pid and the worktree while held', async () => {
    const root = freshDir('lock');
    const work = workDir();
    const env = lockEnv(root, { MARKS: join(work, 'marks') });
    const a = testRun(work, 'bash tests/run-all.sh A', env);
    const holderFile = join(root, 'slot-0/holder');
    await waitFor('A to hold slot-0', () => readHolder(join(root, 'slot-0'))?.pid === a.child.pid, 20_000);
    const h = readHolder(join(root, 'slot-0'));
    assert.ok(h !== null && existsSync(holderFile));
    assert.equal(h.worktree, work);
    assert.equal(h.command, 'bash tests/run-all.sh A');
    assert.doesNotThrow(() => process.kill(h.pid, 0));
    const b = testRun(work, 'bash tests/run-all.sh B', env);
    assert.deepEqual(await Promise.all([a.done, b.done]), [0, 0]);
    const m = marks(work);
    assert.ok((m.get('start B') ?? 0) >= (m.get('end A') ?? Infinity), `B started before A ended: ${JSON.stringify([...m])}`);
    assert.match(b.stderr(), new RegExp(`waiting for a suite slot: held by pid ${a.child.pid} \\(worktree ${escapeRe(work)}\\) for \\d+s`));
    assert.equal(existsSync(join(root, 'slot-0')), false);
  });
  it('runs two full suites at once with TMB_TEST_SUITE_SLOTS=2', async () => {
    const root = freshDir('lock');
    const work = workDir();
    const env = lockEnv(root, { MARKS: join(work, 'marks'), TMB_TEST_SUITE_SLOTS: '2', RENDEZVOUS: '1', HOLD_S: '0' });
    const a = testRun(work, 'bash tests/run-all.sh A', env);
    const b = testRun(work, 'bash tests/run-all.sh B', env);
    assert.deepEqual(await Promise.all([a.done, b.done]), [0, 0]);
    const m = marks(work);
    const lastStart = Math.max(m.get('start A') ?? Infinity, m.get('start B') ?? Infinity);
    const firstEnd = Math.min(m.get('end A') ?? 0, m.get('end B') ?? 0);
    assert.ok(lastStart <= firstEnd, `the two runs did not overlap: ${JSON.stringify([...m])}`);
    assert.equal(b.stderr().includes('waiting for a suite slot'), false);
  });
  it('runs a targeted command straight away while the slot is held', async () => {
    const root = freshDir('lock');
    const work = workDir();
    const slot = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root) }));
    try {
      const r = testRun(work, 'node --test probe.test.js', lockEnv(root));
      assert.equal(await r.done, 0);
      assert.equal(r.stderr().includes('waiting for a suite slot'), false);
      assert.equal(readHolder(slot.slot)?.worktree, '/w/a');
    } finally {
      slot.release();
    }
  });
  it('lets the next waiter take the slot within 5 s of the holder being SIGKILLed', async () => {
    const root = freshDir('lock');
    const work = workDir();
    const a = testRun(work, 'bash tests/run-all.sh A', lockEnv(root, { MARKS: join(work, 'marks'), HOLD_S: '30' }), true);
    await waitFor('A to start its suite', () => marks(work).has('start A'), 20_000);
    const b = testRun(work, 'bash tests/run-all.sh B', lockEnv(root, { MARKS: join(work, 'marks'), HOLD_S: '0' }));
    await waitFor('B to wait', () => b.stderr().includes('waiting for a suite slot'), 20_000);
    process.kill(-(a.child.pid as number), 'SIGKILL');
    await a.done;
    await waitFor('B to take the slot', () => marks(work).has('start B'), 5_000);
    assert.equal(await b.done, 0);
  });
  it('runs a nested full suite under TMB_SUITE_LOCK_HELD without waiting on the one slot', async () => {
    const root = freshDir('lock');
    const work = workDir();
    const slot = held(await acquireSuiteSlot({ command: 'npm test', worktree: '/w/a', env: lockEnv(root) }));
    try {
      const r = testRun(work, 'bash tests/run-all.sh N', lockEnv(root, { MARKS: join(work, 'marks'), HOLD_S: '0', [SUITE_LOCK_HELD_ENV]: slot.slot }));
      assert.equal(await r.done, 0);
      assert.equal(r.stderr().includes('waiting for a suite slot'), false);
    } finally {
      slot.release();
    }
  });
});
