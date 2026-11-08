/**
 * The swe-boundary l3 bash suite in node:test (GH 1692): heredoc programs and
 * variable-held targets (GH 1279), loop variables fed by a glob or path
 * lister and $OLDPWD (GH 1324), and find -exec / -delete, fd -x and xargs
 * (GH 1338). A path outside the worktree is containment-guard's deny on the
 * same PreToolUse event, so those cases run both gates.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  addShapeTasks,
  bashInput,
  DENY,
  has,
  hasNot,
  heredocProg,
  IN_FENCE,
  makeFixture,
  runBro,
  runEvent,
  SURFACE,
  swe,
  type Fixture,
} from './swe-boundary-l3.js';

const UNRESOLVED = 'cannot be judged: depends on a variable the guard cannot resolve';

describe('swe-boundary l3: programs, variables and loops', () => {
  let f: Fixture;
  let wtPlain: string;
  let wtPb: string;

  before(() => {
    f = makeFixture('swe-boundary-loops');
    ({ wtPlain, wtPb } = addShapeTasks(f));
    f.sql(`CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY, task_id INTEGER, issue_id INTEGER, agent_type TEXT,
      started_at TEXT, completed_at TEXT, root_dir TEXT, host TEXT
    )`);
    f.sql("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, root_dir, host) VALUES (20, 1, 'swe', datetime('now'), ?, 'claude')", wtPlain);
  });
  after(() => f.remove());

  describe('GH 1279 heredoc programs and variable-held targets', () => {
    it('GH 1279 swe python3 heredoc writing outside the worktree: DENIED', () => {
      const out = runEvent(f, wtPlain, heredocProg('python3 -', "open('/etc/tmb-1279', 'w').write('x')"));
      has(out, DENY, "the program's write is judged");
      has(out, "/etc/tmb-1279 is outside this run's root", 'containment names the path');
    });

    it('GH 1279 swe python3 heredoc writing inside the worktree: ALLOWED', () => {
      hasNot(runEvent(f, wtPlain, heredocProg('python3 -', `open('${IN_FENCE}', 'w').write('x')`)), DENY, 'an in-worktree, in-fence write');
    });

    it('GH 1279 swe heredoc programs reach the prompt-surface rule', () => {
      for (const [interp, prog] of [
        ['python3 -', `open('${SURFACE}', 'w').write('x')`],
        ['python3', `open('${SURFACE}', 'w').write('x')`],
        ['node', `require('fs').writeFileSync('${SURFACE}', 'x')`],
        ['ruby -', `File.write('${SURFACE}', 'x')`],
        ['perl', `open(my $f, '>', '${SURFACE}');`],
      ]) {
        has(swe(f, wtPlain, heredocProg(interp, prog)), 'prompt-surface', `${interp} heredoc writing ${SURFACE}`);
        hasNot(swe(f, wtPb, heredocProg(interp, prog)), DENY, `${interp} heredoc on a prompt-bearing task`);
      }
      has(swe(f, wtPlain, heredocProg('bash -s', `echo x > ${SURFACE}`)), 'prompt-surface', "an sh program's redirect");
    });

    it('GH 1279 a data heredoc is never scanned', () => {
      hasNot(swe(f, wtPlain, heredocProg('cat > notes/fixture.py', `open('${SURFACE}', 'w')`)), DENY, 'cat > f <<EOF body is data');
      hasNot(swe(f, wtPlain, heredocProg('python3 notes/run.py', `open('${SURFACE}', 'w')`)), DENY, 'stdin of a script is data');
    });

    it('GH 1279 variable-held write targets', () => {
      has(runEvent(f, wtPlain, 'OUT=/etc/tmb-1279-var; cat > "$OUT" < /dev/null'), "/etc/tmb-1279-var is outside this run's root", 'OUT=/etc/x; cat > $OUT is judged on /etc/x');
      hasNot(runEvent(f, wtPlain, `OUT=${wtPlain}/${IN_FENCE}; cat > "$OUT" < /dev/null`), DENY, 'OUT=<worktree>/f; cat > $OUT');
      has(swe(f, wtPlain, 'D=skills/tmb_audit; echo x > "$D/SKILL.md"'), 'prompt-surface', 'a resolved variable reaches the prompt-surface rule');
      const out = swe(f, wtPlain, 'cat > "$UNKNOWN/f" < /dev/null');
      has(out, DENY, 'an unresolvable target is denied');
      has(
        out,
        'write target \\"$UNKNOWN/f\\" cannot be judged: depends on a variable the guard cannot resolve in this command. Allowed form: the same command with the path inlined, or with the variable set in the same command',
        'the deny names the variable',
      );
      has(swe(f, wtPlain, 'F=$(mktemp -u); echo x > "$F"'), 'write target \\"$F\\"', 'a value built by $( ) is unresolvable');
      hasNot(swe(f, wtPlain, 'F=$(mktemp); echo x > "$F"'), DENY, 'GH 1912: an allowlisted mktemp resolves under $TMPDIR');
      hasNot(swe(f, wtPb, 'cat > "$UNKNOWN/f" < /dev/null'), DENY, 'a prompt-bearing swe follows the prompt-surface rules as today');
      hasNot(runBro(f, bashInput('bro', 'cat > "$UNKNOWN/f" < /dev/null')), 'cannot resolve', 'bro is not judged by swe-boundary');
    });
  });

  describe('GH 1324 loop variables and $OLDPWD', () => {
    before(() => {
      mkdirSync(join(wtPlain, 'tests'), { recursive: true });
      mkdirSync(join(wtPlain, 'src/a'), { recursive: true });
    });

    it('GH 1324 swe bulk loops over in-worktree files: ALLOWED', () => {
      hasNot(runEvent(f, wtPlain, `for f in ${wtPlain}/tests/*.sh; do sed -i 's/a/b/' "$f"; done`), DENY, 'for f in <root>/tests/*.sh; sed -i');
      hasNot(runEvent(f, wtPlain, `for f in $(find ${wtPlain} -name '*.md'); do printf x >> "$f"; done`), DENY, "for f in $(find <root> -name '*.md'); printf >>");
      hasNot(runEvent(f, wtPlain, `while read -r f; do sed -i 's/a/b/' "$f"; done < <(git ls-files src)`), DENY, 'while read … done < <(git ls-files src)');
      hasNot(runEvent(f, wtPlain, `find src -name '*.ts' | while read -r f; do cp "$f" "\${f%.ts}.bak"; done`), DENY, 'find src | while read; the ${f%.ts}.bak suffix');
    });

    it('GH 1324 swe loops over a source outside the worktree: DENIED', () => {
      has(swe(f, wtPlain, 'for f in $(find / -name x); do rm "$f"; done'), `write target \\"$f\\" ${UNRESOLVED}`, 'for f in $(find / …); rm');
      has(swe(f, wtPlain, 'for f in $(cat list.txt); do rm "$f"; done'), DENY, '$(cat list.txt)');
      has(swe(f, wtPlain, `for f in skills/*/SKILL.md; do sed -i 's/a/b/' "$f"; done`), 'prompt-surface', 'an in-worktree glob still reaches the prompt-surface rule');
    });

    it('GH 1324 swe loops over prompt-surface dirs: DENIED (non-prompt-bearing)', () => {
      for (const d of [join(wtPlain, 'agents'), join(wtPlain, 'skills/tmb_audit'), join(wtPb, 'agents')]) mkdirSync(d, { recursive: true });
      has(swe(f, wtPlain, `for f in $(find ${wtPlain}/agents -name '*.md'); do sed -i s/a/b/ "$f"; done`), 'prompt-surface', "find <wt>/agents -name '*.md'");
      has(swe(f, wtPlain, `for f in $(find agents -name '*.md'); do sed -i s/a/b/ "$f"; done`), 'prompt-surface', 'relative find agents');
      has(swe(f, wtPlain, `find ${wtPlain}/agents -name '*.md' | while read f; do printf x >> "$f"; done`), 'prompt-surface', 'find <wt>/agents | while read');
      has(swe(f, wtPlain, 'for f in $(git ls-files skills); do sed -i s/a/b/ "$f"; done'), 'prompt-surface', 'git ls-files skills');
      has(swe(f, wtPlain, 'for f in $(find . -name CLAUDE.md); do sed -i s/a/b/ "$f"; done'), 'Human-owned', 'a -name CLAUDE.md source reaches the root CLAUDE.md rule');
      hasNot(swe(f, wtPb, `for f in $(find agents -name '*.md'); do sed -i s/a/b/ "$f"; done`), DENY, 'a prompt-bearing task may');
    });

    it('GH 1324 swe loops over the worktree above its prompt-surface dirs', () => {
      const out = swe(f, wtPlain, `for f in $(find ${wtPlain} -name '*.md'); do sed -i s/a/b/ "$f"; done`);
      has(out, 'reaches prompt-surface paths', "find <wt> -name '*.md': DENIED");
      has(out, 'scope the listing below agents/', 'the reason names the remedy');
      hasNot(swe(f, wtPlain, `for f in $(find ${wtPlain}/tests -name '*.md'); do sed -i s/a/b/ "$f"; done`), DENY, "find <wt>/tests -name '*.md': ALLOWED");
      hasNot(
        swe(f, wtPlain, `for f in $(find ${wtPlain} -name '*.md' -not -path '*/agents/*' -not -path '*/skills/*' -not -path '*/commands/*' -not -path '*/templates/*'); do sed -i s/a/b/ "$f"; done`),
        DENY,
        'find <wt> with -not -path exclusions: ALLOWED',
      );
      has(swe(f, wtPlain, 'for f in $(git ls-files); do sed -i s/a/b/ "$f"; done'), 'reaches prompt-surface paths', 'git ls-files at the worktree root: DENIED');
      hasNot(swe(f, wtPlain, 'for f in $(git ls-files tests); do sed -i s/a/b/ "$f"; done'), DENY, 'git ls-files tests: ALLOWED');
      hasNot(swe(f, wtPb, `for f in $(find ${wtPb} -name '*.md'); do sed -i s/a/b/ "$f"; done`), DENY, 'a prompt-bearing task: ALLOWED');
    });

    it('GH 1324 swe: case-insensitive patterns and partial exclusions DENIED, whole-subtree exclusions ALLOWED', () => {
      mkdirSync(join(wtPlain, 'commands'), { recursive: true });
      const loop = (src: string) => swe(f, wtPlain, `for f in $(${src}); do sed -i s/a/b/ "$f"; done`);
      for (const src of [
        `find ${wtPlain} -iname '*.MD'`,
        `find ${wtPlain} -iname 'skill.md'`,
        `rg --files ${wtPlain} --iglob '*.MD'`,
        `find ${wtPlain} -name '*.md' ! -path '*/agents'`,
        `find ${wtPlain} -name '*.md' -not -path '*/agents/zzz/*'`,
        `find ${wtPlain} -path '*/agents/zzz' -prune -o -name '*.md' -print`,
        "git ls-files ':!agents/zzz'",
        `fd -E agents/zzz md ${wtPlain}`,
      ]) {
        has(loop(src), 'reaches prompt-surface paths', `${src}: DENIED`);
      }
      for (const src of [
        `find ${wtPlain} -name '*.md' -not -path '*/agents/*' -not -path '*/skills/**' -not -path '*/commands/*'`,
        `find ${wtPlain} -path '*/agents' -prune -o -path '*/skills' -prune -o -path '*/commands' -prune -o -name '*.md' -print`,
        "git ls-files ':!agents' ':!skills' ':!commands'",
        `fd -E agents -E skills -E commands md ${wtPlain}`,
        `rg --files ${wtPlain} --glob '!agents/**' --glob '!skills/**' --glob '!commands'`,
      ]) {
        hasNot(loop(src), DENY, `${src}: ALLOWED`);
      }
    });

    it('GH 1324 swe loop shapes that leave the worktree: DENIED', () => {
      has(runEvent(f, wtPlain, 'for f in $(find -- /etc -name x); do rm "$f"; done'), `write target \\"$f\\" ${UNRESOLVED}`, 'find -- /etc');
      has(runEvent(f, wtPlain, `for d in $(find ${wtPlain} -type d); do echo x > "$d/../f"; done`), DENY, '$d/../f: find lists the worktree itself');
      has(runEvent(f, wtPlain, `echo x > ${wtPlain}/*/../../../etc/f`), 'climbs with .. after a glob', 'a glob followed by ..');
    });

    it('GH 1324 swe $OLDPWD after a cd', () => {
      hasNot(runEvent(f, wtPlain, `cd ${wtPlain}/src/a && echo x > "$OLDPWD/${IN_FENCE}"`), DENY, 'cd <root>/src/a from the worktree root');
      has(runEvent(f, wtPlain, `cd /tmp/tmb-1324 && cd ${wtPlain}/src && echo x > "$OLDPWD/f"`), "/tmp/tmb-1324/f is outside this run's root", 'denied as the real path');
      has(swe(f, wtPlain, 'echo x > "$OLDPWD/f"'), 'write target \\"$OLDPWD/f\\"', 'no cd: unresolvable');
    });

    it('GH 1324 the GH 1279 denies hold', () => {
      has(swe(f, wtPlain, 'cat > "$UNKNOWN/f" < /dev/null'), DENY, 'cat > $UNKNOWN/f');
      has(swe(f, wtPlain, 'cat > "$(mktemp -u)" < /dev/null'), DENY, 'cat > $(mktemp -u)');
      has(runEvent(f, wtPlain, 'OUT=/etc/tmb-1324; cat > "$OUT" < /dev/null'), "/etc/tmb-1324 is outside this run's root", 'OUT=/etc/x; cat > $OUT');
    });
  });

  describe('GH 1338 find -exec / -delete, fd -x and xargs', () => {
    it('GH 1338 swe find / fd / xargs writes outside the worktree: DENIED', () => {
      has(swe(f, wtPlain, `find ${f.project} -exec rm {} \\;`), `write target \\"\${find_path}\\" ${UNRESOLVED}`, 'find <project-root> -exec rm from the worktree');
      has(swe(f, wtPlain, `find ${f.project} -print0 | xargs -0 rm`), `write target \\"\${xargs_arg}\\" ${UNRESOLVED}`, 'find <project-root> | xargs rm');
      has(swe(f, wtPlain, 'find $HOME -delete'), DENY, 'find $HOME -delete');
    });

    it('GH 1338 swe find / fd / xargs over prompt-surface dirs: DENIED (non-prompt-bearing)', () => {
      for (const cmd of [
        "find agents -name '*.md' -exec sed -i s/a/b/ {} \\;",
        "find agents -name '*.md' -delete",
        "find agents -name '*.md' -print0 | xargs -0 sed -i s/a/b/",
        'fd -e md . agents -x sed -i s/a/b/',
      ]) {
        has(swe(f, wtPlain, cmd), 'prompt-surface', cmd);
      }
      hasNot(swe(f, wtPb, "find agents -name '*.md' -exec sed -i s/a/b/ {} \\;"), DENY, 'a prompt-bearing task may');
    });

    it('GH 1338 swe find / fd / xargs inside the worktree, outside prompt-surface dirs: ALLOWED', () => {
      for (const cmd of [
        `find ${wtPlain}/src -exec rm {} \\;`,
        "find src -name '*.md' -exec sed -i s/a/b/ {} \\;",
        "find src -name '*.tmp' -delete",
        "find src -name '*.ts' -print0 | xargs -0 sed -i s/a/b/",
        'fd -e ts . src -x sed -i s/a/b/ {}',
        "find agents -name '*.md' -print",
      ]) {
        hasNot(swe(f, wtPlain, cmd), DENY, cmd);
      }
    });
  });
});
