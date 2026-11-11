/**
 * The swe-boundary l3 bash suite in node:test (GH 1692), rules (c), (d) and
 * (e): a swe Edit/Write stays in its worktree; the repo-root CLAUDE.md is
 * always denied and the other prompt-surface paths are denied unless the task
 * is prompt_bearing, for Edit/Write and Bash writes alike. Identity comes from
 * the spawn transcript, never the cwd (GH 1550).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  bashInput,
  bashWithTranscript,
  DENY,
  editInput,
  editWithTranscript,
  has,
  hasNot,
  makeFixture,
  runBro,
  runIn,
  runSwe,
  writeInput,
  type Fixture,
} from './swe-boundary-l3.js';

describe('swe-boundary l3: worktree and prompt surfaces', () => {
  let f: Fixture;

  before(() => {
    f = makeFixture('swe-boundary-surface');
  });
  after(() => f.remove());

  describe('(c) Edit/Write target outside the assigned worktree', () => {
    it('(c) SWE edit inside worktree: allowed', () => {
      hasNot(runSwe(f, editInput('swe', join(f.worktree, 'src/index.ts'))), DENY, 'edit inside worktree should be allowed');
    });

    it('(c) SWE edit outside worktree (absolute path to /tmp): DENIED', () => {
      const out = runSwe(f, editInput('swe', '/tmp/some-file.ts'));
      has(out, DENY, 'edit outside worktree should be denied');
      has(out, 'outside the worktree', 'deny reason should mention outside worktree');
    });

    it('(c) SWE write outside worktree: DENIED', () => {
      has(runSwe(f, writeInput('swe', '/etc/hosts')), DENY, 'write outside worktree should be denied');
    });

    it('(c) bro edit outside any worktree: NOT denied by this hook', () => {
      hasNot(runBro(f, editInput('bro', '/tmp/some-file.ts')), DENY, 'bro edit outside worktree should not be denied by swe-boundary');
    });
  });

  describe('(d) prompt-surface paths', () => {
    const editAs = (cwd: string, agent: string, path: string, task: number) => runIn(f, cwd, editWithTranscript(f, agent, path, task));

    it('(d) SWE edit agents/swe.md: DENIED (no prompt_bearing)', () => {
      const out = editAs(f.worktree, 'swe', 'agents/swe.md', 10);
      has(out, DENY, 'edit agents/swe.md should be denied');
      has(out, 'prompt-surface', 'deny reason should mention prompt-surface');
    });

    for (const [name, path] of [
      ['skills/tmb_planning/SKILL.md', 'skills/tmb_planning/SKILL.md'],
      ['CLAUDE.md', 'CLAUDE.md'],
      ['docs/CLAUDE.md', 'docs/CLAUDE.md'],
      ['commands/scan.md', 'commands/scan.md'],
    ]) {
      it(`(d) SWE edit ${name}: DENIED`, () => {
        has(editAs(f.worktree, 'swe', path, 10), DENY, `edit ${name} should be denied`);
      });
    }

    for (const path of ['CODEX.md', 'CURSOR.md', 'GEMINI.md']) {
      it(`(d) SWE edit ${path}: NOT denied (not a prompt surface)`, () => {
        hasNot(editAs(f.worktree, 'swe', path, 10), DENY, `${path} is not a prompt surface`);
      });
    }

    it('(d) SWE edit agents/swe.md with prompt_bearing=1: ALLOWED', () => {
      hasNot(editAs(f.wtPrompt, 'swe', 'agents/swe.md', 11), DENY, 'prompt_bearing=1 task should allow prompt-surface edit');
    });

    it('(d) SWE edit regular source file: NOT denied by rule (d)', () => {
      hasNot(editAs(f.worktree, 'swe', 'src/index.ts', 10), DENY, 'edit regular source file should not be denied by rule (d)');
    });

    it('(d) bro edit agents/swe.md: NOT denied by swe-boundary (bro is allowed)', () => {
      hasNot(editAs(f.nonWt, 'bro', 'agents/swe.md', 10), DENY, 'bro edit prompt-surface should not be denied by swe-boundary');
    });

    it('(d) SWE edit templates/agents/architect.md: DENIED', () => {
      has(editAs(f.worktree, 'swe', 'templates/agents/architect.md', 10), DENY, 'edit templates/ should be denied');
    });
  });

  describe("(c/1550) identity comes from the spawn transcript, never the cwd", () => {
    const noTranscript = (path: string) => ({ tool_name: 'Edit', agent_type: 'swe', _no_identity: true, tool_input: { file_path: path } });

    for (const slug of ['prompt-task', 'my-feature', 'unknown-task']) {
      it(`(c/1550) NO transcript, shell inside ${slug}: DENIED, names the missing task_id`, () => {
        const wt = join(f.wtRoot, slug);
        mkdirSync(wt, { recursive: true });
        const out = runIn(f, wt, noTranscript(join(wt, 'src/index.ts')));
        has(out, DENY, 'a cwd inside a worktree is not identity');
        has(out, "cannot resolve this swe's worktree", 'the fail-closed reason');
        has(out, 'no task_id', 'names the missing piece');
      });
    }

    it('(c/1550) transcript names a task with no tasks row: DENIED, names it', () => {
      has(runSwe(f, editWithTranscript(f, 'swe', join(f.worktree, 'src/index.ts'), 999)), 'task 999 has no tasks row', 'names the missing row');
    });

    it('(c/1550) subagents transcript beside the session transcript resolves the task', () => {
      const subagents = join(f.sb.dir, 'session/subagents');
      mkdirSync(subagents, { recursive: true });
      writeFileSync(join(subagents, 'agent-a1b2.jsonl'), `${JSON.stringify({ message: { content: [{ type: 'text', text: 'task_id=11' }] } })}\n`);
      const input = {
        tool_name: 'Edit',
        agent_type: 'swe',
        agent_id: 'a1b2',
        transcript_path: join(f.sb.dir, 'session.jsonl'),
        tool_input: { file_path: join(f.wtPrompt, 'agents/swe.md') },
      };
      hasNot(runSwe(f, input), DENY, "task 11's worktree, prompt_bearing=1, whatever the cwd");
    });
  });

  describe('(d/anchor) only the worktree-root prompt dirs are surface', () => {
    it('(d/anchor) SWE edit <worktree>/src/agents/notes.md on a non-prompt_bearing task: ALLOWED', () => {
      hasNot(runSwe(f, editWithTranscript(f, 'swe', join(f.worktree, 'src/agents/notes.md'), 10)), DENY, 'a nested agents/ dir is not prompt surface');
    });

    it('(d/anchor) SWE edit <worktree>/agents/notes.md on a non-prompt_bearing task: DENIED', () => {
      has(runSwe(f, editWithTranscript(f, 'swe', join(f.worktree, 'agents/notes.md'), 10)), DENY, 'a root agents/ dir is prompt surface');
    });
  });

  describe('(d/597) failed-status task, absolute target, shell outside every worktree', () => {
    it('(d/597) failed-status prompt_bearing=1, absolute target, PWD outside worktree: ALLOWED', () => {
      const out = runIn(f, f.nonWt, editWithTranscript(f, 'swe', join(f.wtFailedPb, 'agents/swe.md'), 12));
      hasNot(out, DENY, 'failed-status prompt_bearing=1 via absolute target should be allowed');
    });

    it('(d/597) failed-status prompt_bearing=0, absolute target, PWD outside worktree: DENIED', () => {
      const out = runIn(f, f.nonWt, editWithTranscript(f, 'swe', join(f.wtFailedNonPb, 'agents/swe.md'), 13));
      has(out, DENY, 'failed-status prompt_bearing=0 via absolute target should still be denied');
      has(out, 'prompt-surface', 'denied by the surface rule, not the worktree rule');
    });
  });

  describe('(e) Bash write forms targeting prompt surfaces', () => {
    const sweTask = (command: string, task = 10) => runSwe(f, bashWithTranscript(f, 'swe', command, task));

    it('(e) SWE redirect > to agents/swe.md: DENIED', () => {
      const out = sweTask('echo "content" > agents/swe.md');
      has(out, DENY, 'redirect > to agents/*.md should be denied');
      has(out, 'prompt-surface', 'deny reason should mention prompt-surface');
    });

    for (const [name, cmd] of [
      ['redirect >> to CLAUDE.md', 'echo "extra" >> CLAUDE.md'],
      ['tee to commands/scan.md', 'cat template | tee commands/scan.md'],
      ['sed -i on skills/tmb_planning/SKILL.md', "sed -i 's/old/new/' skills/tmb_planning/SKILL.md"],
      ['perl -i on agents/bro.md', "perl -i -pe 's/old/new/' agents/bro.md"],
      ['python3 open w to agents/swe.md', `python3 -c "open('agents/swe.md','w').write('x')"`],
      ['python open a to docs/CLAUDE.md', `python -c "open('docs/CLAUDE.md','a').write('x')"`],
      ['cp src to templates/agents/foo.md', 'cp /tmp/foo.md templates/agents/foo.md'],
      ['mv src to commands/foo.md', 'mv /tmp/foo.md commands/foo.md'],
      ['rsync src to agents/', 'rsync -av /tmp/agent.md agents/agent.md'],
    ]) {
      it(`(e) SWE ${name}: DENIED`, () => {
        has(sweTask(cmd), DENY, `${name} should be denied`);
      });
    }

    for (const [name, cmd] of [
      ['cat agents/swe.md', 'cat agents/swe.md'],
      ['grep in agents/swe.md', 'grep "pattern" agents/swe.md'],
      ['sed -n on agents/swe.md', "sed -n '1,5p' agents/swe.md"],
    ]) {
      it(`(e) SWE ${name}: NOT denied (read-only)`, () => {
        hasNot(sweTask(cmd), DENY, `${name} is read-only, should not be denied`);
      });
    }

    for (const [name, cmd] of [
      ['redirect > to CODEX.md', 'echo "x" > CODEX.md'],
      ['redirect > to CURSOR.md', 'echo "x" > CURSOR.md'],
      ['python open a to GEMINI.md', `python -c "open('GEMINI.md','a').write('x')"`],
    ]) {
      it(`(e) SWE ${name}: NOT denied (not a prompt surface)`, () => {
        hasNot(sweTask(cmd), DENY, `${name} is not a prompt surface`);
      });
    }

    it('(e) SWE redirect > to non-prompt file: NOT denied', () => {
      hasNot(sweTask('echo "content" > src/index.ts'), DENY, 'redirect to non-prompt file should not be denied by rule (e)');
    });

    it('(e) SWE redirect > to agents/swe.md with prompt_bearing=1 (transcript resolves task): ALLOWED', () => {
      const out = runIn(f, f.nonWt, bashWithTranscript(f, 'swe', 'echo "content" > agents/swe.md', 11));
      hasNot(out, DENY, 'prompt_bearing=1 task should allow Bash write to prompt surface');
    });

    it('(e) SWE sed -i on the root CLAUDE.md on a prompt_bearing=1 task: DENIED (always)', () => {
      const out = runIn(f, f.wtPrompt, bashInput('swe', "sed -i 's/old/new/' CLAUDE.md"));
      has(out, DENY, 'prompt_bearing does not lift the root CLAUDE.md deny');
      has(out, 'Human-owned', 'the CLAUDE.md reason');
    });

    it('(d) SWE Edit of the root CLAUDE.md on a prompt_bearing=1 task: DENIED (always)', () => {
      const out = runIn(f, f.wtPrompt, editInput('swe', join(f.wtPrompt, 'CLAUDE.md')));
      has(out, DENY, 'prompt_bearing does not lift the root CLAUDE.md deny for Edit');
      has(out, 'Human-owned', 'the CLAUDE.md reason');
    });

    it('(d) SWE Edit of a nested docs/CLAUDE.md on a prompt_bearing=1 task: ALLOWED', () => {
      hasNot(runIn(f, f.wtPrompt, editInput('swe', join(f.wtPrompt, 'docs/CLAUDE.md'))), DENY, 'only the repo-root CLAUDE.md is always denied');
    });

    it('(e) SWE redirect > to agents/swe.md via slug fallback (prompt_bearing=0): DENIED', () => {
      has(runIn(f, f.worktree, bashInput('swe', 'echo x > agents/swe.md')), DENY, 'slug fallback prompt_bearing=0 should deny Bash write to prompt surface');
    });

    it('(e) bro redirect > to agents/swe.md: NOT denied (bro is not SWE)', () => {
      hasNot(runBro(f, bashInput('bro', 'echo "content" > agents/swe.md')), DENY, 'bro Bash write to prompt surface not denied by swe-boundary');
    });
  });

  describe('(e/fp) destination coupling: no false positives', () => {
    const sweTask = (command: string) => runSwe(f, bashWithTranscript(f, 'swe', command, 10));

    it('(e/fp) grep containing > char: NOT denied (not a redirect)', () => {
      hasNot(sweTask('grep ">" agents/swe.md'), DENY, 'grep with > in pattern should not be denied');
    });

    it('(e/fp) awk comparison > on .md file: NOT denied (comparison, not redirect)', () => {
      hasNot(sweTask("awk '$1 > 5' agents/swe.md"), DENY, 'awk comparison operator should not be denied');
    });

    it('(e/fp) echo with prompt path in string redirected to /tmp: NOT denied', () => {
      hasNot(sweTask('echo "see agents/swe.md for details" > /tmp/notes.txt'), DENY, 'redirect to /tmp mentioning a prompt path should not be denied');
    });

    it('(e/fp) git commit -m message mentioning agents/swe.md: NOT denied', () => {
      hasNot(sweTask('git commit -m "touch agents/swe.md"'), DENY, 'commit message mentioning prompt path should not be denied');
    });
  });
});
