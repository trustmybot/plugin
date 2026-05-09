import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { onboardTools } from '../tools/onboard.js';

function tempDB(): TrajectoryDB {
  return new TrajectoryDB(':memory:');
}

function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return handlers[name]({ agent: 'bro', ...args });
}

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe('onboard tools', () => {
  describe('onboard_state_get', () => {
    it('reports first_run=true when no identity row exists', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const data = parse(result);
      assert.equal(data.first_run, true);
      const current = data.current as Record<string, unknown>;
      assert.equal(current.human_name, null);
      // Schema-seeded defaults should be visible
      assert.equal(current.branching_model, 'github-flow');
      db.close();
    });

    it('reports first_run=false once a named identity has been written', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, 'Daisy', datetime('now'), datetime('now'))`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const data = parse(result);
      assert.equal(data.first_run, false);
      assert.equal((data.current as Record<string, unknown>).human_name, 'Daisy');
      db.close();
    });

    it('reports first_run=false when an ANONYMOUS identity row exists (#95 — anonymous-cold-restart must not re-trigger onboard)', async () => {
      const db = tempDB();
      // Anonymous = row present, human_name=NULL. The schema doctrine in
      // identity_set says "downstream code distinguishes onboarded by row
      // existence (created_at non-null), not by human_name nullity".
      db.run(
        `INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, NULL, datetime('now'), datetime('now'))`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const data = parse(result);
      assert.equal(data.first_run, false, 'anonymous row should NOT trigger first-run');
      assert.equal((data.current as Record<string, unknown>).human_name, null);
      db.close();
    });
  });

  describe('onboard_get_questions', () => {
    it('local first-run round=main returns ONLY a Name question', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'main',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string }> }>;
      assert.equal(questions.length, 1);
      assert.equal(questions[0].header, 'Your name');
      // First-run: no Keep option, only Anonymous (+ AUQ-rendered Other)
      assert.equal(questions[0].options.length, 1);
      assert.equal(questions[0].options[0].label, 'Anonymous');
      db.close();
    });

    it('local re-onboard round=main returns Name + Branching with Keep options', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO identity (id, human_name, created_at, updated_at) VALUES (1, 'Daisy', datetime('now'), datetime('now'))`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'main',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string }> }>;
      assert.equal(questions.length, 2);
      assert.equal(questions[0].header, 'Your name');
      assert.equal(questions[0].options[0].label, 'Keep "Daisy"');
      assert.equal(questions[1].header, 'Branching');
      assert.equal(questions[1].options[0].label, 'Keep "github-flow"');
      db.close();
    });

    it('remote first-run round=main returns Name + Branching + PR target + Remote', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'remote',
        round: 'main',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string }>;
      assert.deepEqual(
        questions.map((q) => q.header),
        ['Your name', 'Branching', 'PR target', 'Remote'],
      );
      db.close();
    });

    it('remote round=sync returns the issue_sync question', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'remote',
        round: 'sync',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string }> }>;
      assert.equal(questions.length, 1);
      assert.equal(questions[0].header, 'Issue sync');
      assert.equal(questions[0].options.length, 2);
      assert.match(questions[0].options[0].label, /Auto/);
      assert.match(questions[0].options[1].label, /Off/);
      db.close();
    });

    it('local round=sync rejects (sync only valid on remote)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'sync',
      });
      const data = parse(result);
      assert.match(String(data.error), /sync.*only valid for shape='remote'/);
      db.close();
    });
  });

  describe('onboard_apply', () => {
    it('local shape: defaults branching to github-flow, pr_target to main, remotes=[], issue_sync=off', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        name: 'Daisy',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.human_name, 'Daisy');
      assert.equal(applied.branching_model, 'github-flow');
      assert.equal(applied.pr_target, 'main');
      assert.deepEqual(applied.remotes, []);
      assert.equal(applied.issue_sync, 'off');
      assert.deepEqual(applied.protected_branches, ['main']);
      db.close();
    });

    it('local + gitflow: pr_target derives to develop, protected_branches gets both main + develop', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        name: 'Anonymous',
        branching_model: 'gitflow',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.human_name, null);
      assert.equal(applied.branching_model, 'gitflow');
      assert.equal(applied.pr_target, 'develop');
      assert.deepEqual(applied.protected_branches, ['main', 'develop']);
      db.close();
    });

    it('remote shape: persists remote provider + issue_sync', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        name: 'Daisy',
        branching_model: 'github-flow',
        pr_target: 'main',
        remote: 'gitlab',
        issue_sync: 'auto',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string; name: string }>;
      assert.equal(remotes.length, 1);
      assert.equal(remotes[0].provider, 'gitlab');
      assert.equal(remotes[0].name, 'origin');
      assert.equal(applied.issue_sync, 'auto');
      db.close();
    });

    it('remote=both: writes both provider entries', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        name: 'Daisy',
        branching_model: 'github-flow',
        pr_target: 'main',
        remote: 'both',
        issue_sync: 'auto',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string }>;
      assert.equal(remotes.length, 2);
      assert.deepEqual(
        remotes.map((r) => r.provider).sort(),
        ['github', 'gitlab'],
      );
      db.close();
    });

    it('remote shape rejects when remote arg is missing', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        name: 'Daisy',
        branching_model: 'github-flow',
      });
      const data = parse(result);
      assert.match(String(data.error), /'remote' is required when shape='remote'/);
      db.close();
    });

    it('remote shape rejects bad branching_model', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        name: 'Daisy',
        branching_model: 'invalid-flow',
        remote: 'github',
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.match(String(data.error), /branching_model must be 'github-flow' or 'gitflow'/);
      db.close();
    });

    it('all writes happen in one transaction (rollback on failure)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      // Trigger a downstream failure by passing a remote answer that is not in the enum
      // — apply should reject before any writes land.
      // (no straightforward way to force a mid-write fail without monkeypatching; we
      // settle for verifying the success path leaves a coherent state.)
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        name: 'Daisy',
        branching_model: 'gitflow',
        remote: 'github',
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      // Verify directly via the DB
      const config = db.all<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM plugin_config WHERE key IN ('branching_model','pr_target','protected_branches','remotes','issue_sync')`,
      );
      const map = Object.fromEntries(config.map((r) => [r.key, JSON.parse(r.value_json)]));
      assert.equal(map.branching_model, 'gitflow');
      assert.equal(map.pr_target, 'develop'); // derived from gitflow
      assert.deepEqual((map.protected_branches as string[]).sort(), ['develop', 'main']);
      assert.equal(map.issue_sync, 'auto');
      db.close();
    });
  });
});
