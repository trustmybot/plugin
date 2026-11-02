/**
 * The TypeScript swe-boundary where it differs from
 * scripts/hooks/swe-boundary.sh (GH 1692), each difference stricter: a
 * command tree-sitter-bash cannot parse is denied with PARSE_REASON, the DB
 * is read through node:sqlite with no sqlite3 CLI on PATH, where the .sh
 * enforces nothing, a gh api verb is upper-cased by toUpperCase in every
 * locale, and a multibyte prompt-surface name the .sh's macOS awk cannot
 * convert is still judged (GH 2030). Also: the analyzer's never-judged write targets are left
 * to containment-guard, a deny record whose time bash's arithmetic rejects
 * ends the gate with no output as it ends the .sh, and the gate is
 * registered by name.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CAP_REASON, cmdStatements, ghMutation, ghMutationFrom, writePaths } from '../hooks/cmd-analysis/index.js';
import { haveSqlite } from '../hooks/lib/db.js';
import { findGate } from '../hooks/registry.js';
import { GATE_NAME, PARSE_REASON, sweBoundary } from '../hooks/swe-boundary.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/swe-boundary.sh');
const NOW = '2026-10-11T10:00:00.000Z';
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const UNPARSEABLE = 'cat <<E"M"\nx\nEM\necho x > agents/a.md';

interface Out {
  hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
}

function decision(stdout: string): Out['hookSpecificOutput'] | null {
  return stdout === '' ? null : (JSON.parse(stdout) as Out).hookSpecificOutput;
}

describe('swe-boundary.ts: stricter than the .sh, and the rest of its contract', () => {
  let dir: string;
  let wt: string;
  let db: string;
  let env: NodeJS.ProcessEnv;
  let noCli: string;
  const payload = (tool: string, input: Record<string, string>, extra: Record<string, string> = {}): string =>
    JSON.stringify({
      session_id: 'unit',
      cwd: wt,
      tool_name: tool,
      tool_input: input,
      agent_type: 'swe',
      agent_transcript_path: join(dir, 'spawn.jsonl'),
      ...extra,
    });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-sb-unit-')));
    const project = join(dir, 'project');
    wt = join(project, '.claude/worktrees/sb-unit');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    db = join(dir, 'db/trajectory.db');
    mkdirSync(dirname(db));
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (2, 'o', 'open', ?, ?)").run(NOW, NOW);
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, files) VALUES (7, 2, 'feat/sb-unit', 'd', 'running', ?, ?, 'project', '[\"src\"]')",
      ).run(NOW, NOW);
    } finally {
      d.close();
    }
    writeFileSync(join(dir, 'spawn.jsonl'), '{"message":{"content":[{"type":"text","text":"task_id=7"}]}}\n');
    noCli = join(dir, 'empty-path');
    mkdirSync(noCli);
    env = { ...process.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: project };
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered under its gate name', () => {
    assert.equal(GATE_NAME, 'swe-boundary');
    assert.equal(findGate(GATE_NAME), sweBoundary);
  });

  it('denies a command tree-sitter-bash cannot parse with PARSE_REASON', async () => {
    assert.deepEqual(await cmdStatements(UNPARSEABLE, wt, env), { ok: false });
    const r = await sweBoundary(payload('Bash', { command: UNPARSEABLE }), env);
    assert.equal(r.code, 0);
    assert.equal(decision(r.stdout)?.permissionDecisionReason, PARSE_REASON);
  });

  it('upper-cases a gh api verb with toUpperCase, so `poſt` is POST in every locale', async () => {
    assert.equal(ghMutationFrom(['gh', 'api', '-X', 'poſt', 'repos/o/r']), 'POST');
    assert.equal(ghMutation('gh api --method=poſt repos/o/r'), 'POST');
    const r = await sweBoundary(payload('Bash', { command: 'gh api -X poſt repos/o/r/issues' }), env);
    assert.match(decision(r.stdout)?.permissionDecisionReason ?? '', /^BLOCKED: SWE may not run gh\/glab mutating commands/);
  });

  it('denies a Bash write to a multibyte prompt-surface name such as agents/é.md (GH 2030)', async () => {
    const r = await sweBoundary(payload('Bash', { command: 'echo x > agents/é.md' }), { ...env, LC_ALL: 'en_US.UTF-8' });
    const reason = decision(r.stdout)?.permissionDecisionReason ?? '';
    assert.match(reason, /^BLOCKED: SWE may not write prompt-surface files via Bash /);
    assert.ok(reason.includes(`Target: ${join(wt, 'agents/é.md')}.`), reason);
  });

  it('lets a non-swe caller run the same unparseable command', async () => {
    const r = await sweBoundary(JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command: UNPARSEABLE } }), env);
    assert.equal(r.stdout, '');
  });

  it('reads the DB through node:sqlite with no sqlite3 CLI on PATH, so rule (c) still holds', async () => {
    const bare: NodeJS.ProcessEnv = { ...env, PATH: noCli };
    delete bare.TMB_HOOKS_SQLITE;
    assert.equal(haveSqlite(bare), true);
    const r = await sweBoundary(payload('Write', { file_path: join(dir, 'outside/x.txt'), content: 'x' }), bare);
    assert.match(decision(r.stdout)?.permissionDecisionReason ?? '', /^BLOCKED: SWE may only edit files inside its assigned worktree/);
  });

  it('enforces nothing with neither node:sqlite nor the CLI, as the .sh does without the CLI', async () => {
    const bare = { ...env, PATH: noCli, TMB_HOOKS_SQLITE: 'cli' };
    assert.equal(haveSqlite(bare), false);
    const input = payload('Write', { file_path: join(dir, 'outside/x.txt'), content: 'x' });
    const r = await sweBoundary(input, bare);
    assert.equal(r.stdout, '');
  });

  it('leaves never-judged write targets to containment-guard', async () => {
    const command = `perl -i -pe 'BEGIN{open(F,"skills/s/SKILL.md")}' src/a.ts`;
    const lines = await writePaths(command, { cwd: wt, root: wt, env });
    assert.ok(
      lines.some((l) => l.startsWith('UNRESOLVED:$(')),
      lines.join('\n'),
    );
    const r = await sweBoundary(payload('Bash', { command }), env);
    assert.equal(r.stdout, '');
  });

  it('denies a command past the analyzer cap, naming the cap, on a stack shape and a work shape (GH 2090)', async () => {
    for (const depth of [5000, 2000]) {
      const r = await sweBoundary(payload('Bash', { command: `echo ${'$('.repeat(depth)}x${')'.repeat(depth)}` }), env);
      assert.equal(r.code, 0);
      assert.equal(decision(r.stdout)?.permissionDecisionReason, CAP_REASON);
    }
  });

  it('drops the Edit/Write as bash does on a deny record whose time is not valid octal: no output, exit 0', async () => {
    const target = join(wt, 'src/a.ts');
    const record = join(dirname(db), 'locks/boundary-denies/unit', createHash('sha256').update(target).digest('hex'));
    const input = payload('Edit', { file_path: target, old_string: 'a', new_string: 'b' });
    for (const impl of HAVE_SQLITE_CLI ? (['ts', 'bash'] as const) : (['ts'] as const)) {
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, 'containment-guard\n0999\n');
      if (impl === 'ts') {
        const r = await sweBoundary(input, env);
        assert.deepEqual(r, { stdout: '', code: 0 });
      } else {
        const r = spawnSync('bash', [HOOK_SH], { input, env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /0999: value too great for base/);
        assert.equal(r.stdout, '');
      }
    }
    rmSync(join(dirname(db), 'locks'), { recursive: true, force: true });
  });
});
