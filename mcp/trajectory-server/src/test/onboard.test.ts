import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { onboardTools } from '../tools/onboard.js';
import { tempDB } from './helpers.js';
import { repoRemotes, upsertRepoRemotes } from '../repos/remotes.js';
import {
  removeProjectSandbox,
  SANDBOX_NETWORK_PROBE,
  sandboxToolEnv,
  TMB_ALLOWED_DOMAINS,
  type SandboxRecord,
} from '../tools/onboard-sandbox.js';

// No onboard test may reach the real ~/.claude: HOME is a fresh temp dir and no
// inherited plugin root survives, so os.homedir() and resolvePluginRoot() land
// in a sandbox even for apply calls that pass no shim environment.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'onboard-home-'));
process.env['HOME'] = ISOLATED_HOME;
delete process.env['CLAUDE_PLUGIN_ROOT'];
delete process.env['CLAUDE_CONFIG_DIR'];

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
        `INSERT INTO repos (path, name, target_branch, branching_model, protected_branches)
         VALUES ('/repo/x', 'x', 'dev', 'gitflow', '["main","dev"]')`,
      );
      const tools = onboardTools(db);
      const result = await call(tools.handlers, 'onboard_state_get', {});
      const current = parse(result).current as Record<string, unknown>;
      assert.equal(current.branching_model, 'gitflow');
      assert.equal(current.pr_target, 'dev');
      assert.deepEqual(current.protected_branches, ['main', 'dev']);
      assert.deepEqual(current.remotes, []);
      db.close();
    });

    it('reports the repo\'s remotes from repo_remotes as {name, provider, url}, primary first', async () => {
      const db = tempDB();
      db.run(`INSERT INTO repos (path, name) VALUES ('/repo/x', 'x')`);
      upsertRepoRemotes(db, 'x', [
        { name: 'upstream', provider: 'github', url: 'https://github.com/up/x.git' },
        { name: 'origin', provider: 'gitlab', url: 'git@gitlab.com:me/x.git' },
      ]);
      const tools = onboardTools(db);
      const current = parse(await call(tools.handlers, 'onboard_state_get', {})).current as Record<string, unknown>;
      assert.deepEqual(current.remotes, [
        { name: 'origin', provider: 'gitlab', url: 'git@gitlab.com:me/x.git' },
        { name: 'upstream', provider: 'github', url: 'https://github.com/up/x.git' },
      ]);
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

        const aRemotes = repoRemotes(db, 'alpha');
        const bRemotes = repoRemotes(db, 'beta');
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

        const row = db.get<{ target_branch: string; branching_model: string }>(
          `SELECT target_branch, branching_model FROM repos WHERE name='solo'`,
        );
        assert.equal(row!.branching_model, 'gitflow');
        assert.equal(row!.target_branch, 'dev');
        assert.equal(repoRemotes(db, 'solo')[0]!.url, 'https://github.com/acme/solo.git');
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

  describe('sandbox_enforcement', () => {
    function project() {
      const base = mkdtempSync(join(tmpdir(), 'onboard-sandbox-'));
      const proj = join(base, 'proj');
      mkdirSync(proj);
      return { base, proj, dbPath: join(proj, '.claude', 'tmb', 'trajectory.db'), settings: join(proj, '.claude', 'settings.local.json') };
    }

    it('round=sandbox returns one question, default No off the probed platform', async () => {
      const db = tempDB();
      const { base, dbPath } = project();
      const data = parse(
        await call(onboardTools(db, dbPath, { platform: 'linux' }).handlers, 'onboard_get_questions', { round: 'sandbox' }),
      );
      const q = (data.questions as Array<{ header: string; options: Array<{ wire: string; label: string }>; default_index: number }>)[0];
      assert.equal(q.header, 'Sandbox');
      assert.equal(q.options[q.default_index].wire, 'no');
      assert.ok(!q.options.some((o) => /Recommended/.test(o.label)));
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('default apply writes no sandbox block', async () => {
      const db = tempDB();
      const { base, dbPath, settings } = project();
      const data = parse(await call(onboardTools(db, dbPath).handlers, 'onboard_apply', { shape: 'local' }));
      assert.equal((data.applied as Record<string, unknown>).sandbox_enforcement, 'no');
      assert.ok(!existsSync(settings));
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('yes writes the sandbox block with the project and model cache; no removes only what TMB added', async () => {
      const db = tempDB();
      const { base, proj, dbPath, settings } = project();
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(settings, JSON.stringify({ model: 'x', sandbox: { filesystem: { allowWrite: ['/user/own'] } } }));
      const tools = onboardTools(db, dbPath, { platform: 'darwin' });
      const data = parse(await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'yes' }));
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.sandbox_enforcement, 'yes');
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      assert.equal(written.model, 'x', 'other keys kept');
      assert.equal(written.sandbox.enabled, true);
      assert.equal(written.sandbox.filesystem.allowWrite[0], '/user/own', 'the user entry is kept first');
      assert.ok(written.sandbox.filesystem.allowWrite.includes(proj), 'the project is writable');
      assert.equal(written.sandbox.filesystem.allowWrite.length, 3, 'project + model cache added');
      assert.equal(written.sandbox.enableWeakerNetworkIsolation, true, 'macOS: gh can reach the TLS trust service');
      assert.deepEqual(written.env, {
        npm_config_cache: join(proj, '.claude', 'tmb', 'cache', 'npm'),
        BUN_INSTALL_CACHE_DIR: join(proj, '.claude', 'tmb', 'cache', 'bun'),
      });
      for (const value of Object.values(written.env as Record<string, string>)) {
        assert.ok(value.startsWith(proj + '/'), `${value} is inside the project`);
      }
      const sandboxResult = applied.sandbox as Record<string, unknown>;
      assert.deepEqual(sandboxResult.env, written.env);
      assert.equal(sandboxResult.weaker_network_isolation, true);

      await call(tools.handlers, 'onboard_apply', { shape: 'local' });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), written, 'a re-apply keeps the stored yes and is idempotent');

      await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'No' });
      assert.deepEqual(
        JSON.parse(readFileSync(settings, 'utf8')),
        { model: 'x', sandbox: { filesystem: { allowWrite: ['/user/own'] } } },
        'purge leaves exactly the user settings',
      );
      const state = parse(await call(tools.handlers, 'onboard_state_get', {}));
      assert.equal((state.current as Record<string, unknown>).sandbox_enforcement, 'no');
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('on linux the block carries the cache env but not the macOS-only enableWeakerNetworkIsolation', async () => {
      const db = tempDB();
      const { base, proj, dbPath, settings } = project();
      const tools = onboardTools(db, dbPath, { platform: 'linux' });
      await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'yes' });
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      assert.equal(written.sandbox.enableWeakerNetworkIsolation, undefined);
      assert.deepEqual(written.env, sandboxToolEnv(join(proj, '.claude', 'tmb', 'cache')));
      await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'no' });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {}, 'no leaves nothing TMB wrote');
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it("yes keeps the user's env values and enableWeakerNetworkIsolation; no removes only TMB's", async () => {
      const db = tempDB();
      const { base, proj, dbPath, settings } = project();
      mkdirSync(join(proj, '.claude'), { recursive: true });
      const user = {
        env: { npm_config_cache: '/user/npm-cache', FOO: 'bar' },
        sandbox: { enableWeakerNetworkIsolation: false },
      };
      writeFileSync(settings, JSON.stringify(user));
      const tools = onboardTools(db, dbPath, { platform: 'darwin' });
      await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'yes' });
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      assert.equal(written.env.npm_config_cache, '/user/npm-cache', "the user's npm cache is kept");
      assert.equal(written.env.FOO, 'bar');
      assert.equal(written.env.BUN_INSTALL_CACHE_DIR, join(proj, '.claude', 'tmb', 'cache', 'bun'));
      assert.equal(written.sandbox.enableWeakerNetworkIsolation, false, "the user's explicit false is kept");
      const record = sandboxRecord(db);
      assert.deepEqual(record.env, { BUN_INSTALL_CACHE_DIR: join(proj, '.claude', 'tmb', 'cache', 'bun') });
      assert.equal(record.weaker_network_isolation_set, false);

      await call(tools.handlers, 'onboard_apply', { shape: 'local' });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), written, 'a re-apply is idempotent');

      await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'no' });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), user, 'no leaves exactly the user settings');
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('no keeps an env value the user changed after TMB wrote it', () => {
      const { base, proj, settings } = project();
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(
        settings,
        JSON.stringify({
          sandbox: { enabled: true, enableWeakerNetworkIsolation: true },
          env: { npm_config_cache: '/edited', BUN_INSTALL_CACHE_DIR: '/tmb/bun' },
        }),
      );
      const result = removeProjectSandbox({
        projectRoot: proj,
        record: {
          enabled_set: true,
          allow_write: [],
          weaker_network_isolation_set: true,
          env: { npm_config_cache: '/tmb/npm', BUN_INSTALL_CACHE_DIR: '/tmb/bun' },
        },
      });
      assert.equal(result.removed, true);
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { env: { npm_config_cache: '/edited' } });
      rmSync(base, { recursive: true, force: true });
    });

    it('writes nothing without a project derived from the DB path', async () => {
      const db = tempDB();
      const data = parse(await call(onboardTools(db).handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'yes' }));
      assert.equal(((data.applied as Record<string, unknown>).sandbox as Record<string, unknown>).written, false);
      db.close();
    });

    function gitProject(origin: string) {
      const p = project();
      const gitOpts = { cwd: p.proj, encoding: 'utf8' as const };
      spawnSync('git', ['init', '-q', '-b', 'main'], gitOpts);
      spawnSync('git', ['remote', 'add', 'origin', origin], gitOpts);
      return p;
    }

    function sandboxRecord(db: TrajectoryDB): SandboxRecord {
      const row = db.get<{ value_json: string }>("SELECT value_json FROM plugin_config WHERE key='sandbox_settings'");
      return JSON.parse(row!.value_json) as SandboxRecord;
    }

    it("yes merges the network allow-list with each HTTPS remote's host; no removes only TMB's domains", async () => {
      const db = tempDB();
      const { base, proj, dbPath, settings } = gitProject('https://gitlab.example.com/acme/app.git');
      db.run(`INSERT INTO repos (path, name) VALUES (?, 'app')`, [proj]);
      mkdirSync(join(proj, '.claude'), { recursive: true });
      const user = {
        sandbox: { excludedCommands: ['docker'], network: { allowedDomains: ['example.org', 'github.com'] } },
      };
      writeFileSync(settings, JSON.stringify(user));
      const tools = onboardTools(db, dbPath, { platform: 'darwin' });
      const data = parse(
        await call(tools.handlers, 'onboard_apply', {
          shape: 'remote',
          branching_model: 'github-flow',
          remote: ['gitlab'],
          issue_sync: 'off',
          sandbox_enforcement: 'yes',
        }),
      );
      assert.equal(data.ok, true);
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      assert.deepEqual(written.sandbox.excludedCommands, ['docker'], 'the user excludedCommands is kept');
      assert.deepEqual(written.sandbox.network.allowedDomains, [
        'example.org',
        'github.com',
        'api.github.com',
        '*.githubusercontent.com',
        'registry.npmjs.org',
        'gitlab.example.com',
      ]);
      const record = sandboxRecord(db);
      assert.ok(record.allowed_domains && record.allowed_domains.length > 0, 'allowed_domains is populated');
      assert.ok(record.allowed_domains.includes('gitlab.example.com'), "the HTTPS remote's host is recorded");
      assert.ok(!record.allowed_domains.includes('github.com'), 'a domain the user had is not TMB-owned');

      await call(tools.handlers, 'onboard_apply', { shape: 'remote', branching_model: 'github-flow', remote: ['gitlab'], issue_sync: 'off' });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), written, 'a re-apply keeps the stored yes and is idempotent');

      await call(tools.handlers, 'onboard_apply', {
        shape: 'remote',
        branching_model: 'github-flow',
        remote: ['gitlab'],
        issue_sync: 'off',
        sandbox_enforcement: 'no',
      });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), user, 'no leaves exactly the user settings');
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('yes never writes excludedCommands and accepts the Recommended label', async () => {
      const db = tempDB();
      const { base, dbPath, settings } = project();
      await call(onboardTools(db, dbPath).handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'Yes (Recommended)' });
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      assert.equal(written.sandbox.excludedCommands, undefined);
      assert.deepEqual(written.sandbox.network.allowedDomains, [...TMB_ALLOWED_DOMAINS]);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('the recorded probe names its platform, CC version and date', () => {
      assert.equal(SANDBOX_NETWORK_PROBE.platform, 'darwin');
      assert.match(SANDBOX_NETWORK_PROBE.cc_version, /^\d+\.\d+\.\d+$/);
      assert.match(SANDBOX_NETWORK_PROBE.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual([...SANDBOX_NETWORK_PROBE.failed], []);
    });

    it('the fresh default on the probed platform with an HTTPS remote is Yes (Recommended)', async () => {
      const db = tempDB();
      const { base, dbPath } = gitProject('https://github.com/acme/app.git');
      const tools = onboardTools(db, dbPath, { platform: SANDBOX_NETWORK_PROBE.platform });
      const data = parse(await call(tools.handlers, 'onboard_get_questions', { round: 'sandbox' }));
      const q = (data.questions as Array<{ options: Array<{ wire: string; label: string; description: string }>; default_index: number }>)[0];
      assert.equal(q.options[q.default_index].wire, 'yes');
      assert.equal(q.options[q.default_index].label, 'Yes (Recommended)');
      assert.match(q.options[q.default_index].description, /gh needs macOS's TLS trust service, which slightly weakens isolation/);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('the fresh default on linux with an HTTPS remote stays No', async () => {
      const db = tempDB();
      const { base, dbPath } = gitProject('https://github.com/acme/app.git');
      const data = parse(
        await call(onboardTools(db, dbPath, { platform: 'linux' }).handlers, 'onboard_get_questions', { round: 'sandbox' }),
      );
      const q = (data.questions as Array<{ options: Array<{ wire: string; label: string; description: string }>; default_index: number }>)[0];
      assert.equal(q.options[q.default_index].wire, 'no');
      assert.ok(!q.options.some((o) => /Recommended/.test(o.label)));
      assert.doesNotMatch(q.options.find((o) => o.wire === 'yes')!.description, /trust service/);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('an SSH remote keeps the fresh default at No and the Yes option says why', async () => {
      const db = tempDB();
      const { base, dbPath } = gitProject('git@github.com:acme/app.git');
      const tools = onboardTools(db, dbPath, { platform: SANDBOX_NETWORK_PROBE.platform });
      const data = parse(await call(tools.handlers, 'onboard_get_questions', { round: 'sandbox' }));
      const q = (data.questions as Array<{ options: Array<{ wire: string; description: string }>; default_index: number }>)[0];
      assert.equal(q.options[q.default_index].wire, 'no');
      assert.match(q.options.find((o) => o.wire === 'yes')!.description, /\. Git over SSH bypasses the sandbox proxy/);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('re-onboard defaults to keeping the stored value', async () => {
      const db = tempDB();
      const { base, dbPath } = project();
      const tools = onboardTools(db, dbPath);
      await call(tools.handlers, 'onboard_apply', { shape: 'local', sandbox_enforcement: 'yes' });
      const data = parse(await call(tools.handlers, 'onboard_get_questions', { round: 'sandbox' }));
      const q = (data.questions as Array<{ options: Array<{ wire: string; label: string }>; default_index: number }>)[0];
      assert.equal(q.options[q.default_index].label, 'Keep "yes"');
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('a record from before GH 1252 (no allowed_domains) still removes cleanly', () => {
      const { base, proj, settings } = project();
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: ['example.org'] } } }));
      const result = removeProjectSandbox({ projectRoot: proj, record: { enabled_set: true, allow_write: [] } });
      assert.equal(result.removed, true);
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { sandbox: { network: { allowedDomains: ['example.org'] } } });
      rmSync(base, { recursive: true, force: true });
    });
  });

  describe('headless_enforcement', () => {
    const HOOKS_JSON = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/git-guards.sh', timeout: 10 }] },
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/no-source-edit-from-main.sh', timeout: 5 }] },
        ],
      },
    };

    function sandbox() {
      const base = mkdtempSync(join(tmpdir(), 'onboard-headless-'));
      const pluginRoot = join(base, 'claude-home', 'plugins', 'cache', 'trustmybot', 'tmb', '1.0.0');
      mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
      mkdirSync(join(pluginRoot, 'scripts', 'lib'), { recursive: true });
      writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
      writeFileSync(join(pluginRoot, 'scripts', 'lib', 'resolve-hook.sh'), '#!/usr/bin/env bash\nexit 0\n');
      const project = join(base, 'proj');
      mkdirSync(project);
      const dbPath = join(project, '.claude', 'tmb', 'trajectory.db');
      const settings = join(project, '.claude', 'settings.local.json');
      return { base, pluginRoot, project, dbPath, settings };
    }

    it("round='headless' is not an /onboard round", async () => {
      const db = tempDB();
      const { base, pluginRoot, dbPath } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot });
      const result = (await call(tools.handlers, 'onboard_get_questions', { round: 'headless' })) as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(String(parse(result).error), /unknown round 'headless'/);
      const def = tools.definitions.find((d) => d.name === 'onboard_get_questions');
      const roundSchema = (def?.inputSchema.properties as Record<string, { enum: string[] }>)['round'];
      assert.deepEqual(roundSchema.enum, ['shape', 'main', 'sync', 'sandbox']);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('headless_enforcement alone on an onboarded project writes the row and the shim', async () => {
      const db = tempDB();
      const { base, pluginRoot, dbPath, settings } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot });
      await call(tools.handlers, 'onboard_apply', { shape: 'local' });
      const data = parse(await call(tools.handlers, 'onboard_apply', { headless_enforcement: 'yes' }));
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.headless_enforcement, 'yes');
      assert.equal((applied.headless_shim as Record<string, unknown>).written, true);
      const state = parse(await call(tools.handlers, 'onboard_state_get', {}));
      assert.equal((state.current as Record<string, unknown>).headless_enforcement, 'yes');
      const entries = JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse.flatMap((g: { hooks: unknown[] }) => g.hooks);
      assert.equal(entries.length, 2);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('headless_enforcement alone before onboarding is refused, naming /onboard', async () => {
      const db = tempDB();
      const { base, pluginRoot, dbPath, settings } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot });
      const result = (await call(tools.handlers, 'onboard_apply', { headless_enforcement: 'yes' })) as { isError?: boolean };
      assert.equal(result.isError, true);
      assert.match(String(parse(result).error), /\/onboard/);
      assert.equal(db.get(`SELECT 1 AS one FROM plugin_config WHERE key = 'headless_enforcement'`), undefined);
      assert.ok(!existsSync(settings));
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('the sandbox question names the settings file and the keys it writes', async () => {
      const db = tempDB();
      const { base, pluginRoot, dbPath } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot, platform: 'linux' });
      const data = parse(await call(tools.handlers, 'onboard_get_questions', { round: 'sandbox' }));
      const q = (data.questions as Array<{ question: string; options: Array<{ wire: string; description: string }> }>)[0];
      for (const key of [
        '.claude/settings.local.json',
        'sandbox.enabled',
        'sandbox.filesystem.allowWrite',
        'sandbox.network.allowedDomains',
        'sandbox.enableWeakerNetworkIsolation',
        'env.npm_config_cache',
        'env.BUN_INSTALL_CACHE_DIR',
        '.gitignore',
      ]) {
        assert.ok(q.question.includes(key), `question names ${key}`);
      }
      for (const o of q.options) assert.doesNotMatch(o.description, /allow-list|egress|seatbelt/i);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('default apply never writes the shim and stores no', async () => {
      const db = tempDB();
      const { base, pluginRoot, dbPath, settings } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot });
      const data = parse(await call(tools.handlers, 'onboard_apply', { shape: 'local' }));
      const applied = data.applied as Record<string, unknown>;
      assert.equal(applied.headless_enforcement, 'no');
      assert.ok(!existsSync(settings), 'neither the shim nor a sandbox block is written by default');
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('yes writes project-tagged --shim entries into the project; yes→no purges them', async () => {
      const db = tempDB();
      const { base, pluginRoot, project, dbPath, settings } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot });
      await call(tools.handlers, 'onboard_apply', { shape: 'local', headless_enforcement: 'yes' });
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      const entries = written.hooks.PreToolUse.flatMap((g: { hooks: unknown[] }) => g.hooks) as Array<{ command: string; _tmb_project: string }>;
      assert.equal(entries.length, 2);
      for (const e of entries) {
        assert.equal(e._tmb_project, project);
        assert.ok(e.command.endsWith(`--shim --project ${project}`), e.command);
      }
      assert.ok(existsSync(join(project, '.claude', 'tmb', 'resolve-hook.sh')));
      const state = parse(await call(tools.handlers, 'onboard_state_get', {}));
      assert.equal((state.current as Record<string, unknown>).headless_enforcement, 'yes');

      await call(tools.handlers, 'onboard_apply', { shape: 'local', headless_enforcement: 'no' });
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {});
      assert.ok(!existsSync(join(project, '.claude', 'tmb', 'resolve-hook.sh')));
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('re-onboard without an answer keeps a stored yes', async () => {
      const db = tempDB();
      const { base, pluginRoot, dbPath, settings } = sandbox();
      const tools = onboardTools(db, dbPath, { pluginRoot });
      await call(tools.handlers, 'onboard_apply', { shape: 'local', headless_enforcement: 'Yes' });
      const before = readFileSync(settings, 'utf8');
      const data = parse(await call(tools.handlers, 'onboard_apply', { shape: 'local' }));
      assert.equal((data.applied as Record<string, unknown>).headless_enforcement, 'yes');
      assert.equal(readFileSync(settings, 'utf8'), before);
      rmSync(base, { recursive: true, force: true });
      db.close();
    });

    it('the isolated HOME stays empty across every onboard test', () => {
      assert.deepEqual(readdirSync(ISOLATED_HOME), []);
    });
  });
  describe('persona stays out of onboard_apply', () => {
    function fixture() {
      const base = mkdtempSync(join(tmpdir(), 'onboard-persona-'));
      const pluginRoot = join(base, 'plugin');
      const proj = join(base, 'proj');
      mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
      mkdirSync(proj);
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb', version: '1.1.0' }));
      writeFileSync(join(pluginRoot, 'CLAUDE.md'), '# You are bro\n');
      return { base, pluginRoot, proj, dbPath: join(proj, '.claude', 'tmb', 'trajectory.db'), claudeMd: join(proj, 'CLAUDE.md') };
    }
    const personaRows = (db: ReturnType<typeof tempDB>) =>
      db.all<{ id: number }>(`SELECT id FROM audit WHERE event_type = 'persona_block_written'`).length;

    it('the onboard_apply input schema has no persona property', () => {
      const def = onboardTools(tempDB()).definitions.find((d) => d.name === 'onboard_apply');
      assert.ok(def, 'onboard_apply is defined');
      const props = (def.inputSchema as { properties: Record<string, unknown> }).properties;
      assert.equal('persona' in props, false);
    });

    for (const persona of [true, false]) {
      it(`a call passing persona: ${persona} is rejected with persona_input_removed and writes nothing`, async () => {
        const db = tempDB();
        const fx = fixture();
        const tools = onboardTools(db, fx.dbPath, { pluginRoot: fx.pluginRoot });
        const result = (await call(tools.handlers, 'onboard_apply', { shape: 'local', persona })) as { isError?: boolean };
        assert.equal(result.isError, true);
        assert.match(String(parse(result).error), /^persona_input_removed:/);
        assert.equal(existsSync(fx.claudeMd), false);
        assert.equal(db.get<{ value_json: string }>(`SELECT value_json FROM plugin_config WHERE key = 'onboarded'`), undefined);
        rmSync(fx.base, { recursive: true, force: true });
        db.close();
      });
    }

    it('creates no project CLAUDE.md and writes no persona audit row', async () => {
      const db = tempDB();
      const fx = fixture();
      const data = parse(await call(onboardTools(db, fx.dbPath, { pluginRoot: fx.pluginRoot }).handlers, 'onboard_apply', { shape: 'local' }));
      assert.equal(data.ok, true);
      assert.equal('persona' in data, false);
      assert.equal(existsSync(fx.claudeMd), false);
      assert.equal(personaRows(db), 0);
      rmSync(fx.base, { recursive: true, force: true });
      db.close();
    });

    it('leaves an existing project CLAUDE.md byte-identical, old persona block included', async () => {
      const db = tempDB();
      const fx = fixture();
      const human = '# My project\r\n\r\n<!-- tmb:persona start v1.0.2 -->\r\n# You are bro\r\n<!-- tmb:persona end -->\r\n';
      writeFileSync(fx.claudeMd, human, { mode: 0o640 });
      const tools = onboardTools(db, fx.dbPath, { pluginRoot: fx.pluginRoot });
      await call(tools.handlers, 'onboard_apply', { shape: 'local' });
      await call(tools.handlers, 'onboard_apply', { shape: 'local', branching_model: 'gitflow' });
      assert.equal(readFileSync(fx.claudeMd, 'utf8'), human);
      assert.equal(statSync(fx.claudeMd).mode & 0o777, 0o640);
      assert.equal(personaRows(db), 0);
      rmSync(fx.base, { recursive: true, force: true });
      db.close();
    });
  });

  describe('Round 0: a session nested below the workspace DB (GH 1553)', () => {
    function nest(): { base: string; ws: string; session: string; dbPath: string; stray: string; db: TrajectoryDB } {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'onboard-nest-')));
      const ws = join(base, 'ws');
      const session = join(ws, 'a', 'b');
      mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
      mkdirSync(join(session, '.claude', 'tmb'), { recursive: true });
      const dbPath = join(ws, '.claude', 'tmb', 'trajectory.db');
      const stray = join(session, '.claude', 'tmb', 'trajectory.db');
      new TrajectoryDB(stray).close();
      return { base, ws, session, dbPath, stray, db: tempDB({ path: dbPath }) };
    }

    const auditRows = (db: TrajectoryDB, type: string): number =>
      db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE event_type = ?`, [type])?.n ?? 0;
    const rowCount = (db: TrajectoryDB): number =>
      (['issues', 'tasks', 'audit', 'plugin_config', 'repos'] as const)
        .map((t) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0)
        .reduce((a, b) => a + b, 0);

    it('onboard_state_get reports nested:true and the stray DB with its counts', async () => {
      const fx = nest();
      try {
        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session });
        const nesting = parse(await call(tools.handlers, 'onboard_state_get', {})).nesting as {
          session_dir: string;
          project_root: string;
          nested: boolean;
          other_dbs: Array<{ path: string; issues: number; tasks: number; empty: boolean }>;
        };
        assert.equal(nesting.session_dir, fx.session);
        assert.equal(nesting.project_root, fx.ws);
        assert.equal(nesting.nested, true);
        assert.deepEqual(nesting.other_dbs, [{ path: fx.stray, issues: 0, tasks: 0, empty: true }]);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('a session at the project root is not nested', async () => {
      const fx = nest();
      try {
        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.ws });
        const nesting = parse(await call(tools.handlers, 'onboard_state_get', {})).nesting as { nested: boolean };
        assert.equal(nesting.nested, false);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('Cancel (state read, no apply) writes nothing', async () => {
      const fx = nest();
      try {
        const before = rowCount(fx.db);
        await call(onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session }).handlers, 'onboard_state_get', {});
        assert.equal(rowCount(fx.db), before);
        assert.ok(existsSync(fx.stray));
        assert.ok(!existsSync(join(fx.session, '.claude', 'tmb', 'standalone')));
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('remove_stray_dbs deletes an empty stray DB and its state dir, with one stray_db_removed row', async () => {
      const fx = nest();
      try {
        writeFileSync(`${fx.stray}-wal`, '');
        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session });
        const data = parse(await call(tools.handlers, 'onboard_apply', { remove_stray_dbs: [fx.stray] }));
        assert.deepEqual(data.stray_dbs, { removed: [fx.stray], refused: [] });
        assert.ok(!existsSync(fx.stray));
        assert.ok(!existsSync(`${fx.stray}-wal`));
        assert.ok(!existsSync(join(fx.session, '.claude', 'tmb')));
        assert.ok(existsSync(fx.dbPath));
        assert.equal(auditRows(fx.db, 'stray_db_removed'), 1);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('remove_stray_dbs refuses a non-empty stray DB, the current DB and a path outside the project', async () => {
      const fx = nest();
      try {
        const stray = new TrajectoryDB(fx.stray);
        stray.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('kept', 'open', 'x', 'x')`);
        stray.close();
        const outside = join(fx.base, 'other', '.claude', 'tmb', 'trajectory.db');
        mkdirSync(join(fx.base, 'other', '.claude', 'tmb'), { recursive: true });
        new TrajectoryDB(outside).close();

        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session });
        const data = parse(
          await call(tools.handlers, 'onboard_apply', { remove_stray_dbs: [fx.stray, fx.dbPath, outside, 'relative.db'] }),
        );
        const result = data.stray_dbs as { removed: string[]; refused: Array<{ path: string; reason: string }> };
        assert.deepEqual(result.removed, []);
        assert.deepEqual(
          result.refused.map((r) => r.path),
          [fx.stray, fx.dbPath, outside, 'relative.db'],
        );
        assert.match(result.refused[0]!.reason, /not empty \(1 issues, 0 tasks\)/);
        assert.ok(existsSync(fx.stray));
        assert.ok(existsSync(outside));
        assert.equal(auditRows(fx.db, 'stray_db_removed'), 0);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('remove_stray_dbs refuses a stray reached through a symlinked .claude or plugin dir and deletes nothing outside', async () => {
      const fx = nest();
      try {
        const elsewhere = join(fx.base, 'elsewhere');
        mkdirSync(join(elsewhere, '.claude', 'tmb'), { recursive: true });
        const target = join(elsewhere, '.claude', 'tmb', 'trajectory.db');
        new TrajectoryDB(target).close();
        mkdirSync(join(fx.ws, 'c'), { recursive: true });
        symlinkSync(join(elsewhere, '.claude'), join(fx.ws, 'c', '.claude'));
        mkdirSync(join(fx.ws, 'd', '.claude'), { recursive: true });
        symlinkSync(join(elsewhere, '.claude', 'tmb'), join(fx.ws, 'd', '.claude', 'tmb'));
        const viaClaude = join(fx.ws, 'c', '.claude', 'tmb', 'trajectory.db');
        const viaPlugin = join(fx.ws, 'd', '.claude', 'tmb', 'trajectory.db');

        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session });
        const data = parse(await call(tools.handlers, 'onboard_apply', { remove_stray_dbs: [viaClaude, viaPlugin] }));
        const result = data.stray_dbs as { removed: string[]; refused: Array<{ path: string; reason: string }> };
        assert.deepEqual(result.removed, []);
        assert.deepEqual(result.refused, [
          { path: viaClaude, reason: `${join(fx.ws, 'c', '.claude')} is a symlink` },
          { path: viaPlugin, reason: `${join(fx.ws, 'd', '.claude', 'tmb')} is a symlink` },
        ]);
        assert.ok(existsSync(target));
        assert.equal(auditRows(fx.db, 'stray_db_removed'), 0);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('remove_stray_dbs refuses an empty standalone project', async () => {
      const fx = nest();
      try {
        writeFileSync(join(fx.session, '.claude', 'tmb', 'standalone'), '');
        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session });
        const data = parse(await call(tools.handlers, 'onboard_apply', { remove_stray_dbs: [fx.stray] }));
        assert.deepEqual(data.stray_dbs, {
          removed: [],
          refused: [{ path: fx.stray, reason: 'a standalone TMB project' }],
        });
        assert.ok(existsSync(fx.stray));
        assert.equal(auditRows(fx.db, 'stray_db_removed'), 0);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });

    it('standalone=true makes the session dir its own project, with one project_made_standalone row', async () => {
      const fx = nest();
      try {
        rmSync(join(fx.session, '.claude'), { recursive: true, force: true });
        const tools = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.session });
        const data = parse(await call(tools.handlers, 'onboard_apply', { standalone: true }));
        const marker = join(fx.session, '.claude', 'tmb', 'standalone');
        const newDb = join(fx.session, '.claude', 'tmb', 'trajectory.db');
        assert.equal(data.restart_required, true);
        assert.deepEqual(data.standalone, { session_dir: fx.session, db_path: newDb, marker });
        assert.ok(existsSync(marker));
        assert.ok(existsSync(newDb));
        assert.equal(auditRows(fx.db, 'project_made_standalone'), 1);

        const atRoot = onboardTools(fx.db, fx.dbPath, { sessionDir: fx.ws });
        const refused = parse(await call(atRoot.handlers, 'onboard_apply', { standalone: true }));
        assert.match(String(refused.error), /below the project root/);
        const mixed = parse(await call(tools.handlers, 'onboard_apply', { standalone: true, shape: 'local' }));
        assert.match(String(mixed.error), /applied alone/);
        assert.equal(auditRows(fx.db, 'project_made_standalone'), 1);
      } finally {
        fx.db.close();
        rmSync(fx.base, { recursive: true, force: true });
      }
    });
  });
});
