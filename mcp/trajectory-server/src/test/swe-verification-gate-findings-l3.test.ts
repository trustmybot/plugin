/**
 * The swe-verification-gate l3 bash suite in node:test (GH 1692), part 3:
 * review-finding probes run after verification[] (v47, GH 1737), and
 * verification carry-forward (GH 1950), where a rework whose diff misses a
 * command's declared inputs in .config/tmb/verification-inputs.json carries
 * that command's passing row from the source run instead of running it.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DENY, git, has, hasNot, sql } from './git-push-guard-l3.js';
import {
  FINDINGS_SCHEMA,
  addTask,
  contextOfGate,
  execDb,
  gitCommit,
  gitWorktree,
  hook,
  makeInput,
  makeWs,
  q,
  reasonOf,
  runHook,
  type Ws,
} from './swe-verification-gate-l3.js';

describe('swe-verification-gate findings l3', () => {
  let w: Ws;
  const done = (task: number) => makeInput('swe', 'completed', task);
  const addFinding = (id: string, task: number, attempt: number, probe: string, observed: string, status: string, createdAt: string, resolvedAt: string | null) =>
    sql(w.db, "INSERT INTO review_findings VALUES (?, ?, ?, NULL, ?, 'exit 0', ?, ?, ?, ?)", id, task, attempt, probe, observed, status, createdAt, resolvedAt);

  before(() => {
    w = makeWs('swe-verification-gate-findings');
    execDb(w.db, FINDINGS_SCHEMA);
  });
  after(() => w.sb.remove());

  describe('review findings: probes run after verification[]', () => {
    before(() => {
      addTask(w.db, 96, 'findings', ['exit 0']);
      sql(w.db, "INSERT INTO review_findings VALUES ('F96-1', 96, 1, 'SC1', 'exit 0', 'exit 0', 'exit 1', 'open', '2026-01-01T00:00:00.000Z', NULL)");
      addFinding('F96-2', 96, 1, 'echo still broken; exit 3', 'exit 3', 'fixed', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      addFinding('F96-3', 96, 1, 'exit 9', 'exit 9', 'wontfix', '2026-01-01T00:00:00.000Z', null);
      gitWorktree(w, 'findings');
    });

    it('findings: a passing open probe sets fixed, a failing fixed probe denies as a regression, wontfix is skipped', () => {
      const r = runHook(w, done(96));
      const reason = reasonOf(r.stdout);
      has(r.stdout + r.stderr, DENY, 'a failing probe denies');
      has(reason, 'review finding probe(s) failed', 'deny says a finding probe failed');
      has(reason, 'Finding F96-2 (probe 3/3) — REGRESSION', 'deny names F96-2 as a regression');
      has(reason, 'still broken', 'deny carries the probe output');
      hasNot(reason, 'Finding F96-1', 'the passing probe is not named');
      hasNot(reason, 'F96-3', 'the wontfix finding is not probed');
      assert.equal(
        q(w.db, "SELECT status || '|' || (resolved_at IS NOT NULL AND resolved_at > '2026-06-01') FROM review_findings WHERE id = 'F96-1';"),
        'fixed|1',
        'F96-1 is fixed with a fresh resolved_at',
      );
      assert.equal(q(w.db, "SELECT status || '|' || resolved_at FROM review_findings WHERE id = 'F96-2';"), 'fixed|2026-01-02T00:00:00.000Z', 'F96-2 stays fixed, resolved_at untouched');
      assert.equal(q(w.db, "SELECT status || '|' || COALESCE(resolved_at, '') FROM review_findings WHERE id = 'F96-3';"), 'wontfix|', 'F96-3 untouched');
      assert.equal(
        q(w.db, "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_runs WHERE task_id = 96) FROM verification_runs r WHERE r.task_id = 96;"),
        '3|0|1',
        "run finished with the probe's exit, not timed out",
      );
      assert.equal(
        q(w.db, "SELECT group_concat(command, '|') FROM (SELECT c.command FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.task_id = 96 ORDER BY c.ordinal);"),
        'exit 0|[probe F96-1] exit 0|[probe F96-2] echo still broken; exit 3',
        'probe rows are recorded after verification[] as [probe <id>]',
      );
    });

    it('findings: once every probe passes the close is allowed, and that run is reused only for the same findings', () => {
      sql(w.db, "UPDATE review_findings SET probe_cmd = 'exit 0' WHERE id = 'F96-2'");
      gitCommit(w, 'findings', 'fix F96-2');
      hasNot(hook(w, done(96)), DENY, 'all probes pass');
      has(hook(w, done(96)), 'verification reused', 'the same findings reuse the passing run');
      addFinding('F96-4', 96, 2, 'exit 0', 'exit 1', 'open', '2026-01-03T00:00:00.000Z', null);
      hasNot(hook(w, done(96)), 'verification reused', 'a new finding forces a fresh run');
      assert.equal(q(w.db, "SELECT status FROM review_findings WHERE id = 'F96-4';"), 'fixed', "the new finding's passing probe fixes it");
    });

    it('findings: a task with empty verification[] still runs its probes', () => {
      addTask(w.db, 97, 'findings-only', []);
      addFinding('F97-1', 97, 1, 'exit 4', 'exit 4', 'open', '2026-01-01T00:00:00.000Z', null);
      gitWorktree(w, 'findings-only');
      const reason = reasonOf(runHook(w, done(97)).stdout);
      has(reason, 'Finding F97-1 (probe 1/1): exit 4', "the open finding's failing probe denies");
      hasNot(reason, 'REGRESSION', 'an open finding is not a regression');
      assert.equal(q(w.db, "SELECT status || '|' || COALESCE(resolved_at, '') FROM review_findings WHERE id = 'F97-1';"), 'open|', 'a failing open finding stays open');
    });
  });

  // verification[] is A (declares src/**), B (declares lib/**) and U
  // (undeclared in the inputs map), plus one open finding probe P; each appends
  // its letter to <sandbox>/<slug>.ran, outside the worktree.
  describe('verification carry-forward (GH 1950)', () => {
    const carryCmd = (slug: string, letter: string) => `echo ${letter} >> ${w.sb.dir}/${slug}.ran`;
    const carryMap = (slug: string, version: number) => ({
      version,
      commands: [
        { match: carryCmd(slug, 'A'), inputs: ['src/**'] },
        { match: carryCmd(slug, 'B'), inputs: ['lib/**'] },
        { match: carryCmd(slug, 'C'), inputs: ['src/**'] },
      ],
    });
    const wt = (slug: string) => join(w.wtRoot, slug);
    const wtCommit = (slug: string, msg: string) => {
      git(w.sb.env, wt(slug), 'add', '-A');
      git(w.sb.env, wt(slug), 'commit', '--quiet', '-m', msg);
      return git(w.sb.env, wt(slug), 'rev-parse', 'HEAD');
    };
    const ranTake = (slug: string) => {
      const f = join(w.sb.dir, `${slug}.ran`);
      const got = existsSync(f) ? readFileSync(f, 'utf8').replace(/\n/g, '') : '';
      rmSync(f, { force: true });
      return got;
    };
    const lastRun = (task: number) => q(w.db, 'SELECT max(id) FROM verification_runs WHERE task_id = ?', task);
    const carriedOf = (task: number) =>
      q(
        w.db,
        "SELECT COALESCE(group_concat(ordinal, ','), '') FROM (SELECT ordinal FROM verification_run_commands WHERE run_id = ? AND output_tail LIKE 'carried from run #%' ORDER BY ordinal);",
        Number(lastRun(task)),
      );
    const docsEdit = (slug: string, text: string) => appendFileSync(join(wt(slug), 'docs/x.md'), `${text}\n`);

    /** The task, its finding and its worktree, then the first close: it runs every command and is the source run. */
    function carrySetup(id: number, slug: string, version = 1): void {
      addTask(w.db, id, slug, [carryCmd(slug, 'A'), carryCmd(slug, 'B'), carryCmd(slug, 'U')]);
      addFinding(`F${id}-1`, id, 1, carryCmd(slug, 'P'), 'exit 1', 'open', '2026-01-01T00:00:00.000Z', null);
      for (const d of ['src', 'lib', 'docs', '.config/tmb']) mkdirSync(join(wt(slug), d), { recursive: true });
      git(w.sb.env, wt(slug), 'init', '--quiet');
      writeFileSync(join(wt(slug), '.config/tmb/verification-inputs.json'), `${JSON.stringify(carryMap(slug, version), null, 2)}\n`);
      writeFileSync(join(wt(slug), 'src/app.txt'), 'app\n');
      writeFileSync(join(wt(slug), 'lib/lib.txt'), 'lib\n');
      writeFileSync(join(wt(slug), 'docs/x.md'), 'doc\n');
      wtCommit(slug, 'init');
      hasNot(hook(w, done(id)), DENY, 'the first close passes');
      assert.equal(ranTake(slug), 'ABUP', 'the first close runs every command');
    }

    /** The close runs every command and carries none. */
    function carryNone(id: number, slug: string, why: string): void {
      const out = hook(w, done(id));
      hasNot(out, DENY, `${why}: the close passes`);
      assert.equal(ranTake(slug), 'ABUP', `${why}: every command runs`);
      assert.equal(carriedOf(id), '', `${why}: no command row is carried`);
      hasNot(out, 'carried forward', `${why}: no carry-forward context`);
    }

    it('carry-forward: a docs-only rework carries the declared commands; the undeclared one and the probe run', () => {
      carrySetup(100, 'carry-docs');
      const srcRun = lastRun(100);
      const srcSha = git(w.sb.env, wt('carry-docs'), 'rev-parse', 'HEAD');
      docsEdit('carry-docs', 'more');
      wtCommit('carry-docs', 'docs only');
      const r = runHook(w, done(100));
      hasNot(r.stdout + r.stderr, DENY, 'the rework close passes');
      assert.equal(ranTake('carry-docs'), 'UP', 'only the undeclared command and the probe ran');
      assert.equal(carriedOf(100), '1,2', 'A and B are recorded as carried');
      assert.equal(
        q(w.db, "SELECT exit_code || '|' || (elapsed_s = 0) || '|' || output_tail FROM verification_run_commands WHERE run_id = ? AND ordinal = 1;", Number(lastRun(100))),
        `0|1|carried from run #${srcRun} at ${srcSha.slice(0, 12)}`,
        'a carried row has exit 0, elapsed 0 and names the source run',
      );
      const ctx = contextOfGate(r.stdout);
      has(ctx, `carried forward from run #${srcRun} at ${srcSha.slice(0, 12)}`, 'the context names the source run');
      has(ctx, carryCmd('carry-docs', 'A'), 'the context names carried command A');
      has(ctx, carryCmd('carry-docs', 'B'), 'the context names carried command B');
      hasNot(ctx, carryCmd('carry-docs', 'U'), 'the context does not name the command that ran');
    });

    it('carry-forward: a run with carried commands keeps exit_code 0 and is accepted as passing', () => {
      assert.equal(
        q(
          w.db,
          "SELECT r.exit_code || '|' || r.timed_out || '|' || (SELECT COUNT(*) FROM verification_run_commands WHERE run_id = r.id) FROM verification_runs r WHERE r.id = ?;",
          Number(lastRun(100)),
        ),
        '0|0|4',
        'the run finished exit 0, not timed out, with a row per command',
      );
      has(hook(w, done(100)), `verification reused run #${lastRun(100)}`, 'the next close on the same HEAD reuses it');
      assert.equal(ranTake('carry-docs'), '', 'nothing ran again');
    });

    it("carry-forward: a change matching one command's inputs runs that command and carries the other", () => {
      docsEdit('carry-docs', 'again');
      appendFileSync(join(wt('carry-docs'), 'src/app.txt'), 'changed\n');
      wtCommit('carry-docs', 'src change');
      hook(w, done(100));
      assert.equal(ranTake('carry-docs'), 'AUP', 'A (src/**) ran again');
      assert.equal(carriedOf(100), '2', 'B (lib/**) is carried');
    });

    it('carry-forward: after an amend the source commit is no ancestor of HEAD', () => {
      carrySetup(101, 'carry-amend');
      docsEdit('carry-amend', 'more');
      git(w.sb.env, wt('carry-amend'), 'add', '-A');
      git(w.sb.env, wt('carry-amend'), 'commit', '--quiet', '--amend', '-m', 'amended');
      carryNone(101, 'carry-amend', 'amend');
    });

    it('carry-forward: a merge commit in the range carries nothing', () => {
      carrySetup(102, 'carry-merge');
      git(w.sb.env, wt('carry-merge'), 'checkout', '--quiet', '-b', 'side');
      docsEdit('carry-merge', 'side');
      wtCommit('carry-merge', 'side');
      git(w.sb.env, wt('carry-merge'), 'checkout', '--quiet', '-');
      writeFileSync(join(wt('carry-merge'), 'docs/y.md'), 'other\n');
      wtCommit('carry-merge', 'main');
      git(w.sb.env, wt('carry-merge'), 'merge', '--quiet', '--no-edit', 'side');
      carryNone(102, 'carry-merge', 'merge');
    });

    it('carry-forward: a dirty worktree carries nothing', () => {
      carrySetup(103, 'carry-dirty');
      docsEdit('carry-dirty', 'more');
      wtCommit('carry-dirty', 'docs only');
      writeFileSync(join(wt('carry-dirty'), 'docs/new.md'), 'untracked\n');
      carryNone(103, 'carry-dirty', 'dirty');
    });

    it('carry-forward: a commit that changes the inputs map carries nothing', () => {
      carrySetup(104, 'carry-map');
      docsEdit('carry-map', 'more');
      const mapPath = join(wt('carry-map'), '.config/tmb/verification-inputs.json');
      const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { commands: Array<{ match: string; inputs: string[] }> };
      map.commands.push({ match: 'true', inputs: ['x'] });
      writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
      wtCommit('carry-map', 'map change');
      carryNone(104, 'carry-map', 'map change');
    });

    it('carry-forward: a command that failed in the source run is not carried', () => {
      carrySetup(105, 'carry-failed');
      sql(w.db, 'UPDATE verification_run_commands SET exit_code = 1 WHERE run_id = ? AND ordinal = 1', Number(lastRun(105)));
      docsEdit('carry-failed', 'more');
      wtCommit('carry-failed', 'docs only');
      hook(w, done(105));
      assert.equal(ranTake('carry-failed'), 'AUP', 'A runs again');
      assert.equal(carriedOf(105), '2', 'only B is carried');
    });

    it('carry-forward: a declared command the source run never ran is not carried', () => {
      carrySetup(106, 'carry-new');
      const verification = ['A', 'B', 'C', 'U'].map((l) => carryCmd('carry-new', l));
      sql(w.db, 'UPDATE tasks SET verification = ? WHERE id = 106', JSON.stringify(verification));
      docsEdit('carry-new', 'more');
      wtCommit('carry-new', 'docs only');
      hasNot(hook(w, done(106)), DENY, 'the close passes');
      assert.equal(ranTake('carry-new'), 'CUP', 'the new declared command C runs');
      assert.equal(carriedOf(106), '1,2', 'A and B are carried');
    });

    it('carry-forward: an unknown map version carries nothing', () => {
      carrySetup(107, 'carry-version', 2);
      docsEdit('carry-version', 'more');
      wtCommit('carry-version', 'docs only');
      carryNone(107, 'carry-version', 'map version 2');
    });

    it('carry-forward: the gate carries in-process, with no separate dist helper to find', () => {
      carrySetup(108, 'carry-nohelper');
      docsEdit('carry-nohelper', 'more');
      wtCommit('carry-nohelper', 'docs only');
      const r = runHook(w, done(108));
      has(contextOfGate(r.stdout), 'carried forward', 'in-process carry: the context names the carry');
      hasNot(r.stdout + r.stderr, DENY, 'in-process carry: the close passes');
      assert.equal(ranTake('carry-nohelper'), 'UP', 'in-process carry: only the undeclared command and the probe run');
      assert.equal(carriedOf(108), '1,2', 'in-process carry: A and B are carried');
    });
  });
});
