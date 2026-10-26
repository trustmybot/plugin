/**
 * stripLiterals against tmb_cmd_strip_literals of
 * scripts/hooks/lib/cmd-analysis.sh in its plain mode (GH 1692): the same
 * bytes for each command, in the C and UTF-8 locales.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripLiterals } from '../hooks/cmd-analysis/index.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = join(PLUGIN_ROOT, 'scripts/hooks/lib/cmd-analysis.sh');
const COMMANDS = [
    '',
    'git status',
    'cd /r && git switch feat/x && git merge --ff-only @{u}',
    "git commit -m 'a; b | c && d'",
    'echo "x > y" < in',
    "echo $'it\\'s a\\ttab; ok'",
    'echo "$(git rev-parse HEAD) and `date`"',
    'echo "$(printf "(x)" | tr x y)"',
    'echo "a\\"b" \\; c',
    'ls # git push --force',
    'echo a#b # trailing',
    '#!/bin/sh\ngit status',
    "cat <<EOF\ngit push --force origin main\nEOF\ngit status",
    "cat <<-'EOF'\n\tgit commit -m x\n\tEOF\necho done",
    'cat <<"A" <<B\nbody a\nA\nbody b\nB\nnext',
    'tr a b <<< "git push"',
    "echo 'open\nstill open' && git status",
    'echo "multi\nline" ; ls',
    'git switch\tfeat/x  &&   git merge --ff-only @{u}',
    'echo "ü — ß"; git log',
    'trailing newline\n',
    'cat << EOF\nunterminated body',
    'x=$(cat <<EOF\ninner\nEOF\n)',
];
function bash(command, locale) {
    const r = spawnSync('bash', ['-c', '. "$1"; tmb_cmd_strip_literals "$2"', '_', LIB, command], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: locale },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}
describe('stripLiterals matches tmb_cmd_strip_literals', () => {
    it("prints the .sh's bytes for every command (LC_ALL=C)", () => {
        for (const command of COMMANDS)
            assert.equal(stripLiterals(command), bash(command, 'C'), JSON.stringify(command));
    });
    it("prints the .sh's bytes for every ASCII command (LC_ALL=en_US.UTF-8)", () => {
        for (const command of COMMANDS.filter((c) => !/[^\x00-\x7f]/.test(c))) {
            assert.equal(stripLiterals(command), bash(command, 'en_US.UTF-8'), JSON.stringify(command));
        }
    });
    it('reads a non-ASCII command as the .sh does in C, in every locale (BSD awk fails on it under UTF-8)', () => {
        assert.equal(stripLiterals('echo "é"'), bash('echo "é"', 'C'));
    });
});
//# sourceMappingURL=cmd-strip-literals.test.js.map