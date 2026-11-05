/**
 * The swe-boundary l3 bash suite in node:test (GH 1692), rules (a) and (b):
 * a swe never pushes and never runs a mutating gh/glab subcommand, found at
 * any command-position word; reads, quoted text and heredocs are data; bro is
 * never judged (GH 1196, GH 1281).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ghMutation } from '../hooks/cmd-analysis/forge.js';
import { PLUGIN_ROOT } from './hook-sandbox.js';
import { bashInput, DENY, has, hasNot, makeFixture, runBro, runSwe } from './swe-boundary-l3.js';
describe('swe-boundary l3: push and forge writes', () => {
    let f;
    const sweBash = (command) => runSwe(f, bashInput('swe', command));
    before(() => {
        f = makeFixture('swe-boundary-forge');
    });
    after(() => f.remove());
    describe('(a) git push from swe context', () => {
        it('(a) SWE git push: DENIED', () => {
            const out = sweBash('git push origin feat/my-feature');
            has(out, DENY, 'SWE git push should be denied');
            has(out, 'never push', 'deny reason should say never push');
        });
        it('(a) SWE git push via cd prefix: DENIED', () => {
            has(sweBash(`cd ${f.worktree} && git push origin feat/my-feature`), DENY, 'SWE git push with cd prefix should be denied');
        });
        it('(a) SWE git push --force: NOT denied by this hook (delegated to git-guards)', () => {
            hasNot(sweBash('git push --force origin feat/my-feature'), DENY, 'force push should not be denied by swe-boundary (git-guards handles it)');
        });
        it("(a) SWE 'git  push' (double space): DENIED", () => {
            has(sweBash('git  push origin feat/my-feature'), DENY, 'double-space SWE push must not fail open');
        });
        it(`(a) SWE 'bash -c "git push ..."' wrapper: DENIED`, () => {
            has(sweBash('bash -c "git push origin feat/my-feature"'), DENY, 'wrapped SWE push must not fail open');
        });
        it(`(a) SWE 'eval "git push ..."' wrapper: DENIED`, () => {
            has(sweBash('eval "git push origin feat/my-feature"'), DENY, 'eval-wrapped SWE push must not fail open');
        });
        it('(a) bro git push: NOT denied (bro is the push agent)', () => {
            hasNot(runBro(f, bashInput('bro', 'git push origin dev')), DENY, 'bro push should not be denied');
        });
        it('(a) bro INSIDE worktree path: git commit/fetch/rebase NOT denied (explicit identity wins)', () => {
            hasNot(runSwe(f, bashInput('bro', 'git commit -m "review fixup"')), DENY, 'bro git commit inside worktree should be allowed');
            hasNot(runSwe(f, bashInput('bro', 'git fetch origin')), DENY, 'bro git fetch inside worktree should be allowed');
            hasNot(runSwe(f, bashInput('bro', 'git rebase origin/dev')), DENY, 'bro git rebase inside worktree should be allowed');
        });
        it('(a) SWE git status: NOT denied (read-only git)', () => {
            hasNot(sweBash('git status'), DENY, 'git status should not be denied');
        });
        it('(a) SWE git log: NOT denied', () => {
            hasNot(sweBash('git log --oneline -5'), DENY, 'git log should not be denied');
        });
    });
    describe('(b) gh/glab mutating subcommands from swe context', () => {
        it('(b) SWE gh issue create: DENIED', () => {
            const out = sweBash('gh issue create --title "test"');
            has(out, DENY, 'SWE gh issue create should be denied');
            has(out, 'mutating', 'deny reason should mention mutating');
        });
        for (const [name, cmd] of [
            ['gh pr create', 'gh pr create --base dev'],
            ['gh pr merge', 'gh pr merge 42'],
            ['gh api -X POST', 'gh api repos/foo/bar -X POST --field foo=bar'],
            ['gh api --method DELETE', 'gh api repos/foo/bar --method DELETE'],
            ['glab issue create', 'glab issue create --title "test"'],
            ['glab mr create', 'glab mr create --source-branch feat/x'],
        ]) {
            it(`(b) SWE ${name}: DENIED`, () => {
                has(sweBash(cmd), DENY, `SWE ${name} should be denied`);
            });
        }
        for (const cmd of ['gh issue view 42', 'gh issue list --state open', 'gh pr view 42']) {
            it(`(b) SWE ${cmd}: NOT denied (read-only)`, () => {
                hasNot(sweBash(cmd), DENY, `${cmd} should be allowed`);
            });
        }
        it('(b) bro gh pr create: NOT denied (bro is allowed)', () => {
            hasNot(runBro(f, bashInput('bro', 'gh pr create --base dev --head feat/x')), DENY, 'bro gh pr create should not be denied');
        });
        for (const cmd of [
            'gh api -X POST x',
            'gh api -XPOST x',
            'gh api --method DELETE x',
            'gh api --method=PATCH x',
            'gh api x -X PUT',
            '/usr/bin/gh api -X POST x',
            'sudo gh api -X POST x',
            'glab api -X POST x',
            'gh api -X post x',
            'gh issue comment 3 --body x',
            'gh release create v1',
            'gh repo delete o/r',
            'gh api repos/o/r/issues -f title=x',
            'gh api repos/o/r/issues -F body=@f',
            'gh api --input body.json repos/o/r/labels',
            'glab api projects/1/issues -f title=x',
        ]) {
            it(`(b) SWE '${cmd}': DENIED`, () => {
                has(sweBash(cmd), 'gh/glab mutating', 'a forge write must be denied for SWE');
            });
        }
        for (const cmd of [
            'gh api repos/o/r',
            'gh api -X GET x',
            'gh release view v1',
            'gh api -X GET repos/o/r -f per_page=5',
            'echo "gh api repos/o/r/issues -f title=x"',
            "cat > notes.md <<'EOF'\ngh api -X POST x\ngh api --method=PATCH x\nEOF",
            'echo "gh api -X POST x"',
            "grep -n 'gh api --method DELETE x' notes.md",
        ]) {
            it(`(b) SWE read-only or data '${cmd.split('\n')[0]}': NOT denied`, () => {
                hasNot(sweBash(cmd), DENY, 'a read or a quoted/heredoc mention is allowed');
            });
        }
        for (const cmd of [
            'timeout 5 gh pr merge 3',
            'nice gh issue create -t x',
            'xargs gh pr merge <<< 3',
            'echo 3 | xargs -I{} gh pr merge {}',
            'time -p gh api -X POST x',
            'timeout 5 gh api -X POST x',
            'nice -n 10 glab mr merge 4',
            'stdbuf -oL gh issue close 9',
            'FOO=1 timeout 5 gh pr merge 3',
            'ionice -c3 gh pr merge 3',
            'env -i FOO=1 gh pr merge 3',
            'sudo -u bob gh pr merge 3',
            'xargs -I{} -P4 gh issue close {}',
        ]) {
            it(`(b) SWE wrapped '${cmd}': DENIED`, () => {
                has(sweBash(cmd), 'gh/glab mutating', 'a wrapped forge write must be denied for SWE');
            });
        }
        for (const cmd of ['timeout 5 gh pr view 3', 'echo "timeout 5 gh pr merge 3"', 'gh api -X GET x', 'git log --grep="gh pr merge"']) {
            it(`(b) SWE wrapped read or data '${cmd}': NOT denied`, () => {
                hasNot(sweBash(cmd), DENY, 'a wrapped read or a quoted mention is allowed');
            });
        }
        it('(b) ghMutation keeps no wrapper allowlist', () => {
            const src = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/hooks/cmd-analysis/forge.ts'), 'utf8');
            for (const head of ['export function ghMutation(stmt: string): string {', 'export function ghMutationFrom(', 'function ghMutationIn(']) {
                const start = src.indexOf(`\n${head}`);
                const end = src.indexOf('\n}\n', start + 1);
                const fn = start < 0 ? '' : src.slice(start + 1, end + 2);
                has(fn, head, 'the function is found');
                hasNot(fn, 'nohup', `no wrapper list in ${head}`);
                hasNot(fn, 'sudo', `no wrapper list in ${head}`);
                hasNot(fn, 'split-string', `no wrapper option list in ${head}`);
                hasNot(fn, 'WRAPPER', `no wrapper pattern in ${head}`);
            }
            assert.equal(ghMutation('frobnicate --opt gh pr merge 3'), 'pr merge', 'an unknown wrapper still finds the forge write');
        });
    });
    describe('GH 1196: role from identity only; quoted text and heredocs are data', () => {
        const noAgent = (cwd, command) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
        it("GH 1196: bro 'cd <main> && gh issue create' with the shell inside a worktree: NOT denied", () => {
            hasNot(runSwe(f, noAgent(f.worktree, `cd ${f.project} && gh issue create --title t --body b`)), DENY, 'no agent_type is bro, whatever the cwd');
        });
        it("GH 1196: bro 'git -C <main> push' with the shell inside a worktree: NOT denied", () => {
            hasNot(runSwe(f, noAgent(f.worktree, `git -C ${f.project} push origin dev`)), 'SWE must never push', 'a path never makes bro an SWE');
        });
        it('GH 1196: SWE python one-liner writing text that mentions gh pr merge: NOT denied', () => {
            hasNot(sweBash(`python3 -c "open('t.txt','w').write('then gh pr merge 3 --merge')"`), DENY, "a python program's text is data");
        });
        it('GH 1196: SWE markdown heredoc mentioning gh pr merge and git push: NOT denied', () => {
            hasNot(sweBash("cat > notes.md <<'EOF'\ngh pr merge 12 --merge\ngit push origin dev\nEOF"), DENY, 'heredoc content is data');
        });
        it('GH 1196: SWE real gh pr merge after a heredoc: DENIED', () => {
            has(sweBash("cat > notes.md <<'EOF'\ntext\nEOF\ngh pr merge 12 --merge"), 'gh/glab mutating', 'a real statement after the heredoc still fires');
        });
    });
    describe('GH 1281: only command-position words run gh/glab', () => {
        for (const cmd of [
            "cat > x.test.ts <<'EOF'\nit('closes', () => {\n  run('gh', ['issue', 'close', '1'])\n  // gh issue close 1\n})\nEOF",
            "printf 'gh pr merge' > notes.txt",
            'echo gh pr merge 1',
            'cat > notes.md <<-EOF\n\tgh issue close 1\n\tEOF',
            "x=$(cat <<'EOF'\ngh pr merge 1\nEOF\n)",
        ]) {
            it(`GH 1281: SWE text naming a gh mutation '${cmd.split('\n')[0]}': NOT denied`, () => {
                hasNot(sweBash(cmd), DENY, 'text is data');
            });
        }
        for (const cmd of [
            'echo "$(gh pr merge 1)"',
            'GH_TOKEN=x gh api -X POST repos/o/r/issues',
            '/usr/bin/gh issue close 2',
            'glab mr merge 3',
            "printf 'x' | xargs gh pr merge",
            'sudo -u git gh pr merge 1',
            'env -u cat gh pr merge 1',
            'git bisect run gh pr merge 1',
            'git submodule foreach gh pr merge 1',
            "git rebase -x 'gh pr merge 1' main",
            'git submodule --quiet foreach gh pr merge 1',
            'git submodule -q foreach gh pr merge 1',
            "git rebase -ix 'gh pr merge 1' main",
            "git rebase -kx 'gh pr merge 1' main",
            "git rebase --exe='gh pr merge 1' main",
            "git rebase -i --exe 'gh pr merge 1' main",
            'git rebase -x "echo hi && gh pr merge 1" main',
            "git submodule foreach 'echo x; gh pr merge 1'",
        ]) {
            it(`GH 1281: SWE real gh/glab mutation '${cmd}': DENIED`, () => {
                has(sweBash(cmd), 'gh/glab mutating', 'a command-position forge write still fires');
            });
        }
    });
});
//# sourceMappingURL=swe-boundary-l3-forge.test.js.map