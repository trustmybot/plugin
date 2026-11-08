// node:test suite for scorers.ts: every pass and fail case of the L5 scorers, run-log usage
// detection and on-disk materialization, plus the score-all CLI.
// Run: node --experimental-strip-types --experimental-sqlite --test tests/l5-l6/lib/scorers.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  materializedOnDisk,
  scoreCoherence,
  scoreGit,
  scoreNoSandbox,
  scoreTrajectoryForbidden,
  scoreTrajectoryRequired,
  type ScoreContext,
  type Scorer,
  usageInLog,
} from './scorers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..', '..');
const SCHEMA = join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'src', 'schema.sql');
const SCHEMA_EVAL = join(PLUGIN_ROOT, 'mcp', 'trajectory-server', 'src', 'schema-eval.sql');
const SCORERS_TS = join(HERE, 'scorers.ts');

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function gitIn(dir: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

const trajectoryDb = (project: string): string => join(project, '.claude', 'tmb', 'trajectory.db');

function sql(path: string, statements: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
}

function mkProject(withEvalSchema = false): string {
  const p = tempDir('scorers-');
  gitIn(p, 'init', '-q', '-b', 'main');
  gitIn(p, 'config', 'user.email', 't@t.test');
  gitIn(p, 'config', 'user.name', 't');
  writeFileSync(join(p, 'README.md'), 'init\n');
  gitIn(p, 'add', '.');
  gitIn(p, 'commit', '-qm', 'init');
  mkdirSync(join(p, '.claude', 'tmb'), { recursive: true });
  sql(trajectoryDb(p), readFileSync(SCHEMA, 'utf8'));
  if (withEvalSchema) sql(trajectoryDb(p), readFileSync(SCHEMA_EVAL, 'utf8'));
  return p;
}

const mkFlowDir = (): string => tempDir('scorers-flow-');

function run(scorer: Scorer, project: string, scorerDir: string, runId: string): { exit: number; text: string } {
  const lines: string[] = [];
  const c: ScoreContext = { project, flow: 'test', scorerDir, runId, out: (line) => lines.push(line) };
  return { exit: scorer(c), text: lines.join('\n') };
}

const ISSUE_ROW =
  "INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'x', '', 'open', datetime('now'), datetime('now'));";
const taskRow = (branch: string, status = 'pending'): string =>
  `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (1, 1, '${branch}', 'main', '', '${status}', datetime('now'), datetime('now'));`;

describe('coherence scorer', () => {
  const P = mkProject();
  const FD = mkFlowDir();
  const cfg = (body: unknown): void => writeFileSync(join(FD, 'outcome-coherence.json'), JSON.stringify(body));

  test('no outcome-coherence.json → exit 0', () => {
    assert.equal(run(scoreCoherence, P, FD, 'run-1').exit, 0);
  });
  test('empty config → exit 0', () => {
    cfg({});
    assert.equal(run(scoreCoherence, P, FD, 'run-2').exit, 0);
  });
  test('issues>=1 with one row → pass', () => {
    sql(trajectoryDb(P), ISSUE_ROW);
    cfg({ expected_writes: { issues: '>=1' } });
    assert.equal(run(scoreCoherence, P, FD, 'run-3').exit, 0);
  });
  test('issues>=5 with one row → fail', () => {
    cfg({ expected_writes: { issues: '>=5' } });
    assert.equal(run(scoreCoherence, P, FD, 'run-4').exit, 1);
  });
  test('tasks WHERE branch != main → pass', () => {
    sql(trajectoryDb(P), taskRow('feat/foo'));
    cfg({ expected_writes: { 'tasks WHERE branch_id != "main"': '>=1' } });
    assert.equal(run(scoreCoherence, P, FD, 'run-5').exit, 0);
  });
  test('tasks = 1 → pass', () => {
    cfg({ expected_writes: { tasks: '1' } });
    assert.equal(run(scoreCoherence, P, FD, 'run-6').exit, 0);
  });
  test('audit !=99 → pass', () => {
    cfg({ expected_writes: { audit: '!=99' } });
    assert.equal(run(scoreCoherence, P, FD, 'run-7').exit, 0);
  });
  test('invalid operator → fail', () => {
    cfg({ expected_writes: { issues: 'wat' } });
    assert.equal(run(scoreCoherence, P, FD, 'run-8').exit, 1);
  });
});

describe('git scorer', () => {
  test('no outcome-git.json → exit 0', () => {
    assert.equal(run(scoreGit, mkProject(), mkFlowDir(), 'run-g1').exit, 0);
  });

  describe('base_branch_unchanged', () => {
    const P = mkProject();
    const FD = mkFlowDir();
    writeFileSync(join(FD, 'outcome-git.json'), '{"base_branch_unchanged": true}');

    test('base SHA unchanged from pre-run → pass', () => {
      const preHead = gitIn(P, 'rev-parse', 'HEAD');
      writeFileSync(join(P, '.claude', 'tmb', '_l5_pre_run_git.json'), `{"head":"${preHead}","branch":"main"}\n`);
      assert.equal(run(scoreGit, P, FD, 'run-g2').exit, 0);
    });
    test('base advanced post-snapshot → fail', () => {
      appendFileSync(join(P, 'README.md'), 'more\n');
      gitIn(P, 'add', '.');
      gitIn(P, 'commit', '-qm', 'bro committed to base!');
      assert.equal(run(scoreGit, P, FD, 'run-g3').exit, 1);
    });
  });

  test('no pre-run snapshot → fail (loud signal)', () => {
    const P = mkProject();
    const FD = mkFlowDir();
    writeFileSync(join(FD, 'outcome-git.json'), '{"base_branch_unchanged": true}');
    assert.equal(run(scoreGit, P, FD, 'run-g3b').exit, 1);
  });

  describe('worktrees', () => {
    const P = mkProject();
    const FD = mkFlowDir();
    sql(trajectoryDb(P), ISSUE_ROW + taskRow('feat/check'));
    gitIn(P, 'branch', 'feat/check', 'HEAD');
    mkdirSync(join(P, '.claude', 'worktrees'), { recursive: true });
    gitIn(P, 'worktree', 'add', '-q', '.claude/worktrees/check', 'feat/check');
    const cfg = (body: unknown): void => writeFileSync(join(FD, 'outcome-git.json'), JSON.stringify(body));

    test('worktree on feat/check → pass', () => {
      cfg({ worktrees: [{ path: '.claude/worktrees/<slug>', head_branch: '<task.branch_id>' }] });
      assert.equal(run(scoreGit, P, FD, 'run-g4').exit, 0);
    });
    test("worktree on forbidden 'feat/check' → fail", () => {
      cfg({ worktrees: [{ path: '.claude/worktrees/check', head_not_branch: ['feat/check'] }] });
      assert.equal(run(scoreGit, P, FD, 'run-g5').exit, 1);
    });
    test('worktree path missing → fail', () => {
      cfg({ worktrees: [{ path: '.claude/worktrees/missing', head_branch: 'main' }] });
      assert.equal(run(scoreGit, P, FD, 'run-g6').exit, 1);
    });
  });
});

const T_INTENT = 'mcp__plugin_tmb_trajectory-server__intent_start';
const T_ISSUE = 'mcp__plugin_tmb_trajectory-server__issue_create';
const T_BATCH = 'mcp__plugin_tmb_trajectory-server__task_create_batch';
const T_VALID = 'mcp__plugin_tmb_trajectory-server__validation_record';

function writeAssistantLine(project: string, tool: string, parent: string | null = null): void {
  const event = { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', name: tool }] } };
  appendFileSync(join(project, 'trajectory.jsonl'), `${JSON.stringify(event)}\n`);
}

describe('trajectory_forbidden scorer', () => {
  const P = mkProject();
  const FD = mkFlowDir();

  test('subagent validation_record → pass', () => {
    writeAssistantLine(P, T_INTENT);
    writeAssistantLine(P, T_VALID, 'toolu_x');
    writeFileSync(join(FD, 'tools-forbidden.json'), JSON.stringify([T_VALID]));
    assert.equal(run(scoreTrajectoryForbidden, P, FD, 'run-tf1').exit, 0);
  });
  test('top-level validation_record → fail', () => {
    writeAssistantLine(P, T_VALID);
    assert.equal(run(scoreTrajectoryForbidden, P, FD, 'run-tf2').exit, 1);
  });
});

describe('trajectory_required scorer', () => {
  const P = mkProject();
  const FD = mkFlowDir();
  const required = (body: unknown): void => writeFileSync(join(FD, 'tools-required.json'), JSON.stringify(body));

  test('any_of(issue_create|intent_start) with intent_start called → pass', () => {
    writeAssistantLine(P, T_INTENT);
    required([{ any_of: [T_ISSUE, T_INTENT] }]);
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr1').exit, 0);
  });
  test('any_of(issue_create|task_create_batch) with neither called → fail', () => {
    required([{ any_of: [T_ISSUE, T_BATCH] }]);
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr2').exit, 1);
  });
  test('string entry for called tool → pass', () => {
    required([T_INTENT]);
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr3').exit, 0);
  });
  test('string entry for uncalled tool → fail', () => {
    required([T_BATCH]);
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr4').exit, 1);
  });
  test('string entry satisfied by subagent call → pass', () => {
    writeAssistantLine(P, T_BATCH, 'toolu_y');
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr5').exit, 0);
  });
});

describe('trajectory_required: row 06 waives Agent + bro_atomic_close when step 5 already closed the task', () => {
  const ROW06 = join(PLUGIN_ROOT, 'tests', 'l5-l6', 'rows', '06', '06-swe-atomic-close');
  const P = mkProject();
  const FD = mkFlowDir();
  copyFileSync(join(ROW06, 'tools-required.json'), join(FD, 'tools-required.json'));
  writeAssistantLine(P, T_INTENT);
  const preStep = join(P, '.claude', 'tmb', '_l6_pre_step.db');

  test('no pre-step DB (L5 mode), neither tool called → fail', () => {
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr6').exit, 1);
  });
  test('failure names both tools', () => {
    assert.match(run(scoreTrajectoryRequired, P, FD, 'run-tr6b').text, /Agent.*bro_atomic_close/s);
  });
  test('pre-step DB with only a pending task, neither tool called → fail', () => {
    copyFileSync(trajectoryDb(P), preStep);
    sql(preStep, ISSUE_ROW + taskRow('feat/pending'));
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr7').exit, 1);
  });
  test('pre-step DB with a closed task but no swe run, neither tool called → fail', () => {
    sql(preStep, "UPDATE tasks SET status = 'closed' WHERE id = 1;");
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr8').exit, 1);
  });
  test('pre-step DB with a closed task and a swe run, neither tool called → pass', () => {
    sql(preStep, "INSERT INTO agent_runs (task_id, issue_id, agent_type) VALUES (1, 1, 'swe');");
    assert.equal(run(scoreTrajectoryRequired, P, FD, 'run-tr9').exit, 0);
  });
});

describe('no_sandbox scorer (GH 1549): TEST MODE pins the sandbox answer to no', () => {
  const P = mkProject();
  const FD = mkFlowDir();
  const settings = join(P, '.claude', 'settings.local.json');

  test('no settings.local.json, no answer → pass', () => {
    assert.equal(run(scoreNoSandbox, P, FD, 'run-ns1').exit, 0);
  });
  test('settings without a sandbox block, answer no → pass', () => {
    sql(trajectoryDb(P), `INSERT INTO plugin_config (key, value_json) VALUES ('sandbox_enforcement', '"no"');`);
    writeFileSync(settings, '{"permissions":{"allow":["Bash"]}}\n');
    assert.equal(run(scoreNoSandbox, P, FD, 'run-ns2').exit, 0);
  });
  test('sandbox block present → fail', () => {
    writeFileSync(settings, '{"sandbox":{"enabled":true}}\n');
    assert.equal(run(scoreNoSandbox, P, FD, 'run-ns3').exit, 1);
  });
  test('sandbox_enforcement = yes → fail', () => {
    writeFileSync(settings, '{}\n');
    sql(trajectoryDb(P), `UPDATE plugin_config SET value_json = '"yes"' WHERE key = 'sandbox_enforcement';`);
    assert.equal(run(scoreNoSandbox, P, FD, 'run-ns4').exit, 1);
  });
});

describe('usageInLog (issue #119)', () => {
  const TMP = tempDir('usage-in-log-');
  // Mirrors a real `claude -p --output-format stream-json --verbose` stream: a system/init event
  // listing loaded plugins, an assistant Skill tool_use, then the tool_result text.
  const SKILL_LOG = join(TMP, 'skill-invoked.jsonl');
  writeFileSync(
    SKILL_LOG,
    [
      '{"type":"system","subtype":"init","session_id":"s1","plugins":["tmb@trustmybot"],"tools":["Skill","Bash"]}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Loading the planning skill."},{"type":"tool_use","id":"tu_1","name":"Skill","input":{"skill":"tmb:tmb_planning"}}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"Launching skill: tmb:tmb_planning"}]}}',
      '{"type":"result","subtype":"success","duration_ms":1234}',
      '',
    ].join('\n'),
  );
  const NO_SKILL_LOG = join(TMP, 'no-skill.jsonl');
  writeFileSync(
    NO_SKILL_LOG,
    [
      '{"type":"system","subtype":"init","session_id":"s2","plugins":["tmb@trustmybot"],"tools":["Bash"]}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Just running a command."},{"type":"tool_use","id":"tu_9","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"result","subtype":"success","duration_ms":42}',
      '',
    ].join('\n'),
  );

  test('detect: tmb:tmb_planning (prefixed query) in skill log', () => {
    assert.equal(usageInLog(SKILL_LOG, 'tmb:tmb_planning'), true);
  });
  test('detect: tmb_planning (bare query) matches prefixed log', () => {
    assert.equal(usageInLog(SKILL_LOG, 'tmb_planning'), true);
  });
  test('reject: tmb_planning absent from no-skill log', () => {
    assert.equal(usageInLog(NO_SKILL_LOG, 'tmb_planning'), false);
  });
  test('reject: tmb_review absent from skill log', () => {
    assert.equal(usageInLog(SKILL_LOG, 'tmb_review'), false);
  });
  test('detect: plugin presence via init plugins[]', () => {
    assert.equal(usageInLog(SKILL_LOG, 'tmb@trustmybot:tmb_planning'), true);
  });
  test('reject: missing run log', () => {
    assert.equal(usageInLog(join(TMP, 'does-not-exist.jsonl'), 'tmb_planning'), false);
  });
});

describe('materializedOnDisk (issue #95)', () => {
  const TMP = tempDir('materialized-on-disk-');
  // Mirrors what cheatcode_install writes: global swe.md copied local, the skill added to its
  // skills: [...] frontmatter.
  const MAT = join(TMP, 'materialized');
  mkdirSync(join(MAT, '.claude', 'agents'), { recursive: true });
  writeFileSync(
    join(MAT, '.claude', 'agents', 'swe.md'),
    '---\nname: swe\nskills: [tmb_swe-checklist, feature-dev]\n---\n\n# You are swe\n',
  );
  writeFileSync(
    join(MAT, '.claude', 'CLAUDE.md'),
    '# You are bro\n\nInstalled skill: code-review — load it when its capability is needed.\n',
  );
  const NO_SKILL = join(TMP, 'no-skill');
  mkdirSync(join(NO_SKILL, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(NO_SKILL, '.claude', 'agents', 'swe.md'), '---\nname: swe\nskills: [tmb_swe-checklist]\n---\n\n# You are swe\n');
  const ABSENT = join(TMP, 'absent');
  mkdirSync(join(ABSENT, '.claude'), { recursive: true });

  test('detect: swe.md lists feature-dev', () => {
    assert.equal(materializedOnDisk(MAT, 'swe', 'feature-dev'), true);
  });
  test('detect: bare skill matches plugin-prefixed query', () => {
    assert.equal(materializedOnDisk(MAT, 'swe', 'tmb:feature-dev'), true);
  });
  test('detect: bro CLAUDE.md references code-review', () => {
    assert.equal(materializedOnDisk(MAT, 'bro', 'code-review'), true);
  });
  test('reject: agent md present but skill not in header', () => {
    assert.equal(materializedOnDisk(NO_SKILL, 'swe', 'feature-dev'), false);
  });
  test('reject: code-reviewer.md never materialized', () => {
    assert.equal(materializedOnDisk(ABSENT, 'code-reviewer', 'code-review'), false);
  });
  test('reject: bro CLAUDE.md does not reference the skill', () => {
    assert.equal(materializedOnDisk(NO_SKILL, 'bro', 'feature-dev'), false);
  });
  test('reject: substring of a longer skill name must not match', () => {
    assert.equal(materializedOnDisk(MAT, 'swe', 'feature'), false);
  });
});

describe('score-all CLI', () => {
  // One fixture every recording scorer reads: outcome passes, trajectory_required passes,
  // trajectory_forbidden fails, cost passes observationally, files fails, coherence passes,
  // git passes, usage fails, materialized passes and no_sandbox fails.
  const P = mkProject(true);
  const FD = mkFlowDir();
  sql(trajectoryDb(P), ISSUE_ROW);
  writeFileSync(join(FD, 'outcome.sql'), "-- two assertions\nSELECT 1, 'issue 1 exists' FROM issues WHERE id = 1;\nSELECT COUNT(*) >= 1, 'count' FROM issues;\n");
  const usageEvent = { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: T_INTENT }] } };
  writeFileSync(join(P, 'trajectory.jsonl'), `${JSON.stringify(usageEvent)}\n{"type":"result","duration_ms":7}\n`);
  writeFileSync(join(FD, 'tools-required.json'), JSON.stringify([T_INTENT]));
  writeFileSync(join(FD, 'tools-forbidden.json'), JSON.stringify([T_INTENT]));
  writeFileSync(join(FD, 'outcome-files.json'), '{"files":[{"path":"missing.txt","must_exist":true}]}');
  writeFileSync(join(FD, 'outcome-coherence.json'), '{"expected_writes":{"issues":">=1"}}');
  writeFileSync(join(P, '.claude', 'tmb', '_l5_pre_run_git.json'), `{"head":"${gitIn(P, 'rev-parse', 'HEAD')}"}`);
  writeFileSync(join(FD, 'outcome-git.json'), '{"base_branch_unchanged":true}');
  writeFileSync(join(FD, 'outcome-usage.json'), '{"skills_used":["tmb_planning"]}');
  mkdirSync(join(P, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(P, '.claude', 'agents', 'swe.md'), '---\nskills: [feature-dev]\n---\n');
  writeFileSync(join(FD, 'outcome-materialized.json'), '{"materialized":[{"agent":"swe","skill":"feature-dev"}]}');
  writeFileSync(join(P, '.claude', 'settings.local.json'), '{"sandbox":{}}');

  const cli = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-sqlite', SCORERS_TS, 'score-all', P, 'parity', FD, 'run-all'],
    { encoding: 'utf8' },
  );

  test('exits with the fail count', () => {
    assert.equal(cli.status, 4, cli.stdout + cli.stderr);
  });
  test('prints each scorer line on stdout, failures on stderr', () => {
    assert.match(cli.stdout, /✓ outcome: 2\/2 assertions passed/);
    assert.match(cli.stdout, /⊘ cost \(observational\): tokens_total=15 \(in=10 out=5\) duration_ms=7/);
    assert.match(cli.stderr, /✗ trajectory_forbidden: forbidden tools called: ; mcp__plugin_tmb_trajectory-server__intent_start/);
    assert.match(cli.stderr, /✗ files: missing.txt does not exist/);
    assert.match(cli.stderr, /✗ no_sandbox: sandbox block in \.claude\/settings\.local\.json/);
  });
  test('writes one eval_results row per recording scorer', () => {
    const db = new DatabaseSync(trajectoryDb(P), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT scorer_name, pass, value, explanation FROM eval_results WHERE run_id = 'run-all' AND flow_name = 'parity' ORDER BY id")
        .all();
      assert.equal(rows.length, 9);
      assert.deepEqual(
        rows.map((r) => r.scorer_name),
        ['outcome', 'trajectory_required', 'trajectory_forbidden', 'cost', 'coherence', 'git', 'usage', 'materialized', 'no_sandbox'],
      );
      assert.deepEqual(
        rows.map((r) => [r.pass, r.value, r.explanation]),
        [
          [1, '2/2', 'all assertions passed'],
          [1, null, 'all required tools present'],
          [0, 'violation', `; ${T_INTENT}`],
          [1, '15', 'tokens_total=15 (in=10 out=5) duration_ms=7'],
          [1, null, '1 check(s) passed'],
          [1, null, '1 check(s) passed'],
          [0, 'missing', '; tmb_planning'],
          [1, '1', 'all agents materialized'],
          [0, 'present', 'sandbox block in .claude/settings.local.json'],
        ],
      );
    } finally {
      db.close();
    }
  });
  test('rejects a malformed invocation', () => {
    const bad = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', SCORERS_TS, 'score-all'], {
      encoding: 'utf8',
    });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage: scorers\.ts score-all/);
  });
});
