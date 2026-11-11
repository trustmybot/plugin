/**
 * no-source-edit-from-main end to end (GH 1692), the l3 bash suite's cases in
 * node:test: an Edit/Write of source outside an SWE worktree in a TMB project
 * is denied by location, whatever the agent identity. Worktree targets, .md
 * files, configs/manifests and a missing DB pass; enforcement surfaces are
 * denied first, but only in the running plugin's own source repo (GH 1362).
 * Bash writes to prompt surfaces are judged by destination (GH 1031, GH 1196),
 * a non-isolated swe may edit source, Rule 1 scopes by repo registration
 * (GH 693) and .claude/tmb/scratch/ is sanctioned scratch (GH 1597). Each case
 * runs `node dist/hooks.js no-source-edit-from-main` with CLAUDE_PROJECT_DIR
 * pinned to a sandbox and a fake uid, so /tmp/claude-<uid> never covers it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate, type Sandbox } from './hook-sandbox.js';
import { DENY, git, has, hasNot, sql } from './git-push-guard-l3.js';

const GATE = 'no-source-edit-from-main';
const SOURCE_DENY = 'source edits from the main checkout are denied';
const SURFACE_DENY = 'enforcement surfaces';
const REPOS_TABLE =
  "CREATE TABLE repos(name TEXT PRIMARY KEY, path TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')), target_branch TEXT, branching_model TEXT, protected_branches TEXT)";
const CONFIG_TABLE = 'CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT)';

let sb: Sandbox;
let t: string;
let db: string;
let runningPlugin: string;
let pluginRepo: string;
let userRepo: string;
let otherPluginRepo: string;
const tx: Record<string, string> = {};

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function makeRepo(dir: string, manifestName?: string): void {
  mkdirSync(dir, { recursive: true });
  git(sb.env, dir, 'init', '-q', '-b', 'main');
  if (manifestName === undefined) return;
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: manifestName }));
}

function pluginFixture(dir: string, name: string): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name }));
  return dir;
}

before(() => {
  sb = makeSandbox('no-source-edit-l3');
  t = sb.dir;
  db = join(t, 'trajectory.db');
  sql(db, 'CREATE TABLE meta (k TEXT)');
  const bro = { role: 'assistant', content: 'Entering bro mode.' };
  const files: Record<string, string> = {
    bro: jsonl(bro),
    plain: jsonl({ role: 'user', content: 'hi' }),
    exited: jsonl(bro, { role: 'user', content: 'exit bro mode' }),
    empty: '',
    subagent: jsonl({ role: 'user', content: 'Edit src/foo.ts to fix the bug.' }, { role: 'assistant', content: 'On it.' }),
    bareBro: jsonl(
      { role: 'user', content: 'thanks bro, can you edit src/foo.ts' },
      { role: 'assistant', content: 'Source edits go through bro + swe; this is bro-mode territory.' },
    ),
  };
  for (const [k, body] of Object.entries(files)) {
    tx[k] = join(t, `${k}.jsonl`);
    writeFileSync(tx[k], body);
  }
  runningPlugin = pluginFixture(join(t, 'running-plugin'), 'fixture-plugin');
  pluginRepo = join(t, 'plugin-source-repo');
  userRepo = join(t, 'user-repo');
  otherPluginRepo = join(t, 'other-plugin-repo');
  makeRepo(pluginRepo, 'fixture-plugin');
  makeRepo(userRepo);
  makeRepo(otherPluginRepo, 'some-other-plugin');
});
after(() => sb.remove());

interface Run {
  cwd?: string;
  db?: string;
  env?: NodeJS.ProcessEnv;
}

function hook(payload: unknown, opts: Run = {}): string {
  const cwd = opts.cwd ?? t;
  const r = runGate(GATE, {
    cwd,
    input: JSON.stringify(payload),
    env: {
      ...sb.env,
      CLAUDE_PROJECT_DIR: t,
      CLAUDE_PLUGIN_ROOT: runningPlugin,
      PWD: cwd,
      TRAJECTORY_DB_PATH: opts.db ?? db,
      NODE_OPTIONS: `--import ${join(PLUGIN_ROOT, 'tests/lib/fake-uid.mjs')}`,
      ...opts.env,
    },
  });
  return r.stdout + r.stderr;
}

const edit = (tool: string, filePath: string, transcript = '') => ({ tool_name: tool, tool_input: { file_path: filePath }, transcript_path: transcript });
const asAgent = (tool: string, filePath: string, agent: string) => ({ tool_name: tool, agent_type: agent, tool_input: { file_path: filePath } });
const bash = (command: string, cwd = t) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const silent = (out: string, msg: string) => assert.equal(out, '', msg);

describe('no-source-edit-from-main l3: non-block paths', () => {
  it('non-Edit tool: silent pass', () => silent(hook(edit('Bash', 'whatever', tx.bro)), 'non-Edit tool ignored'));
  it('TMB_ALLOW_SOURCE_EDIT bypass: pass', () =>
    silent(hook(edit('Edit', 'src/foo.ts', tx.bro), { env: { TMB_ALLOW_SOURCE_EDIT: '1' } }), 'env bypass works'));
});

describe('no-source-edit-from-main l3: location-based block, any agent context', () => {
  it('bro mode + src/foo.ts: BLOCK', () => {
    const out = hook(edit('Edit', 'src/foo.ts', tx.bro));
    has(out, DENY, 'deny decision emitted');
    has(out, SOURCE_DENY, 'reason cites location policy');
  });
  it('plain session (no bro) + src/foo.ts: BLOCK (location-based)', () =>
    has(hook(edit('Edit', 'src/foo.ts', tx.plain)), DENY, 'non-bro session still denied by location policy'));
  it('exited bro mode + src/foo.ts: BLOCK (exit irrelevant under location policy)', () =>
    has(hook(edit('Edit', 'src/foo.ts', tx.exited)), DENY, 'exited bro still denied'));
  it('no transcript + src/foo.ts: BLOCK (identity irrelevant)', () => has(hook(edit('Edit', 'src/foo.ts')), DENY, 'location denies'));
  it('general-purpose subagent context + src/foo.ts: BLOCK', () => {
    const out = hook(edit('Edit', 'src/foo.ts', tx.subagent));
    has(out, DENY, 'subagent identity never grants main-checkout source edits');
    has(out, SOURCE_DENY, 'reason cites location policy');
  });
  it("#276: bare 'bro' word + src/foo.ts: BLOCK (location policy, not substring match)", () =>
    has(hook(edit('Edit', 'src/foo.ts', tx.bareBro)), DENY, 'location policy blocks regardless of bare-word mention'));
  it('unknown/absent agent identity + mcp/server.ts: BLOCK', () =>
    has(hook(edit('Write', 'mcp/trajectory-server/src/index.ts', tx.empty)), DENY, 'absent identity never grants passage'));
});

describe('no-source-edit-from-main l3: allowlist paths (DB present, any context)', () => {
  for (const [label, tool, path, transcript] of [
    ['bro mode + .md file', 'Edit', 'docs/architecture/FILES.md', 'bro'],
    ['bro mode + CHANGELOG.md', 'Edit', 'CHANGELOG.md', 'bro'],
    ['bro mode + LICENSE', 'Write', 'LICENSE', 'bro'],
    ['bro mode + .gitignore', 'Edit', '.gitignore', 'bro'],
    ['bro mode + agents/swe.md (agent prompts editable)', 'Edit', 'agents/swe.md', 'bro'],
    ['bro mode + skills/tmb_foo/SKILL.md', 'Edit', 'skills/tmb_foo/SKILL.md', 'bro'],
    ['plain session + .md file (allowlist applies to all contexts)', 'Edit', 'docs/architecture/FILES.md', 'plain'],
    ['bro mode + .claude-plugin/plugin.json', 'Edit', '.claude-plugin/plugin.json', 'bro'],
    ['bro mode + .github/workflows/test.yml', 'Edit', '.github/workflows/test.yml', 'bro'],
  ] as const) {
    it(`${label}: pass`, () => silent(hook(edit(tool, path, tx[transcript])), `${path} allowed`));
  }
  it('bro mode + hooks.json: BLOCK (enforcement surface)', () => {
    const out = hook(edit('Edit', 'hooks/hooks.json', tx.bro), { cwd: pluginRepo });
    has(out, DENY, 'hooks.json denied from main checkout');
    has(out, SURFACE_DENY, 'deny message cites enforcement-surface doctrine');
  });
});

describe('no-source-edit-from-main l3: enforcement-surface deny precedes the allowlist', () => {
  it('bro mode + scripts/hooks/foo.ts: BLOCK (enforcement surface)', () => {
    const out = hook(edit('Edit', 'scripts/hooks/foo.ts', tx.bro), { cwd: pluginRepo });
    has(out, DENY, 'deny decision emitted');
    has(out, SURFACE_DENY, 'deny message cites enforcement-surface doctrine');
  });
  it('bro mode + scripts/hooks/readme.md: BLOCK (enforcement surface beats .md allowlist)', () =>
    has(hook(edit('Edit', 'scripts/hooks/readme.md', tx.bro), { cwd: pluginRepo }), DENY, 'deny fires before allowlist'));
  it('bro mode + nested hooks/hooks.json: BLOCK', () =>
    has(hook(edit('Edit', 'some/path/hooks/hooks.json', tx.bro), { cwd: pluginRepo }), DENY, 'nested hooks.json denied from main checkout'));
});

describe('no-source-edit-from-main l3: worktree paths, SWE always allowed', () => {
  for (const [label, tool, path, transcript] of [
    ['worktree + scripts/hooks/foo.ts (SWE in worktree edits hooks)', 'Edit', '.claude/worktrees/task-14/scripts/hooks/foo.ts', 'bro'],
    ['worktree + hooks/hooks.json (SWE in worktree edits manifest)', 'Edit', '.claude/worktrees/task-14/hooks/hooks.json', 'bro'],
    ['REGRESSION: target inside .claude/worktrees/<slug>/', 'Edit', '.claude/worktrees/task-42/src/foo.ts', 'bro'],
    ['REGRESSION: target with absolute worktree path', 'Write', '/tmp/proj/.claude/worktrees/task-42/src/index.ts', 'bro'],
    ['worktree target with no transcript (worktree exemption is location-only)', 'Edit', '.claude/worktrees/task-99/src/foo.ts', ''],
  ] as const) {
    it(`${label}: PASS`, () => silent(hook(edit(tool, path, transcript === '' ? '' : tx[transcript])), `${path} allowed`));
  }
  it('REGRESSION: target outside any worktree, even when CWD pretends: BLOCK', () => {
    const wt = join(t, '.claude/worktrees/task-42');
    mkdirSync(wt, { recursive: true });
    has(hook(edit('Edit', 'src/foo.ts', tx.bro), { cwd: wt }), DENY, 'non-worktree target blocked even from worktree CWD');
  });
});

describe('no-source-edit-from-main l3: other block paths and the missing DB', () => {
  it('bro mode + tests/lib/assert.sh: BLOCK', () => has(hook(edit('Edit', 'tests/lib/assert.sh', tx.bro)), DENY, 'deny decision emitted'));
  it('no DB: pass even on source (not a TMB project)', () =>
    silent(hook(edit('Edit', 'src/foo.ts', tx.bro), { db: join(t, 'no-such.db') }), 'no DB = not a TMB project = allow'));
});

describe('no-source-edit-from-main l3: Rule 2, Bash writes to prompt surfaces', () => {
  for (const [label, cmd] of [
    ['Bash non-write', 'cat agents/swe.md'],
    ['Bash redirect > to non-prompt file', 'echo "hello" > src/index.ts'],
    ['Bash sed -n (read-only) on agents/swe.md', "sed -n '1,5p' agents/swe.md"],
    ['Bash grep on agents/swe.md', 'grep "pattern" agents/swe.md'],
    ['Bash write in a worktree path (worktree exemption)', 'echo "x" > .claude/worktrees/task-99/agents/swe.md'],
    ['#1031: write whose destination IS the worktree', 'cat agents/swe.md > .claude/worktrees/task-99/agents/swe.md'],
    ['Bash grep containing > char (not a redirect)', 'grep ">" agents/swe.md'],
    ['Bash awk comparison > on .md file (comparison, not redirect)', "awk '$1 > 5' agents/swe.md"],
    ['Bash echo with prompt path in string redirected to /tmp', 'echo "see agents/swe.md for details" > /tmp/notes.txt'],
    ['Bash git commit -m message mentioning agents/swe.md', 'git commit -m "touch agents/swe.md"'],
    ['GH 1196: heredoc whose body mentions a redirect to agents/swe.md', "cat > /tmp/notes.md <<'EOF'\necho x > agents/swe.md\nEOF\n"],
    ['Bash redirect > to CODEX.md (not a prompt surface)', 'echo "x" > CODEX.md'],
    ['Bash redirect > to CURSOR.md (not a prompt surface)', 'echo "x" > CURSOR.md'],
    ['Bash python open a to GEMINI.md (not a prompt surface)', `python -c "open('GEMINI.md','a').write('x')"`],
  ] as const) {
    it(`${label}: pass`, () => silent(hook(bash(cmd)), `${cmd} is not a prompt-surface write`));
  }
  it('Bash redirect > to agents/swe.md: DENIED', () => {
    const out = hook(bash('echo "content" > agents/swe.md'));
    has(out, DENY, 'redirect > to agents/*.md denied from main checkout');
    has(out, 'prompt-surface', 'deny reason mentions prompt-surface');
  });
  for (const [label, cmd] of [
    ['Bash redirect >> to CLAUDE.md', 'echo "extra" >> CLAUDE.md'],
    ['Bash tee to commands/scan.md', 'cat /tmp/x | tee commands/scan.md'],
    ['Bash sed -i on skills/tmb_planning/SKILL.md', "sed -i 's/old/new/' skills/tmb_planning/SKILL.md"],
    ['Bash perl -i on agents/bro.md', "perl -i -pe 's/x/y/' agents/bro.md"],
    ['Bash python3 open w to agents/swe.md', `python3 -c "open('agents/swe.md','w').write('x')"`],
    ['Bash python open a to CLAUDE.md', `python -c "open('CLAUDE.md','a').write('x')"`],
    ['Bash cp to templates/agents/foo.md', 'cp /tmp/foo.md templates/agents/foo.md'],
    ['Bash mv to commands/foo.md', 'mv /tmp/foo.md commands/foo.md'],
    ['Bash rsync to agents/foo.md', 'rsync -av /tmp/agent.md agents/foo.md'],
    ['#1031: sed reads worktree source, redirects to main-checkout prompt surface', "sed 's/x/y/' .claude/worktrees/task-99/agents/swe.md > agents/swe.md"],
    ['#1031: cp from worktree source to main-checkout prompt surface', 'cp .claude/worktrees/task-99/agents/swe.md agents/swe.md'],
    ['Bash redirect > to CLAUDE.md', 'echo "x" > CLAUDE.md'],
    ['Bash deny applies regardless of agent identity (no agent_type field)', 'echo "x" > agents/swe.md'],
    ["GH 1196: heredoc written straight to a prompt surface", "cat > agents/swe.md <<'EOF'\ntext\nEOF\n"],
  ] as const) {
    it(`${label}: DENIED`, () => has(hook(bash(cmd)), DENY, `${cmd} writes a prompt surface`));
  }
  it('Bash redirect > to <main>/src/templates/a.md: not prompt surface, pass; <main>/templates/a.md: DENIED', () => {
    mkdirSync(join(userRepo, 'src/templates'), { recursive: true });
    mkdirSync(join(userRepo, 'templates'), { recursive: true });
    hasNot(hook(bash(`echo x > ${userRepo}/src/templates/a.md`)), 'prompt-surface', 'a nested templates/ dir is not prompt surface');
    has(hook(bash(`echo x > ${userRepo}/templates/a.md`)), DENY, 'a root templates/ dir is prompt surface');
  });
});

describe('no-source-edit-from-main l3: the non-isolated swe permit', () => {
  it('agent_type=swe + src/foo.ts from main: ALLOWED', () => silent(hook(asAgent('Edit', 'src/foo.ts', 'swe')), 'swe role may edit source from main checkout'));
  it('agent_type=swe + mcp/server.ts from main: ALLOWED', () =>
    silent(hook(asAgent('Write', 'mcp/trajectory-server/src/index.ts', 'swe')), 'swe role may write .ts source from main checkout'));
  it('agent_type=bro + src/foo.ts from main: DENIED (bro may not use swe permit)', () =>
    has(hook(asAgent('Edit', 'src/foo.ts', 'bro')), DENY, 'bro is denied even with explicit agent_type'));
  it('no agent_type + src/foo.ts from main: DENIED (fail closed)', () => has(hook(edit('Edit', 'src/foo.ts')), DENY, 'absent agent_type fails closed'));
  it('agent_type=swe + scripts/hooks/foo.ts from main: DENIED (enforcement surface)', () => {
    const out = hook(asAgent('Edit', 'scripts/hooks/foo.ts', 'swe'), { cwd: pluginRepo });
    has(out, DENY, 'swe cannot edit enforcement surfaces from main');
    has(out, SURFACE_DENY, 'deny message cites enforcement-surface doctrine');
  });
  it('agent_type=swe + hooks/hooks.json from main: DENIED (enforcement surface)', () =>
    has(hook(asAgent('Edit', 'hooks/hooks.json', 'swe'), { cwd: pluginRepo }), DENY, 'swe cannot edit hooks.json from main'));
  it('REGRESSION: worktree path edit + agent_type=swe: ALLOWED', () =>
    silent(hook(asAgent('Edit', '.claude/worktrees/task-99/src/foo.ts', 'swe')), 'worktree-path edit always allowed regardless of agent_type'));
  it('deny message teaches recovery without mentioning shell rc files', () => {
    const out = hook(asAgent('Edit', 'src/foo.ts', 'bro'));
    hasNot(out, 'bashrc', 'deny message must not mention bashrc');
    has(out, 'non-isolated', 'deny message mentions non-isolated mode');
  });
});

describe("no-source-edit-from-main l3: the enforcement surface is the plugin's own source repo (GH 1362)", () => {
  it('plugin source repo + absolute scripts/hooks/foo.ts from main: BLOCK (enforcement surface)', () =>
    has(hook(edit('Edit', join(pluginRepo, 'scripts/hooks/foo.ts'), tx.bro)), SURFACE_DENY, 'absolute target in the plugin repo hits the enforcement surface'));
  it('user repo (no manifest) + scripts/hooks/x.ts, bro: generic source-edit deny, not enforcement surface', () => {
    const out = hook(asAgent('Edit', 'scripts/hooks/x.ts', 'bro'), { cwd: userRepo });
    has(out, DENY, 'bro still denied source edits in a user repo');
    has(out, SOURCE_DENY, 'generic source-edit reason');
    hasNot(out, SURFACE_DENY, 'enforcement-surface reason not applied to a user repo');
  });
  it('user repo (no manifest) + hooks/hooks.json, bro: generic source-edit deny', () => {
    const out = hook(asAgent('Edit', 'hooks/hooks.json', 'bro'), { cwd: userRepo });
    has(out, SOURCE_DENY, 'generic source-edit reason');
    hasNot(out, SURFACE_DENY, 'enforcement-surface reason not applied to a user repo');
  });
  it('user repo (no manifest) + scripts/hooks/x.ts, non-isolated swe: ALLOWED', () =>
    silent(hook(asAgent('Edit', 'scripts/hooks/x.ts', 'swe'), { cwd: userRepo }), "swe permit applies to a user repo's scripts/hooks/"));
  it('user repo (no manifest) + scripts/hooks/README.md: ALLOWED as .md', () =>
    silent(hook(asAgent('Edit', 'scripts/hooks/README.md', 'bro'), { cwd: userRepo }), ".md allowlist applies to a user repo's scripts/hooks/"));
  it('user repo (no manifest) + absolute scripts/hooks/x.ts, swe: ALLOWED', () =>
    silent(hook(asAgent('Edit', join(userRepo, 'scripts/hooks/x.ts'), 'swe')), 'absolute target in a user repo is not an enforcement surface'));
  it('repo with a DIFFERENT plugin manifest name + scripts/hooks/x.ts, bro: treated as user repo', () => {
    const out = hook(asAgent('Edit', 'scripts/hooks/x.ts', 'bro'), { cwd: otherPluginRepo });
    has(out, SOURCE_DENY, 'generic source-edit reason');
    hasNot(out, SURFACE_DENY, "a different plugin's repo is not the running plugin's source");
  });
  it('repo with a DIFFERENT plugin manifest name + hooks/hooks.json, swe: ALLOWED', () =>
    silent(hook(asAgent('Edit', 'hooks/hooks.json', 'swe'), { cwd: otherPluginRepo }), 'swe permit applies when the manifest names another plugin'));
  it('running plugin without a manifest: no repo counts as the plugin source', () =>
    silent(
      hook(asAgent('Edit', 'scripts/hooks/x.ts', 'swe'), { cwd: pluginRepo, env: { CLAUDE_PLUGIN_ROOT: join(t, 'no-such-plugin') } }),
      'unreadable running manifest means not the plugin repo',
    ));
});

describe('no-source-edit-from-main l3: managed-repo scope by registration (#693)', () => {
  let managedRoot: string;
  let siblingRoot: string;
  let managedDb: string;
  before(() => {
    const ws = join(t, 'ws');
    managedRoot = join(ws, 'plugin');
    siblingRoot = join(ws, 'benchmarks');
    mkdirSync(join(ws, '.claude/tmb'), { recursive: true });
    for (const repo of [managedRoot, siblingRoot]) {
      makeRepo(repo);
      mkdirSync(join(repo, 'src'));
    }
    managedRoot = git(sb.env, managedRoot, 'rev-parse', '--show-toplevel');
    siblingRoot = git(sb.env, siblingRoot, 'rev-parse', '--show-toplevel');
    managedDb = join(ws, '.claude/tmb/trajectory.db');
    sql(managedDb, CONFIG_TABLE);
    sql(managedDb, REPOS_TABLE);
    sql(managedDb, 'INSERT INTO repos (name, path) VALUES (?, ?)', 'plugin', managedRoot);
  });

  it('registration scope + edit inside REGISTERED repo from main: BLOCK', () =>
    has(hook(edit('Edit', join(managedRoot, 'src/foo.ts'), tx.bro), { db: managedDb }), DENY, 'source edit inside the registered repo still denied from main'));
  it('registration scope + edit in UNREGISTERED sibling repo from main: ALLOWED (no-op)', () =>
    silent(hook(edit('Edit', join(siblingRoot, 'src/foo.ts'), tx.bro), { db: managedDb }), 'unregistered sibling-repo source edit allowed'));
  it('registration scope + target with no resolvable git-root: BLOCK (fail-closed)', () =>
    has(hook(edit('Edit', '/some/project/src/foo.ts', tx.bro), { db: managedDb }), DENY, 'target outside any git tree fails closed'));
  it('single-repo-at-root: the git repo IS the registered root + src/foo.ts: BLOCK', () => {
    const root = join(t, 'repo-at-root');
    mkdirSync(join(root, '.claude/tmb'), { recursive: true });
    makeRepo(root);
    mkdirSync(join(root, 'src'));
    const real = git(sb.env, root, 'rev-parse', '--show-toplevel');
    const srDb = join(root, '.claude/tmb/trajectory.db');
    sql(srDb, CONFIG_TABLE);
    sql(srDb, REPOS_TABLE);
    sql(srDb, 'INSERT INTO repos (name, path) VALUES (?, ?)', 'repo-at-root', real);
    has(hook(asAgent('Edit', join(real, 'src/foo.ts'), 'bro'), { db: srDb }), DENY, 'source under the single registered repo-at-root is guarded');
  });
  it('absolute target in an existing directory inside no git repo (.html): ALLOWED', () => {
    mkdirSync(join(t, 'scratchpad/compare'), { recursive: true });
    silent(hook(edit('Write', join(t, 'scratchpad/compare/index.html'), tx.bro), { db: managedDb }), 'scratchpad write outside every git repo is outside Rule 1 scope');
  });
  it('absolute target in an existing directory inside no git repo (.ts): ALLOWED', () => {
    mkdirSync(join(t, 'scratchpad'), { recursive: true });
    silent(hook(edit('Write', join(t, 'scratchpad/report.ts'), tx.bro), { db: managedDb }), 'decision is location-based, not extension-based');
  });
  it('absolute target whose parent directory is absent: BLOCK (fail-closed)', () => {
    rmSync(join(t, 'missing-dir'), { recursive: true, force: true });
    has(hook(edit('Write', join(t, 'missing-dir/x.ts'), tx.bro), { db: managedDb }), DENY, 'absent parent directory still fails closed');
  });

  it('GH 1597: .claude/tmb/scratch/ is sanctioned scratch: ALLOWED; .claude/scratch/ is not', () => {
    const tmb = { CLAUDE_PLUGIN_ROOT: pluginFixture(join(t, 'tmb-plugin'), 'tmb') };
    silent(hook(edit('Write', '.claude/tmb/scratch/x.py', tx.bro), { env: tmb }), 'relative .claude/tmb/scratch/x.py');
    mkdirSync(join(managedRoot, '.claude/tmb/scratch'), { recursive: true });
    silent(hook(edit('Write', join(managedRoot, '.claude/tmb/scratch/x.py'), tx.bro), { db: managedDb, env: tmb }), '<registered repo>/.claude/tmb/scratch/x.py');
    const out = hook(edit('Write', '.claude/scratch/x.py', tx.bro), { env: tmb });
    has(out, DENY, '.claude/scratch/ is not the sanctioned dir');
    has(out, '.claude/tmb/scratch/', 'the deny names the sanctioned scratch dir');
    has(hook(edit('Write', '.claude/tmb/scratch/../../../src/x.py', tx.bro), { env: tmb }), DENY, 'a .. climbing out of scratch stays guarded');
    has(
      hook(edit('Write', `${managedRoot}/.claude/tmb/scratch/../../../src/x.py`, tx.bro), { db: managedDb, env: tmb }),
      DENY,
      'an absolute .. climbing out of scratch stays guarded',
    );
  });
});
