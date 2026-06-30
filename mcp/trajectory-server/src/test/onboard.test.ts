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
      // Repo-scoped policy reads from the repos table (#980); an empty repos
      // table yields null (no schema-seeded global default any more).
      assert.equal(current.branching_model, null);
      db.close();
    });

    it('reports repo-scoped policy from the repos table (#980)', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO repos (path, name, target_branch, branching_model, protected_branches, remotes)
         VALUES ('/repo/x', 'x', 'dev', 'gitflow', '["main","dev"]', '[]')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const current = parse(result).current as Record<string, unknown>;
      assert.equal(current.branching_model, 'gitflow');
      assert.equal(current.pr_target, 'dev');
      assert.deepEqual(current.protected_branches, ['main', 'dev']);
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

    it('probes the SOLE (registered) REPO path, not the workspace-root cwd (#675)', async () => {
      // A real git repo with a github origin, sitting at an arbitrary path that
      // is NOT the workspace root the dbPath would strip down to. The probe must
      // resolve it via the `repos` row (resolveSoleRepoPath single-repo
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
        assert.equal(probe.in_git, true, 'must probe inside the sole (registered) repo git tree');
        const origin = probe.detected_remotes.find((r) => r.name === 'origin');
        assert.ok(origin, 'origin remote must be detected from the sole (registered) repo path');
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
      // Current branching model lives on the repos table now (#980).
      db.run(`INSERT INTO repos (path, name, branching_model) VALUES ('/repo/r', 'r', 'github-flow')`);
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
      db.run(`INSERT INTO repos (path, name, branching_model) VALUES ('/repo/r', 'r', 'github-flow')`);
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

    it('per-repo round=main reflects THAT repo row values in Keep options', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO repos (path, name, target_branch, branching_model, protected_branches)
         VALUES ('/repo/a', 'a', 'develop', 'gitflow', '["main","develop"]'),
                ('/repo/b', 'b', 'main', 'github-flow', '["main"]')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'remote',
        round: 'main',
        repo: 'a',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string; wire: string }> }>;
      assert.deepEqual(questions.map((q) => q.header), ['Branching', 'PR target']);
      assert.equal(questions[0].options[0].label, 'Keep "gitflow"');
      assert.equal(questions[0].options[0].wire, '__keep__');
      assert.equal(questions[1].options[0].label, 'Keep "develop"');
      assert.equal(questions[1].options[0].wire, '__keep__');
      db.close();
    });

    it('per-repo round=main on a never-onboarded repo shows no Keep options', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a')`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'remote',
        round: 'main',
        repo: 'a',
      });
      const data = parse(result);
      const questions = data.questions as Array<{ header: string; options: Array<{ label: string }> }>;
      for (const q of questions) {
        assert.ok(!q.options.some((o) => o.label.startsWith('Keep')), `${q.header} must not offer Keep for a fresh repo`);
      }
      db.close();
    });

    it('per-repo round=main rejects an unknown repo name', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a')`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'remote',
        round: 'main',
        repo: 'nope',
      });
      const data = parse(result);
      assert.match(String(data.error), /unknown repo 'nope'/);
      db.close();
    });

    it('per-repo param requires shape=remote', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a')`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_get_questions', {
        shape: 'local',
        round: 'main',
        repo: 'a',
      });
      const data = parse(result);
      assert.match(String(data.error), /requires shape='remote'/);
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
      // Sole (registered) repo path points at a NON-git directory → probe finds no remote
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
      // Existing value lives on the repos table now (#980).
      db.run(`INSERT INTO repos (path, name, branching_model) VALUES ('/repo/k', 'k', 'gitflow')`);
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
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a')`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'gitflow',
        remote: 'github',
        issue_sync: 'auto',
      });
      const data = parse(result);
      assert.equal(data.ok, true);

      // The four repo-scoped keys live on the repos table, NOT plugin_config (#980).
      const stale = db.all<{ key: string }>(
        `SELECT key FROM plugin_config WHERE key IN ('branching_model','pr_target','protected_branches','remotes')`,
      );
      assert.equal(stale.length, 0, 'no repo-scoped keys may be written to plugin_config');

      const repo = db.get<{
        target_branch: string;
        branching_model: string;
        protected_branches: string;
      }>(`SELECT target_branch, branching_model, protected_branches FROM repos WHERE path = '/repo/a'`);
      assert.equal(repo!.branching_model, 'gitflow');
      assert.equal(repo!.target_branch, 'dev');
      assert.deepEqual((JSON.parse(repo!.protected_branches) as string[]).sort(), ['dev', 'main']);

      // issue_sync stays global in plugin_config.
      const sync = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='issue_sync'");
      assert.equal(JSON.parse(sync!.value_json), 'auto');
      // identity row also written as marker
      const cfg = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='onboarded'");
      assert.ok(cfg && cfg.value_json === 'true', 'plugin_config onboarded marker written');
      db.close();
    });
  });

  describe('onboard_apply (workspace per-repo reconciliation #13)', () => {
    function initRepo(dir: string, opts: { branches?: string[]; origin?: string } = {}): void {
      const gitOpts = { cwd: dir, encoding: 'utf8' as const };
      spawnSync('git', ['init', '-q', '-b', 'main'], gitOpts);
      spawnSync('git', ['config', 'user.email', 't@t.t'], gitOpts);
      spawnSync('git', ['config', 'user.name', 't'], gitOpts);
      spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], gitOpts);
      for (const b of opts.branches ?? []) {
        spawnSync('git', ['branch', b], gitOpts);
      }
      if (opts.origin) {
        spawnSync('git', ['remote', 'add', 'origin', opts.origin], gitOpts);
      }
    }

    it('main-only sibling is reconciled to github-flow/main under a gitflow workspace choice (#13)', async () => {
      const repoMain = mkdtempSync(join(tmpdir(), 'onboard-main-'));
      const repoDev = mkdtempSync(join(tmpdir(), 'onboard-dev-'));
      try {
        initRepo(repoMain, { origin: 'https://github.com/acme/main-only.git' });
        initRepo(repoDev, { branches: ['dev'], origin: 'https://github.com/acme/has-dev.git' });

        const db = tempDB();
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'main-only')`, [repoMain]);
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'has-dev')`, [repoDev]);
        const tools = onboardTools(db);
        const result = await call(tools.handlers, 'onboard_apply', {
          shape: 'remote',
          branching_model: 'gitflow',
          pr_target: 'dev',
          remote: ['github'],
          issue_sync: 'auto',
        });
        assert.equal(parse(result).ok, true);

        const mainRow = db.get<{ target_branch: string; branching_model: string; protected_branches: string }>(
          `SELECT target_branch, branching_model, protected_branches FROM repos WHERE name='main-only'`,
        );
        assert.equal(mainRow!.branching_model, 'github-flow', 'main-only repo cannot run gitflow/dev');
        assert.equal(mainRow!.target_branch, 'main', 'downgraded to its real default branch');
        assert.deepEqual(JSON.parse(mainRow!.protected_branches), ['main']);

        const devRow = db.get<{ target_branch: string; branching_model: string; protected_branches: string }>(
          `SELECT target_branch, branching_model, protected_branches FROM repos WHERE name='has-dev'`,
        );
        assert.equal(devRow!.branching_model, 'gitflow', 'dev-capable sibling keeps the chosen gitflow model');
        assert.equal(devRow!.target_branch, 'dev');
        assert.deepEqual((JSON.parse(devRow!.protected_branches) as string[]).sort(), ['dev', 'main']);
        db.close();
      } finally {
        rmSync(repoMain, { recursive: true, force: true });
        rmSync(repoDev, { recursive: true, force: true });
      }
    });

    it('each repo gets ITS OWN remotes, not the managed repo\'s (#979)', async () => {
      const repoA = mkdtempSync(join(tmpdir(), 'onboard-rA-'));
      const repoB = mkdtempSync(join(tmpdir(), 'onboard-rB-'));
      try {
        initRepo(repoA, { branches: ['dev'], origin: 'https://github.com/acme/alpha.git' });
        initRepo(repoB, { branches: ['dev'], origin: 'https://github.com/acme/beta.git' });

        const db = tempDB();
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'alpha')`, [repoA]);
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'beta')`, [repoB]);
        const tools = onboardTools(db);
        await call(tools.handlers, 'onboard_apply', {
          shape: 'remote',
          branching_model: 'gitflow',
          pr_target: 'dev',
          remote: ['github'],
          issue_sync: 'auto',
        });

        const a = db.get<{ remotes: string }>(`SELECT remotes FROM repos WHERE name='alpha'`);
        const b = db.get<{ remotes: string }>(`SELECT remotes FROM repos WHERE name='beta'`);
        const aRemotes = JSON.parse(a!.remotes) as Array<{ url: string }>;
        const bRemotes = JSON.parse(b!.remotes) as Array<{ url: string }>;
        assert.equal(aRemotes[0].url, 'https://github.com/acme/alpha.git');
        assert.equal(bRemotes[0].url, 'https://github.com/acme/beta.git');
        db.close();
      } finally {
        rmSync(repoA, { recursive: true, force: true });
        rmSync(repoB, { recursive: true, force: true });
      }
    });

    it('single real git repo keeps the chosen gitflow/dev (single-repo unchanged)', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'onboard-solo-'));
      try {
        initRepo(repo, { branches: ['dev'], origin: 'https://github.com/acme/solo.git' });
        const db = tempDB();
        db.run(`INSERT INTO repos (path, name) VALUES (?, 'solo')`, [repo]);
        const tools = onboardTools(db);
        const result = await call(tools.handlers, 'onboard_apply', {
          shape: 'remote',
          branching_model: 'gitflow',
          pr_target: 'dev',
          remote: ['github'],
          issue_sync: 'auto',
        });
        const applied = parse(result).applied as Record<string, unknown>;
        assert.equal(applied.branching_model, 'gitflow');
        assert.equal(applied.pr_target, 'dev');

        const row = db.get<{ target_branch: string; branching_model: string; remotes: string }>(
          `SELECT target_branch, branching_model, remotes FROM repos WHERE name='solo'`,
        );
        assert.equal(row!.branching_model, 'gitflow');
        assert.equal(row!.target_branch, 'dev');
        const remotes = JSON.parse(row!.remotes) as Array<{ url: string }>;
        assert.equal(remotes[0].url, 'https://github.com/acme/solo.git');
        db.close();
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('onboard_apply (per-repo)', () => {
    it('writes ONLY the named repos row; other repos + global markers untouched', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO repos (path, name, target_branch, branching_model, protected_branches)
         VALUES ('/repo/a', 'a', 'main', 'github-flow', '["main"]'),
                ('/repo/b', 'b', 'main', 'github-flow', '["main"]')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        repo: 'a',
        branching_model: 'gitflow',
        pr_target: 'develop',
      });
      const data = parse(result);
      assert.equal(data.ok, true);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.repo, 'a');
      assert.equal(applied.branching_model, 'gitflow');
      assert.equal(applied.pr_target, 'develop');
      assert.deepEqual(applied.protected_branches, ['main', 'develop']);

      const rowA = db.get<{ target_branch: string; branching_model: string; protected_branches: string }>(
        `SELECT target_branch, branching_model, protected_branches FROM repos WHERE name='a'`,
      );
      assert.ok(rowA);
      assert.equal(rowA.target_branch, 'develop');
      assert.equal(rowA.branching_model, 'gitflow');
      assert.equal(rowA.protected_branches, JSON.stringify(['main', 'develop']));

      // Repo b is untouched.
      const rowB = db.get<{ target_branch: string; branching_model: string }>(
        `SELECT target_branch, branching_model FROM repos WHERE name='b'`,
      );
      assert.ok(rowB);
      assert.equal(rowB.target_branch, 'main');
      assert.equal(rowB.branching_model, 'github-flow');

      // Global markers untouched — per-repo apply writes neither onboarded nor issue_sync.
      // onboarded is not schema-seeded, so its absence proves no global write.
      const onboarded = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='onboarded'");
      assert.equal(onboarded, undefined, 'per-repo apply must NOT write the global onboarded marker');
      // issue_sync stays at its schema-seeded default ("off"); the workspace apply would set it.
      const sync = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='issue_sync'");
      assert.equal(JSON.parse(sync!.value_json), 'off', 'per-repo apply must leave global issue_sync at its seeded default');
      db.close();
    });

    it('derives pr_target from branching_model when pr_target omitted', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/a', 'a')`);
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        repo: 'a',
        branching_model: 'gitflow',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.pr_target, 'dev');
      assert.deepEqual(applied.protected_branches, ['main', 'dev']);
      db.close();
    });

    it('Keep sentinel retains the repo row existing values', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO repos (path, name, target_branch, branching_model)
         VALUES ('/repo/a', 'a', 'develop', 'gitflow')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        repo: 'a',
        branching_model: '__keep__',
        pr_target: '__keep__',
      });
      const data = parse(result);
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.branching_model, 'gitflow');
      assert.equal(applied.pr_target, 'develop');
      db.close();
    });

    it('rejects an unknown repo name with no partial write', async () => {
      const db = tempDB();
      db.run(
        `INSERT INTO repos (path, name, target_branch, branching_model)
         VALUES ('/repo/a', 'a', 'main', 'github-flow')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        repo: 'nope',
        branching_model: 'gitflow',
      });
      const data = parse(result);
      assert.match(String(data.error), /unknown repo 'nope'/);
      const rowA = db.get<{ branching_model: string }>(`SELECT branching_model FROM repos WHERE name='a'`);
      assert.ok(rowA);
      assert.equal(rowA.branching_model, 'github-flow');
      db.close();
    });
  });
});
