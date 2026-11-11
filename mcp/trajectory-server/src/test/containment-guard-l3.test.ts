/**
 * containment-guard end to end (GH 1692), the l3 bash suite's cases in
 * node:test. The gate denies writes outside the run's root (the swe row's
 * worktree, else the project), audits every denial, and leaves reads, the model
 * cache and un-onboarded projects alone. Through the real dispatcher, a "cannot
 * be judged" Bash deny, an unresolved target's included, records no
 * boundary-deny path, so the literal-path Edit it prescribes is no bypass; a
 * judged deny records one. Each case runs `node dist/hooks.js <gate>` with
 * CLAUDE_PROJECT_DIR pinned and PWD set, under the fake-uid preload so
 * /tmp/claude-<uid> never covers the sandbox. The cases share one sandbox and
 * run in order: the audit-row count counts every denial before it.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { makeSandbox, PLUGIN_ROOT, runGate, type HookRun, type Sandbox } from './hook-sandbox.js';
import { git, has, hasNot } from './git-push-guard-l3.js';
import { FAKE_UID_PRELOAD, sqlExec } from './db-test-fixtures.js';

const FAKE_UID = 4242424;
const NOW = '2026-10-11T10:00:00.000Z';
const DENY = '"permissionDecision":"deny"';

const write = (p: string) => ({ file_path: p, content: 'x' });
const bashCmd = (c: string) => ({ command: c });
const editOf = (p: string) => ({ file_path: p, old_string: 'a', new_string: 'b' });
/** A python3 program fed through a quoted heredoc. */
const py = (...lines: string[]) => ["python3 - <<'EOF'", ...lines, 'EOF'].join('\n');
const nodeProg = (...lines: string[]) => ["node - <<'EOF'", ...lines, 'EOF'].join('\n');
const interpProg = (interp: string, ...lines: string[]) => [`${interp} - <<'EOF'`, ...lines, 'EOF'].join('\n');
/** The gate's decision on an in-root program outside its closed safe set (GH 1739). */
const UNPROVEN = 'deny';

/** permissionDecision of the output, 'allow' when it is empty (the bash suite's jq read). */
function decision(out: string): string {
  if (out === '') return 'allow';
  try {
    const v = JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: unknown } } | null;
    const d = v?.hookSpecificOutput?.permissionDecision;
    return typeof d === 'string' ? d : 'allow';
  } catch {
    return `unparseable: ${out}`;
  }
}

/** <r>'s stdout, after asserting <gate> wrote nothing to stderr. */
function noStderr(gate: string, r: HookRun): string {
  assert.equal(r.stderr, '', `${gate} stderr was not empty: ${r.stderr}`);
  return r.stdout;
}

