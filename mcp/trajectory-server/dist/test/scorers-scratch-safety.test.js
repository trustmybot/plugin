// Keep failed scorer fixture setup from writing or committing in the caller's checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(root, 'tests/l5-l6/lib/scorers-test.sh');
const commands = Object.fromEntries(['mktemp', 'git', 'sqlite3'].map((name) => [name, execFileSync('which', [name], { encoding: 'utf8' }).trim()]));
function runFixture(failure) {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-scorers-safety-')));
    const outer = join(fixture, 'caller');
    const scratch = join(fixture, 'scratch');
    const shims = join(fixture, 'bin');
    const isolatedHome = join(fixture, 'home');
    for (const dir of [outer, scratch, shims, isolatedHome])
        mkdirSync(dir);
    writeFileSync(join(shims, 'package.json'), '{"type":"module"}\n');
    const env = { ...process.env, HOME: isolatedHome, TMPDIR: scratch, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (...args) => execFileSync(commands['git'], ['-C', outer, ...args], { env, encoding: 'utf8' }).trim();
    const callsFile = join(fixture, 'calls.jsonl');
    try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 'fixture@example.test');
        git('config', 'user.name', 'Fixture');
        writeFileSync(join(outer, 'README.md'), 'Caller checkout must stay unchanged.\n');
        writeFileSync(join(outer, 'staged.txt'), 'original\n');
        git('add', '.');
        git('commit', '-qm', 'caller sentinel');
        writeFileSync(join(outer, 'staged.txt'), 'staged change must survive\n');
        git('add', 'staged.txt');
        const snapshot = () => ({
            readme: readFileSync(join(outer, 'README.md'), 'utf8'),
            head: git('rev-parse', 'HEAD'),
            index: git('write-tree'),
            status: git('status', '--porcelain=v1', '--untracked-files=all'),
        });
        const before = snapshot();
        writeFileSync(join(scratch, 'keep.txt'), 'unowned sibling\n');
        const config = { commands, failure, outer, callsFile, counter: join(fixture, 'mktemp-count') };
        const shim = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const config = ${JSON.stringify(config)};
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(config.callsFile, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'mktemp') {
  const n = existsSync(config.counter) ? Number(readFileSync(config.counter, 'utf8')) + 1 : 1;
  writeFileSync(config.counter, String(n));
  if ((config.failure === 'root' || config.failure === 'empty-root') && n === 1) {
    process.stderr.write('forced scratch allocation failure\\n');
    process.exit(config.failure === 'empty-root' ? 0 : 97);
  }
  if ((config.failure === 'project' && n === 2) || (config.failure === 'flow' && n === 3)) {
    // A failing allocator's stdout must never become a usable fixture path.
    process.stdout.write(config.outer + '\\n');
    process.exit(97);
  }
}
if ((tool === 'git' && config.failure === 'git-' + args[0]) || (tool === 'sqlite3' && config.failure === 'sqlite')) {
  process.stderr.write('forced fixture setup failure\\n');
  process.exit(97);
}
const result = spawnSync(config.commands[tool], args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`;
        for (const name of Object.keys(commands))
            writeFileSync(join(shims, name), shim, { mode: 0o755 });
        const run = spawnSync('bash', [script], {
            cwd: outer,
            env: { ...env, PATH: `${shims}${delimiter}${process.env.PATH ?? ''}`, TMB_DISABLE_REMOTE_SYNC: '1' },
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.equal(run.error, undefined, String(run.error));
        assert.deepEqual(snapshot(), before, 'fixture setup must preserve the caller README, HEAD and staged index');
        assert.equal(readFileSync(join(scratch, 'keep.txt'), 'utf8'), 'unowned sibling\n');
        assert.deepEqual(readdirSync(scratch), ['keep.txt'], 'remove only the owned scratch root, including all its fixtures');
        const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        return { output: run.stdout + run.stderr, status: run.status, calls };
    }
    finally {
        rmSync(fixture, { recursive: true, force: true });
    }
}
describe('scorer fixture setup fails closed (GH 2160)', () => {
    for (const failure of ['root', 'empty-root', 'project', 'flow', 'git-init', 'git-config', 'git-add', 'git-commit', 'sqlite']) {
        it(`stops on ${failure} failure without changing the caller checkout`, () => {
            const run = runFixture(failure);
            assert.notEqual(run.status, 0, run.output);
            assert.doesNotMatch(run.output, /^\s+(?:PASS|FAIL) /m, 'no scorer runs after setup fails');
            if (['root', 'empty-root', 'project'].includes(failure)) {
                assert.ok(run.calls.every(([tool]) => tool === 'mktemp'), 'no Git or database setup after allocation fails');
            }
            else if (failure.startsWith('git-')) {
                assert.deepEqual(run.calls.at(-1)?.slice(0, 2), ['git', failure.slice(4)]);
            }
            else if (failure === 'sqlite') {
                assert.equal(run.calls.at(-1)?.[0], 'sqlite3');
            }
        });
    }
    it('runs every existing scorer assertion and cleans its owned fixtures', () => {
        const run = runFixture('none');
        const summary = /scorers-test: (\d+) pass \/ (\d+) fail/.exec(run.output);
        assert.ok(summary, run.output);
        assert.equal(Number(summary[1]) + Number(summary[2]), 31, 'retain all existing scorer assertions');
        assert.equal(run.status, Number(summary[2]) === 0 ? 0 : 1, 'retain the existing scorer verdict');
    });
});
//# sourceMappingURL=scorers-scratch-safety.test.js.map