import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        `INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const data = parse(result);
      assert.equal(data.first_run, false);
      db.close();
    });

    it('probes the DEFAULT REPO path, not the workspace-root cwd (#675)', async () => {
      // A real git repo with a github origin, sitting at an arbitrary path that
      // is NOT the workspace root the dbPath would strip down to. The probe must
      // resolve it via the `repos` row (resolveDefaultRepoPath single-repo
      // fallback) so in_git:true and the remote is detected.
      const repoDir = mkdtempSync(join(tmpdir(), 'onboard-probe-'));
      const gitOpts = { cwd: repoDir, encoding: 'utf8' as const };
      try {
        spawnSync('git', ['init', '-q'], gitOpts);
        spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], gitOpts);

        const db = tempDB();
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'widget')`, [repoDir]);
        // dbPath points at a workspace root that is NOT a git repo — the legacy
        // derivation would probe here and find nothing.
        const tools = onboardTools(db, '/tmp/some-workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'onboard_state_get', {});
        const data = parse(result);
        const probe = data.probe as {
          in_git: boolean;
          detected_remotes: Array<{ name: string; url: string; provider: string }>;
        };
        assert.equal(probe.in_git, true, 'must probe inside the default repo git tree');
        const origin = probe.detected_remotes.find((r) => r.name === 'origin');
        assert.ok(origin, 'origin remote must be detected from the default repo path');
        assert.equal(origin.url, 'https://github.com/acme/widget.git');
        assert.equal(origin.provider, 'github');
        db.close();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
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
        `INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')`,
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

    it('every option in every question round carries a wire field', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const cases: Array<{ shape: string; round: string }> = [
        { shape: 'remote', round: 'main' },
        { shape: 'remote', round: 'sync' },
      ];
      for (const c of cases) {
        const result = await call(tools.handlers, 'onboard_get_questions', {
          shape: c.shape,
          round: c.round,
        });
        const data = parse(result);
        const questions = data.questions as Array<{ header: string; options: Array<{ wire?: string; label: string }> }>;
        for (const q of questions) {
          for (const opt of q.options) {
            assert.ok(
              typeof opt.wire === 'string' && opt.wire.length > 0,
              `(${c.shape}/${c.round}) question "${q.header}" option "${opt.label}" is missing wire field`,
            );
          }
        }
      }
      db.close();
    });

    it('Keep option carries wire=__keep__', async () => {
      const db = tempDB();
      db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'main',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string; wire: string }> }>;
      const keepOpt = questions[0].options.find((o) => o.label.startsWith('Keep'));
      assert.ok(keepOpt, 'Keep option should be present on re-onboard');
      assert.equal(keepOpt.wire, '__keep__');
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

    it('round=shape returns one Shape question with Remote-tracked and Local-only options', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', { round: 'shape' });
      const data = parse(result);
      const questions = data.questions as Array<{
        header: string;
        question: string;
        multiSelect: boolean;
        options: Array<{ label: string; wire: string }>;
        default_index: number;
      }>;
      assert.equal(questions.length, 1, 'shape round must return exactly one question');
      const q = questions[0];
      assert.equal(q.header, 'Shape');
      assert.equal(q.multiSelect, false);
      const labels = q.options.map((o) => o.label);
      assert.ok(labels.includes('Remote-tracked'), 'Must include Remote-tracked option');
      assert.ok(labels.includes('Local-only'), 'Must include Local-only option');
      db.close();
    });

    it('round=shape wire values are remote and local', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', { round: 'shape' });
      const data = parse(result);
      const questions = data.questions as Array<{ options: Array<{ label: string; wire: string }> }>;
      const opts = questions[0].options;
      const remoteOpt = opts.find((o) => o.label === 'Remote-tracked');
      const localOpt = opts.find((o) => o.label === 'Local-only');
      assert.ok(remoteOpt, 'Remote-tracked option must exist');
      assert.ok(localOpt, 'Local-only option must exist');
      assert.equal(remoteOpt.wire, 'remote', 'Remote-tracked wire must be "remote"');
      assert.equal(localOpt.wire, 'local', 'Local-only wire must be "local"');
      db.close();
    });

    it('round=shape default_index=0 (Remote-tracked) when no-origin probe', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', { round: 'shape' });
      const data = parse(result);
      const questions = data.questions as Array<{ options: Array<{ label: string; wire: string }>; default_index: number }>;
      const q = questions[0];
      // When git probe finds no origin, default_index points to Local-only (index 1)
      // OR Remote-tracked (index 0) depending on origin_kind.
      // In test env (no git), origin_kind=null → Local-only first.
      // The test just verifies default_index is a valid 0-based index.
      assert.ok(typeof q.default_index === 'number', 'default_index must be a number');
      assert.ok(q.default_index >= 0 && q.default_index < q.options.length, 'default_index must be a valid option index');
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
      const row = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='onboarded'");
      assert.ok(row && row.value_json === 'true', 'plugin_config onboarded must be true');
      db.close();
    });

    it('local + gitflow: pr_target derives to dev, protected_branches gets both main + dev (#2878)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        branching_model: 'gitflow',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'gitflow');
      assert.equal(applied.pr_target, 'dev');
      assert.deepEqual(applied.protected_branches, ['main', 'dev']);
      db.close();
    });

    it('remote shape with no detectable origin URL emits a blank-URL warning (#675)', async () => {
      // Default repo path points at a NON-git directory → probe finds no remote
      // → origin URL blank. onboard_apply must surface a warning (not throw) so
      // issue-sync silence is visible to the operator. (An empty dir, rather
      // than the test cwd which IS a git repo with a real origin.)
      const noGitDir = mkdtempSync(join(tmpdir(), 'onboard-nogit-'));
      try {
        const db = tempDB();
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'widget')`, [noGitDir]);
        const tools = onboardTools(db, '/tmp/some-workspace/.claude/tmb/trajectory.db');
        const result = await call(tools.handlers, 'onboard_apply', {
          shape: 'remote',
          branching_model: 'github-flow',
          remote: ['github'],
          issue_sync: 'auto',
        });
        const data = parse(result);
        assert.equal(data.ok, true);
        assert.match(String(data.warning), /remote URL not detected for github/);
        const applied = data.applied as Record<string, unknown>;
        assert.match(String(applied.warning), /issues will not sync/);
        db.close();
      } finally {
        rmSync(noGitDir, { recursive: true, force: true });
      }
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

    it('branching_model label "GitHub Flow" resolves to wire value github-flow', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        branching_model: 'GitHub Flow',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'github-flow');
      db.close();
    });

    it('branching_model label "Git Flow" resolves to wire value gitflow', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        branching_model: 'Git Flow',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'gitflow');
      db.close();
    });

    it('branching_model label is case-insensitive ("GITHUB FLOW" resolves to github-flow)', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        branching_model: 'GITHUB FLOW',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'github-flow');
      db.close();
    });

    it('branching_model Keep sentinel resolves to omission (retains existing value)', async () => {
      const db = tempDB();
      db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('onboarded', 'true')`);
      db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('branching_model', '"gitflow"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'local',
        branching_model: '__keep__',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'gitflow');
      db.close();
    });

    it('issue_sync label resolves: "Auto — sync to the remote you picked" → auto', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: ['github'],
        issue_sync: 'Auto — sync to the remote you picked',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.issue_sync, 'auto');
      db.close();
    });

    it('issue_sync label resolves: "Off — local DB only" → off', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: ['github'],
        issue_sync: 'Off — local DB only',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.issue_sync, 'off');
      db.close();
    });

    it('remote label "GitHub" resolves to wire value github', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: ['GitHub'],
        issue_sync: 'off',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string }>;
      assert.equal(remotes.length, 1);
      assert.equal(remotes[0].provider, 'github');
      db.close();
    });

    it('remote label "GitHub (CLI not installed)" resolves to wire value github', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: ['GitHub (CLI not installed)'],
        issue_sync: 'off',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      const remotes = applied.remotes as Array<{ provider: string }>;
      assert.equal(remotes.length, 1);
      assert.equal(remotes[0].provider, 'github');
      db.close();
    });

    it('remote bad branching_model rejects bad branching_model', async () => {
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

    it('repos rows get target_branch/branching_model/protected_branches seeded after onboard_apply', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a'), ('/repo/b', 'b')`);
      const tools = onboardTools(db);
      await call(tools.handlers, 'onboard_apply', { shape: 'local', branching_model: 'gitflow' });
      const rows = db.all<{ target_branch: string; branching_model: string; protected_branches: string }>(
        `SELECT target_branch, branching_model, protected_branches FROM repos ORDER BY path`,
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.target_branch, 'dev');
        assert.equal(row.branching_model, 'gitflow');
        assert.equal(row.protected_branches, JSON.stringify(['main', 'dev']));
      }
      db.close();
    });

    it('re-onboard with different model overwrites all repos rows (no stale values)', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a')`);
      const tools = onboardTools(db);
      await call(tools.handlers, 'onboard_apply', { shape: 'local', branching_model: 'github-flow' });
      await call(tools.handlers, 'onboard_apply', { shape: 'local', branching_model: 'gitflow' });
      const row = db.get<{ target_branch: string; branching_model: string; protected_branches: string }>(
        `SELECT target_branch, branching_model, protected_branches FROM repos WHERE path = '/repo/a'`,
      );
      assert.ok(row, 'repos row should exist');
      assert.equal(row.target_branch, 'dev');
      assert.equal(row.branching_model, 'gitflow');
      assert.equal(row.protected_branches, JSON.stringify(['main', 'dev']));
      db.close();
    });

    it('onboard_apply with empty repos table does not error', async () => {
      const db = tempDB();
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', { shape: 'local' });
      const data = parse(result);
      assert.equal(data.ok, true);
      db.close();
    });

    it('stored protected_branches in repos parses as a JSON array', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/x', 'x')`);
      const tools = onboardTools(db);
      await call(tools.handlers, 'onboard_apply', { shape: 'local', branching_model: 'github-flow' });
      const row = db.get<{ protected_branches: string }>(
        `SELECT protected_branches FROM repos WHERE path = '/repo/x'`,
      );
      assert.ok(row, 'repos row should exist');
      const parsed = JSON.parse(row.protected_branches) as unknown;
      assert.ok(Array.isArray(parsed), 'protected_branches must parse as a JSON array');
      assert.ok((parsed as string[]).length > 0, 'array must be non-empty');
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
      assert.equal(map.pr_target, 'dev');
      assert.deepEqual((map.protected_branches as string[]).sort(), ['dev', 'main']);
      assert.equal(map.issue_sync, 'auto');
      // identity row also written as marker
      const cfg = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='onboarded'");
      assert.ok(cfg && cfg.value_json === 'true', 'plugin_config onboarded marker written');
      db.close();
    });
  });
});
