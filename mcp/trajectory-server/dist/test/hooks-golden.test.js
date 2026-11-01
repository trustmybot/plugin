/**
 * The golden-master recordings (GH 1692): every gate and corpus payload has an
 * entry, every parity suite reads its bash side through goldenBash, the default
 * mode never runs the live side, a recording depends on no checkout or temp
 * path, and a changed recording fails a TypeScript result that matched.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandRoots, GENERIC_CASE_PREFIX, GOLDEN_DIR, goldenBash, goldenGates, goldenLocales, goldenRoots, goldenStore, sandboxSha, settledTree, tokenizeRoots, } from './golden.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const SUITES = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/test');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const REQUIRED_LOCALES = ['C', 'en_US.UTF-8'];
function corpusFiles(gate) {
    return readdirSync(join(CORPUS_ROOT, gate)).filter((f) => f.endsWith('.json'));
}
function withRecord(body) {
    const saved = process.env.TMB_HOOK_GOLDEN;
    process.env.TMB_HOOK_GOLDEN = 'record';
    try {
        return body();
    }
    finally {
        if (saved === undefined)
            delete process.env.TMB_HOOK_GOLDEN;
        else
            process.env.TMB_HOOK_GOLDEN = saved;
    }
}
function withDefaultMode(body) {
    const saved = process.env.TMB_HOOK_GOLDEN;
    delete process.env.TMB_HOOK_GOLDEN;
    try {
        return body();
    }
    finally {
        if (saved !== undefined)
            process.env.TMB_HOOK_GOLDEN = saved;
    }
}
const noLive = () => {
    throw new Error('the live side ran');
};
function coverageProblems(gates, goldenDir) {
    return gates.flatMap((gate) => {
        const entries = goldenLocales(gate, goldenDir);
        const names = Object.keys(entries);
        if (names.length === 0)
            return [`${gate}: no recording`];
        const payloads = new Set(corpusFiles(gate));
        const missing = [...payloads].filter((f) => entries[f] === undefined && entries[`${GENERIC_CASE_PREFIX}${f}`] === undefined).map((f) => `${gate}/${f}: no entry`);
        const stale = names.filter((name) => !payloads.has(name.replace(GENERIC_CASE_PREFIX, ''))).map((name) => `${gate}/${name}: entry with no corpus payload`);
        const thin = names
            .filter((name) => REQUIRED_LOCALES.some((l) => !entries[name].includes(l)))
            .map((name) => `${gate}/${name}: recorded under ${entries[name].join(',')}, needs ${REQUIRED_LOCALES.join(',')}`);
        const uneven = names
            .filter((name) => name.startsWith(GENERIC_CASE_PREFIX) === names[0].startsWith(GENERIC_CASE_PREFIX) && entries[name].join() !== entries[names[0]].join())
            .map((name) => `${gate}/${name}: recorded under ${entries[name].join(',')}, ${names[0]} under ${entries[names[0]].join(',')}`);
        return [...missing, ...stale, ...thin, ...uneven];
    });
}
function spansOf(text, opener) {
    return [...text.matchAll(new RegExp(opener.source, 'g'))].flatMap((match) => {
        const start = match.index + match[0].length - 1;
        const [open, close] = text[start] === '(' ? ['(', ')'] : ['{', '}'];
        let depth = 0;
        for (let at = start; at < text.length; at++) {
            if (text[at] === open)
                depth++;
            else if (text[at] === close && --depth === 0)
                return [[start, at]];
        }
        return [];
    });
}
const SCRIPT_PATH = /\b(?:join|resolve)\([^)]*scripts\/hooks[^)]*\.sh\b/;
const BASH_SPAWN = /\brun\((?:'bash'|BASH),/;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;
/** A `const` whose only calls build the path names the script without touching it: its uses are what count. */
function isPathOnly(line) {
    return /^\s*const \w+ =/.test(line) && !/\b(?!join\b|resolve\b)\w+\(/.test(line);
}
function scriptAliases(lines) {
    return lines.filter((line) => SCRIPT_PATH.test(line) && isPathOnly(line)).map((line) => /const (\w+) =/.exec(line)[1]);
}
/** Each line of a suite that spawns, reads or copies a gate .sh where default mode would run it: outside every goldenBash thunk and every `name === 'bash'` line of runSide, unless isRecording() guards it. */
function scriptTouchesOutsideGolden(text) {
    const lines = text.split('\n');
    const thunks = spansOf(text, /\bgoldenBash(?:<[^>\n]*>)?\(/);
    const runSides = spansOf(text, /\bconst runSide = [^\n]*\{/);
    const within = (spans, at) => spans.some(([start, end]) => start <= at && at <= end);
    const aliasUses = scriptAliases(lines).map((alias) => new RegExp(`[(\\[,]\\s*${alias}\\b`));
    let offset = 0;
    return lines.flatMap((line, i) => {
        const lineStart = offset;
        offset += line.length + 1;
        if (COMMENT_LINE.test(line) || /\bisRecording\(\)/.test(line))
            return [];
        const touches = [BASH_SPAWN, ...aliasUses, ...(isPathOnly(line) ? [] : [SCRIPT_PATH])].map((touch) => line.search(touch)).filter((column) => column >= 0);
        const outside = touches.some((column) => {
            const at = lineStart + column;
            return !within(thunks, at) && !(within(runSides, at) && line.includes("name === 'bash'"));
        });
        return outside ? [`line ${i + 1}: ${line.trim()}`] : [];
    });
}
describe('hook golden recordings', () => {
    describe('coverage', () => {
        const gates = readdirSync(CORPUS_ROOT).sort();
        it('every scripts/hooks/*.sh but dispatch.sh has a corpus, so the checks below cover it', () => {
            const scripts = readdirSync(join(PLUGIN_ROOT, 'scripts/hooks'))
                .filter((f) => f.endsWith('.sh') && f !== 'dispatch.sh')
                .map((f) => f.slice(0, -'.sh'.length));
            assert.deepEqual(scripts.filter((gate) => !gates.includes(gate)), []);
        });
        it('every gate and corpus payload has an entry in both required locales, and no entry outlives its payload', () => {
            assert.deepEqual(coverageProblems(gates, GOLDEN_DIR), []);
            assert.deepEqual(goldenGates(), gates);
        });
        it('self-test: a gate or a payload with no entry fails the check', () => {
            const dir = mkdtempSync(join(tmpdir(), 'tmb-golden-coverage-'));
            try {
                const gate = 'git-guards';
                const [first, second, ...rest] = corpusFiles(gate);
                const entry = { [REQUIRED_LOCALES.join(',')]: { code: 0, stdout: '' } };
                writeFileSync(join(dir, `${gate}.json`), JSON.stringify(Object.fromEntries([first, ...rest, 'gone.json'].map((f) => [f, entry]))));
                const problems = coverageProblems([gate, 'worktree-create'], dir);
                assert.ok(problems.includes(`${gate}/${second}: no entry`), problems.join('\n'));
                assert.ok(problems.includes(`${gate}/gone.json: entry with no corpus payload`), problems.join('\n'));
                assert.ok(problems.includes('worktree-create: no recording'), problems.join('\n'));
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it('no recording holds a path of this checkout, this home or a temp sandbox', () => {
            const leaks = [PLUGIN_ROOT, homedir()];
            for (const gate of goldenGates()) {
                const text = readFileSync(join(GOLDEN_DIR, `${gate}.json`), 'utf8');
                for (const leak of leaks)
                    assert.ok(!text.includes(leak), `${gate}: holds ${leak}`);
                assert.doesNotMatch(text, /tmb-[a-z-]+-parity-|\/private\/(tmp|var)\/|\/var\/folders\//, `${gate}: holds a temp sandbox path`);
            }
        });
    });
    describe('every parity suite', () => {
        const suites = readdirSync(SUITES).filter((f) => /^hooks-.*parity\.suite\.ts$/.test(f));
        it('finds the suites', () => {
            assert.ok(suites.length >= 24, `${suites.length} suites`);
        });
        for (const suite of suites) {
            it(`${suite} spawns, reads or copies a .sh only inside a goldenBash thunk`, () => {
                const text = readFileSync(join(SUITES, suite), 'utf8');
                assert.match(text, /goldenBash\(/);
                assert.match(text, BASH_SPAWN, 'the suite names its live side');
                assert.deepEqual(scriptTouchesOutsideGolden(text), []);
                if (suite.includes('task-close'))
                    assert.match(text, /goldenBash\([^\n]*runSide\('bash'\)\)/);
            });
        }
    });
    describe('the .sh check', () => {
        const flagged = (body) => scriptTouchesOutsideGolden(body).length;
        it('flags a spawn, a read or a copy of a gate .sh outside a thunk', () => {
            assert.equal(flagged("run('bash', [join(PLUGIN_ROOT, 'scripts/hooks/x.sh')], c);"), 1);
            assert.equal(flagged("cpSync(join(PLUGIN_ROOT, `scripts/hooks/${RESCAN_GATE}.sh`), join(plugin, `scripts/hooks/${RESCAN_GATE}.sh`));"), 1);
            assert.equal(flagged("const text = readFileSync(join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`), 'utf8');"), 1);
            assert.equal(flagged("const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/x.sh');\nconst text = readFileSync(HOOK_SH, 'utf8');"), 1);
            assert.equal(flagged("goldenBash(g, f, l, r, () => 1);\ncpSync(join(PLUGIN_ROOT, 'scripts/hooks/x.sh'), to);"), 1);
            assert.equal(flagged("const runSide = (name) => {\n  cpSync(join(PLUGIN_ROOT, 'scripts/hooks/x.sh'), to);\n};"), 1);
        });
        it('passes one inside a thunk, on the bash line of runSide, or guarded by record mode', () => {
            assert.equal(flagged("const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/x.sh');\ngoldenBash(g, f, l, r, () => {\n  return run('bash', [HOOK_SH], c);\n});"), 0);
            assert.equal(flagged("goldenBash(g, f, l, r, () => run('bash', [join(PLUGIN_ROOT, 'scripts/hooks/x.sh')], c));"), 0);
            assert.equal(flagged("const runSide = (name) => {\n  if (name === 'bash') cpSync(join(PLUGIN_ROOT, 'scripts/hooks/x.sh'), to);\n};"), 0);
            assert.equal(flagged("const gates = all.filter((g) => (isRecording() ? existsSync(join(PLUGIN_ROOT, 'scripts/hooks', `${g}.sh`)) : true));"), 0);
            assert.equal(flagged("const ps = ['bash /x/scripts/hooks/orphan-scan.sh'];"), 0);
        });
    });
    describe('with the gate scripts gone', () => {
        it('the task-close parity suite passes in default mode, its sandbox setup included', { timeout: 300_000 }, () => {
            const dir = mkdtempSync(join(tmpdir(), 'tmb-golden-no-sh-'));
            const scripts = join(PLUGIN_ROOT, 'scripts/hooks');
            try {
                cpSync(PLUGIN_ROOT, dir, {
                    recursive: true,
                    filter: (src) => {
                        const name = basename(src);
                        if (src !== PLUGIN_ROOT && ['node_modules', '.git', '.claude'].includes(name))
                            return false;
                        return !(dirname(src) === scripts && name.endsWith('.sh') && name !== 'dispatch.sh');
                    },
                });
                const tests = join(dir, 'mcp/trajectory-server/dist/test');
                const shards = readdirSync(tests).filter((f) => /^hooks-task-close-parity.*\.test\.js$/.test(f));
                assert.ok(shards.length > 0, 'the task-close shards');
                const env = { ...process.env };
                delete env.NODE_TEST_CONTEXT;
                delete env.TMB_HOOK_GOLDEN;
                const r = spawnSync(process.execPath, ['--experimental-sqlite', '--test', ...shards.map((f) => join(tests, f))], { cwd: join(dir, 'mcp/trajectory-server'), env, encoding: 'utf8' });
                assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
    describe('goldenBash', () => {
        let dir;
        const roots = { '@SANDBOX@': '/sandbox/one', '@PLUGIN_ROOT@': '/checkout/plugin', '@HOME@': '/checkout' };
        const value = { code: 0, stdout: 'see /sandbox/one/x and /checkout/plugin/y and /checkout/z and /sandbox/one-other', tree: ['/sandbox/one/'] };
        before(() => {
            dir = mkdtempSync(join(tmpdir(), 'tmb-golden-'));
        });
        after(() => {
            rmSync(dir, { recursive: true, force: true });
        });
        it('default mode reads the recording and never calls live', () => {
            const store = goldenStore(dir);
            withRecord(() => store('default-gate', 'a.json', 'C', roots, () => value));
            assert.deepEqual(withDefaultMode(() => store('default-gate', 'a.json', 'C', roots, noLive)), value);
        });
        it('default mode reads a real recording without running the .sh', () => {
            const gate = 'askuserquestion-length-lint';
            const [file] = corpusFiles(gate);
            const read = withDefaultMode(() => goldenBash(gate, `${GENERIC_CASE_PREFIX}${file}`, 'C', goldenRoots({}), noLive));
            assert.equal(typeof read.code, 'number');
        });
        it('a missing entry fails, naming the gate and case; a missing locale too', () => {
            const store = goldenStore(dir);
            withRecord(() => store('missing-gate', 'a.json', 'C', roots, () => value));
            withDefaultMode(() => {
                assert.throws(() => store('missing-gate', 'b.json', 'C', roots, noLive), /missing-gate \/ b\.json \(LC_ALL=C\)/);
                assert.throws(() => store('missing-gate', 'a.json', 'UTF-8', roots, noLive), /missing-gate \/ a\.json \(LC_ALL=UTF-8\)/);
                assert.throws(() => store('no-such-gate', 'a.json', 'C', roots, noLive), /no-such-gate \/ a\.json/);
            });
        });
        it('an unknown TMB_HOOK_GOLDEN mode fails instead of comparing', () => {
            const saved = process.env.TMB_HOOK_GOLDEN;
            process.env.TMB_HOOK_GOLDEN = 'recrod';
            try {
                assert.throws(() => goldenStore(dir)('default-gate', 'a.json', 'C', roots, noLive), /the only mode is record/);
            }
            finally {
                if (saved === undefined)
                    delete process.env.TMB_HOOK_GOLDEN;
                else
                    process.env.TMB_HOOK_GOLDEN = saved;
            }
        });
        it('a token round trip restores the paths, the longest first, and stores none of them', () => {
            const tokenized = tokenizeRoots(value, roots);
            const text = JSON.stringify(tokenized);
            assert.equal(text.includes('/sandbox/one/'), false, text);
            assert.equal(text.includes('/checkout/'), false, text);
            assert.ok(text.includes('@PLUGIN_ROOT@/y'), text);
            assert.ok(text.includes('@HOME@/z'), text);
            assert.ok(text.includes('/sandbox/one-other'), 'a longer name is not the root');
            assert.deepEqual(expandRoots(tokenized, roots), value);
            assert.deepEqual(expandRoots(tokenized, { '@SANDBOX@': '/other', '@PLUGIN_ROOT@': '/elsewhere/p', '@HOME@': '/h' }), {
                code: 0,
                stdout: 'see /other/x and /elsewhere/p/y and /h/z and /sandbox/one-other',
                tree: ['/other/'],
            });
        });
        it('the raw and realpath spellings of a root each come back as they were', () => {
            const real = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-golden-real-')));
            const link = `${real}-link`;
            try {
                spawnSync('ln', ['-s', real, link]);
                const both = { '@SANDBOX@': link };
                const seen = { raw: `${link}/a`, real: `${real}/b` };
                const tokenized = tokenizeRoots(seen, both);
                assert.deepEqual(tokenized, { raw: '@SANDBOX@/a', real: '@SANDBOX:real@/b' });
                assert.deepEqual(expandRoots(tokenized, both), seen);
            }
            finally {
                rmSync(link, { force: true });
                rmSync(real, { recursive: true, force: true });
            }
        });
        it('stores one value when the locales agree, one per locale where they differ, in any recording order', () => {
            const recordAll = (name, order) => {
                const store = goldenStore(dir);
                withRecord(() => {
                    for (const [locale, stdout] of order)
                        store(name, 'a.json', locale, {}, () => ({ stdout, code: 0 }));
                });
                return readFileSync(join(dir, `${name}.json`), 'utf8');
            };
            const agree = JSON.parse(recordAll('agree', [['UTF-8', 'x'], ['C', 'x'], ['en_US.UTF-8', 'x']]));
            assert.deepEqual(Object.keys(agree['a.json']), ['C,UTF-8,en_US.UTF-8']);
            const one = recordAll('one', [['C', 'a'], ['UTF-8', 'b'], ['en_US.UTF-8', 'b']]);
            const two = recordAll('two', [['en_US.UTF-8', 'b'], ['UTF-8', 'b'], ['C', 'a']]);
            assert.equal(one, two);
            assert.deepEqual(Object.keys(JSON.parse(one)['a.json']).sort(), ['C', 'UTF-8,en_US.UTF-8']);
        });
        it('re-recording a locale moves it out of the group it shared', () => {
            const store = goldenStore(dir);
            withRecord(() => {
                for (const locale of ['C', 'UTF-8'])
                    store('moved', 'a.json', locale, {}, () => ({ stdout: 'same' }));
                store('moved', 'a.json', 'C', {}, () => ({ stdout: 'changed' }));
            });
            assert.deepEqual(withDefaultMode(() => store('moved', 'a.json', 'C', {}, noLive)), { stdout: 'changed' });
            assert.deepEqual(withDefaultMode(() => store('moved', 'a.json', 'UTF-8', {}, noLive)), { stdout: 'same' });
        });
        it('a settled tree hides only the hashes a run left alone', () => {
            const a = 'a'.repeat(64);
            const b = 'b'.repeat(64);
            const before = { 'kept': a, 'edited': a, 'removed': a, 'dir/': null, 'db': '{"rows":1}' };
            const after = { 'kept': a, 'edited': b, 'added': b, 'dir/': null, 'db': '{"rows":1}' };
            assert.deepEqual(settledTree(before, after), { 'kept': '<unchanged>', 'edited': b, 'added': b, 'dir/': null, 'db': '{"rows":1}' });
        });
        it('a sandbox hash does not depend on where the sandbox is', () => {
            const one = mkdtempSync(join(tmpdir(), 'tmb-golden-sha-'));
            const two = mkdtempSync(join(tmpdir(), 'tmb-golden-sha-'));
            try {
                writeFileSync(join(one, 'f'), `root=${one}\n`);
                writeFileSync(join(two, 'f'), `root=${two}\n`);
                assert.equal(sandboxSha(join(one, 'f'), one), sandboxSha(join(two, 'f'), two));
                writeFileSync(join(two, 'f'), `root=${two}!\n`);
                assert.notEqual(sandboxSha(join(one, 'f'), one), sandboxSha(join(two, 'f'), two));
            }
            finally {
                rmSync(one, { recursive: true, force: true });
                rmSync(two, { recursive: true, force: true });
            }
        });
        it('writes sorted keys in a stable format, and leaves no lock or temp file', () => {
            const store = goldenStore(dir);
            withRecord(() => {
                store('sorted', 'b.json', 'C', {}, () => ({ z: 1, a: { y: 1, b: 2 } }));
                store('sorted', 'a.json', 'C', {}, () => ({ z: 1 }));
            });
            assert.equal(readFileSync(join(dir, 'sorted.json'), 'utf8'), `${JSON.stringify({ 'a.json': { C: { z: 1 } }, 'b.json': { C: { a: { b: 2, y: 1 }, z: 1 } } }, null, 2)}\n`);
            assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('sorted') && f !== 'sorted.json'), []);
        });
    });
    describe('a recording bites', () => {
        const gate = 'askuserquestion-length-lint';
        const locale = 'C';
        let dir;
        let caseName;
        let tsSide;
        const parity = (bash) => {
            assert.equal(tsSide.code, bash.code, 'exit code');
            assert.deepEqual(tsSide.stdout.trim() === '' ? null : JSON.parse(tsSide.stdout), bash.stdout.trim() === '' ? null : JSON.parse(bash.stdout), 'stdout');
        };
        const mutated = (change) => {
            const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, `${gate}.json`), 'utf8'));
            for (const group of Object.values(golden[caseName]))
                change(group);
            writeFileSync(join(dir, `${gate}.json`), JSON.stringify(golden));
            return withDefaultMode(() => goldenStore(dir)(gate, caseName, locale, goldenRoots({}), noLive));
        };
        before(() => {
            dir = mkdtempSync(join(tmpdir(), 'tmb-golden-bites-'));
            const file = corpusFiles(gate).find((f) => {
                const r = spawnSync(process.execPath, [HOOKS_BUNDLE, gate], { input: readFileSync(join(CORPUS_ROOT, gate, f)), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: dir, LC_ALL: locale } });
                return r.stdout.trim() !== '';
            });
            assert.ok(file, `${gate}: a payload whose TypeScript side prints`);
            caseName = `${GENERIC_CASE_PREFIX}${file}`;
            const r = spawnSync(process.execPath, [HOOKS_BUNDLE, gate], { input: readFileSync(join(CORPUS_ROOT, gate, file)), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: dir, LC_ALL: locale } });
            tsSide = { code: r.status, stdout: r.stdout };
        });
        after(() => {
            rmSync(dir, { recursive: true, force: true });
        });
        it('the TypeScript result matches the stored recording', () => {
            assert.ok(existsSync(join(GOLDEN_DIR, `${gate}.json`)));
            parity(withDefaultMode(() => goldenBash(gate, caseName, locale, goldenRoots({}), noLive)));
        });
        it('a changed stored exit code fails that same result', () => {
            assert.throws(() => parity(mutated((s) => { s.code = (s.code ?? 0) + 1; })), /exit code/);
        });
        it('a changed stored stdout fails that same result', () => {
            assert.throws(() => parity(mutated((s) => { s.stdout = '{"changed":true}\n'; })), /stdout/);
        });
    });
});
//# sourceMappingURL=hooks-golden.test.js.map