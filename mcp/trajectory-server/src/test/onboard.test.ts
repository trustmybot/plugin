import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryDB } from '../db.js';
import { onboardTools } from '../tools/onboard.js';
import { tempDB } from './helpers.js';

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
      // No human_name field — bro doesn't store names.
      assert.equal((current as { human_name?: unknown }).human_name, undefined);
      // Schema-seeded defaults should be visible
      assert.equal(current.branching_model, 'github-flow');
      db.close();
    });

    it('reports first_run=false once identity row has been written', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO identity (id, created_at, updated_at) VALUES (1, datetime('now'), datetime('now'))`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const data = parse(result);
      assert.equal(data.first_run, false);
      db.close();
    });
  });

  describe('onboard_get_questions', () => {
    it('local first-run round=main returns ZERO AUQ questions (branching defaults silently)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'main',
      });
      const data = parse(result);
      const questions = data.questions as Array<unknown>;
      // No name question (bro doesn't ask). Branching defaults silently for
      // local first-run. Skill skips AUQ Round 2 entirely.
      assert.equal(questions.length, 0);
      db.close();
    });

    it('every AUQ question has ≥2 options (schema minimum)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const cases: Array<{ shape: string; round: string }> = [
        { shape: 'local', round: 'main' },
        { shape: 'remote', round: 'main' },
        { shape: 'remote', round: 'sync' },
      ];
      for (const c of cases) {
        const result = await call(tools.handlers, 'onboard_get_questions', {
          shape: c.shape,
          round: c.round,
        });
        const data = parse(result);
        const questions = data.questions as Array<{ header: string; options: unknown[] }>;
        for (const q of questions) {
          assert.ok(
            q.options.length >= 2,
            `(${c.shape}/${c.round}) question "${q.header}" has ${q.options.length} option(s); AUQ requires ≥2`,
          );
        }
      }
      db.close();
    });

    it('local re-onboard round=main returns Branching only (with Keep option)', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO identity (id, created_at, updated_at) VALUES (1, datetime('now'), datetime('now'))`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'main',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string }> }>;
      assert.equal(questions.length, 1);
      assert.equal(questions[0].header, 'Branching');
      assert.equal(questions[0].options[0].label, 'Keep "github-flow"');
      db.close();
    });

    it('remote first-run round=main returns Branching + PR target + Remote', async () => {
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
        ['Branching', 'PR target', 'Remote'],
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
    it('local shape: marks onboarded, defaults branching to github-flow, pr_target to main, remotes=[], issue_sync=off', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', { shape: 'local' });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.onboarded, true);
      assert.equal(applied.branching_model, 'github-flow');
      assert.equal(applied.pr_target, 'main');
      assert.deepEqual(applied.remotes, []);
      assert.equal(applied.issue_sync, 'off');
      assert.deepEqual(applied.protected_branches, ['main']);

      // Identity row should now exist as the onboarded marker.
      const row = db.get<{ id: number }>('SELECT id FROM identity WHERE id = 1');
      assert.ok(row, 'identity row must be written');
      db.close();
    });

    it('local + gitflow: pr_target derives to develop, protected_branches gets both main + develop', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        branching_model: 'gitflow',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'gitflow');
      assert.equal(applied.pr_target, 'develop');
      assert.deepEqual(applied.protected_branches, ['main', 'develop']);
      db.close();
    });

    it('remote shape: persists single-provider array', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        pr_target: 'main',
        remote: ['gitlab'],
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

    it('remote=[github,gitlab]: writes both provider entries with stable github-first order', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        pr_target: 'main',
        remote: ['github', 'gitlab'],
        issue_sync: 'auto',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string; name: string }>;
      assert.equal(remotes.length, 2);
      assert.equal(remotes[0].provider, 'github');
      assert.equal(remotes[0].name, 'origin');
      assert.equal(remotes[1].provider, 'gitlab');
      assert.equal(remotes[1].name, 'gitlab');
      db.close();
    });

    it('remote=["gitlab","github"] order is normalized — github still first', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        pr_target: 'main',
        remote: ['gitlab', 'github'],
        issue_sync: 'auto',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string; name: string }>;
      assert.equal(remotes[0].provider, 'github');
      assert.equal(remotes[1].provider, 'gitlab');
      db.close();
    });

    it('remote shape: legacy string form ("gitlab") is still accepted for backward compat', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        pr_target: 'main',
        remote: 'gitlab',
        issue_sync: 'auto',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string }>;
      assert.equal(remotes.length, 1);
      assert.equal(remotes[0].provider, 'gitlab');
      db.close();
    });

    it('remote shape rejects when remote arg is missing', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
      });
      const data = parse(result);
      assert.match(String(data.error), /'remote' is required when shape='remote'/);
      db.close();
    });

    it('remote shape rejects empty array', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: [],
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.match(String(data.error), /at least one/);
      db.close();
    });

    it('remote shape rejects unknown provider in array', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: ['bitbucket'],
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.match(String(data.error), /'github' or 'gitlab'/);
      db.close();
    });

    it('remote shape rejects bad branching_model', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'invalid-flow',
        remote: 'github',
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.match(String(data.error), /branching_model must be 'github-flow' or 'gitflow'/);
      db.close();
    });

    it('successful apply leaves a coherent DB state (transactional write)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'gitflow',
        remote: 'github',
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const config = db.all<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM plugin_config WHERE key IN ('branching_model','pr_target','protected_branches','remotes','issue_sync')`,
      );
      const map = Object.fromEntries(config.map((r) => [r.key, JSON.parse(r.value_json)]));
      assert.equal(map.branching_model, 'gitflow');
      assert.equal(map.pr_target, 'develop');
      assert.deepEqual((map.protected_branches as string[]).sort(), ['develop', 'main']);
      assert.equal(map.issue_sync, 'auto');
      // identity row also written as marker
      const id = db.get<{ id: number }>('SELECT id FROM identity WHERE id = 1');
      assert.ok(id, 'identity row written as onboarded marker');
      db.close();
    });
  });
});
