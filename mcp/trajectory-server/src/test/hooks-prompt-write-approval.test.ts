/**
 * prompt-write-approval (GH 2927): an Edit, Write or MultiEdit of a project
 * file under .claude/skills/ or .claude/agents/ needs a prompt_write_approved
 * audit row by bro naming its canonical path from the last 30 minutes; with a
 * skills-array approval only an existing agent's frontmatter skills: list may
 * change. A swe, another path and another tool pass; no DB or no sqlite denies.
 * Each case runs the gate in-process on a fresh project and trajectory DB.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, describe, it } from 'node:test';
import { auditEventWriters, isAuditEventType } from '../audit-events.js';
import { braceEdge, braceExpand, braceWords } from '../hooks/cmd-analysis/index.js';
import { containmentGuard } from '../hooks/containment-guard.js';
import { findGate, routerGates } from '../hooks/registry.js';
import { APPROVAL_WINDOW_MINUTES, EVENT_TYPE, GATE_NAME, promptWriteApproval, withoutSkillsEntry } from '../hooks/prompt-write-approval.js';
import { PLUGIN_ROOT } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const AGENT = '---\nname: a\ndescription: d\nskills:\n  - one\n---\nBody line.\n';
const INLINE_AGENT = '---\nname: b\nskills: [one]\n---\nBody line.\n';

type Output = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

describe('prompt-write-approval (GH 2927)', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-prompt-write-approval-')));
  let seq = 0;
  let project: string;
  let db: string;

  const skill = (name: string): string => join(project, '.claude/skills', name, 'SKILL.md');
  const agentPath = (name: string): string => join(project, '.claude/agents', `${name}.md`);
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: join(base, 'home'), CLAUDE_PROJECT_DIR: project, TRAJECTORY_DB_PATH: db, ...extra });
  const approve = (path: string, scope: string, at = minutesAgo(1), fromNode = 'bro'): void => {
    const d = new DatabaseSync(db);
    try {
      d.prepare("INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (9, ?, 'prompt_write_approved', 'approved', ?, ?)").run(fromNode, JSON.stringify({ path, scope }), at);
    } finally {
      d.close();
    }
  };
  const run = (tool: string, toolInput: object, extra: object = {}, runEnv: NodeJS.ProcessEnv = env()): Output | null => {
    const r = promptWriteApproval(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: tool, tool_input: toolInput, ...extra }), runEnv);
    assert.ok(!(r instanceof Promise), 'an edit tool is answered at once');
    assert.equal(r.code, 0);
    return r.stdout.trim() === '' ? null : (JSON.parse(r.stdout) as Output);
  };
  const denied = (out: Output | null): string => {
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny', 'denied');
    return out?.hookSpecificOutput?.permissionDecisionReason ?? '';
  };
  const write = (path: string, extra: object = {}, runEnv?: NodeJS.ProcessEnv): Output | null => run('Write', { file_path: path, content: '---\nname: x\n---\nx\n' }, extra, runEnv);

  beforeEach(() => {
    seq += 1;
    project = join(base, `p${seq}`);
    db = join(project, '.claude/tmb/trajectory.db');
    mkdirSync(dirname(db), { recursive: true });
    mkdirSync(join(project, '.claude/agents'), { recursive: true });
    writeFileSync(agentPath('a'), AGENT);
    writeFileSync(agentPath('b'), INLINE_AGENT);
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(minutesAgo(0), minutesAgo(0));
    } finally {
      d.close();
    }
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it('registers its audit event for bro and runs for every Write-group tool', () => {
    assert.ok(isAuditEventType(EVENT_TYPE));
    assert.deepEqual(auditEventWriters(EVENT_TYPE), ['bro']);
    assert.ok(findGate(GATE_NAME));
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.ok(routerGates('PreToolUse', tool).some((g) => g.name === GATE_NAME && g.kind === 'enforcement'), tool);
  });

  it('SC1: denies a bro write of a project skill with no approval, naming audit_append and the event', () => {
    const reason = denied(write(skill('x')));
    assert.match(reason, /audit_append/);
    assert.match(reason, /prompt_write_approved/);
    assert.ok(reason.includes(skill('x')), reason);
    denied(run('Edit', { file_path: agentPath('a'), old_string: 'Body', new_string: 'B' }));
  });

  it('SC2: allows the write with a matching approval under 30 minutes old, denies with only an older one', () => {
    approve(skill('x'), 'full', minutesAgo(APPROVAL_WINDOW_MINUTES - 5));
    assert.equal(write(skill('x')), null);
    approve(skill('y'), 'full', minutesAgo(APPROVAL_WINDOW_MINUTES + 5));
    denied(write(skill('y')));
  });

  it('denies an approval of another path, one not written by bro, and takes the newest matching row', () => {
    approve(skill('other'), 'full');
    denied(write(skill('x')));
    approve(skill('x'), 'full', minutesAgo(1), 'hook:x');
    denied(write(skill('x')));
    approve(agentPath('a'), 'full', minutesAgo(10));
    approve(agentPath('a'), 'skills-array', minutesAgo(2));
    denied(run('Edit', { file_path: agentPath('a'), old_string: 'Body line.', new_string: 'Other.' }));
  });

  it('compares the target canonically, so a symlinked spelling needs the canonical path approved', () => {
    const link = join(base, `link${seq}`);
    symlinkSync(project, link);
    approve(skill('x'), 'full');
    assert.equal(write(join(link, '.claude/skills/x/SKILL.md')), null);
    const reason = denied(write(join(link, '.claude/skills/y/SKILL.md')));
    assert.ok(reason.includes(skill('y')), reason);
  });

  it('F837-1: a symlinked prompt dir, inside or outside the project, and its real path are gated', () => {
    const shared = join(base, `shared${seq}`);
    mkdirSync(shared);
    symlinkSync(shared, join(project, '.claude/skills'));
    const outside = denied(write(skill('x')));
    assert.ok(outside.includes(join(shared, 'x/SKILL.md')), outside);
    denied(write(join(shared, 'y/SKILL.md')));
    approve(join(shared, 'x/SKILL.md'), 'full');
    assert.equal(write(skill('x')), null);

    const libAgents = join(project, 'lib-agents');
    mkdirSync(libAgents);
    writeFileSync(join(libAgents, 'a.md'), AGENT);
    rmSync(join(project, '.claude/agents'), { recursive: true });
    symlinkSync(libAgents, join(project, '.claude/agents'));
    denied(write(agentPath('a')));
    denied(write(join(libAgents, 'a.md')));
    approve(join(libAgents, 'a.md'), 'skills-array');
    assert.equal(run('Edit', { file_path: agentPath('a'), old_string: '  - one\n', new_string: '  - one\n  - two\n' }), null);
    assert.match(denied(run('Edit', { file_path: agentPath('a'), old_string: 'Body line.', new_string: 'Other.' })), /skills-array/);
    assert.match(denied(run('Edit', { file_path: join(libAgents, 'a.md'), old_string: 'Body line.', new_string: 'Other.' })), /skills-array/);
  });

  it('F837-1: a symlinked skill entry is gated through its real path', () => {
    const vendor = join(project, 'vendor/x');
    mkdirSync(vendor, { recursive: true });
    mkdirSync(join(project, '.claude/skills'), { recursive: true });
    symlinkSync(vendor, join(project, '.claude/skills/x'));
    denied(write(join(vendor, 'SKILL.md')));
    assert.equal(write(join(project, 'vendor/other.md')), null);
  });

  it('F837-1: a letter-case spelling of the prompt dirs or the root is gated', () => {
    mkdirSync(join(project, '.claude/skills'), { recursive: true });
    denied(write(join(project, '.Claude/Skills/x/SKILL.md')));
    denied(run('Edit', { file_path: join(project, '.CLAUDE/AGENTS/a.md'), old_string: 'Body', new_string: 'B' }));
    denied(write(join(project.toUpperCase(), '.claude/skills/x/SKILL.md')));
    assert.equal(write(join(project, '.claude/skillset/x.md')), null);
  });

  it('SC3: a skills-array approval allows an Edit that only appends to skills:, denies one that changes the body', () => {
    approve(agentPath('a'), 'skills-array');
    assert.equal(run('Edit', { file_path: agentPath('a'), old_string: '  - one\n', new_string: '  - one\n  - two\n' }), null);
    const reason = denied(run('Edit', { file_path: agentPath('a'), old_string: 'Body line.', new_string: 'Other.' }));
    assert.match(reason, /skills-array/);
    denied(run('Edit', { file_path: agentPath('a'), old_string: 'name: a', new_string: 'name: z' }));
  });

  it('skills-array: the inline form, Write, MultiEdit and replace_all are judged on the post-edit text', () => {
    approve(agentPath('a'), 'skills-array');
    approve(agentPath('b'), 'skills-array');
    assert.equal(run('Edit', { file_path: agentPath('b'), old_string: 'skills: [one]', new_string: 'skills: [one, two]' }), null);
    assert.equal(run('Write', { file_path: agentPath('a'), content: AGENT.replace('  - one\n', '  - one\n  - two\n') }), null);
    denied(run('Write', { file_path: agentPath('a'), content: AGENT.replace('Body line.', 'New.') }));
    assert.equal(run('MultiEdit', { file_path: agentPath('a'), edits: [{ old_string: '  - one\n', new_string: '  - one\n  - two\n' }, { old_string: '  - two\n', new_string: '  - two\n  - three\n' }] }), null);
    denied(run('MultiEdit', { file_path: agentPath('a'), edits: [{ old_string: '  - one\n', new_string: '  - one\n  - two\n' }, { old_string: 'Body', new_string: 'Bad' }] }));
    denied(run('Edit', { file_path: agentPath('a'), old_string: 'e', new_string: 'E', replace_all: true }));
    assert.equal(run('Edit', { file_path: agentPath('a'), old_string: 'one', new_string: 'uno', replace_all: true }), null);
  });

  it('skills-array: an Edit whose old_string is absent is left to the tool, and a skill path is not diffed', () => {
    approve(agentPath('a'), 'skills-array');
    assert.equal(run('Edit', { file_path: agentPath('a'), old_string: 'not there', new_string: 'x' }), null);
    approve(skill('x'), 'skills-array');
    assert.equal(write(skill('x')), null);
  });

  it('a scope other than full or skills-array is held to the skills list', () => {
    approve(agentPath('a'), 'everything');
    denied(run('Edit', { file_path: agentPath('a'), old_string: 'Body line.', new_string: 'Other.' }));
  });

  it('SC4: a swe, a path outside the prompt dirs and a non-edit tool are allowed', () => {
    assert.equal(write(skill('x'), { agent_type: 'tmb:swe', agent_id: 'a1' }), null);
    assert.equal(write(join(project, 'docs/x.md')), null);
    assert.equal(write(join(project, '.claude/settings.md')), null);
    assert.equal(write(join(base, 'elsewhere/.claude/skills/x/SKILL.md')), null);
    assert.equal(run('Read', { file_path: skill('x') }), null);
    assert.equal(run('NotebookEdit', { notebook_path: skill('x') }), null);
  });

  it('SC4: a missing DB or no sqlite denies, failing closed', () => {
    approve(skill('x'), 'full');
    const reason = denied(write(skill('x'), {}, env({ TRAJECTORY_DB_PATH: join(base, 'nowhere/trajectory.db') })));
    assert.match(reason, /trajectory DB is unavailable/);
    denied(write(skill('x'), {}, env({ TMB_HOOKS_SQLITE: 'cli', PATH: join(base, 'empty-path') })));
  });

  describe('Bash (GH 2942)', () => {
    const bash = async (command: string, extra: object = {}, runEnv: NodeJS.ProcessEnv = env()): Promise<Output | null> => {
      const r = await promptWriteApproval(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash', tool_input: { command }, ...extra }), runEnv);
      assert.equal(r.code, 0);
      return r.stdout.trim() === '' ? null : (JSON.parse(r.stdout) as Output);
    };
    const noDb = (): NodeJS.ProcessEnv => env({ TRAJECTORY_DB_PATH: join(base, 'nowhere/trajectory.db') });
    const WRITES = [
      'echo x > .claude/skills/x/SKILL.md',
      'cp /etc/hosts .claude/skills/x/SKILL.md',
      'echo x | tee .claude/skills/x/SKILL.md',
      "sed -i '' s/a/b/ .claude/skills/x/SKILL.md",
    ];

    it('runs in the PreToolUse Bash router group', () => {
      assert.ok(routerGates('PreToolUse', 'Bash').some((g) => g.name === GATE_NAME && g.kind === 'enforcement'));
    });

    it('SC1: denies a redirect, cp, tee and sed -i into a project skill with no approval, naming the canonical path', async () => {
      for (const command of WRITES) {
        const reason = denied(await bash(command));
        assert.ok(reason.includes(skill('x')), `${command}: ${reason}`);
        assert.match(reason, /prompt_write_approved/);
      }
    });

    it('SC2: allows each with a fresh full approval, and a skills-array approval alone does not', async () => {
      approve(skill('x'), 'full');
      for (const command of WRITES) assert.equal(await bash(command), null, command);
      approve(agentPath('a'), 'skills-array');
      assert.match(denied(await bash(`echo '  - two' >> ${agentPath('a')}`)), /skills-array/);
    });

    it('SC1: a case-variant spelling, a non-.md file and a worktree copy are gated', async () => {
      mkdirSync(join(project, '.claude/skills'), { recursive: true });
      denied(await bash('echo x > .Claude/Skills/foo/SKILL.md'));
      denied(await bash('echo x > .claude/skills/foo/scripts/run.py'));
      const copy = join(project, 'plugin/.claude/worktrees/w/.claude/skills/foo/SKILL.md');
      assert.ok(denied(await bash(`echo x > ${copy}`)).includes(copy));
    });

    it('two gated targets need both approved', async () => {
      approve(skill('x'), 'full');
      const reason = denied(await bash('echo x | tee .claude/skills/x/SKILL.md .claude/skills/y/SKILL.md'));
      assert.ok(reason.includes(skill('y')), reason);
      approve(skill('y'), 'full');
      assert.equal(await bash('echo x | tee .claude/skills/x/SKILL.md .claude/skills/y/SKILL.md'), null);
    });

    it('SC3: a write elsewhere and a read need no DB; a swe is exempt', async () => {
      assert.equal(await bash('echo x > docs/x.md', {}, noDb()), null);
      assert.equal(await bash(`cat ${skill('x')}`, {}, noDb()), null);
      assert.equal(await bash('echo x > docs/x.md', {}, env({ TMB_HOOKS_SQLITE: 'cli', PATH: join(base, 'empty-path') })), null);
      assert.equal(await bash('echo x > .claude/skills/x/SKILL.md', { agent_type: 'tmb:swe', agent_id: 'a1' }), null);
    });

    it('fails closed on a gated target with no DB', async () => {
      approve(skill('x'), 'full');
      assert.match(denied(await bash('echo x > .claude/skills/x/SKILL.md', {}, noDb())), /trajectory DB is unavailable/);
    });

    describe('a write naming only an ancestor of the prompt dirs (GH 2981)', () => {
      const ANCESTOR_WRITES: [string, () => string][] = [
        ['cp -r x/skills .claude/', () => join(project, '.claude')],
        ['rsync -a src/ .claude/', () => join(project, '.claude')],
        ['git checkout HEAD~1 -- .claude/skills', () => join(project, '.claude/skills')],
        ['tar -x -f a.tar -C .claude', () => join(project, '.claude')],
        ['cp -r foo/.claude .', () => project],
        ['tar -xf a.tar', () => project],
      ];
      const UNGATED = ['git commit -m x', 'mkdir build', 'cp a.txt .', 'cp -r src/ lib/', 'tar -x -f a.tar -C build', 'rsync -a src/ dist/', 'git checkout HEAD -- src/a.ts', 'git checkout main', 'make -C .', 'npm --prefix . install'];

      it('SC1: denies each with no approval, naming the canonical ancestor target', async () => {
        for (const [command, target] of ANCESTOR_WRITES) {
          const reason = denied(await bash(command));
          assert.ok(reason.includes(`for the project skill/agent write to ${target()}.`), `${command}: ${reason}`);
          assert.ok(reason.includes(JSON.stringify({ path: target(), scope: 'full' })), `the fix names the path to approve: ${reason}`);
        }
      });

      it('SC2: allows each with a fresh full approval of its target; a skills-array approval gets the shell-scope reason', async () => {
        for (const [command, target] of ANCESTOR_WRITES) {
          approve(target(), 'skills-array');
          assert.match(denied(await bash(command)), /scoped "skills-array", not "full"/, command);
          approve(target(), 'full');
          assert.equal(await bash(command), null, command);
        }
      });

      it('SC3: a write elsewhere, or one naming the root that lands no tree there, reads no DB', async () => {
        for (const command of UNGATED) assert.equal(await bash(command, {}, noDb()), null, command);
      });

      it('gates every write naming a .claude dir, a tree landing above the project, a tree mv, a git restore of the whole tree or into a prompt dir, and an interpreter copy', async () => {
        for (const command of ['mkdir .claude', 'cp a.txt .claude/agents', 'cp -r x/.Claude/Skills .CLAUDE/', 'mv foo/.claude .', `cp -r foo ${dirname(project)}`, 'git checkout HEAD -- .', 'git restore --source HEAD~1 .claude', "git checkout HEAD -- '*.md'", 'git checkout HEAD -- .claude/skills/x/SKILL.md', 'cat a.tar | tar -x', 'D=.; cp -r foo/.claude $D', 'python3 -c "import shutil; shutil.copytree(\'x\', \'.\')"']) {
          denied(await bash(command));
        }
        assert.equal(await bash('git restore --staged .claude', {}, noDb()), null);
      });

      it('gates a tree landing in a dir a symlinked skill entry resolves into', async () => {
        mkdirSync(join(project, 'vendor/x'), { recursive: true });
        mkdirSync(join(project, '.claude/skills'), { recursive: true });
        symlinkSync(join(project, 'vendor/x'), join(project, '.claude/skills/x'));
        assert.ok(denied(await bash('cp -r y/x vendor/')).includes(join(project, 'vendor')));
        assert.equal(await bash('cp -r y/x other/', {}, noDb()), null);
      });

      it('SC4: a swe stays exempt', async () => {
        for (const [command] of ANCESTOR_WRITES) assert.equal(await bash(command, { agent_type: 'tmb:swe', agent_id: 'a1' }, noDb()), null, command);
      });

      describe('a top-anchored pathspec resolves against the repository top (F876-1)', () => {
        const TOP_WRITES = ['git checkout HEAD -- :/.claude/skills', "git checkout HEAD -- ':(top).claude'", "git restore -- ':(top,glob).claude/**'", 'git checkout HEAD -- ":(glob,top).claude/**"', 'git checkout HEAD -- :/', "git checkout HEAD -- ':(exclude)x'", 'git checkout HEAD -- :/!x', 'git checkout --pathspec-from-file=f HEAD'];
        const fromSrc = (): object => ({ cwd: join(project, 'src') });

        beforeEach(() => mkdirSync(join(project, 'src'), { recursive: true }));

        it('SC6: denies each from <root>/src with no approval, and allows a top pathspec elsewhere with no DB read', async () => {
          for (const command of TOP_WRITES) denied(await bash(command, fromSrc()));
          assert.ok(denied(await bash(TOP_WRITES[0], fromSrc())).includes(join(project, '.claude/skills')));
          for (const command of ['git checkout HEAD -- :/src/a.ts', "git checkout HEAD -- ':(top)src'", 'git checkout HEAD -- a.ts']) assert.equal(await bash(command, fromSrc(), noDb()), null, command);
        });

        it('SC6: finds the top from the nearest .git, the cwd or a git -C dir', async () => {
          mkdirSync(join(project, '.git'));
          mkdirSync(join(project, 'src/deep'), { recursive: true });
          denied(await bash('git checkout HEAD -- :/.claude', { cwd: join(project, 'src/deep') }));
          denied(await bash('git -C src restore --source HEAD~1 :/'));
          denied(await bash('cd src && git checkout HEAD -- :/'));
          assert.equal(await bash('git -C src restore --source HEAD~1 :/src', {}, noDb()), null);
        });

        it('SC6: fails closed when git is told where the repository is', async () => {
          for (const command of ['GIT_DIR=x git checkout -- :/src', 'git --git-dir=x checkout -- :/src', 'git --work-tree=.. checkout -- .']) denied(await bash(command, fromSrc()));
          denied(await bash('git checkout -- :/src', fromSrc(), env({ GIT_WORK_TREE: join(project, 'src') })));
        });

        it('F876-1: the review probe commands are denied', async () => {
          for (const [command, cwd] of [
            ['git checkout HEAD -- :/', 'sub'],
            ['git checkout HEAD -- :(top).claude', 'sub'],
            ['git checkout HEAD -- :/.claude/skills', 'sub'],
            ['git -C sub restore --source HEAD~1 :/', ''],
          ]) {
            mkdirSync(join(project, 'sub'), { recursive: true });
            for (const runEnv of [env(), noDb()]) denied(await bash(command, { cwd: join(project, cwd), agent_type: 'tmb:code-reviewer', agent_id: 'z' }, runEnv));
          }
        });
      });

      describe('a command that does not parse (F876-4)', () => {
        const TRAILER = '\necho "unterminated';
        const NAMES_CLAUDE = [
          'git checkout HEAD -- :(top).claude',
          'echo $(( > .Claude/x',
          'echo $(( > ".cl"a\\ude/x',
          "cp -r x $'.CLAUDE' $(",
          ...["cp -r x/skills .cl$'a'ude/", "cp -r x/skills $'\\x2e'claude/", "cp -r x/skills $'\\056claude'/", 'cp -r x/skills $"x"/', 'cp -r x/skills .c*/', 'cp -r x/skills .[cC]laude/', 'cp -r x/skills .$X/', 'cp -r x/skills x/.{a,b}/'].map((c) => c + TRAILER),
        ];
        const UNPARSED = [...NAMES_CLAUDE, 'echo "unterminated', 'ls $(', `cp -r x/skills build/${TRAILER}`, `cat a.txt b.md > out.log${TRAILER}`];
        const standAside = (): NodeJS.ProcessEnv[] => [noDb(), env({ TMB_HOOKS_SQLITE: 'cli', PATH: join(base, 'empty-path') })];

        it('SC9: with a trajectory DB it is denied, since nothing it writes can be told', async () => {
          for (const command of UNPARSED) assert.match(denied(await bash(command)), /cannot be judged: the command could not be parsed/, command);
        });

        it('SC9, F876-7: with no DB or no sqlite it is denied when its text may name .claude: any case or quoting, ANSI-C or locale quoting, or a dot with a glob, brace or $ after it', async () => {
          for (const runEnv of standAside()) {
            for (const command of NAMES_CLAUDE) assert.match(denied(await bash(command, {}, runEnv)), /trajectory DB is unavailable/, command);
          }
        });

        it('SC9: with no DB or no sqlite any other gets containment-guard\'s decision', async () => {
          for (const runEnv of standAside()) {
            for (const command of UNPARSED.filter((c) => !NAMES_CLAUDE.includes(c))) {
              const payload = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash', tool_input: { command }, agent_type: 'tmb:code-reviewer', agent_id: 'z' });
              const contained = await containmentGuard(payload, runEnv);
              assert.deepEqual(await promptWriteApproval(payload, runEnv), contained, command);
              assert.equal(contained.stdout.trim(), '', `containment-guard stands aside: ${command}`);
            }
          }
        });

        it('SC4: a swe stays exempt', async () => {
          for (const command of UNPARSED) assert.equal(await bash(command, { agent_type: 'tmb:swe', agent_id: 'a1' }), null, command);
        });
      });

      describe('a mv into the root (F876-2)', () => {
        it('SC7: denies a mv landing a .claude dir, in any letter case, and a mv into a prompt dir', async () => {
          for (const command of ['mv x/.claude .', 'mv x/.Claude .', 'mv a.md .claude/skills/', 'mv -t . x/.claude', 'git mv x/.claude .', 'mv x/.c* .', 'mv -T x/skills .claude']) denied(await bash(command));
        });

        it('SC7: allows any other mv into the root with no DB read', async () => {
          for (const command of ['mv a.txt .', 'mv src/ .', 'mv src/*.ts .', 'git mv a.txt .', 'mv -T src lib']) assert.equal(await bash(command, {}, noDb()), null, command);
        });
      });

      describe('a brace source of a mv into the root (F876-3)', () => {
        it('SC8: denies a mv or git mv whose brace alternatives name .claude, in any case, nested or with a prefix', async () => {
          for (const command of [
            'mv x/{.claude,a} .',
            'mv x/{a,.Claude} .',
            'mv x/.{claude,b} .',
            'git mv x/{.claude,a} .',
            'mv x/{a,{b,.claude}} .',
            'mv {x/.claude,y} .',
            'mv x/.{c,d}{l,m}aude .',
            'mv x/.{a..c}laude .',
          ]) {
            denied(await bash(command));
          }
          // A mv also removes its source, and an x/.claude dir is gated in its own right; approved, the landing in the root is left.
          for (const source of ['x/.claude', 'x/.Claude']) approve(join(project, source), 'full');
          for (const command of ['mv x/{.claude,a} .', 'mv x/{a,.Claude} .', 'mv x/.{claude,b} .', 'git mv x/{.claude,a} .', 'mv x/.{a..c}laude .']) {
            const reason = denied(await bash(command));
            assert.ok(reason.toLowerCase().includes(`write to ${join(project, '.claude')}.`.toLowerCase()), `${command}: ${reason}`);
          }
        });

        it('SC8, SC11: a mv source expanding past what can be listed fails closed for that source alone', async () => {
          for (const command of ['mv x/{1..9999} .', 'mv x/{1..9999} .claude/skills/', 'mv a.txt x/{1..9999} .']) denied(await bash(command));
          assert.ok(denied(await bash('mv x/{1..9999} .')).includes(`write to ${join(project, '.claude*')}.`));
          for (const command of ['mv x/{1..9999} build/', 'mv -t build/ x/{1..9999}', 'git mv x/{1..9999} build/', 'mv a.txt {1..9999}', 'cp -r src {1..9999}', 'mkdir -p out/{1..9999}', 'git checkout HEAD -- src/{1..9999}']) {
            assert.equal(await bash(command, {}, noDb()), null, command);
          }
        });

        it('SC11, F876-6: a command that writes nothing has no word brace-expanded, so it reads no DB', async () => {
          const objects = `[${Array(13).fill('{"id":1,"ok":true}').join(',')}]`;
          for (const command of ['echo {1..5000}', 'printf "%s\\n" {1..5000}', "printf '%s\\n' {a,b}{c,d}", `jq -n '${objects}'`, `curl -d '${objects}' https://api.example.com/items`, 'echo {1..99}{1..99}']) {
            for (const agent of [{}, { agent_type: 'tmb:code-reviewer', agent_id: 'z' }]) assert.equal(await bash(command, agent, noDb()), null, command);
          }
        });

        it('SC8: a brace in the destination, a tar -C or a git pathspec expands as bash passes it', async () => {
          for (const command of ['mv x/skills {.claude,}', 'cp -r x/skills {.claude,}', 'tar -x -f a.tar -C {.claude,b}', 'git checkout HEAD -- {.claude,src}', 'mkdir {.claude,b}']) {
            denied(await bash(command));
          }
        });

        it('SC8: allows a brace mv with no .claude alternative, and a literal brace, with no DB read', async () => {
          for (const command of ['mv x/{a,b} .', 'git mv x/{a,b} .', 'mv x/{.claude} y/', 'mv x/{a,b .', 'cp -r src/{a,b} lib/', 'mkdir {a,b}']) assert.equal(await bash(command, {}, noDb()), null, command);
        });
      });

      describe('a brace word past the limit that may leave its stem, and a tee or redirect target (GH 2994)', () => {
        const reviewer = { agent_type: 'tmb:code-reviewer', agent_id: 'z' };

        it('SC1: denies a tree write whose overflowing word climbs out with .., naming the root .claude dir to approve', async () => {
          for (const command of ['git checkout -- z/{1..5000}/../../{a,.claude}{,x}', 'cp -r src z/{1..5000}/../../{a,.claude}', 'git checkout -- z/{a,{1..5000},/../..,b}', 'mv {/,a}{1..5000} .']) {
            const reason = denied(await bash(command, reviewer));
            assert.ok(reason.includes(`write to ${join(project, '.claude')}.`), `${command}: ${reason}`);
            assert.ok(reason.includes(JSON.stringify(join(project, '.claude'))), `${command}: ${reason}`);
          }
          approve(join(project, '.claude'), 'full');
          for (const command of ['git checkout -- z/{1..5000}/../../{a,.claude}{,x}', 'cp -r src z/{1..5000}/../../{a,.claude}']) assert.equal(await bash(command, reviewer), null, command);
        });

        it('SC2: an overflowing word with no .. keeps its stand-in, and a command that writes nothing reads no DB', async () => {
          for (const command of ['echo {1..5000}', 'mv x/{1..5000} build/', 'cp -r src build/{1..5000}', 'echo x | tee build/{1..5000}.log', 'echo x > build/{1..5000}.log']) {
            assert.equal(await bash(command, reviewer, noDb()), null, command);
          }
        });

        it('SC3: denies a tee or redirect target past the limit that names or climbs into a prompt dir', async () => {
          for (const command of [
            'echo x | tee z/{1..5000}/../../.claude/skills/a.md',
            'echo x > z/{1..5000}/../../.claude/agents/{a,b}.md',
            'echo x >> z/{1..5000}/../../.claude/skills/a.md',
            'echo x &> z/{1..5000}/../../.claude/skills/a.md',
            'echo x >| z/{1..5000}/../../.claude/skills/a.md',
            'echo x > {.claude/skills/{1..5000},b}/../q',
            'echo x | tee -a {.claude/skills/{1..5000},b}/../q',
            'rm -rf {a,.claude,{1..5000}}',
            'echo x | tee {a,.claude/skills/x,{1..5000}}',
          ]) {
            denied(await bash(command, reviewer));
          }
        });

        it('SC3: a .. after a brace resolves per expanded word, below the limit too', async () => {
          for (const command of ['echo x > {.claude/skills/a,b}/../q', 'echo x | tee {.claude/agents/a,b}/../q.md', 'cp a {.claude/skills/a,b}/../q']) {
            const reason = denied(await bash(command, reviewer));
            assert.match(reason, /\.claude\/(skills|agents)\/q/, `${command}: ${reason}`);
          }
        });

        it('SC4: swe stays exempt', async () => {
          for (const command of ['git checkout -- z/{1..5000}/../../{a,.claude}{,x}', 'echo x | tee z/{1..5000}/../../.claude/skills/a.md', 'echo x > {.claude/skills/{1..5000},b}/../q']) {
            assert.equal(await bash(command, { agent_type: 'tmb:swe', agent_id: 'a1' }, noDb()), null, command);
          }
        });
      });

      describe('a glob source of a mv into the root (F876-5)', () => {
        it('SC10: a glob does not match a leading dot, so these read no DB', async () => {
          for (const command of ['mv build/* .', 'mv src/*.ts .', 'mv x/?claude .', 'mv x/[.]claude .', 'mv x/[!a]claude .']) assert.equal(await bash(command, {}, noDb()), null, command);
        });

        it('SC10: a glob starting with a literal dot, an extglob, or dotglob / GLOB_DOTS named in the command is gated', async () => {
          for (const command of ['mv x/.c* .', 'mv x/.[cC]laude .', 'mv x/.?laude .', 'mv x/@(.claude) .', 'shopt -s dotglob; mv x/* .', 'GLOBIGNORE=x; mv x/* .', 'setopt globdots; mv x/* .']) {
            denied(await bash(command));
          }
          assert.equal(await bash('mv x/a* .', {}, noDb()), null);
        });
      });
    });

    describe('an unzip extracts a tree (GH 2987)', () => {
      it('SC1: denies an unzip into the root, into .claude and into .claude/skills, naming the target', async () => {
        for (const [command, target] of [
          ['unzip a.zip', project],
          ['unzip a.zip -d .claude', join(project, '.claude')],
          ['unzip -o a.zip -d .claude/skills', join(project, '.claude/skills')],
          ['unzip -d.claude a.zip x/y', join(project, '.claude')],
        ]) {
          assert.ok(denied(await bash(command)).includes(`write to ${target}.`), command);
        }
      });

      it('SC1: allows an unzip into another dir and a list-only unzip with no DB read', async () => {
        for (const command of ['unzip a.zip -d build', 'unzip -l a.zip', 'unzip -Z a.zip', 'unzip -t a.zip', 'unzip -p a.zip x > build/x']) {
          assert.equal(await bash(command, {}, noDb()), null, command);
        }
      });
    });

    describe('a git move that rewrites the work tree (GH 2987)', () => {
      const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: join(base, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: gitEnv() });
      const put = (rel: string, text: string): void => {
        mkdirSync(dirname(join(project, rel)), { recursive: true });
        writeFileSync(join(project, rel), text);
      };
      const commitAll = (cwd: string, message: string): void => {
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-q', '-m', message);
      };
      const skills = (): string => join(project, '.claude/skills');
      // With no git on PATH and no DB, an allow proves the gate ran no git query and read no DB.
      const noGitNoDb = (): NodeJS.ProcessEnv => env({ TRAJECTORY_DB_PATH: join(base, 'nowhere/trajectory.db'), PATH: join(base, 'empty-path') });
      const TO_B = ['git checkout b', 'git switch b', 'git merge b', 'git reset --hard b'];

      beforeEach(() => {
        put('.gitignore', '.claude/tmb/\n');
        put('.claude/skills/s.md', 'v1\n');
        put('.claude/agents/a.md', 'v1\n');
        put('src/x.ts', '1\n');
        git(project, 'init', '-q');
        commitAll(project, 'base');
        git(project, 'checkout', '-q', '-b', 'b');
        put('.claude/skills/s.md', 'v2\n');
        commitAll(project, 'skill');
        git(project, 'checkout', '-q', '-b', 'c', 'main');
        put('src/x.ts', '2\n');
        commitAll(project, 'src');
        git(project, 'checkout', '-q', '-b', 'd', 'main');
        git(project, 'mv', '.claude/skills/s.md', 'docs.md');
        commitAll(project, 'move a skill out');
        git(project, 'checkout', '-q', 'main');
      });

      it('SC2: denies a checkout, switch, merge and reset --hard to a branch changing a skill, naming the skills dir', async () => {
        for (const command of [...TO_B, 'git checkout d']) {
          const reason = denied(await bash(command));
          assert.ok(reason.includes(`write to ${skills()}.`), `${command}: ${reason}`);
        }
      });

      it('SC2: allows each with a fresh full approval of the skills dir', async () => {
        approve(skills(), 'skills-array');
        assert.match(denied(await bash(TO_B[0])), /scoped "skills-array", not "full"/);
        approve(skills(), 'full');
        for (const command of TO_B) assert.equal(await bash(command), null, command);
      });

      it('SC2: allows a move to a branch changing only src/ with no DB read', async () => {
        for (const command of ['git checkout c', 'git switch c', 'git merge c', 'git reset --hard c', 'git -C src checkout c', 'cd src && git merge c', 'git merge c > build.log 2>&1', 'git checkout c </dev/null']) {
          assert.equal(await bash(command, {}, noDb()), null, command);
        }
      });

      it('SC3: a stash pop or apply is judged on the paths the stash changes', async () => {
        put('.claude/agents/a.md', 'changed\n');
        git(project, 'stash', 'push', '-q');
        put('src/x.ts', '3\n');
        git(project, 'stash', 'push', '-q');
        for (const command of ['git stash pop stash@{1}', 'git stash apply stash@{1}']) {
          assert.ok(denied(await bash(command)).includes(join(project, '.claude/agents')), command);
        }
        for (const command of ['git stash pop', 'git stash apply stash@{0}']) assert.equal(await bash(command, {}, noDb()), null, command);
      });

      it('SC3: a reset --hard or forced checkout is judged on the work tree changes it drops', async () => {
        put('.claude/skills/s.md', 'dirty\n');
        for (const command of ['git reset --hard', 'git checkout -f c', 'git switch --discard-changes c']) assert.ok(denied(await bash(command)).includes(skills()), command);
        git(project, 'checkout', '--', '.claude/skills/s.md');
        put('src/x.ts', 'dirty\n');
        for (const command of ['git reset --hard', 'git checkout -f c']) assert.equal(await bash(command, {}, noDb()), null, command);
      });

      it('SC4: a cherry-pick or revert is judged on the paths each commit changes', async () => {
        for (const command of ['git cherry-pick b', 'git revert b', 'git cherry-pick c b']) assert.ok(denied(await bash(command)).includes(skills()), command);
        for (const command of ['git cherry-pick c', 'git revert c', 'git cherry-pick -x c']) assert.equal(await bash(command, {}, noDb()), null, command);
      });

      it('SC4: a move whose changes cannot be told before it runs is denied, pointing to git fetch then git merge', async () => {
        for (const command of [
          'git pull',
          'git pull --rebase origin main',
          'git rebase main',
          'git am x.patch',
          'git apply x.patch',
          'git checkout no-such-ref',
          'git cherry-pick main..c',
          'git merge -- -x',
          'git fetch && git merge c',
          'git checkout $REF',
          'git checkout "$REF"',
          'git checkout $(echo c)',
          'git -C $(pwd) checkout c',
          'git --work-tree=. checkout c',
          '$G checkout c',
          '$(which git) checkout c',
          'echo "git checkout c" | sh',
          "python3 -c \"import os; c='git checkout c'; os.system(c)\"",
          'find . -maxdepth 0 -execdir git checkout c \\;',
          'echo c | xargs git stash pop',
        ]) {
          const reason = denied(await bash(command));
          assert.match(reason, /`git fetch`, then `git merge <ref>`/, command);
          assert.ok(reason.includes(join(project, '.claude')), command);
        }
        denied(await bash('git checkout c', {}, env({ GIT_DIR: join(project, '.git') })));
      });

      it('SC4: an unresolvable move is allowed with a full approval of the .claude dir', async () => {
        approve(join(project, '.claude'), 'full');
        for (const command of ['git pull', 'git rebase main']) assert.equal(await bash(command), null, command);
      });

      it('SC5: in a sibling repo holding no prompt dir, a move runs no git and reads no DB', async () => {
        const sub = join(project, 'sub');
        mkdirSync(sub);
        writeFileSync(join(sub, 'f'), '1\n');
        git(sub, 'init', '-q');
        commitAll(sub, 'base');
        git(sub, 'branch', 'b');
        for (const command of ['git pull', 'git checkout b', 'git reset --hard', 'git rebase main']) {
          assert.equal(await bash(command, { cwd: sub }, noGitNoDb()), null, command);
        }
        for (const command of ['git -C sub pull', 'cd sub && git checkout b', 'git -C sub fetch && git -C sub merge b']) assert.equal(await bash(command, {}, noGitNoDb()), null, command);
        for (const cwd of [project, sub]) {
          for (const command of ['git checkout -b new', 'git switch -c new', 'git stash list', 'git stash show', 'git stash push', 'git merge --abort', 'git reset --soft HEAD~1', 'git reset --mixed', 'git apply --check x.patch', 'git status']) {
            assert.equal(await bash(command, { cwd }, noGitNoDb()), null, `${cwd}: ${command}`);
          }
        }
      });

      it('SC5: a checkout of named paths keeps its pathspec judgement', async () => {
        assert.equal(await bash('git checkout b -- src/x.ts', {}, noDb()), null);
        assert.ok(denied(await bash('git checkout b -- .claude/skills/s.md')).includes(join(project, '.claude/skills/s.md')));
      });

      it('SC6: a swe stays exempt', async () => {
        for (const command of [...TO_B, 'git pull', "watch 'git checkout b'"]) assert.equal(await bash(command, { agent_type: 'tmb:swe', agent_id: 'a1' }, noGitNoDb()), null, command);
      });

      describe('a move another command runs', () => {
        it('SC7: denies a move, or an unzip, that find, fd, xargs, a wrapper or a shell body runs', async () => {
          for (const command of [
            'find . -maxdepth 0 -exec git checkout b \\;',
            'find . -maxdepth 0 -execdir git reset --hard b \\;',
            'find . -maxdepth 0 -ok git merge b \\;',
            'find . -maxdepth 0 -exec git pull \\;',
            'echo b | xargs git checkout',
            'echo b | xargs git switch',
            'echo b | xargs git checkout 2>/dev/null',
            'xargs git merge <<< b',
            'xargs -I % git merge % <<< b',
            'xargs -I{} git checkout {} <<< b',
            'xargs -0 -n1 git checkout <<< b',
            'env git checkout b',
            "sh -c 'git checkout b'",
            "find . -maxdepth 0 -exec sh -c 'git checkout b' \\;",
            "find . -maxdepth 0 -exec sh -c 'git checkout \"$0\"' {} \\;",
            'sudo find . -maxdepth 0 -exec git checkout b \\;',
            'command xargs git checkout <<< b',
            'find . -maxdepth 0 -exec git stash pop \\;',
            'git fetch && find . -maxdepth 0 -exec git checkout c \\;',
            'find . -name a.zip -exec unzip {} -d .claude \\;',
            'watch git checkout b',
            'watch -n1 git checkout b',
            'timeout 5 watch git merge b',
            'watch -n 1 git pull',
            '/usr/bin/git checkout b',
            '/usr/bin/git pull',
            'env /usr/bin/git reset --hard b',
            'find . -maxdepth 0 -exec /usr/bin/git checkout b \\;',
            './git checkout b',
            'echo $(git checkout b)',
            "python3 -c \"import os; os.system('git checkout b')\"",
          ]) {
            denied(await bash(command));
          }
          assert.ok(denied(await bash('/usr/bin/git checkout b')).includes(`write to ${skills()}.`));
          assert.ok(denied(await bash('watch git checkout b')).includes(`write to ${skills()}.`));
          assert.ok(denied(await bash('find . -maxdepth 0 -exec git checkout b \\;')).includes(`write to ${skills()}.`));
        });

        it('SC7: a resolvable wrapped move that changes only src/ is allowed with no DB read, and a skill change with a full approval', async () => {
          for (const command of [
            'find . -maxdepth 0 -exec git checkout c \\;',
            'xargs -I % git merge c <<< x',
            '/usr/bin/git checkout c',
            'watch git checkout c',
            'watch -n 1 /usr/bin/git merge c',
            'cd src && /usr/bin/git -C .. checkout c',
            "bash -c 'git checkout c'",
          ]) {
            assert.equal(await bash(command, {}, noDb()), null, command);
          }
          approve(skills(), 'full');
          assert.equal(await bash('find . -maxdepth 0 -exec git checkout b \\;'), null);
        });

        it('SC7: a runner that starts no move runs no git and reads no DB', async () => {
          for (const command of ["find . -name '*.md' -exec cat {} \\;", 'echo x | xargs git log', 'find . -maxdepth 0 -exec git stash list \\;', "watch 'git status'"]) {
            assert.equal(await bash(command, {}, noGitNoDb()), null, command);
          }
        });

        it('SC7: a runner that may repeat a stash pop or apply cannot tell which stash it takes', async () => {
          put('src/x.ts', '3\n');
          git(project, 'stash', 'push', '-q');
          assert.equal(await bash('git stash pop', {}, noDb()), null);
          for (const command of ['watch git stash pop', 'watch -n 5 git stash apply', 'for i in 1 2; do git stash pop; done', 'find . -maxdepth 0 -exec git stash pop \\;']) {
            assert.match(denied(await bash(command)), /more than once/, command);
          }
        });
      });

      describe('a git move behind watch quoting (F891-1)', () => {
        it('SC7: denies each move watch runs from a quoted or wrapped command', async () => {
          for (const command of [
            "watch 'git checkout b'",
            'watch "git checkout b"',
            "watch -n1 'git checkout b'",
            "watch -n 2 -- 'git checkout b'",
            "watch 'git pull'",
            "timeout 5 watch 'git merge b'",
            "nohup watch 'git checkout b'",
            'bash -c "watch \'git checkout b\'"',
          ]) {
            denied(await bash(command));
          }
          assert.ok(denied(await bash("watch 'git checkout b'")).includes(`write to ${skills()}.`));
        });

        it('SC7: allows a quoted watch of a move that changes only src/ with no DB read', async () => {
          assert.equal(await bash("watch 'git checkout c'", {}, noDb()), null);
        });
      });

      describe('a git move is found wherever a tree write is (SC8)', () => {
        const TREE_WRITE = 'cp -r /tmp/x .claude/skills/';
        const MOVE = 'git checkout b';
        // `%` stands for the command each runner runs.
        const RUNNERS = [
          '%',
          'sudo %',
          'env %',
          'env A=1 %',
          'command %',
          'nohup %',
          'time %',
          'exec %',
          'timeout 5 %',
          'gtimeout 5 %',
          'stdbuf -o0 %',
          'nice -n 5 %',
          'watch %',
          "watch '%'",
          'watch "%"',
          "watch -n1 '%'",
          "watch -n 2 -- '%'",
          "timeout 5 watch '%'",
          "nohup watch '%'",
          'bash -c "watch \'%\'"',
          "bash -c '%'",
          "sh -c '%'",
          "zsh -c '%'",
          "eval '%'",
          'bash -c "sh -c \'%\'"',
          'find . -maxdepth 0 -exec % \\;',
          'find . -maxdepth 0 -ok % \\;',
          "find . -maxdepth 0 -exec sh -c '%' \\;",
          'echo x | xargs -I @ %',
          'fd -x %',
          "sh <<< '%'",
          'for i in 1; do %; done',
          'if true; then %; fi',
          '(%)',
          '{ %; }',
          'true && %',
          '% &',
          'echo $(%)',
          "python3 -c \"import os; os.system('%')\"",
        ];

        it('SC8: each runner that the gate judges a tree write into .claude/skills behind also has its checkout of b denied', async () => {
          for (const runner of RUNNERS) {
            assert.equal((await bash(runner.replace('%', TREE_WRITE)))?.hookSpecificOutput?.permissionDecision, 'deny', runner);
            assert.ok(denied(await bash(runner.replace('%', MOVE))).includes(join(project, '.claude')), runner);
          }
        });

        it('SC8: shell text the analyzer cannot read is left to containment-guard for a tree write, and fails closed for a git move', async () => {
          const runner = "echo '%' | sh";
          assert.equal(await bash(runner.replace('%', TREE_WRITE), {}, noDb()), null);
          assert.match(denied(await bash(runner.replace('%', MOVE))), /`git fetch`, then `git merge <ref>`/);
        });
      });
    });

    it('SC4: leaves a never-judged target to containment-guard and denies the analyzer cap line', async () => {
      assert.equal(await bash('python3 -c "import os; open(os.environ[\'P\'], \'w\')"'), null);
      const padded = Array.from({ length: 20000 }, (_, i) => `cd d${i} && echo > f${i};`).join(' ');
      assert.match(denied(await bash(padded)), /analyzer stopped/);
    });
  });

  it('a relative file_path resolves against the payload cwd, else the project root', () => {
    denied(write('.claude/skills/x/SKILL.md'));
    denied(write('.claude/skills/x/SKILL.md', { cwd: undefined }));
    assert.equal(write('.claude/skills/x/SKILL.md', { cwd: join(base, 'elsewhere') }), null);
  });
});