describe('containment-guard l3', () => {
  let sb: Sandbox;
  let SANDBOX: string;
  let HOME: string;
  let PROJECT: string;
  let WT: string;
  let CACHE: string;
  let DB: string;
  let HOST_TMP: string;
  let SHIM: string;
  let TRANSCRIPT: string;
  let OUTSIDE_CWD: string;

  function query<T>(statement: string): T {
    const d = new DatabaseSync(DB, { timeout: 5000 });
    try {
      return d.prepare(statement).get() as T;
    } finally {
      d.close();
    }
  }
  const count = (statement: string) => query<{ n: number }>(statement).n;
  const denials = () => count("SELECT COUNT(*) AS n FROM audit WHERE event_type='containment_denied' AND from_node='hook:containment-guard'");
  const bypasses = () => count("SELECT COUNT(*) AS n FROM audit WHERE event_type='hook_block_bypassed'");
  const lastDenial = () => {
    const r = query<{ content_json: string; issue_id: number }>(
      "SELECT content_json, issue_id FROM audit WHERE event_type='containment_denied' ORDER BY id DESC LIMIT 1",
    );
    return `${r.content_json}|${r.issue_id}`;
  };

  function hookEnv(projectDir: string, cwd: string): NodeJS.ProcessEnv {
    return {
      ...sb.env,
      CLAUDE_PROJECT_DIR: projectDir,
      PWD: cwd,
      CLAUDE_CONFIG_DIR: '',
      TMB_MODEL_CACHE_DIR: CACHE,
      TMPDIR: HOST_TMP,
      PATH: [SHIM, sb.env.PATH].join(delimiter),
      NODE_OPTIONS: FAKE_UID_PRELOAD,
    };
  }

  /**
   * The gate's stdout (trailing newlines gone) for a PreToolUse <tool> payload
   * from <cwd>, after asserting its stderr is empty. A swe payload carries the
   * task-5 spawn transcript unless <noIdentity>.
   */
  function run(cwd: string, agent: string, tool: string, toolInput: object, opts: { projectDir?: string; noIdentity?: boolean } = {}): string {
    const payload: Record<string, unknown> = { hook_event_name: 'PreToolUse', session_id: 's-1', cwd, tool_name: tool, tool_input: toolInput };
    if (agent !== '') payload.agent_type = agent;
    if (/swe$/.test(agent) && !opts.noIdentity) payload.agent_transcript_path = TRANSCRIPT;
    const r = runGate('containment-guard', { cwd, input: JSON.stringify(payload), env: hookEnv(opts.projectDir ?? PROJECT, cwd) });
    return noStderr('containment-guard', r).replace(/\n+$/, '');
  }
  const dec = (cwd: string, agent: string, tool: string, toolInput: object, opts?: { projectDir?: string; noIdentity?: boolean }) =>
    decision(run(cwd, agent, tool, toolInput, opts));
  const swe = (command: string) => dec(WT, 'swe', 'Bash', bashCmd(command));
  const bro = (command: string) => dec(PROJECT, '', 'Bash', bashCmd(command));

  /**
   * <gate>'s stdout on a swe payload of session s-1 from the worktree. A Bash
   * payload first runs through the PreToolUse router, which writes the
   * boundary-denies records.
   */
  function dispatched(gate: string, tool: string, toolInput: object, toolUseId: string): string {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's-1',
      cwd: WT,
      agent_type: 'swe',
      agent_transcript_path: TRANSCRIPT,
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    });
    const env = { ...hookEnv(PROJECT, WT), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
    if (tool === 'Bash') noStderr('PreToolUse', runGate('PreToolUse', { cwd: WT, input: payload, env }));
    return noStderr(gate, runGate(gate, { cwd: WT, input: payload, env })).replace(/\n+$/, '');
  }
  let DENIES: string;
  let UJ_FILE: string;

  before(() => {
    sb = makeSandbox('containment-guard');
    SANDBOX = sb.dir;
    HOME = sb.home;
    PROJECT = join(SANDBOX, 'project');
    WT = join(PROJECT, '.claude/worktrees/cg-task');
    CACHE = join(SANDBOX, 'model-cache');
    DB = join(PROJECT, '.claude/tmb/trajectory.db');
    HOST_TMP = join(SANDBOX, 'host-tmp');
    OUTSIDE_CWD = join(SANDBOX, 'outside-cwd');
    for (const d of [join(WT, 'src'), join(PROJECT, '.claude/tmb'), CACHE, HOST_TMP]) mkdirSync(d, { recursive: true });
    SHIM = join(SANDBOX, 'shim');
    mkdirSync(SHIM);
    writeFileSync(join(SHIM, 'id'), `#!/bin/sh\n[ "$1" = -u ] && { echo ${FAKE_UID}; exit 0; }\nexec /usr/bin/id "$@"\n`);
    chmodSync(join(SHIM, 'id'), 0o755);
    sqlExec(DB, readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
    const d = new DatabaseSync(DB);
    try {
      d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', PROJECT);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (7, 'containment', 'open', ?, ?)").run(NOW, NOW);
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo) VALUES (5, 7, 'feat/cg-task', 'd', 'running', ?, ?, 'project')",
      ).run(NOW, NOW);
      d.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host) VALUES (5, 7, 'swe', ?, ?, 'claude')").run(NOW, WT);
    } finally {
      d.close();
    }
    TRANSCRIPT = join(SANDBOX, 'spawn-5.jsonl');
    writeFileSync(TRANSCRIPT, '{"message":{"content":[{"type":"text","text":"task_id=5"}]}}\n');
    DENIES = join(PROJECT, '.claude/tmb/locks/boundary-denies');
    UJ_FILE = join(WT, 'src/uj.md');
  });
  after(() => sb.remove());

  it('swe Write to /tmp/x → deny + audit row', () => {
    const OUT = run(WT, 'tmb:swe', 'Write', write('/tmp/x'));
    assert.equal(decision(OUT), 'deny', 'outside the worktree');
    has(OUT, WT, 'the reason names the root');
    has(OUT, '/tmp/x', 'the reason names the path');
    assert.equal(denials(), 1, 'one containment_denied row');
    assert.equal(lastDenial(), `{"tool":"Write","path":"/tmp/x","root":"${WT}","task_id":5}|7`, "content {tool, path, root, task_id} on the task's issue");
  });

  it('swe Write to $HOME/.claude/x → deny + audit row', () => {
    assert.equal(dec(WT, 'swe', 'Write', write(`${HOME}/.claude/x`)), 'deny', 'home is outside the worktree');
    assert.equal(denials(), 2, 'second containment_denied row');
  });

  it('swe Write inside the worktree → allow', () => {
    assert.equal(dec(WT, 'swe', 'Write', write(`${WT}/src/a.ts`)), 'allow', 'worktree file');
    assert.equal(dec(WT, 'swe', 'Edit', write('src/b.ts')), 'allow', 'relative path resolves against cwd');
  });

  it('swe Write to the project outside its worktree → deny', () => {
    assert.equal(dec(WT, 'swe', 'Write', write(`${PROJECT}/README.md`)), 'deny', 'the swe root is the worktree, not the project');
  });

  it('symlinked spelling of a path inside the root → allow', () => {
    const ALIAS = join(SANDBOX, 'alias');
    symlinkSync(WT, ALIAS);
    assert.equal(dec(WT, 'swe', 'Write', write(`${ALIAS}/src/c.ts`)), 'allow', 'symlink resolved into the root');
    symlinkSync('/tmp', join(WT, 'escape'));
    assert.equal(dec(WT, 'swe', 'Write', write(`${WT}/escape/d`)), 'deny', 'a symlink inside the root pointing out is outside');
  });

  it('Bash: echo hi > ~/.claude/y → deny', () => {
    const OUT = run(WT, 'swe', 'Bash', bashCmd('echo hi > ~/.claude/y'));
    assert.equal(decision(OUT), 'deny', 'redirect into home');
    has(OUT, `${HOME}/.claude/y`, 'the reason names the expanded path');
  });

  it('Bash: cat ~/.claude.json → allow (reads are not judged)', () => {
    assert.equal(swe('cat ~/.claude.json'), 'allow', 'read');
  });

  it('Bash: a heredoc and quotes mentioning > /tmp/z → allow', () => {
    const HEREDOC = ["cat <<'EOF' > notes.txt", 'echo "> /tmp/z"', 'write > /tmp/z', 'EOF', 'echo "see > /tmp/z"'].join('\n');
    assert.equal(swe(HEREDOC), 'allow', 'data, not redirects');
  });

  it("Bash: a swe's cwd is not its identity; a relative write still joins the cwd", () => {
    assert.equal(dec(SANDBOX, 'swe', 'Bash', bashCmd('ls')), 'allow', 'a read from outside the worktree');
    assert.equal(dec(SANDBOX, 'swe', 'Bash', bashCmd('touch notes.txt')), 'deny', 'a relative write from outside lands outside');
    assert.equal(dec(SANDBOX, 'swe', 'Bash', bashCmd(`touch ${WT}/notes.txt`)), 'allow', 'an absolute write into the worktree');
  });

  it('GH 1550: a swe with no spawn transcript fails closed, naming the missing piece', () => {
    const OUT = run(WT, 'swe', 'Write', write(`${WT}/src/a.ts`), { noIdentity: true });
    assert.equal(decision(OUT), 'deny', 'a cwd inside the worktree is not identity');
    has(OUT, 'no task_id', 'the reason names the missing piece');
    assert.equal(dec(WT, 'swe', 'Bash', bashCmd('ls'), { noIdentity: true }), 'allow', 'Bash with no write runs');
    sqlExec(DB, "DELETE FROM audit WHERE event_type='containment_denied' AND content_json LIKE '%unbound_caller%'");
  });

  it('Bash: mkdir "$TMB_MODEL_CACHE_DIR"/x → allow', () => {
    assert.equal(swe('mkdir "$TMB_MODEL_CACHE_DIR"/x'), 'allow', 'the model cache is sanctioned');
  });

  it('Bash: write positions outside the root → deny', () => {
    for (const cmd of [
      'cp a.txt /tmp/b.txt',
      'echo x | tee -a /tmp/log',
      'rm -rf /tmp/foo*',
      'git worktree add /tmp/wt feat/x',
      'git clone https://example.test/r.git /tmp/clone',
      'touch $HOME/f',
      'mkdir -p ${HOME}/d',
      'mv x ../../outside',
      'touch "$UNRESOLVED/x"',
    ]) {
      assert.equal(swe(cmd), 'deny', cmd);
    }
  });

  it('Bash: write positions inside the root and devices → allow', () => {
    for (const cmd of ['cp a.txt b.txt', 'ls 2>/dev/null >> out.log', 'echo x 2>&1 | tee out', 'rm -rf build/']) {
      assert.equal(swe(cmd), 'allow', cmd);
    }
  });

  it('the host temp dir ($TMPDIR) is allowed; /tmp outside it is not', () => {
    assert.equal(dec(WT, 'swe', 'Write', write(`${HOST_TMP}/scratch.txt`)), 'allow', 'Write under $TMPDIR');
    assert.equal(dec(WT, 'swe', 'Write', write(`${realpathSync(HOST_TMP)}/real.txt`)), 'allow', 'Write under the realpath of $TMPDIR');
    assert.equal(swe(`echo x > ${HOST_TMP}/out.txt`), 'allow', 'Bash redirect into $TMPDIR');
    assert.equal(dec(WT, 'swe', 'Write', write('/tmp/tmb-not-host-tmp/x')), 'deny', 'Write under /tmp outside $TMPDIR');
  });

  it('bro context: the root is the project', () => {
    assert.equal(dec(PROJECT, '', 'Write', write(`${PROJECT}/README.md`)), 'allow', 'project file');
    const OUT = run(PROJECT, '', 'Write', write('/tmp/x'));
    assert.equal(decision(OUT), 'deny', 'outside the project');
    assert.equal(lastDenial(), `{"tool":"Write","path":"/tmp/x","root":"${PROJECT}","task_id":null}|-1`, 'bro denials audit on the system issue with task_id null');
  });

  it('symlink then .. lands where the link points → deny', () => {
    const OUTSIDE = join(SANDBOX, 'outside/deep');
    mkdirSync(OUTSIDE, { recursive: true });
    symlinkSync(OUTSIDE, join(WT, 'link'));
    assert.equal(dec(WT, 'swe', 'Write', write(`${WT}/link/../x`)), 'deny', 'Write to <root>/link/../x');
    assert.equal(swe(`echo hi > ${WT}/link/../x`), 'deny', 'Bash echo hi > <root>/link/../x');
    assert.equal(dec(WT, 'swe', 'Write', write(`${WT}/src/../b.ts`)), 'allow', 'Write to <root>/a/../b with no symlink');
    assert.equal(swe(`echo hi > ${WT}/src/../b.txt`), 'allow', 'Bash redirect to <root>/a/../b with no symlink');
  });

  it('planting a link is a write → deny when the link or a hard-linked source is outside', () => {
    for (const cmd of [`ln -s ${WT}/x ${SANDBOX}/link2`, 'link /etc/hosts h', 'cp -s /etc/hosts h', 'cp -l /etc/hosts h']) {
      assert.equal(swe(cmd), 'deny', cmd);
    }
    assert.equal(swe('ln -s a.ts src/alias.ts'), 'allow', 'a relative link inside the root');
  });

  const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

  it("Claude Code's own project and plans dirs: main session only", () => {
    const CC_PROJECT = `${HOME}/.claude/projects/${slug(PROJECT)}`;
    assert.equal(dec(PROJECT, '', 'Write', write(`${CC_PROJECT}/memory/MEMORY.md`)), 'allow', 'bro Write to its auto-memory');
    assert.equal(dec(PROJECT, '', 'Write', write(`${HOME}/.claude/plans/x.md`)), 'allow', 'bro Write to a plan');
    assert.equal(dec(PROJECT, 'bro', 'Bash', bashCmd('echo x > ~/.claude/plans/p.md')), 'allow', 'bro Bash redirect into plans');
    assert.equal(dec(PROJECT, '', 'Write', write(`${HOME}/.claude/settings.json`)), 'deny', 'bro Write to ~/.claude/settings.json');
    assert.equal(dec(PROJECT, '', 'Write', write(`${HOME}/.claude/projects/-Users-someone-else/memory/x.md`)), 'deny', "bro Write to another project's slug");
    assert.equal(dec(WT, 'swe', 'Write', write(`${CC_PROJECT}/memory/x.md`)), 'deny', "swe Write to the project's auto-memory");
    assert.equal(dec(WT, 'code-reviewer', 'Write', write(`${HOME}/.claude/plans/x.md`)), 'deny', 'code-reviewer Write to a plan');
  });

  it('GH 1553: a session nested below the project writes the auto-memory Claude Code names after CLAUDE_PROJECT_DIR', () => {
    const NESTED = `${PROJECT}/apps/web`;
    mkdirSync(NESTED, { recursive: true });
    const CC_PROJECT = `${HOME}/.claude/projects/${slug(PROJECT)}`;
    const CC_NESTED = `${HOME}/.claude/projects/${slug(NESTED)}`;
    const nested = { projectDir: NESTED };
    assert.equal(dec(NESTED, '', 'Write', write(`${CC_NESTED}/memory/MEMORY.md`), nested), 'allow', "bro Write to the session's auto-memory");
    assert.equal(dec(NESTED, '', 'Write', write(`${CC_PROJECT}/memory/MEMORY.md`), nested), 'allow', "bro Write to the project root's auto-memory");
    assert.equal(dec(NESTED, '', 'Write', write(`${PROJECT}/README.md`), nested), 'allow', 'the root is still the project');
    assert.equal(dec(PROJECT, '', 'Write', write(`${CC_NESTED}/memory/MEMORY.md`)), 'deny', "a session at the project root does not get a subdir's slug");
  });

  it('every denial wrote an audit row', () => {
    assert.equal(denials(), count("SELECT COUNT(*) AS n FROM audit WHERE event_type='containment_denied'"), 'all rows from hook:containment-guard');
    assert.equal(denials(), 28, 'one row per denial above');
  });

  it('GH 1789: ln -s is judged by the link it creates; its target only where a later write could follow the link', () => {
    const OUT_DIR = join(SANDBOX, 'outside-1789');
    mkdirSync(join(WT, 'sub'), { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });
    assert.equal(swe(`ln -s ${SANDBOX}/main/mcp/trajectory-server/node_modules node_modules`), 'allow', 'a link inside the root to an outside target');
    assert.equal(swe(`cd sub && ln -s ${OUT_DIR}/x link`), 'allow', 'a link made under a cd prefix');
    assert.equal(swe(`ln -s ${WT}/x ${OUT_DIR}/link`), 'deny', 'the link itself is outside');
    for (const cmd of [
      `ln -s ${OUT_DIR} link3 && echo x > link3/f`,
      `ln -s ${OUT_DIR} link3; touch link3/f`,
      `(sleep 1; echo x > link3/f) & ln -s ${OUT_DIR} link3`,
      `(sleep 1; echo x > link3/f) | ln -s ${OUT_DIR} link3`,
      `{ sleep 1; echo x > link3/f; } | ln -s ${OUT_DIR} link3`,
      `while sleep 1; do echo x > link3/f; done | ln -s ${OUT_DIR} link3`,
      `trap 'echo x > link3/f' EXIT; ln -s ${OUT_DIR} link3`,
      `bash -c 'ln -s ${OUT_DIR} link3'`,
      `ln ${OUT_DIR}/f h`,
      `ln ${OUT_DIR}/f -s`,
    ]) {
      assert.equal(swe(cmd), 'deny', cmd);
    }
    symlinkSync(OUT_DIR, join(WT, 'premade'));
    assert.equal(swe('echo x > premade/f'), 'deny', 'Bash write through a link made beforehand');
    assert.equal(dec(WT, 'swe', 'Write', write(`${WT}/premade/f`)), 'deny', 'Write through a link made beforehand');
  });

  const NODE_OUT = ["node <<'EOF'", "require('fs').writeFileSync('/tmp/tmb-cg-x', 'y')", 'EOF'].join('\n');

  it('GH 1279: a program fed to an interpreter through a heredoc is judged', () => {
    const OUT = run(PROJECT, '', 'Bash', bashCmd(NODE_OUT));
    assert.equal(decision(OUT), 'deny', 'bro node heredoc writing /tmp outside the root');
    has(OUT, '/tmp/tmb-cg-x', "the reason names the program's path");
    const NODE_IN = ["node <<'EOF'", "require('fs').writeFileSync('src/x.js', 'y')", 'EOF'].join('\n');
    assert.equal(bro(NODE_IN), 'allow', 'bro node heredoc writing inside the root');
    assert.equal(swe(py("open('/etc/tmb-cg', 'w').write('x')")), 'deny', 'swe python heredoc writing outside its worktree');
    const SH_OUT = ["sh <<'EOF'", 'echo x > /tmp/tmb-cg-sh', 'EOF'].join('\n');
    assert.equal(swe(SH_OUT), 'deny', 'swe sh heredoc redirecting outside its worktree');
    const DATA = ["cat > notes.py <<'EOF'", "open('/etc/passwd', 'w')", 'EOF'].join('\n');
    assert.equal(swe(DATA), 'allow', 'a data heredoc is never scanned');
  });

  it('GH 1567: /onboard quoted inside a larger string literal is not a write target', () => {
    const PROSE = [
      "p = 'src/x.sh'",
      's = open(p).read()',
      "old = '''x'''",
      "new = old + '''",
      'assert_not_contains "$PREAMBLE" "/onboard" "preamble /onboard token"',
      'If you run `/onboard`, answer No',
      "'''",
    ].join('\n');
    assert.equal(swe(py(PROSE, "open(p, 'w').write(s.replace(old, new))")), UNPROVEN, 'swe editing a relative file through a variable path');
    assert.equal(swe(py(PROSE, "open(p, 'w').write(s.replace(old, new))", 'open("/onboard/x", "w")')), 'deny', 'the same edit with a literal write to /onboard/x');
    assert.equal(swe(py(PROSE, 'q = "/onboard"', "open(p, 'w').write(s.replace(old, new))")), 'deny', 'the same edit with a standalone /onboard literal');
  });

  it("GH 1510: a program is judged by its write calls' own path arguments", () => {
    assert.equal(
      swe(py('import json', "cfg = json.load(open('/etc/tmb-cg/config.json', encoding='utf-8'))", "open('out.txt','w').write(str(cfg))")),
      'allow',
      'swe reading a config outside, writing out.txt inside',
    );
    assert.equal(swe(py('import os', "open('out.txt','w').write(str(os.listdir('/usr/share/doc')))")), 'allow', 'swe listing a dir outside');
    assert.equal(swe(py('import sys', "sys.path.insert(0, '/opt/tmb-cg/lib')", "open('out.txt','w').write('x')")), UNPROVEN, 'swe extending sys.path with a dir outside');
    const REGEX_EDIT = "s = open('src/x.sh').read().replace('/^[\\\\/~$]/', '/x/')";
    assert.equal(swe(py(REGEX_EDIT, "open('src/x.sh','w').write(s)")), 'allow', 'swe editing a file whose text holds regex slashes (proven since GH 1723)');
    assert.equal(swe(py(REGEX_EDIT, "open('/etc/tmb-cg/x.sh','w').write(s)")), 'deny', 'the same edit written outside');
    assert.equal(swe(py("open('/etc/tmb-cg/x', 'w')")), 'deny', 'swe open w outside');
    assert.equal(swe(py("p = '/etc/tmb-cg/x'", "open(p, 'w').write('y')")), 'deny', 'swe writing a variable assigned an outside path');
    assert.equal(swe(py('import shutil', "shutil.copy('in.txt', '/etc/tmb-cg/')")), 'deny', 'swe copying out');
  });

  it('GH 1279: variable-held write targets', () => {
    const OUT = run(PROJECT, '', 'Bash', bashCmd('cat > "$UNKNOWN/f"'));
    assert.equal(decision(OUT), 'deny', 'bro $UNKNOWN/f');
    has(OUT, 'write target \\"$UNKNOWN/f\\" cannot be judged: depends on a variable the guard cannot resolve in this command', 'the reason names the variable');
    assert.equal(bro('OUT=/etc/tmb-cg; cat > "$OUT"'), 'deny', 'a variable set to a path outside the root');
    assert.equal(bro(`OUT=${PROJECT}/notes.txt; cat > "$OUT"`), 'allow', 'a variable set to a path inside the root');
    assert.equal(bro('D=build; mkdir -p "$D/out"'), 'allow', 'a relative variable resolves against the cwd');
    assert.equal(bro('touch "build/$UNKNOWN"'), 'allow', 'the literal dir before an unknown variable is inside the root');
    assert.equal(bro('touch "/tmp/tmb-cg/$UNKNOWN"'), 'deny', 'the literal dir before an unknown variable is outside the root');
    assert.equal(swe('OUT=$(mktemp -u "$TMPDIR/f.XXXXXX"); cat > "$OUT"'), 'deny', 'a value built by $( ) is unresolvable');
    assert.equal(swe('OUT=$(mktemp "$TMPDIR/f.XXXXXX"); cat > "$OUT"'), 'allow', 'GH 1912: an allowlisted mktemp resolves to its template');
    assert.equal(swe('OUT=$(mktemp /etc/tmb-cg/f.XXXXXX); cat > "$OUT"'), 'deny', 'GH 1912: a mktemp template outside the root');
  });

  it("GH 1279: $PWD is the statement's own dir", () => {
    assert.equal(bro('echo x > "$PWD/out"'), 'allow', 'bro from inside the root');
    assert.equal(swe('echo x > "$PWD/out"'), 'allow', 'swe from inside its worktree');
    mkdirSync(join(PROJECT, 'x'), { recursive: true });
    assert.equal(bro(`cd ${PROJECT}/x && echo y > "$PWD/f"`), 'allow', 'cd <root>/x && echo y > $PWD/f');
    let OUT = run(PROJECT, '', 'Bash', bashCmd('cd /tmp/tmb-cg-pwd && echo y > "$PWD/f"'));
    assert.equal(decision(OUT), 'deny', '$PWD after a cd outside the root');
    has(OUT, '/tmp/tmb-cg-pwd/f is outside', 'denied as the real path');
    mkdirSync(OUTSIDE_CWD, { recursive: true });
    OUT = run(OUTSIDE_CWD, '', 'Bash', bashCmd('echo x > "$PWD/out"'));
    assert.equal(decision(OUT), 'deny', 'from a cwd outside the root');
    has(OUT, OUTSIDE_CWD, 'denied as the real path');
    assert.equal(bro('HOME=/inside cat > "$HOME/.bashrc"'), 'deny', 'a HOME= prefix: judged on the real ~/.bashrc');
  });

  it('GH 1324: loop variables bounded by an in-root source', () => {
    for (const d of [`${PROJECT}/tests`, `${PROJECT}/a`, `${WT}/tests`]) mkdirSync(d, { recursive: true });
    assert.equal(bro(`for f in ${PROJECT}/tests/*.sh; do sed -i 's/a/b/' "$f"; done`), 'allow', 'bro: for f in <root>/tests/*.sh; sed -i');
    assert.equal(bro(`for f in $(find ${PROJECT} -name '*.md'); do printf x >> "$f"; done`), 'allow', 'bro: for f in $(find <root> …); printf >>');
    assert.equal(bro(`find . -name '*.sh' | while read -r f; do sed -i 's/a/b/' "$f"; done`), 'allow', 'bro: find . | while read');
    assert.equal(swe(`for f in $(git ls-files); do sed -i 's/a/b/' "$f"; done`), 'allow', 'swe: for f in $(git ls-files) from its worktree');
    const OUT = run(PROJECT, '', 'Bash', bashCmd('for f in $(find / -name x); do rm "$f"; done'));
    assert.equal(decision(OUT), 'deny', 'bro: for f in $(find / …); rm');
    has(OUT, 'depends on a variable the guard cannot resolve', 'an out-of-root source is unresolvable');
    assert.equal(swe(`for f in $(find ${PROJECT} -name x); do rm "$f"; done`), 'deny', 'swe: a source in the project but outside its worktree');
    assert.equal(bro('for f in $(cat list.txt); do rm "$f"; done'), 'deny', 'bro: $(cat list.txt)');
  });

  it('GH 1324: bro loops over the project above its prompt-surface dirs are allowed', () => {
    for (const d of [`${PROJECT}/agents`, `${PROJECT}/skills/x`]) mkdirSync(d, { recursive: true });
    assert.equal(bro(`for f in $(find ${PROJECT} -name '*.md'); do sed -i s/a/b/ "$f"; done`), 'allow', "bro: find <root> -name '*.md'");
    assert.equal(bro('for f in $(git ls-files); do sed -i s/a/b/ "$f"; done'), 'allow', 'bro: git ls-files');
  });

  it('GH 1324: loop shapes that leave the root stay denied', () => {
    assert.equal(bro('for f in $(find -- /etc -name x); do rm "$f"; done'), 'deny', 'find -- /etc');
    assert.equal(swe('for f in $(find -- /etc -name x); do rm "$f"; done'), 'deny', 'swe: find -- /etc');
    assert.equal(bro(`for d in $(find ${PROJECT} -type d); do echo x > "$d/../f"; done`), 'deny', '$d/../f: find lists the root itself');
    assert.equal(bro(`for f in $(find ${PROJECT} -maxdepth 0); do cp x "$f.bak"; done`), 'deny', '$f.bak of the root');
    assert.equal(bro(`for f in $(find ${PROJECT} -name '*'); do rm -rf "$f/.."; done`), 'deny', '$f/.. of the root');
    assert.equal(swe(`for d in $(find ${WT} -type d); do echo x > "$d/../f"; done`), 'deny', 'swe: $d/../f from its worktree');
    assert.equal(swe(`for f in $(find ${WT} -maxdepth 0); do cp x "$f.bak"; done`), 'deny', 'swe: $f.bak of its worktree');
    const OUT = run(PROJECT, '', 'Bash', bashCmd(`echo x > ${PROJECT}/*/../../../etc/f`));
    assert.equal(decision(OUT), 'deny', 'a literal glob followed by ..');
    has(OUT, 'climbs with .. after a glob', 'the reason names the shape');
    assert.equal(bro(`for d in $(find ${PROJECT}/a -type d); do echo x > "$d/../../../etc/f"; done`), 'deny', 'a bound glob followed by ..');
    assert.equal(bro('cd /tmp/tmb-cg-z; echo x > "$OLDPWD/f"'), 'deny', 'a cd not chained with && leaves $OLDPWD unknown');
  });

  it("GH 1324: $OLDPWD is the dir before the command's last cd", () => {
    assert.equal(bro(`cd ${PROJECT}/a && echo x > "$OLDPWD/f"`), 'allow', 'bro: cd <root>/a from inside the root');
    assert.equal(swe(`cd ${WT}/src && echo x > "$OLDPWD/f"`), 'allow', 'swe: cd <wt>/src from its worktree');
    let OUT = run(OUTSIDE_CWD, '', 'Bash', bashCmd(`cd ${PROJECT}/a && echo x > "$OLDPWD/f"`));
    assert.equal(decision(OUT), 'deny', 'bro: from a cwd outside the root');
    has(OUT, OUTSIDE_CWD, 'the outside dir is named');
    OUT = run(PROJECT, '', 'Bash', bashCmd(`cd /tmp/tmb-cg-old && cd ${PROJECT}/a && echo x > "$OLDPWD/f"`));
    assert.equal(decision(OUT), 'deny', 'bro: $OLDPWD left outside the root by an earlier cd');
    has(OUT, '/tmp/tmb-cg-old/f is outside', 'denied as the real path');
    assert.equal(bro('echo x > "$OLDPWD/f"'), 'deny', 'no cd: unresolvable');
  });

  it('GH 1324: the GH 1279 denies hold', () => {
    assert.equal(bro('cat > "$UNKNOWN/f"'), 'deny', 'cat > $UNKNOWN/f');
    assert.equal(bro('cat > "$(mktemp -u "$TMPDIR/f.XXXXXX")"'), 'deny', 'cat > $(mktemp -u <template>)');
    assert.equal(bro('cat > "$(mktemp /etc/tmb-cg/f.XXXXXX)"'), 'deny', 'GH 1912: cat > $(mktemp <outside template>)');
    assert.equal(bro('OUT=/etc/tmb-cg; cat > "$OUT"'), 'deny', 'OUT=/etc/x; cat > $OUT');
    assert.equal(bro(NODE_OUT), 'deny', 'an interpreter heredoc writing outside the root');
  });

  it('GH 1338: what find, fd and xargs run is judged on the listed paths', () => {
    const OUT = run(PROJECT, '', 'Bash', bashCmd('find / -exec rm {} \\;'));
    assert.equal(decision(OUT), 'deny', 'bro: find / -exec rm {} \\;');
    has(OUT, 'depends on a variable the guard cannot resolve', 'an out-of-root start path is unresolvable');
    for (const cmd of ['find $HOME -delete', 'find / -print0 | xargs -0 rm', 'cat list | xargs rm', 'fd x /etc -x rm', `find ${PROJECT} -fprint /tmp/tmb-cg-list`]) {
      assert.equal(bro(cmd), 'deny', `bro: ${cmd}`);
    }
    for (const cmd of [
      `find ${PROJECT} -name '*.md' -exec sed -i s/a/b/ {} \\;`,
      `find ${PROJECT} -name '*.sh' -print`,
      'find / -name x -print',
      `find ${PROJECT} -name '*.tmp' -delete`,
      'find src -print0 | xargs -0 sed -i s/a/b/',
      'fd -e md -x sed -i s/a/b/ {}',
    ]) {
      assert.equal(bro(cmd), 'allow', `bro: ${cmd}`);
    }
    assert.equal(swe(`find ${PROJECT} -exec rm {} \\;`), 'deny', 'swe: find <project> -exec rm from its worktree');
    assert.equal(swe(`find ${WT}/src -exec rm {} \\;`), 'allow', 'swe: find <wt>/src -exec rm');
  });

  it('GH 1531: git subcommands, program calls and wrapper options that write outside are denied', () => {
    for (const [cmd, want] of [
      [`git -C ${PROJECT} bisect start`, PROJECT],
      ['git archive -o /etc/tmb-cg.tar HEAD', '/etc/tmb-cg.tar'],
      ['sudo -S rm /etc/tmb-cg', '/etc/tmb-cg'],
      ['sudo -C 5 rm ../tmb-cg-x', `${WT}/../tmb-cg-x`],
    ]) {
      const OUT = run(WT, 'swe', 'Bash', bashCmd(cmd));
      assert.equal(decision(OUT), 'deny', `swe: ${cmd}`);
      has(OUT, want, `the reason names ${want}`);
    }
    for (const [l1, l2, want] of [
      ['import os', "os.truncate('/etc/tmb-cg', 0)", '/etc/tmb-cg'],
      ['import subprocess', "subprocess.run(['cp', 'a', '/etc/tmb-cg'])", '/etc/tmb-cg'],
      ['import zipfile', "zipfile.ZipFile('/etc/tmb-cg.zip', 'w')", '/etc/tmb-cg.zip'],
    ]) {
      const OUT = run(WT, 'swe', 'Bash', bashCmd(py(l1, l2)));
      assert.equal(decision(OUT), 'deny', `swe: ${l2}`);
      has(OUT, want, `the reason names ${want}`);
    }
  });

  it('GH 1531: a process call is judged as the shell command it runs', () => {
    for (const [imp, call] of [
      ['import subprocess', "subprocess.run(['rm', '-rf', '..'])"],
      ['import subprocess', "subprocess.run(['rm', '-rf', 'x'], cwd='..')"],
      ['import os', "os.system('rm -rf ~')"],
      ['import os', "os.system('cd .. && rm -rf cg-task')"],
      ['import subprocess as sp', "sp.run(['rm', '-rf', '..'])"],
      ['from subprocess import run as r', "r(['rm', '-rf', '..'])"],
      ['import subprocess', "subprocess.run(['rm', '-rf', d])"],
      ['import subprocess', "f = subprocess.run; f(['touch', 'x'])"],
    ]) {
      assert.equal(swe(py(imp, call)), 'deny', `swe: ${call}`);
    }
    for (const prog of [
      "const {execSync: x} = require('child_process'); x('rm -rf ..')",
      "const cp = require('child_process'); cp.execSync('rm -rf ..')",
      "require('child_process').spawnSync('rm', ['-rf', 'x'], { cwd: '..' })",
    ]) {
      assert.equal(swe(nodeProg(prog)), 'deny', `swe: ${prog}`);
    }
    for (const [imp, call] of [
      ['import subprocess', "subprocess.run(['rm', '-rf', 'build'])"],
      ['import subprocess', "subprocess.run(['touch', 'x'], cwd='src')"],
      ['import os', "os.system('cd src && touch x')"],
      ['import subprocess as sp', "sp.run(['git', 'status'], check=True)"],
    ]) {
      assert.equal(swe(py(imp, call)), 'allow', `swe inside its worktree: ${call}`);
    }
    const OUT = run(WT, 'swe', 'Bash', bashCmd('cd .. && rm -rf cg-task'));
    assert.equal(decision(OUT), 'deny', 'swe: cd .. && rm -rf <its own worktree>');
    has(OUT, 'comes back into it', 'the reason names the climb');
    assert.equal(swe('mkdir -p src && cd src/.. && touch x'), 'allow', 'swe: a .. that stays inside its worktree');
  });

  it('GH 1531: a process call is judged only when every part is a plain literal', () => {
    for (const [imp, call] of [
      ['import os', "os.system('rm -rf %s' % '..')"],
      ['import subprocess', "subprocess.run('rm -rf %s' % '..', shell=True)"],
      ['import os', "os.system('rm -rf {}'.format('..'))"],
      ['import subprocess', "subprocess.run(['rm', '-rf', '..'.strip()])"],
      ['import subprocess', "kw = {'cwd': '..'}; subprocess.run(['rm', '-rf', 'x'], **kw)"],
      ['import os', "os.chdir('..'); os.system('rm -rf cg-task')"],
      ['import os', 'exec("os.system(\'rm -rf ..\')")'],
    ]) {
      assert.equal(swe(py(imp, call)), 'deny', `swe: ${call}`);
    }
    for (const prog of [
      "const { execSync } = require('child_process'); const o = { cwd: '..' }; execSync('rm -rf x', o)",
      "const { execSync } = require('child_process'); execSync('rm -rf x', { ...{ cwd: '..' } })",
      "process.chdir('..'); require('child_process').execSync('rm -rf cg-task')",
      "import cp from 'child_process'; cp.execSync('rm -rf ..')",
      'eval("require(\'child_process\').execSync(\'rm -rf ..\')")',
    ]) {
      assert.equal(swe(nodeProg(prog)), 'deny', `swe: ${prog}`);
    }
    assert.equal(swe(interpProg('perl', "chdir '..'; system('rm', '-rf', 'cg-task');")), 'deny', 'swe: perl chdir then system');
    assert.equal(swe(interpProg('ruby', "Dir.chdir('..')", "system('rm -rf cg-task')")), 'deny', 'swe: ruby Dir.chdir then system');
    assert.equal(swe(interpProg('perl', 'my $o = qx(rm -rf ..);')), 'deny', 'swe: perl qx()');
    assert.equal(swe(interpProg('ruby', 'o = %x(rm -rf ..)')), 'deny', 'swe: ruby %x()');
    assert.equal(
      swe(py('import subprocess', "subprocess.run(['touch', 'x'], cwd='src', check=True, capture_output=True, text=True)")),
      'allow',
      'swe: plain literals with ordinary options inside its worktree',
    );
    assert.equal(swe(nodeProg("import cp from 'child_process'; cp.execSync('touch x', { stdio: 'inherit' })")), UNPROVEN, 'swe: a node default import inside its worktree');
    assert.equal(swe(py("print('%s' % 'x'.strip())")), 'allow', 'swe: a program without process calls');
  });

  it('GH 1531: text a program writes is content, not a target', () => {
    const CONTENT = "const root = '/work/proj'; const branch = 'fix/sess-a';";
    assert.equal(swe(py(`p = '${WT}/a.ts'`, "with open(p, 'w') as f:", `    f.write("${CONTENT}")`)), 'allow', 'swe writing path-like text into its worktree');
    assert.equal(swe(py('from pathlib import Path', `p = Path('${WT}/a.ts')`, `p.write_text("${CONTENT}")`)), 'allow', 'an unknown receiver writing path-like text');
    const OUT = run(WT, 'swe', 'Bash', bashCmd(py("p = '/etc/tmb-cg-a.ts'", "with open(p, 'w') as f:", `    f.write("${CONTENT}")`)));
    assert.equal(decision(OUT), 'deny', 'the same program writing outside');
    has(OUT, '/etc/tmb-cg-a.ts', 'the reason names the written path');
    hasNot(OUT, '/work/proj', 'the content is not named');
    assert.equal(swe(py("d = '/etc'", "open(d + '/tmb-cg', 'w').write('x')")), 'deny', 'a computed write path fails closed');
  });

  it('GH 1723: a ~/ literal a proven program only passes to replace is not a write target', () => {
    const replace = (target: string) => `p='docs/a.md'; s=open(p).read().replace('~/.jobduck','{{home}}'); open(${target},'w').write(s)`;
    assert.equal(swe(py(replace('p'))), 'allow', 'swe heredoc rewriting an in-worktree file with a ~/ replace argument');
    const OUT = run(WT, 'swe', 'Bash', bashCmd(`python3 -c "${replace("'/etc/q'")}"`));
    assert.equal(decision(OUT), 'deny', 'the same program writing /etc/q');
    has(OUT, '/etc/q', 'the reason names the written path');
  });

  it('GH 1569: code-string runners and dynamic builtins', () => {
    assert.equal(
      swe(py('import cProfile', "p = 'out.txt'", 'cProfile.run(\'p = "/etc/tmb-cg"\')', "open(p, 'w').write('x')")),
      'deny',
      'swe: cProfile.run rebinding a variable write path',
    );
    assert.equal(
      swe(`python3 -c "import cProfile; p = 'out.txt'; cProfile.run('p = %r' % 'x'); open(p, 'w')"`),
      'deny',
      'swe python -c: cProfile.run with a computed code string',
    );
    const OUT = run(WT, 'swe', 'Bash', bashCmd(py('import cProfile', 'cProfile.run(\'open("/etc/tmb-cg", "w")\')', "open('out.txt', 'w').write('x')")));
    assert.equal(decision(OUT), 'deny', 'swe: a write inside a cProfile.run code string');
    has(OUT, '/etc/tmb-cg', "the reason names the code string's path");
    assert.equal(swe(py('import builtins', "getattr(builtins, 'ex' + 'ec')(\"open('/etc/tmb-cg', 'w')\")")), 'deny', "swe: getattr(builtins, 'ex' + 'ec')");
    assert.equal(swe(`python3 -c "import builtins; getattr(builtins, 'ex' + 'ec')(s)"`), 'deny', "swe python -c: getattr(builtins, 'ex' + 'ec')");
    assert.equal(
      swe(py('import cProfile, timeit', "cProfile.run('sum(range(9))')", "print(timeit.timeit('sum(range(9))', number=10))", "open('out.txt', 'w').write('x')")),
      UNPROVEN,
      'swe: benign cProfile.run and timeit writing inside its worktree',
    );
    assert.equal(
      swe(py('import cProfile', 'with cProfile.Profile() as pr:', '    sum(range(9))', "pr.dump_stats('out.prof')")),
      'deny',
      'swe: with cProfile.Profile() as pr is unresolvable even dumping stats inside its worktree',
    );
    assert.equal(
      swe(py('import cProfile, timeit', "cProfile.run('main()', 'out.prof')", 'print(timeit.timeit(lambda: 1, number=10))')),
      UNPROVEN,
      'swe: cProfile.run with a filename and a timeit lambda writing inside its worktree',
    );
    assert.equal(
      swe(py('import cProfile, sys', "p = 'out.txt'", 'pr = cProfile.Profile()', "getattr(pr, 'run')(sys.argv[1])", "open(p, 'w').write('x')")),
      'deny',
      "swe: getattr(pr, 'run') rebinding a variable write path",
    );
    assert.equal(
      swe(py('import cProfile, inspect, sys', "p = 'out.txt'", 'pr = cProfile.Profile()', "inspect.getattr_static(pr, 'run')(pr, sys.argv[1])", "open(p, 'w').write('x')")),
      'deny',
      "swe: inspect.getattr_static(pr, 'run') rebinding a variable write path",
    );
    assert.equal(
      swe(py('from cProfile import Profile as P', "p = 'out.txt'", 'P.runctx(o, sys.argv[1], globals(), None)', "open(p, 'w').write('x')")),
      'deny',
      'swe: a class-method runctx rebinding a variable write path',
    );
    assert.equal(swe(py('import cProfile, sys', 'cProfile.Profile().run("pass").run(sys.argv[1])')), 'deny', 'swe: a chained Profile().run returns the profiler');
  });

  it('GH 1571: python paths that hide a write are unresolvable when referenced at all', () => {
    assert.equal(swe(`python3 -m timeit -s "open('/etc/tmb-cg','w')" pass`), 'deny', 'swe: python -m timeit -s');
    assert.equal(swe('python3 -m cProfile -o out.prof x.py'), 'deny', 'swe: python -m cProfile');
    assert.equal(swe('python3 -m pdb x.py'), 'deny', 'swe: python -m pdb');
    assert.equal(swe(py('import runpy', "open('out.txt','w')")), 'deny', 'swe: a program importing runpy');
    assert.equal(swe(py('o = open', "o('/etc/tmb-cg', 'w')")), 'deny', 'swe: open held as a value');
    assert.equal(swe('python3 -m json.tool x.json'), 'allow', 'swe: python -m json.tool');
    assert.equal(swe('python3 -m pytest -q'), 'allow', 'swe: python -m pytest');
    assert.equal(swe(py("import json; open('out.txt','w').write(json.dumps({}))")), 'allow', 'swe: an ordinary program writing inside its worktree');
  });

  it("GH 1597: the harness's /tmp/claude-<uid> and .claude/tmb/scratch/ are sanctioned scratch", () => {
    assert.equal(dec(WT, 'swe', 'Write', write(`/tmp/claude-${FAKE_UID}/x`)), 'allow', 'swe Write under /tmp/claude-<uid> with $TMPDIR elsewhere');
    assert.equal(bro(`echo x > /tmp/claude-${FAKE_UID}/y`), 'allow', 'bro Bash redirect under /tmp/claude-<uid>');
    assert.equal(dec(WT, 'swe', 'Write', write(`/tmp/claude-${FAKE_UID}-other/x`)), 'deny', 'a sibling of /tmp/claude-<uid> is not covered');
    assert.equal(dec(PROJECT, '', 'Write', write(`${PROJECT}/.claude/tmb/scratch/x.py`)), 'allow', 'bro Write to <project>/.claude/tmb/scratch/');
    const OUT = run(PROJECT, '', 'Write', write('/etc/tmb-cg'));
    has(OUT, `${PROJECT}/.claude/tmb/scratch/`, 'the deny names the sanctioned scratch dir');
    has(OUT, `/tmp/claude-${FAKE_UID}`, 'the deny names the harness temp dir');
  });

  it("GH 1595: bro's cwd is judged only when the command writes", () => {
    const OTHER_REPO = join(SANDBOX, 'other-repo');
    mkdirSync(OTHER_REPO, { recursive: true });
    git(sb.env, OTHER_REPO, 'init', '-q');
    assert.equal(dec(OTHER_REPO, '', 'Bash', bashCmd(`git -C ${PROJECT} status`)), 'allow', 'bro: git -C <project> status from another repo');
    assert.equal(dec(OTHER_REPO, '', 'Bash', bashCmd(`ls ${PROJECT}`)), 'allow', 'bro: a read from another repo');
    const OUT = run(OTHER_REPO, '', 'Bash', bashCmd('touch f'));
    assert.equal(decision(OUT), 'deny', 'bro: a relative write from another repo');
    has(OUT, OTHER_REPO, "the reason names the write's real dir");
  });

  it('GH 1595: a relative write after cd $VAR is judged under the variable', () => {
    let OUT = run(PROJECT, '', 'Bash', bashCmd('cd $UNSET && touch f'));
    assert.equal(decision(OUT), 'deny', 'bro: cd $UNSET && touch f');
    has(OUT, '$UNSET', 'the reason names the variable');
    hasNot(OUT, 'is outside', 'never judged as a bare path under the cwd');
    assert.equal(bro(`D=${PROJECT}/src; cd $D && touch f`), 'allow', 'bro: D=<root>/src; cd $D && touch f');
    assert.equal(bro('D=/etc; cd $D && touch f'), 'deny', 'bro: D=/etc; cd $D && touch f');
    OUT = run(PROJECT, '', 'Bash', bashCmd('cd - && touch f'));
    assert.equal(decision(OUT), 'deny', 'bro: cd - && touch f');
    has(OUT, 'cd, pushd or popd', 'the reason names the unresolvable cd');
  });

  it('GH 1602: a non-literal process call in an inline program gets its own reason', () => {
    const OUT = run(WT, 'swe', 'Bash', bashCmd(py('import subprocess', 'for n in range(3):', "    subprocess.run(['true', str(n)])")));
    assert.equal(decision(OUT), 'deny', "swe: subprocess.run(['true', str(n)])");
    hasNot(OUT, '$()', 'not reported as a command substitution');
    has(OUT, 'process call in an inline program', 'the reason names the process call');
  });

  const ALIAS_WHY =
    "is written through an aliased or stored write builtin the guard can't resolve. Allowed form: open() (or the write method) called directly with a literal path";

  it('GH 1676: a write through an aliased or held write builtin gets its own reason', () => {
    let OUT = run(WT, 'swe', 'Bash', bashCmd(`python3 -c "o=open; o('/etc/tmb-cg','w')"`));
    assert.equal(decision(OUT), 'deny', 'swe: python3 -c "o=open; o(...)"');
    has(OUT, ALIAS_WHY, 'the reason names the aliased write builtin');
    hasNot(OUT, 'process call', 'not reported as a process call');
    OUT = run(WT, 'swe', 'Bash', bashCmd(py('writers = [open]', "writers[0]('/etc/tmb-cg', 'w')")));
    assert.equal(decision(OUT), 'deny', 'swe: open held in a list');
    has(OUT, ALIAS_WHY, 'the reason names the held write builtin');
    OUT = run(WT, 'swe', 'Bash', bashCmd(py('import subprocess', 'f = subprocess.run', "f(['touch', '/etc/tmb-cg'])")));
    assert.equal(decision(OUT), 'deny', 'swe: a process function held in a variable');
    has(OUT, 'process call in an inline program', 'a process call keeps the process-call reason');
    hasNot(OUT, 'write builtin', 'a process call is not reported as a write builtin');
  });

  it('GH 1687: a write through a held or aliased module-qualified write callable is denied as alias-write', () => {
    for (const prog of [
      "import io|f = io.open|f('/etc/tmb-cg', 'w')",
      "import os|o = os.open|o('/etc/tmb-cg', os.O_WRONLY)",
      "import shutil|m = shutil.move|m('a', '/etc/tmb-cg')",
      "import shutil|m = shutil.copy|m('a', '/etc/tmb-cg')",
      "import shutil as s|m = s.move|m('a', '/etc/tmb-cg')",
      "from shutil import *|m = move|m('a', '/etc/tmb-cg')",
      "import shutil|m = shutil . move|m('a', '/etc/tmb-cg')",
      "import shutil|m = getattr(shutil, 'move')|m('a', '/etc/tmb-cg')",
      "m = __import__('shutil').move|m('a', '/etc/tmb-cg')",
      "o = __import__('io').open|o('/etc/tmb-cg', 'w')",
      "s = __import__('shutil')|m = s.move|m('a', '/etc/tmb-cg')",
    ]) {
      const OUT = run(WT, 'swe', 'Bash', bashCmd(py(...prog.split('|'))));
      assert.equal(decision(OUT), 'deny', `swe: ${prog}`);
      has(OUT, ALIAS_WHY, `the reason names the held writer: ${prog}`);
    }
    assert.equal(swe(py('import shutil', "shutil.move('a.txt', 'b.txt')")), 'allow', 'swe: a direct shutil.move inside the worktree');
    assert.equal(swe(py('import shutil', "shutil.copy('a.txt', 'b.txt')")), 'allow', 'swe: a direct shutil.copy inside the worktree');
    assert.equal(swe(py("__import__('shutil').move('a', '/etc/tmb-cg')")), 'deny', "swe: a direct __import__('shutil').move outside the worktree");
    assert.equal(swe(py("__import__('shutil').move('a.txt', 'b.txt')")), UNPROVEN, "swe: a direct __import__('shutil').move inside the worktree");
    for (const prog of [
      'import csv|for row in rows: print(row.open, row.close)',
      "import feedparser|for e in feedparser.parse('feed.xml').entries: print(e.link)",
      'import argparse|args = argparse.ArgumentParser().parse_args()|print(args.rm)',
      "import pandas as pd|df = pd.read_csv('prices.csv')|print(df.open.mean())",
    ]) {
      const expect = prog.startsWith('import csv') ? 'allow' : UNPROVEN;
      assert.equal(swe(py(...prog.split('|'))), expect, `swe: an attribute read named like a writer: ${prog}`);
    }
  });

  const ujComputed = () => ["python3 - <<'EOF'", 'import os', `open(os.path.join('${UJ_FILE}'), 'w').write('x')`, 'EOF'].join('\n');
  const ujParse = () => `echo hi > ${UJ_FILE}; echo "unterminated`;
  const ujUnproven = () => `python3 -c "import os; os.chmod('${UJ_FILE}', 0o777)"`;
  const deniesRecorded = () => existsSync(DENIES);

  it('GH 1750: a cannot-be-judged Bash deny records no path, so the Edit it prescribes is no bypass', () => {
    for (const [kind, cmd] of [
      ['computed', ujComputed()],
      ['parse', ujParse()],
      ['unproven', ujUnproven()],
    ]) {
      rmSync(DENIES, { recursive: true, force: true });
      const before = bypasses();
      let OUT = dispatched('containment-guard', 'Bash', bashCmd(cmd), `tu-uj-${kind}`);
      assert.equal(decision(OUT), 'deny', `$(${kind}) through the dispatcher`);
      has(OUT, 'cannot be judged: ', `$(${kind}): the cannot-be-judged reason`);
      if (kind === 'unproven') has(OUT, 'the inline program is unproven', 'GH 1739: $(unproven) names the program as unproven');
      assert.ok(!deniesRecorded(), `$(${kind}): a boundary-denies record was written`);
      OUT = dispatched('swe-boundary', 'Edit', editOf(UJ_FILE), `tu-uj-edit-${kind}`);
      hasNot(OUT, DENY, `$(${kind}): the literal-path Edit is allowed`);
      hasNot(OUT, 'hook_block_bypassed', `$(${kind}): no bypass context`);
      hasNot(OUT, 'hard stop', `$(${kind}): no hard-stop message`);
      assert.equal(bypasses(), before, `$(${kind}): no hook_block_bypassed row`);
    }
    rmSync(DENIES, { recursive: true, force: true });
    const OUT = dispatched('containment-guard', 'Bash', bashCmd(ujComputed()), 'tu-uj-again');
    assert.equal(decision(OUT), 'deny', 'a second call: the computed path is still not judged');
    assert.ok(!deniesRecorded(), 'a second call: a boundary-denies record was written');
  });

  it('GH 1750: a judged containment deny of a Bash write still records its path', () => {
    rmSync(DENIES, { recursive: true, force: true });
    const OUT = dispatched('containment-guard', 'Bash', bashCmd(`touch ${SANDBOX}/judged.txt`), 'tu-judged');
    assert.equal(decision(OUT), 'deny', 'outside the worktree');
    hasNot(OUT, 'cannot be judged', 'a judged reason');
    const dir = join(DENIES, 's-1');
    const recs = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')) : [];
    assert.equal(recs.length, 1, 'one record for the judged path');
    assert.equal(readFileSync(join(dir, recs[0] ?? ''), 'utf8').split('\n')[0], 'containment-guard', 'the record names the gate');
    rmSync(DENIES, { recursive: true, force: true });
  });

  it('GH 1772: an unresolved-target Bash deny records no path, so the literal Edit it prescribes is no bypass', () => {
    for (const [cg, target] of [
      ['deny', '$UNKNOWN/f'],
      ['allow', `${WT}/src/$1.yml`],
    ]) {
      rmSync(DENIES, { recursive: true, force: true });
      const cmd = `echo x > ${UJ_FILE}; cat > "${target}" < /dev/null`;
      const before = bypasses();
      let OUT = dispatched('containment-guard', 'Bash', bashCmd(cmd), `tu-ur-cg-${target.length}`);
      assert.equal(decision(OUT), cg, `${target}: containment-guard`);
      if (cg !== 'allow') has(OUT, 'cannot be judged: ', `${target}: containment-guard's cannot-be-judged reason`);
      OUT = dispatched('swe-boundary', 'Bash', bashCmd(cmd), `tu-ur-sb-${target.length}`);
      assert.equal(decision(OUT), 'deny', `${target}: swe-boundary`);
      has(OUT, 'cannot be judged: ', `${target}: swe-boundary's cannot-be-judged reason`);
      assert.ok(!deniesRecorded(), `${target}: a boundary-denies record was written`);
      OUT = dispatched('swe-boundary', 'Edit', editOf(UJ_FILE), `tu-ur-edit-${target.length}`);
      hasNot(OUT, DENY, `${target}: the literal-path Edit is allowed`);
      hasNot(OUT, 'hook_block_bypassed', `${target}: no bypass context`);
      assert.equal(bypasses(), before, `${target}: no hook_block_bypassed row`);
    }
    rmSync(DENIES, { recursive: true, force: true });
    const OUT = dispatched('containment-guard', 'Bash', bashCmd(`echo x > ${UJ_FILE}; cat > "$UNKNOWN/f" < /dev/null`), 'tu-ur-again');
    has(OUT, 'cannot be judged: ', 'a second call: the reason is unjudged too');
    assert.ok(!deniesRecorded(), 'a second call: a boundary-denies record was written');
  });

  it('GH 1772: a judged deny of a literal target outside still records, and the later Edit is flagged', () => {
    rmSync(DENIES, { recursive: true, force: true });
    const before = bypasses();
    let OUT = dispatched('containment-guard', 'Bash', bashCmd(`echo x > ${UJ_FILE}; touch ${SANDBOX}/judged.txt`), 'tu-ur-judged');
    assert.equal(decision(OUT), 'deny', 'outside the worktree');
    hasNot(OUT, 'cannot be judged', 'a judged reason');
    OUT = dispatched('swe-boundary', 'Edit', editOf(UJ_FILE), 'tu-ur-judged-edit');
    has(OUT, 'hook_block_bypassed', 'the Edit after a judged deny is flagged');
    assert.equal(bypasses(), before + 1, 'one hook_block_bypassed row');
    rmSync(DENIES, { recursive: true, force: true });
  });

  it("GH 1944: a loop body's later assignment reaches its earlier use", () => {
    for (const head of ['while :', 'until false', 'for i in 1 2']) {
      const OUT = run(PROJECT, '', 'Bash', bashCmd(`x=${PROJECT}/a; ${head}; do echo > $x; x=/etc/p1944; done`));
      assert.equal(decision(OUT), 'deny', `${head}: echo > $x before x=/etc/p1944`);
      has(OUT, '/etc/p1944', `${head}: the in-body value is judged`);
    }
    assert.equal(bro(`x=${PROJECT}/a; while :; do while :; do echo > $x; done; x=/etc/p1944; done`), 'deny', 'a use in a nested loop');
    const OUT = run(PROJECT, '', 'Bash', bashCmd(`x=${PROJECT}/a; while :; do echo > $x; read -r x; done`));
    assert.equal(decision(OUT), 'deny', 'an in-body read the guard cannot name');
    has(OUT, 'cannot be judged', 'denied as unjudged');
    assert.equal(bro(`for f in a b; do x=${PROJECT}/$f; echo > $x; done`), 'allow', 'a for-loop over in-root targets');
    assert.equal(bro(`for f in a b; do x=${PROJECT}/$f; echo "done" > $x; done`), 'allow', 'a for-loop with a quoted done argument');
    assert.equal(bro(`x=${PROJECT}/a; while :; do echo > $x; done`), 'allow', 'a loop that never reassigns');
    for (const body of [
      'for ((i=0;i<2;i++)) { echo > $x; x=/etc/p1944; }',
      'for i in 1 2; { echo > $x; x=/etc/p1944; }',
      'select i in 1 2; { echo > $x; x=/etc/p1944; }',
      'while :; do coproc for i in 1; do :; done; echo > $x; x=/etc/p1944; done',
      'for i do echo > $x; x=/etc/p1944; done',
      'select i do echo > $x; x=/etc/p1944; done',
      'while :; do for i do :; done; echo > $x; x=/etc/p1944; done',
      'echo > $x; x=/etc/p1944; done',
      'while :; do echo > $x; "done"; x=/etc/p1944; "while" :; "do" :; done',
      'while :; do echo > $x; \\done; x=/etc/p1944; \\while :; \\do :; done',
      'for i in 1 2; { echo > $x; "}"; x=/etc/p1944; "{"; }',
    ]) {
      assert.equal(bro(`x=${PROJECT}/a; ${body}`), 'deny', body);
    }
  });

  it("GH 1977: a loop body's later cd reaches its earlier relative write", () => {
    for (const body of ['echo > f1977; cd /etc', 'echo > f1977; pushd /etc']) {
      const OUT = run(PROJECT, '', 'Bash', bashCmd(`while :; do ${body}; done`));
      assert.equal(decision(OUT), 'deny', body);
      has(OUT, '/etc/f1977', `${body}: the next pass's dir is judged`);
    }
    assert.equal(bro('while false; do cd /etc; done; echo > f1977'), 'deny', 'a write after a loop that may cd');
    for (const c of ['cd "$d"', 'cd -', 'popd']) {
      const OUT = run(PROJECT, '', 'Bash', bashCmd(`while :; do echo > f1977; ${c}; done`));
      assert.equal(decision(OUT), 'deny', `a body cd it cannot name: ${c}`);
      has(OUT, 'cannot be judged', `${c}: denied as unjudged`);
    }
    assert.equal(bro('while :; do echo > f1977; ( cd /etc ); done'), 'allow', 'a subshell cd stays inside it');
    assert.equal(bro(`while :; do echo > f1977; cd ${PROJECT}/src; done`), 'allow', 'a body cd that stays in the root');
  });

  it('GH 2443: a literal $ in a write path is judged as the path bash writes', () => {
    assert.equal(swe("touch '$HOME/x'"), 'allow', "'$HOME/x' is a file under the worktree");
    assert.equal(swe('touch \\$PWD'), 'allow', '\\$PWD is a file under the worktree');
    for (const c of ["touch '../../../../$PWD'", 'touch ../../../../\\$PWD', "touch '/etc/$x'", 'touch /etc/a$']) {
      const OUT = run(WT, 'swe', 'Bash', bashCmd(c));
      assert.equal(decision(OUT), 'deny', c);
      hasNot(OUT, 'cannot be judged', `${c}: judged, not unjudged`);
    }
  });

  it('GH 2451: a bare $ in a relative write path is judged against the cwd, not skipped', () => {
    assert.equal(swe('touch a$'), 'allow', 'a$ is a file under the worktree');
    const OUT = run(WT, 'swe', 'Bash', bashCmd('cd /etc && touch a$'));
    assert.equal(decision(OUT), 'deny', 'a trailing $ resolves against the new cwd');
    hasNot(OUT, 'cannot be judged', 'judged, not unjudged');
  });

  it('GH 2451: $$ is the shell pid, so it is not resolved as two literal $', () => {
    assert.equal(swe('touch a$$'), 'allow', 'a<pid> is a file under the worktree');
    const OUT = run(WT, 'swe', 'Bash', bashCmd('cd /etc && touch a$$'));
    assert.equal(decision(OUT), 'deny', 'a<pid> lands outside the worktree');
    has(OUT, 'cannot be judged', 'pid is unjudged, so denied');
  });

  it('un-onboarded project → allow', () => {
    const BARE = join(SANDBOX, 'bare');
    mkdirSync(BARE, { recursive: true });
    assert.equal(dec(BARE, '', 'Write', write('/tmp/x'), { projectDir: BARE }), 'allow', 'no trajectory DB');
  });

  it('a DB that resolves but cannot be read → deny', () => {
    const BROKEN = join(SANDBOX, 'broken');
    mkdirSync(join(BROKEN, '.claude/tmb'), { recursive: true });
    writeFileSync(join(BROKEN, '.claude/tmb/trajectory.db'), 'not a database');
    const OUT = run(BROKEN, '', 'Write', write(`${BROKEN}/a`), { projectDir: BROKEN });
    assert.equal(decision(OUT), 'deny', 'fail closed');
    has(OUT, 'trajectory DB unavailable', 'the db-unavailable reason');
  });

  it('other tools pass through', () => {
    assert.equal(dec(WT, 'swe', 'Read', write('/etc/hosts')), 'allow', 'Read is not judged');
  });
});
