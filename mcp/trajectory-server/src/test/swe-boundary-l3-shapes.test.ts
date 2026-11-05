/**
 * The swe-boundary l3 bash suite in node:test (GH 1692), rules (e) and (f)
 * for every Bash write shape (GH 1272): a prompt-surface write is denied on a
 * non-prompt-bearing task; a write outside files[] is allowed with a
 * once-per-path note (GH 1295); text a program writes is content (GH 1531).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PLUGIN_ROOT } from './hook-sandbox.js';
import {
  addShapeTasks,
  DENY,
  editInput,
  has,
  hasNot,
  IN_FENCE,
  makeFixture,
  runIn,
  SURFACE,
  swe,
  type Fixture,
} from './swe-boundary-l3.js';

const SHAPES: [string, (t: string) => string][] = [
  ['>', (t) => `echo x > ${t}`],
  ['>>', (t) => `echo x >> ${t}`],
  ['heredoc', (t) => `cat > ${t} <<'EOF'\nbody\nEOF`],
  ['tee', (t) => `echo x | tee ${t}`],
  ['tee -a', (t) => `echo x | tee -a ${t}`],
  ['sed -i', (t) => `sed -i 's/a/b/' ${t}`],
  ['perl -i', (t) => `perl -i -pe 's/a/b/' ${t}`],
  ['cp', (t) => `cp /tmp/src.md ${t}`],
  ['mv', (t) => `mv /tmp/src.md ${t}`],
  ['install', (t) => `install -m 644 /tmp/src.md ${t}`],
  ['rsync', (t) => `rsync -a /tmp/src.md ${t}`],
  ['python3', (t) => `python3 -c "open('${t}','w').write('x')"`],
  ['node', (t) => `node -e "require('fs').writeFileSync('${t}','x')"`],
  ['dd', (t) => `dd if=/tmp/src.md of=${t}`],
  ['>|', (t) => `echo x >| ${t}`],
  ['exec N>', (t) => `exec 3> ${t}`],
  ['truncate', (t) => `truncate -s 0 ${t}`],
  ['git mv', (t) => `git mv /tmp/src.md ${t}`],
  ['perl -e', (t) => `perl -e 'open(my $f, ">", "${t}")'`],
];

/** The shape writing <out> with the surface path <src> only as a read input. */
const READ_INPUT: Record<string, (src: string, out: string) => string> = {
  '>': (s, o) => `cat ${s} > ${o}`,
  '>>': (s, o) => `cat ${s} >> ${o}`,
  heredoc: (s, o) => `cat - ${s} > ${o} <<'EOF'\nbody\nEOF`,
  tee: (s, o) => `cat ${s} | tee ${o}`,
  'tee -a': (s, o) => `cat ${s} | tee -a ${o}`,
  'sed -i': (s, o) => `sed -i '/x/r ${s}' ${o}`,
  'perl -i': (s, o) => `perl -i -pe 'BEGIN{open(F,"${s}")}' ${o}`,
  cp: (s, o) => `cp ${s} ${o}`,
  install: (s, o) => `install -m 644 ${s} ${o}`,
  rsync: (s, o) => `rsync -a ${s} ${o}`,
  python3: (s, o) => `python3 -c "open('${o}','w').write(open('${s}').read())"`,
  node: (s, o) => `node -e "const fs=require('fs'); fs.writeFileSync('${o}', fs.readFileSync('${s}'))"`,
  dd: (s, o) => `dd if=${s} of=${o}`,
};