describe('withoutSkillsEntry', () => {
  it('drops the block form with its items, indented or not', () => {
    assert.equal(withoutSkillsEntry(AGENT), '---\nname: a\ndescription: d\n---\nBody line.\n');
    assert.equal(withoutSkillsEntry('---\nskills:\n- a\n- b\nname: n\n---\n'), '---\nname: n\n---\n');
  });

  it('drops the inline form, one line or wrapped', () => {
    assert.equal(withoutSkillsEntry(INLINE_AGENT), '---\nname: b\n---\nBody line.\n');
    assert.equal(withoutSkillsEntry('---\nskills: [a,\n  b]\nname: n\n---\n'), '---\nname: n\n---\n');
  });

  it('leaves a body skills: line and a file with no frontmatter alone', () => {
    assert.equal(withoutSkillsEntry('---\nname: n\n---\nskills:\n  - a\n'), '---\nname: n\n---\nskills:\n  - a\n');
    assert.equal(withoutSkillsEntry('skills: [a]\n'), 'skills: [a]\n');
  });
});

describe('braceExpand (bash brace expansion)', () => {
  it('expands comma lists left to right, nested, with prefix and suffix', () => {
    assert.deepEqual(braceExpand('x/{.claude,a}'), ['x/.claude', 'x/a']);
    assert.deepEqual(braceExpand('{a,b}{c,d}'), ['ac', 'ad', 'bc', 'bd']);
    assert.deepEqual(braceExpand('x{a,{b,c}}y'), ['xay', 'xby', 'xcy']);
    assert.deepEqual(braceExpand('a{,}'), ['a', 'a']);
  });

  it('expands numeric and character sequences, padded and stepped', () => {
    assert.deepEqual(braceExpand('{1..3}'), ['1', '2', '3']);
    assert.deepEqual(braceExpand('{3..1}'), ['3', '2', '1']);
    assert.deepEqual(braceExpand('{01..3}'), ['01', '02', '03']);
    assert.deepEqual(braceExpand('{-1..1}'), ['-1', '0', '1']);
    assert.deepEqual(braceExpand('{a..e..2}'), ['a', 'c', 'e']);
    assert.deepEqual(braceExpand('{-../}x'), ['-x', '.x', '/x']);
  });

  it('leaves a brace with no comma or sequence, an unclosed one and a parameter literal', () => {
    assert.deepEqual(braceExpand('x{a}y{b,c}'), ['x{a}yb', 'x{a}yc']);
    assert.deepEqual(braceExpand('{a,b'), ['{a,b']);
    assert.deepEqual(braceExpand('{{a,b}'), ['{a', '{b']);
    assert.deepEqual(braceExpand('{a,b}}'), ['a}', 'b}']);
    assert.deepEqual(braceExpand('${a,b}'), ['${a,b}']);
    assert.deepEqual(braceExpand('{a..5}'), ['{a..5}']);
  });

  it('gives null past its limit', () => {
    assert.equal(braceExpand('{1..100000}'), null);
    assert.equal(braceExpand('{1..20}{1..20}{1..20}'), null);
  });

  it('braceEdge finds the first and last word without listing the rest', () => {
    assert.equal(braceEdge('x/{1..100000}', false), 'x/1');
    assert.equal(braceEdge('x/{1..100000}', true), 'x/100000');
    assert.equal(braceEdge('{01..10..3}', true), '10');
    assert.equal(braceEdge('{a,{b,c}}{1..9}y', true), 'c9y');
    assert.equal(braceEdge('{z..a..2}', true), 'b');
    assert.equal(braceEdge('${a,b}', true), '${a,b}');
  });

  it('braceWords stands a word past the limit as its first, a .claude glob under its stem, and its last', () => {
    assert.deepEqual(braceWords(['-t', 'd', 'x/{a,b}'], '/r/.claude'), ['-t', 'd', 'x/a', 'x/b']);
    assert.deepEqual(braceWords(['x/{1..9999}', 'build/'], '/r/.claude'), ['x/1', 'x/.claude*', 'x/9999', 'build/']);
    assert.deepEqual(braceWords(['--directory={1..9999}'], '/r/.claude'), ['--directory=1', '--directory=.claude*', '--directory=9999']);
    assert.deepEqual(braceWords(['{1..9999}'], '/r/.claude'), ['1', '.claude*', '9999']);
  });

  it('braceWords keeps the words between a word past the limit holds, each numeric sequence cut to its ends', () => {
    assert.deepEqual(braceWords(['{a,.claude,{1..5000}}'], '/r/.claude'), ['a', '.claude*', '.claude', '1', '5000']);
    assert.deepEqual(braceWords(['x/{a..c}{1..5000}'], '/r/.claude'), ['x/a1', 'x/.claude*', 'x/a5000', 'x/b1', 'x/b5000', 'x/c1', 'x/c5000']);
  });

  it('braceWords stands a word past the limit that may leave its stem as the unresolvable path, after its option prefix (GH 2994)', () => {
    assert.deepEqual(braceWords(['z/{1..5000}/../../{a,.claude}'], '/r/.claude'), ['z/1/../../a', '/r/.claude', 'z/5000/../../.claude']);
    assert.deepEqual(braceWords(['z/{a,{1..5000},/../..,b}'], '/r/.claude'), ['z/a', '/r/.claude', 'z/b']);
    assert.deepEqual(braceWords(['-Cz/{1..9999}/..'], '/r/.claude'), ['-Cz/1/..', '-C/r/.claude', '-Cz/9999/..']);
    assert.deepEqual(braceWords(['{/,a}{1..5000}'], '/r/.claude'), ['/1', '/r/.claude', 'a5000']);
    assert.deepEqual(braceWords(['x/{1..9999}$v'], '/r/.claude'), ['x/1$v', '/r/.claude', 'x/9999$v']);
    assert.deepEqual(braceWords(['x/{1..9999}/..x'], '/r/.claude'), ['x/1/..x', 'x/.claude*', 'x/9999/..x']);
  });
});