describe('swe-boundary l3: Bash write shapes', () => {
  let f: Fixture;
  let wtPlain: string;
  let wtPb: string;

  before(() => {
    f = makeFixture('swe-boundary-shapes');
    ({ wtPlain, wtPb } = addShapeTasks(f));
  });
  after(() => f.remove());

  SHAPES.forEach(([shape, write], i) => {
    describe(`GH 1272 [${shape}]`, () => {
      it(`GH 1272 [${shape}] non-prompt-bearing task writes ${SURFACE}: DENIED`, () => {
        const out = swe(f, wtPlain, write(SURFACE));
        has(out, DENY, `a surface write via ${shape} is denied`);
        has(out, 'prompt-surface', 'the prompt-surface reason');
      });

      it(`GH 1272 [${shape}] prompt-bearing task writes ${SURFACE}: ALLOWED`, () => {
        hasNot(swe(f, wtPb, write(SURFACE)), DENY, `prompt_bearing=1 lifts the surface rule for ${shape}`);
      });

      const outOfFence = `scripts/hooks/x-${i}.sh`;
      it(`GH 1295 [${shape}] write outside files[] (${outOfFence}): ALLOWED with a note`, () => {
        const out = swe(f, wtPlain, write(outOfFence));
        hasNot(out, DENY, `an out-of-fence write via ${shape} is allowed`);
        has(out, `${outOfFence} is outside this task's files[]`, 'the note names the path');
        has(out, 'additionalContext', 'the note is additionalContext');
      });

      it(`GH 1272 [${shape}] write inside files[] (${IN_FENCE}): ALLOWED`, () => {
        hasNot(swe(f, wtPlain, write(IN_FENCE)), DENY, `an in-fence write via ${shape} is allowed`);
      });

      const readInput = READ_INPUT[shape];
      if (readInput !== undefined) {
        it(`GH 1272 [${shape}] in-fence write with ${SURFACE} as read input: ALLOWED`, () => {
          hasNot(swe(f, wtPlain, readInput(SURFACE, IN_FENCE)), DENY, `a surface read input of ${shape} is not a write`);
        });
      }
    });
  });

  for (const cmd of [
    `cat ${SURFACE}`,
    `grep -n x ${SURFACE}`,
    `sed -n '1,5p' ${SURFACE}`,
    `head -3 ${SURFACE}`,
    `python3 -c "print(open('${SURFACE}').read())"`,
    `node -e "process.stdout.write(require('fs').readFileSync('${SURFACE}'))"`,
    'grep -rn x skills/ > /dev/null',
  ]) {
    it(`GH 1272 read '${cmd}': ALLOWED`, () => {
      hasNot(swe(f, wtPlain, cmd), DENY, 'a read never fires');
    });
  }

  it(`GH 1272 mv removes its source: moving ${SURFACE} away is a surface write`, () => {
    has(swe(f, wtPlain, `mv ${SURFACE} ${IN_FENCE}`), 'prompt-surface', 'the mv source is removed, so it is written');
  });

  it('GH 1272 path boundary: myskills/ is not the skills/ surface', () => {
    hasNot(swe(f, wtPlain, 'echo x > myskills/notes.md'), DENY, 'myskills/x.md is neither a surface nor out of fence');
  });

  it('GH 1272 rules/ and .claude/agents/ are surfaces', () => {
    has(swe(f, wtPlain, 'echo x > rules/style.md'), 'prompt-surface', 'rules/*.md is a surface');
    has(swe(f, wtPlain, 'echo x > .claude/agents/local.md'), 'prompt-surface', '.claude/agents/*.md is a surface');
  });

  it('GH 1272 directory-aware: cd into skills/ then write a relative path', () => {
    has(swe(f, wtPlain, 'cd skills && echo x > tmb_audit/SKILL.md'), 'prompt-surface', "the statement's cd dir is applied");
    has(swe(f, wtPlain, 'cd src && echo x > ../skills/tmb_audit/SKILL.md'), 'prompt-surface', 'a ../ path from the cd dir is normalized');
    hasNot(swe(f, wtPlain, 'cd src && echo x > index.ts'), DENY, 'src/index.ts via cd stays in fence');
  });

  it('GH 1272 bash -c and a second statement are judged', () => {
    has(swe(f, wtPlain, `bash -c 'echo x > ${SURFACE}'`), 'prompt-surface', 'a bash -c body is a statement');
    const out = swe(f, wtPlain, `echo ok > ${IN_FENCE} && echo x > docs/second-statement.md`);
    has(out, "docs/second-statement.md is outside this task's files[]", "every statement's paths are judged");
  });

  it('GH 1272 interpreter write mode with the path in argv', () => {
    has(swe(f, wtPlain, `python3 -c "import sys; open(sys.argv[1],'w').write('x')" ${SURFACE}`), 'prompt-surface', 'the operand of a writing one-liner is written');
    has(swe(f, wtPlain, `python3 -c "from pathlib import Path; Path('${SURFACE}').write_text('x')"`), 'prompt-surface', 'write_text');
    has(swe(f, wtPlain, `node -e "require('fs').appendFileSync('${SURFACE}','x')"`), 'prompt-surface', 'appendFileSync');
  });

  it('GH 1272 writes outside the worktree are not fenced (/dev/null, /tmp)', () => {
    hasNot(swe(f, wtPlain, 'ls 2>/dev/null > /tmp/swe-boundary-out.txt'), DENY, 'the fence covers the worktree only');
  });

  it('GH 1272 task with empty files[]: no note', () => {
    const out = swe(f, f.worktree, 'echo x > scripts/hooks/empty-files.ts');
    hasNot(out, DENY, 'no typed files[] means no fence, as for Edit');
    hasNot(out, "outside this task's files[]", 'no typed files[] means no note');
  });

  it('GH 1295 ordinary out-of-fence write inside the worktree: ALLOWED, noted once per path', () => {
    const out = swe(f, wtPlain, 'echo x > docs/once.md');
    hasNot(out, DENY, 'an ordinary out-of-fence path is allowed');
    has(out, "docs/once.md is outside this task's files[] (myskills, notes, src)", 'the note lists files[] dirs');
    has(out, 'list it and why in your report', 'the note asks for the report entry');
    hasNot(swe(f, wtPlain, 'echo y >> docs/once.md'), "outside this task's files[]", 'the second write to the same path is silent');
    assert.equal(existsSync(join(f.sb.dir, 'locks/scope-notes/20')), true, "the marker lives under the state dir's locks/");
  });

  it('GH 1531 text a program writes is content: no scope note for the paths it mentions', () => {
    const prog = ["python3 - <<'EOF'", "p = 'src/a.ts'", "with open(p, 'w') as f:", `    f.write("const root = '/work/proj'; const branch = 'fix/sess-a';")`, 'EOF'].join('\n');
    const out = swe(f, wtPlain, prog);
    hasNot(out, DENY, 'a write into files[] is allowed');
    hasNot(out, "outside this task's files[]", "the content's path-like text draws no note");
  });

  it('GH 1295 Edit outside the worktree and prompt surface on a non-bearing task stay DENIED', () => {
    has(runIn(f, wtPlain, editInput('swe', '/tmp/elsewhere.ts')), 'outside the worktree', 'outside-worktree Edit is denied');
    has(runIn(f, wtPlain, editInput('swe', join(wtPlain, SURFACE))), 'prompt-surface', 'prompt-surface Edit on a non-bearing task is denied');
    has(swe(f, wtPlain, 'echo x > CLAUDE.md'), 'Human-owned', 'a Bash write to the root CLAUDE.md is denied');
  });

  it('GH 1272 Edit/Write and Bash share one surface predicate', () => {
    has(runIn(f, wtPlain, editInput('swe', join(wtPlain, 'rules/style.md'))), 'prompt-surface', 'Edit of rules/*.md reaches the same decision');
  });

  it('GH 1272 one shared write-shape list: neither guard carries its own copy', () => {
    for (const guard of ['swe-boundary', 'no-source-edit-from-main']) {
      const body = readFileSync(join(PLUGIN_ROOT, `mcp/trajectory-server/src/hooks/${guard}.ts`), 'utf8');
      hasNot(body, 'sed -i', `${guard} names no write shape itself`);
      hasNot(body, 'function isPromptSurface', `${guard} keeps no surface predicate of its own`);
      has(body, 'writePaths', `${guard} takes written paths from cmd-analysis`);
      has(body, 'isPromptSurfacePath', `${guard} takes the surface predicate from cmd-analysis`);
      has(body, "from './cmd-analysis/index.js'", `${guard} imports both from cmd-analysis`);
    }
  });
});
