/**
 * The ensure-mcp-deps-installed gate and its install worker (GH 1695), on temp
 * plugin roots, data dirs and plugin caches only. Stub `bun` / `npm` on PATH
 * record each call and write a fake transformers tree, so nothing reaches a
 * registry, the real ~/.claude/plugins or the real CLAUDE_PLUGIN_DATA.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync, } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_TOKEN_ENV, ensureBridge, installRuntimeDeps, isValidInstall, releaseLock, takeLock, } from '../hooks/ensure-mcp-deps-installed.js';
import { TRANSFORMERS_VERSION, pinnedTransformersVersion, runtimeDepsKey, runtimeDepsRoot, transformersEsmEntry, } from '../runtime-deps.js';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER_DIR = join(PLUGIN_ROOT, 'mcp/trajectory-server');
const RUNTIME_DEPS = join(SERVER_DIR, 'runtime-deps');
const HOOKS_BUNDLE = join(SERVER_DIR, 'dist/hooks.js');
const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/ensure-mcp-deps-installed.sh');
const PKG = '@huggingface/transformers';
const DATA_ARGS = 'install --frozen-lockfile --production --ignore-scripts';
const LEGACY_BUN_ARGS = 'install --production --ignore-scripts --no-save';
const STUB_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2).join(' ');
const lockOwner = () => {
  try {
    return fs.readFileSync(path.join(process.env.STUB_LOCK, 'owner'), 'utf8');
  } catch {
    return '';
  }
};
if (process.env.STUB_RECORD) {
  fs.appendFileSync(process.env.STUB_RECORD, [process.cwd(), name, args, process.env.BUN_INSTALL_CACHE_DIR || '', process.env.npm_config_cache || '', process.env.TMB_MCP_DEPS_LOCK_TOKEN || '', process.env.STUB_LOCK ? lockOwner() : ''].join('|') + '\\n');
}
if (process.env.STUB_FAIL === '1') process.exit(1);
if (args.includes('--no-save')) process.exit(0);
const nm = path.join(process.cwd(), 'node_modules');
const put = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(nm, rel)), { recursive: true });
  fs.writeFileSync(path.join(nm, rel), body);
};
const tf = '@huggingface/transformers';
put(tf + '/package.json', JSON.stringify({
  name: tf,
  version: process.env.STUB_VERSION || '${TRANSFORMERS_VERSION}',
  main: './src/transformers.js',
  exports: {
    node: { import: { default: './dist/transformers.node.mjs' }, require: { default: './dist/transformers.node.cjs' } },
    default: { default: './dist/transformers.web.js' },
  },
}));
put(tf + '/dist/transformers.node.mjs', "export const pipeline = () => 'stub';\\n");
put(tf + '/dist/transformers.node.cjs', "exports.pipeline = () => 'stub';\\n");
for (const extra of ['transformers.node.min.mjs', 'transformers.node.mjs.map', 'transformers.web.js', 'transformers.js']) put(tf + '/dist/' + extra, 'x');
put(tf + '/src/transformers.js', 'x');
put(tf + '/types/transformers.d.ts', 'x');
put('onnxruntime-node/package.json', '{"name":"onnxruntime-node"}');
for (const p of ['darwin', 'linux', 'win32']) for (const a of ['arm64', 'x64']) put('onnxruntime-node/bin/napi-v3/' + p + '/' + a + '/onnxruntime_binding.node', 'x');
put('onnxruntime-web/package.json', '{"name":"onnxruntime-web"}');
put('onnxruntime-web/dist/ort.wasm', 'x');
`;
let base;
function writeStub(dir, name) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(dir, name), `#!${process.execPath}\n${STUB_SOURCE}`);
    chmodSync(join(dir, name), 0o755);
}
function dir(...parts) {
    const path = join(base, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
}
/** A plugin root holding the MCP package.json and the committed runtime-deps manifest, or one pinning `pin`. */
function fakeRoot(path, pin) {
    const mcp = join(path, 'mcp/trajectory-server');
    mkdirSync(mcp, { recursive: true });
    writeFileSync(join(mcp, 'package.json'), JSON.stringify({ name: 'traj', type: 'module' }));
    cpSync(RUNTIME_DEPS, join(mcp, 'runtime-deps'), { recursive: true });
    if (pin !== undefined) {
        const manifest = join(mcp, 'runtime-deps/package.json');
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        parsed.dependencies[PKG] = pin;
        writeFileSync(manifest, JSON.stringify(parsed));
    }
    return path;
}
/** A valid install of transformers `version` for this host under `<data>/deps/<key>`, without any package manager. */
function fakeKey(dataDir, version, at) {
    const key = runtimeDepsKey(process.platform, process.arch, version);
    const pkg = join(dataDir, 'deps', key, 'node_modules', PKG);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: PKG,
        version,
        exports: { node: { import: { default: './dist/transformers.node.mjs' } } },
    }));
    writeFileSync(join(pkg, 'dist/transformers.node.mjs'), "export const pipeline = () => 'stub';\n");
    writeFileSync(join(dataDir, 'deps', key, '.installed-at'), `${at}\n`);
    return key;
}
/** The transformers version a root's bridge resolves to, read through its realpath. */
function resolvedVersion(root) {
    const real = realpathSync(join(root, 'node_modules', PKG));
    return JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')).version;
}
function records(file) {
    if (!existsSync(file))
        return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split('|'));
}
function install(root, dataDir, env, opts = {}) {
    const log = [];
    const rc = installRuntimeDeps({
        root,
        dataDir,
        env,
        platform: opts.platform,
        arch: opts.arch,
        now: opts.at ? () => new Date(opts.at) : undefined,
        log: (m) => log.push(m),
        stdio: 'ignore',
    });
    return { rc, log };
}
function keyDirs(dataDir) {
    return readdirSync(join(dataDir, 'deps'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
}
/** Every entry under `path`: its type and its bytes or link target. */
function snapshot(path) {
    const out = [];
    const walk = (rel) => {
        const abs = join(path, rel);
        const st = lstatSync(abs);
        if (st.isSymbolicLink())
            out.push([rel, `link:${readlinkSync(abs)}`]);
        else if (st.isDirectory()) {
            out.push([rel, 'dir']);
            for (const name of readdirSync(abs).sort())
                walk(join(rel, name));
        }
        else
            out.push([rel, `file:${readFileSync(abs, 'base64')}`]);
    };
    walk('');
    return out;
}
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Waits, at most 400 polls, for the detached worker to drop its lock. */
function waitUnlocked(lock) {
    for (let i = 0; i < 400 && existsSync(lock); i++)
        sleepMs(50);
    assert.equal(existsSync(lock), false, `the worker released ${lock}`);
}
function runNode(env) {
    const r = spawnSync(process.execPath, [HOOKS_BUNDLE, 'ensure-mcp-deps-installed'], {
        input: '{"hook_event_name":"SessionStart","session_id":"s1"}',
        env,
        cwd: base,
        encoding: 'utf8',
    });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout };
}
function runBash(env) {
    const r = spawnSync('/bin/bash', [HOOK_SH], {
        input: '{"hook_event_name":"SessionStart","session_id":"s1"}',
        env,
        cwd: base,
        encoding: 'utf8',
    });
    if (r.error)
        throw r.error;
    return { code: r.status, stdout: r.stdout };
}
function context(stdout) {
    return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}
function bridgeTarget(dataDir, key = runtimeDepsKey()) {
    return join(dataDir, 'deps', key, 'node_modules', PKG);
}
/** A PATH of symlinks to the tools the .sh needs, plus the stub dir: no real bun or npm. */
function toolPath(stubDir) {
    const tools = dir('tools');
    for (const tool of ['jq', 'dirname', 'basename', 'find', 'mkdir', 'rmdir', 'date', 'sqlite3', 'od', 'tr', 'cat', 'sed', 'awk', 'grep', 'head', 'env', 'sleep']) {
        if (existsSync(join(tools, tool)))
            continue;
        const found = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        if (found.startsWith('/'))
            cpSymlink(found, join(tools, tool));
    }
    if (!existsSync(join(tools, 'node')))
        cpSymlink(process.execPath, join(tools, 'node'));
    return `${stubDir}:${tools}`;
}
function cpSymlink(target, link) {
    spawnSync('/bin/ln', ['-s', target, link]);
}
function driftProblems(version, files) {
    const problems = [];
    const runtime = JSON.parse(readFileSync(files.runtimeManifest, 'utf8')).dependencies?.[PKG];
    if (runtime !== version)
        problems.push(`runtime-deps/package.json pins ${runtime}`);
    const locked = /"@huggingface\/transformers@([^"]+)"/.exec(readFileSync(files.runtimeLock, 'utf8'))?.[1];
    if (locked !== version)
        problems.push(`runtime-deps/bun.lock locks ${locked}`);
    const server = JSON.parse(readFileSync(files.serverManifest, 'utf8')).dependencies?.[PKG];
    if (server !== version)
        problems.push(`server package.json pins ${server}`);
    return problems;
}
const COMMITTED = {
    runtimeManifest: join(RUNTIME_DEPS, 'package.json'),
    runtimeLock: join(RUNTIME_DEPS, 'bun.lock'),
    serverManifest: join(SERVER_DIR, 'package.json'),
};
describe('ensure-mcp-deps-installed (GH 1695)', () => {
    let bunDir;
    let npmDir;
    let emptyDir;
    before(() => {
        base = mkdtempSync(join(tmpdir(), 'tmb-ensure-mcp-deps-'));
        bunDir = dir('stub-bun');
        npmDir = dir('stub-npm');
        emptyDir = dir('stub-none');
        writeStub(bunDir, 'bun');
        writeStub(npmDir, 'npm');
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    describe('version drift', () => {
        it('TRANSFORMERS_VERSION matches runtime-deps/package.json, runtime-deps/bun.lock and the server package.json', () => {
            assert.deepEqual(driftProblems(TRANSFORMERS_VERSION, COMMITTED), []);
        });
        it('self-test: a different version fails on all three', () => {
            assert.equal(driftProblems('0.0.0-drift', COMMITTED).length, 3);
        });
        it('the key is version-platform-arch and the root sits under <data>/deps', () => {
            assert.equal(runtimeDepsKey('linux', 'x64'), `${TRANSFORMERS_VERSION}-linux-x64`);
            assert.equal(runtimeDepsRoot('/d', 'k'), '/d/deps/k');
            assert.equal(runtimeDepsRoot(''), undefined);
        });
        it('a manifest\'s pin is read only when it is one exact version, so it never escapes <data>/deps as a key', () => {
            assert.equal(pinnedTransformersVersion(RUNTIME_DEPS), TRANSFORMERS_VERSION);
            assert.equal(runtimeDepsKey('linux', 'x64', '3.0.0'), '3.0.0-linux-x64');
            for (const [i, pin] of ['^3.0.0', '../../x', '3.0.0/..', 'latest'].entries()) {
                const root = fakeRoot(dir('pin', `p${i}`), pin);
                assert.equal(pinnedTransformersVersion(join(root, 'mcp/trajectory-server/runtime-deps')), undefined, pin);
            }
            assert.equal(pinnedTransformersVersion(dir('pin/no-manifest')), undefined);
        });
        it('the root defaults to CLAUDE_PLUGIN_DATA and is undefined when it is unset', () => {
            const saved = process.env.CLAUDE_PLUGIN_DATA;
            try {
                delete process.env.CLAUDE_PLUGIN_DATA;
                assert.equal(runtimeDepsRoot(), undefined);
                process.env.CLAUDE_PLUGIN_DATA = '/env-data';
                assert.equal(runtimeDepsRoot(), join('/env-data', 'deps', runtimeDepsKey()));
            }
            finally {
                if (saved === undefined)
                    delete process.env.CLAUDE_PLUGIN_DATA;
                else
                    process.env.CLAUDE_PLUGIN_DATA = saved;
            }
        });
    });
    describe('install and retention', () => {
        it('three successive keys leave two key dirs, current → the newest, a pruned tree and the sharp stub', () => {
            const root = fakeRoot(dir('retain/root'));
            const data = dir('retain/data');
            const env = { PATH: bunDir, STUB_RECORD: join(base, 'retain.rec') };
            const keys = [
                ['darwin', 'arm64', '2026-01-01T00:00:00.000Z'],
                ['linux', 'x64', '2026-01-02T00:00:00.000Z'],
                ['linux', 'arm64', '2026-01-03T00:00:00.000Z'],
            ];
            for (const [platform, arch, at] of keys) {
                assert.equal(install(root, data, env, { platform, arch, at }).rc, 0);
            }
            const newest = runtimeDepsKey('linux', 'arm64');
            assert.deepEqual(keyDirs(data), [runtimeDepsKey('linux', 'x64'), newest].sort());
            assert.equal(readlinkSync(join(data, 'deps/current')), newest);
            const rec = records(env.STUB_RECORD);
            assert.equal(rec.length, 3);
            for (const [cwd, name, args] of rec) {
                assert.equal(name, 'bun');
                assert.equal(args, DATA_ARGS);
                assert.match(cwd, /\/deps\/\.staging-/);
            }
            const nm = join(data, 'deps', newest, 'node_modules');
            assert.deepEqual(readdirSync(join(nm, 'onnxruntime-node/bin/napi-v3')), ['linux']);
            assert.deepEqual(readdirSync(join(nm, 'onnxruntime-node/bin/napi-v3/linux')), ['arm64']);
            assert.equal(existsSync(join(nm, 'onnxruntime-web')), false);
            assert.deepEqual(readdirSync(join(nm, PKG, 'dist')).sort(), ['transformers.node.cjs', 'transformers.node.mjs']);
            assert.equal(existsSync(join(nm, PKG, 'src')), false);
            assert.equal(existsSync(join(nm, PKG, 'types')), false);
            assert.ok(existsSync(join(nm, 'sharp/index.js')));
            assert.equal(JSON.parse(readFileSync(join(nm, 'sharp/package.json'), 'utf8')).name, 'sharp');
            assert.ok(isValidInstall(join(data, 'deps', newest)));
            assert.equal(transformersEsmEntry(join(data, 'deps', newest)), join(nm, PKG, 'dist/transformers.node.mjs'));
            assert.match(readFileSync(join(data, 'deps', newest, '.installed-at'), 'utf8'), /^2026-01-03T00:00:00\.000Z$/m);
            assert.equal(readlinkSync(join(root, 'node_modules', PKG)), bridgeTarget(data, newest));
            assert.equal(existsSync(join(data, 'deps/.install.lock')), false, 'the in-process worker takes no lock');
        });
        it('a failed install leaves the existing dirs and current byte-identical and removes its staging', () => {
            const root = fakeRoot(dir('fail/root'));
            const data = dir('fail/data');
            const env = { PATH: bunDir, STUB_RECORD: join(base, 'fail.rec') };
            assert.equal(install(root, data, env, { platform: 'linux', arch: 'x64', at: '2026-01-01T00:00:00.000Z' }).rc, 0);
            assert.equal(install(root, data, env, { platform: 'darwin', arch: 'arm64', at: '2026-01-02T00:00:00.000Z' }).rc, 0);
            const before = snapshot(join(data, 'deps'));
            const run = install(root, data, { ...env, STUB_FAIL: '1' }, { platform: 'linux', arch: 'arm64' });
            assert.equal(run.rc, 1);
            assert.ok(run.log.some((l) => /bun exit 1/.test(l)), run.log.join('\n'));
            assert.deepEqual(snapshot(join(data, 'deps')), before);
            assert.equal(readdirSync(join(data, 'deps')).some((n) => n.startsWith('.staging-')), false);
        });
        it('a version mismatch fails the check and keeps nothing', () => {
            const root = fakeRoot(dir('mismatch/root'));
            const data = dir('mismatch/data');
            const run = install(root, data, { PATH: bunDir, STUB_VERSION: '3.0.0' });
            assert.equal(run.rc, 1);
            assert.ok(run.log.some((l) => /is 3\.0\.0, expected/.test(l)), run.log.join('\n'));
            assert.deepEqual(readdirSync(join(data, 'deps')), []);
        });
        it('a .staging-* older than 1 h is removed; a fresh one stays', () => {
            const root = fakeRoot(dir('staging/root'));
            const data = dir('staging/data');
            const old = dir('staging/data/deps/.staging-crashed-1');
            const fresh = dir('staging/data/deps/.staging-running-2');
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            utimesSync(old, twoHoursAgo, twoHoursAgo);
            assert.equal(install(root, data, { PATH: bunDir }).rc, 0);
            assert.equal(existsSync(old), false);
            assert.equal(existsSync(fresh), true);
        });
        it('the npm fallback runs with the production, no-scripts flags', () => {
            const root = fakeRoot(dir('npm/root'));
            const data = dir('npm/data');
            const rec = join(base, 'npm.rec');
            assert.equal(install(root, data, { PATH: npmDir, STUB_RECORD: rec }).rc, 0);
            assert.deepEqual(records(rec).map((r) => [r[1], r[2]]), [['npm', 'install --omit=dev --ignore-scripts --no-audit --no-fund']]);
        });
    });
    describe('reuse and the bridge', () => {
        let data;
        before(() => {
            data = dir('reuse/data');
            assert.equal(install(fakeRoot(dir('reuse/first')), data, { PATH: bunDir }).rc, 0);
        });
        it('a second plugin root sharing the data dir runs no package manager and gets a bridge', () => {
            const root = fakeRoot(dir('reuse/second'));
            const rec = join(base, 'reuse.rec');
            const out = runNode({ PATH: bunDir, STUB_RECORD: rec, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 0);
            assert.equal(out.stdout, '');
            assert.deepEqual(records(rec), []);
            assert.equal(readlinkSync(join(root, 'node_modules', PKG)), bridgeTarget(data));
            const resolved = createRequire(join(root, 'mcp/trajectory-server/package.json')).resolve(PKG);
            assert.ok(resolved.startsWith(realpathSync(join(data, 'deps', runtimeDepsKey()))), resolved);
            const again = runNode({ PATH: bunDir, STUB_RECORD: rec, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(again.stdout, '', 'ready on the next session start');
            assert.deepEqual(records(rec), []);
        });
        it('a broken bridge symlink is re-pointed', () => {
            const root = fakeRoot(dir('reuse/broken'));
            mkdirSync(join(root, 'node_modules/@huggingface'), { recursive: true });
            spawnSync('/bin/ln', ['-s', join(base, 'nowhere'), join(root, 'node_modules', PKG)]);
            const out = runNode({ PATH: bunDir, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.stdout, '');
            assert.equal(readlinkSync(join(root, 'node_modules', PKG)), bridgeTarget(data));
        });
        it('a real-directory install at the plugin root is never replaced', () => {
            const root = fakeRoot(dir('reuse/real'));
            const real = dir('reuse/real/node_modules', PKG);
            writeFileSync(join(real, 'package.json'), JSON.stringify({ name: PKG, version: '3.0.0' }));
            const before = snapshot(join(root, 'node_modules'));
            const rec = join(base, 'real.rec');
            const out = runNode({ PATH: bunDir, STUB_RECORD: rec, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 0);
            assert.equal(out.stdout, '');
            assert.deepEqual(records(rec), []);
            assert.deepEqual(snapshot(join(root, 'node_modules')), before);
            assert.equal(ensureBridge(root, data), false);
            assert.ok(lstatSync(real).isDirectory());
        });
        it('ready from another install: a foreign symlink is left alone', () => {
            const root = fakeRoot(dir('reuse/ready'));
            const elsewhere = dir('reuse/elsewhere/@huggingface/transformers');
            cpSync(join(data, 'deps', runtimeDepsKey(), 'node_modules', PKG), elsewhere, { recursive: true });
            mkdirSync(join(root, 'node_modules/@huggingface'), { recursive: true });
            spawnSync('/bin/ln', ['-s', elsewhere, join(root, 'node_modules', PKG)]);
            const out = runNode({ PATH: bunDir, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.stdout, '');
            assert.equal(readlinkSync(join(root, 'node_modules', PKG)), elsewhere);
        });
        it('a bridge to deps/current is re-pointed to the root\'s own key, by the gate and by ensureBridge under own-symlink (GH 1717)', () => {
            const toCurrent = (name) => {
                const root = fakeRoot(dir('reuse', name));
                mkdirSync(join(root, 'node_modules/@huggingface'), { recursive: true });
                spawnSync('/bin/ln', ['-s', join(data, 'deps/current/node_modules', PKG), join(root, 'node_modules', PKG)]);
                return root;
            };
            const viaGate = toCurrent('current-gate');
            assert.equal(runNode({ PATH: bunDir, CLAUDE_PLUGIN_ROOT: viaGate, CLAUDE_PLUGIN_DATA: data }).stdout, '');
            assert.equal(readlinkSync(join(viaGate, 'node_modules', PKG)), bridgeTarget(data));
            const direct = toCurrent('current-direct');
            assert.equal(ensureBridge(direct, data, 'own-symlink'), true);
            assert.equal(readlinkSync(join(direct, 'node_modules', PKG)), bridgeTarget(data));
        });
        it('under own-symlink a link outside <data>/deps is refused and a real dir is untouched (GH 1717)', () => {
            const foreign = fakeRoot(dir('reuse/own-foreign'));
            const elsewhere = dir('reuse/own-elsewhere', PKG);
            mkdirSync(join(foreign, 'node_modules/@huggingface'), { recursive: true });
            spawnSync('/bin/ln', ['-s', elsewhere, join(foreign, 'node_modules', PKG)]);
            assert.equal(ensureBridge(foreign, data, 'own-symlink'), false);
            assert.equal(readlinkSync(join(foreign, 'node_modules', PKG)), elsewhere);
            const real = fakeRoot(dir('reuse/own-real'));
            writeFileSync(join(dir('reuse/own-real/node_modules', PKG), 'package.json'), JSON.stringify({ name: PKG, version: '3.0.0' }));
            const before = snapshot(join(real, 'node_modules'));
            assert.equal(ensureBridge(real, data, 'own-symlink'), false);
            assert.deepEqual(snapshot(join(real, 'node_modules')), before);
        });
    });
    describe('versions pinning different transformers (GH 1717)', () => {
        it('each root bridges to its own key, and installing for one leaves the other\'s bridge and version unchanged', () => {
            const cache = dir('pins/plugins/cache/m/p');
            const data = dir('pins/data');
            const oldKey = fakeKey(data, '3.0.0', '2026-01-01T00:00:00.000Z');
            const oldRoot = fakeRoot(join(cache, '1.0.0'), '3.0.0');
            assert.equal(ensureBridge(oldRoot, data, 'any-symlink', oldKey), true);
            const newRoot = fakeRoot(join(cache, '2.0.0'));
            assert.equal(install(newRoot, data, { PATH: bunDir }).rc, 0);
            assert.equal(readlinkSync(join(data, 'deps/current')), runtimeDepsKey());
            assert.equal(readlinkSync(join(newRoot, 'node_modules', PKG)), bridgeTarget(data));
            assert.equal(resolvedVersion(newRoot), TRANSFORMERS_VERSION);
            assert.equal(readlinkSync(join(oldRoot, 'node_modules', PKG)), bridgeTarget(data, oldKey));
            assert.equal(resolvedVersion(oldRoot), '3.0.0');
            const before = readlinkSync(join(oldRoot, 'node_modules', PKG));
            assert.equal(ensureBridge(newRoot, data, 'own-symlink'), true);
            assert.equal(runNode({ PATH: bunDir, CLAUDE_PLUGIN_ROOT: newRoot, CLAUDE_PLUGIN_DATA: data }).stdout, '');
            assert.equal(readlinkSync(join(oldRoot, 'node_modules', PKG)), before);
            assert.equal(resolvedVersion(oldRoot), '3.0.0');
            assert.equal(resolvedVersion(newRoot), TRANSFORMERS_VERSION);
        });
        it('garbage collection keeps a key a sibling bridge resolves into and drops an unreferenced one beyond the newest other', () => {
            const cache = dir('gc/plugins/cache/m/p');
            const data = dir('gc/data');
            const referenced = fakeKey(data, '1.0.0', '2026-01-01T00:00:00.000Z');
            const unreferenced = fakeKey(data, '2.0.0', '2026-01-02T00:00:00.000Z');
            const newestOther = fakeKey(data, '3.0.0', '2026-01-03T00:00:00.000Z');
            const sibling = fakeRoot(join(cache, '1.0.0'), '1.0.0');
            assert.equal(ensureBridge(sibling, data, 'any-symlink', referenced), true);
            const root = fakeRoot(join(cache, '2.0.0'));
            const run = install(root, data, { PATH: bunDir, STUB_RECORD: join(base, 'gc.rec') }, { at: '2026-01-04T00:00:00.000Z' });
            assert.equal(run.rc, 0, run.log.join('\n'));
            assert.deepEqual(keyDirs(data), [referenced, newestOther, runtimeDepsKey()].sort());
            assert.equal(existsSync(join(data, 'deps', unreferenced)), false);
            assert.equal(resolvedVersion(sibling), '1.0.0');
        });
    });
    describe('sibling cleanup', () => {
        it('replaces hook-installed node_modules in other version dirs under plugins/cache/<m>/<p>/ only, bridging each to its own pinned key', () => {
            const cache = dir('siblings/plugins/cache');
            const data = dir('siblings/data');
            const root = fakeRoot(dir('siblings/plugins/cache/m/p/2.0.0'));
            const pinnedKey = fakeKey(data, '3.0.0', '2026-01-01T00:00:00.000Z');
            fakeRoot(join(cache, 'm/p/1.0.0'));
            dir('siblings/plugins/cache/m/p/1.0.0/node_modules', PKG, 'dist');
            fakeRoot(join(cache, 'm/p/1.1.0'), '3.0.0');
            dir('siblings/plugins/cache/m/p/1.1.0/mcp/trajectory-server/node_modules/onnxruntime-node');
            dir('siblings/plugins/cache/m/p/1.2.0/node_modules', PKG);
            writeFileSync(join(cache, 'm/p/1.2.0/node_modules/keep-me'), 'x');
            fakeRoot(join(cache, 'm/p/1.3.0'), '3.1.0');
            dir('siblings/plugins/cache/m/p/1.3.0/node_modules', PKG);
            const outside = [dir('siblings/plugins/cache/m/other/0.9.0/node_modules/x'), dir('siblings/plugins/cache/m2/p/0.9.0/node_modules/x')];
            const run = install(root, data, { PATH: bunDir });
            assert.equal(run.rc, 0, run.log.join('\n'));
            assert.equal(readlinkSync(join(cache, 'm/p/1.0.0/node_modules', PKG)), bridgeTarget(data));
            assert.equal(readlinkSync(join(cache, 'm/p/1.1.0/node_modules', PKG)), bridgeTarget(data, pinnedKey));
            assert.equal(resolvedVersion(join(cache, 'm/p/1.1.0')), '3.0.0');
            assert.equal(existsSync(join(cache, 'm/p/1.1.0/mcp/trajectory-server/node_modules')), false);
            for (const unbridged of ['1.2.0', '1.3.0']) {
                assert.equal(existsSync(join(cache, 'm/p', unbridged, 'node_modules')), false, `${unbridged} has no valid key to bridge to`);
            }
            assert.ok(run.log.some((l) => l.includes('left') && l.includes('1.2.0') && l.includes('(unreadable)')), run.log.join('\n'));
            assert.ok(run.log.some((l) => l.includes('left') && l.includes('1.3.0') && l.includes('3.1.0')), run.log.join('\n'));
            for (const path of outside)
                assert.ok(lstatSync(path).isDirectory(), path);
        });
        it('a plugin root outside plugins/cache/<m>/<p>/ touches no sibling', () => {
            const data = dir('nocache/data');
            const root = fakeRoot(dir('nocache/p/2.0.0'));
            const sibling = dir('nocache/p/1.0.0/node_modules', PKG);
            assert.equal(install(root, data, { PATH: bunDir }).rc, 0);
            assert.ok(lstatSync(sibling).isDirectory());
        });
    });
    describe('the gate', () => {
        it('not ready: takes the lock, installs detached into the data dir and says so; the log and caches go to the project state dir', () => {
            const root = fakeRoot(dir('gate/root'));
            const data = dir('gate/data');
            const project = dir('gate/project');
            dir('gate/project/.claude/tmb');
            writeFileSync(join(project, '.claude/tmb/trajectory.db'), '');
            const rec = join(base, 'gate.rec');
            const env = {
                PATH: bunDir,
                STUB_RECORD: rec,
                CLAUDE_PLUGIN_ROOT: root,
                CLAUDE_PLUGIN_DATA: data,
                CLAUDE_PROJECT_DIR: project,
                TRAJECTORY_DB_PATH: join(project, '.claude/tmb/trajectory.db'),
            };
            const out = runNode(env);
            assert.equal(out.code, 0);
            const log = join(project, '.claude/tmb/logs/mcp-deps-install.log');
            assert.equal(context(out.stdout), `📦 Installing the MCP server's @huggingface/transformers in the background (bun); semantic search runs on FTS until then and embeddings go live on the next Claude Code restart. Log: ${log}`);
            waitUnlocked(join(data, 'deps/.install.lock'));
            const [call, ...rest] = records(rec);
            assert.deepEqual(rest, []);
            assert.equal(call[2], DATA_ARGS);
            assert.equal(call[3], join(project, '.claude/tmb/cache/bun'));
            assert.equal(call[4], join(project, '.claude/tmb/cache/npm'));
            assert.ok(isValidInstall(join(data, 'deps', runtimeDepsKey())));
            assert.match(readFileSync(log, 'utf8'), /ensure-mcp-deps-installed: exit 0/);
            assert.equal(readlinkSync(join(root, 'node_modules', PKG)), bridgeTarget(data));
            assert.equal(runNode(env).stdout, '', 'ready on the next session start');
        });
        it('install already running (lock held) → no installer, no output', () => {
            const root = fakeRoot(dir('locked/root'));
            const data = dir('locked/data');
            dir('locked/data/deps/.install.lock');
            const rec = join(base, 'locked.rec');
            const out = runNode({ PATH: bunDir, STUB_RECORD: rec, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 0);
            assert.equal(out.stdout, '');
            sleepMs(300);
            assert.deepEqual(records(rec), []);
            assert.ok(existsSync(join(data, 'deps/.install.lock')), 'the holder keeps its lock');
        });
        it('no bun and no npm → the manual-command notice, pointing at the data dir', () => {
            const root = fakeRoot(dir('nopm/root'));
            const data = dir('nopm/data');
            const out = runNode({ PATH: emptyDir, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 0);
            const text = context(out.stdout);
            assert.match(text, /^📦 Semantic search is degraded: .*neither bun nor npm is on PATH\. Install one and restart Claude Code, or run: /);
            assert.ok(text.includes(join(data, 'deps', runtimeDepsKey())), text);
            assert.ok(text.includes('ensure-mcp-deps-installed --install'), text);
            assert.equal(existsSync(join(data, 'deps/.install.lock')), false);
        });
        it('the spawned worker\'s env carries the lock token the gate wrote to <lock>/owner (GH 1719)', () => {
            const root = fakeRoot(dir('gate-token/root'));
            const data = dir('gate-token/data');
            const lock = join(data, 'deps/.install.lock');
            const rec = join(base, 'gate-token.rec');
            const out = runNode({ PATH: bunDir, STUB_RECORD: rec, STUB_LOCK: lock, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 0);
            waitUnlocked(lock);
            const [call, ...rest] = records(rec);
            assert.deepEqual(rest, []);
            assert.match(call[5], /^[0-9a-f-]{36}$/);
            assert.equal(call[6], call[5], 'the worker env token equals <lock>/owner while it installs');
        });
    });
    describe('the install lock (GH 1718, GH 1719)', () => {
        const STALE_MIN = 15;
        const DEPS_MODULE = join(SERVER_DIR, 'dist/hooks/ensure-mcp-deps-installed.js');
        function staleLock(name) {
            const lock = join(dir('lock', name), '.install.lock');
            mkdirSync(lock);
            const old = new Date(Date.now() - (STALE_MIN + 5) * 60_000);
            utimesSync(lock, old, old);
            return lock;
        }
        function owner(lock) {
            return readFileSync(join(lock, 'owner'), 'utf8');
        }
        function runWorker(env) {
            const r = spawnSync(process.execPath, [HOOKS_BUNDLE, 'ensure-mcp-deps-installed', '--install'], {
                input: '{}',
                env,
                cwd: base,
                encoding: 'utf8',
            });
            if (r.error)
                throw r.error;
            return { code: r.status, stdout: r.stdout };
        }
        async function waitFor(paths) {
            for (let i = 0; i < 600 && !paths.every((p) => existsSync(p)); i++)
                await new Promise((r) => setTimeout(r, 50));
            assert.ok(paths.every((p) => existsSync(p)), 'every racer is ready');
        }
        it('reclaim is atomic: of 6 processes racing on one stale lock exactly one gets a token, and <lock>/owner holds it', async () => {
            const lock = staleLock('race');
            const sync = dir('lock/race-sync');
            const go = join(sync, 'go');
            const racers = Array.from({ length: 6 }, (_, i) => {
                const ready = join(sync, `ready-${i}`);
                const script = [
                    `import { existsSync, writeFileSync } from 'node:fs';`,
                    `const { takeLock } = await import(${JSON.stringify(pathToFileURL(DEPS_MODULE).href)});`,
                    `writeFileSync(${JSON.stringify(ready)}, '');`,
                    `while (!existsSync(${JSON.stringify(go)}));`,
                    `process.stdout.write(takeLock(${JSON.stringify(lock)}, ${STALE_MIN}) ?? '');`,
                ].join('\n');
                const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
                const result = new Promise((res, rej) => {
                    let out = '';
                    child.stdout.on('data', (d) => { out += d.toString(); });
                    child.on('error', rej);
                    child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`racer ${i} exited ${code}`))));
                });
                return { ready, result };
            });
            await waitFor(racers.map((r) => r.ready));
            writeFileSync(go, '');
            const tokens = (await Promise.all(racers.map((r) => r.result))).filter((t) => t !== '');
            assert.equal(tokens.length, 1, `tokens: ${JSON.stringify(tokens)}`);
            assert.equal(owner(lock), tokens[0]);
            assert.equal(existsSync(`${lock}.reclaim`), false, 'the mutex is released');
        });
        it('a fresh <lock>.reclaim blocks the reclaim; one older than 30 s is dropped so a later call reclaims', () => {
            const lock = staleLock('mutex');
            const mutex = `${lock}.reclaim`;
            mkdirSync(mutex);
            assert.equal(takeLock(lock, STALE_MIN), undefined);
            assert.ok(existsSync(lock), 'the stale lock stays while the mutex is held');
            assert.ok(existsSync(mutex));
            const old = new Date(Date.now() - 31_000);
            utimesSync(mutex, old, old);
            assert.equal(takeLock(lock, STALE_MIN), undefined);
            assert.equal(existsSync(mutex), false, 'a mutex older than 30 s is dropped');
            assert.ok(existsSync(lock));
            const token = takeLock(lock, STALE_MIN);
            assert.ok(token);
            assert.equal(owner(lock), token);
            assert.equal(existsSync(mutex), false);
        });
        it('a lock that is not stale is never reclaimed', () => {
            const lock = join(dir('lock/fresh'), '.install.lock');
            const token = takeLock(lock, STALE_MIN);
            assert.ok(token);
            assert.equal(takeLock(lock, STALE_MIN), undefined);
            assert.equal(owner(lock), token);
        });
        it('only the owner token releases the lock; an ownerless lock is never released', () => {
            const lock = join(dir('lock/release'), '.install.lock');
            const token = takeLock(lock, STALE_MIN);
            assert.ok(token);
            assert.equal(releaseLock(lock, 'not-the-owner'), false);
            assert.equal(releaseLock(lock, undefined), false);
            assert.equal(releaseLock(lock, ''), false);
            assert.equal(owner(lock), token);
            assert.equal(releaseLock(lock, token), true);
            assert.equal(existsSync(lock), false);
            const ownerless = join(dir('lock/ownerless'), '.install.lock');
            mkdirSync(ownerless);
            for (const t of [undefined, '', 'any-token'])
                assert.equal(releaseLock(ownerless, t), false);
            assert.ok(existsSync(ownerless));
        });
        it('a worker whose token does not own the lock leaves it in place', () => {
            const root = fakeRoot(dir('lock/worker-wrong/root'));
            const data = dir('lock/worker-wrong/data');
            const lock = join(data, 'deps/.install.lock');
            const held = takeLock(lock, STALE_MIN);
            assert.ok(held);
            const out = runWorker({ PATH: bunDir, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, [LOCK_TOKEN_ENV]: 'not-the-owner' });
            assert.equal(out.code, 0, out.stdout);
            assert.equal(owner(lock), held);
        });
        it('a manual run while another owner holds a fresh lock returns 1, installs nothing and keeps the lock', () => {
            const root = fakeRoot(dir('lock/manual-held/root'));
            const data = dir('lock/manual-held/data');
            const lock = join(data, 'deps/.install.lock');
            const held = takeLock(lock, STALE_MIN);
            assert.ok(held);
            const rec = join(base, 'manual-held.rec');
            const out = runWorker({ PATH: bunDir, STUB_RECORD: rec, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 1);
            assert.match(out.stdout, /another install holds .*\.install\.lock; not installing/);
            assert.deepEqual(records(rec), []);
            assert.equal(owner(lock), held);
        });
        it('a manual run with no lock held takes the lock, installs and releases it', () => {
            const root = fakeRoot(dir('lock/manual-free/root'));
            const data = dir('lock/manual-free/data');
            const lock = join(data, 'deps/.install.lock');
            const rec = join(base, 'manual-free.rec');
            const out = runWorker({ PATH: bunDir, STUB_RECORD: rec, STUB_LOCK: lock, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data });
            assert.equal(out.code, 0, out.stdout);
            const [call, ...rest] = records(rec);
            assert.deepEqual(rest, []);
            assert.equal(call[5], '', 'a manual run carries no token');
            assert.match(call[6], /^[0-9a-f-]{36}$/, 'the lock was held with its own token while installing');
            assert.equal(existsSync(lock), false);
            assert.ok(isValidInstall(join(data, 'deps', runtimeDepsKey())));
        });
    });
    describe('edge cases match the .sh', () => {
        let path;
        before(() => {
            path = toolPath(bunDir);
        });
        /** Runs the .sh, then the gate, on one fake root; `wait` names the lock each run's install drops. */
        function both(name, env, wait) {
            const root = fakeRoot(dir('edge', name));
            const project = dir('edge', `${name}-project`);
            return ['bash', 'node'].map((impl) => {
                const rec = join(base, `edge-${name}-${impl}.rec`);
                const full = {
                    PATH: path,
                    STUB_RECORD: rec,
                    CLAUDE_PLUGIN_ROOT: root,
                    CLAUDE_PROJECT_DIR: project,
                    TMB_FORBID_LIVE_SYNC: '1',
                    ...env,
                };
                for (const [k, v] of Object.entries(full))
                    if (v === undefined)
                        delete full[k];
                const out = impl === 'bash' ? runBash(full) : runNode(full);
                if (wait)
                    waitUnlocked(wait(root));
                return { out, rec: records(rec), root };
            });
        }
        function sameOutput(runs) {
            const [bash, node] = runs;
            assert.equal(node.out.code, bash.out.code, 'exit code');
            assert.deepEqual(node.out.stdout === '' ? null : JSON.parse(node.out.stdout), bash.out.stdout === '' ? null : JSON.parse(bash.out.stdout), 'stdout');
        }
        it('TMB_SKIP_MCP_DEPS_INSTALL=1 → no-op', () => {
            const runs = both('bypass', { TMB_SKIP_MCP_DEPS_INSTALL: '1', CLAUDE_PLUGIN_DATA: dir('edge/bypass-data') });
            sameOutput(runs);
            for (const r of runs) {
                assert.equal(r.out.stdout, '');
                assert.deepEqual(r.rec, []);
            }
        });
        it('unset CLAUDE_PLUGIN_ROOT → exit 0, no output', () => {
            const runs = both('noroot', { CLAUDE_PLUGIN_ROOT: undefined, CLAUDE_PLUGIN_DATA: dir('edge/noroot-data') });
            sameOutput(runs);
            for (const r of runs) {
                assert.equal(r.out.code, 0);
                assert.equal(r.out.stdout, '');
                assert.deepEqual(r.rec, []);
            }
        });
        it('missing MCP dir → exit 0, no output', () => {
            const runs = ['bash', 'node'].map((impl) => {
                const root = dir('edge/nomcp', impl);
                const rec = join(base, `edge-nomcp-${impl}.rec`);
                const env = { PATH: path, STUB_RECORD: rec, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dir('edge/nomcp-data'), TMB_FORBID_LIVE_SYNC: '1' };
                return { out: impl === 'bash' ? runBash(env) : runNode(env), rec: records(rec) };
            });
            sameOutput(runs);
            for (const r of runs) {
                assert.equal(r.out.stdout, '');
                assert.deepEqual(r.rec, []);
            }
        });
        it('unset CLAUDE_PLUGIN_DATA → the legacy install in the MCP dir, same flags and notice', () => {
            const runs = both('nodata', { CLAUDE_PLUGIN_DATA: undefined }, (root) => join(root, 'mcp/trajectory-server/.deps-install.lock'));
            sameOutput(runs);
            assert.match(context(runs[1].out.stdout), /^📦 Installing the MCP server's @huggingface\/transformers in the background \(bun\)/);
            for (const r of runs) {
                assert.equal(r.rec.length, 1);
                assert.equal(r.rec[0][2], LEGACY_BUN_ARGS);
                assert.equal(realpathSync(r.rec[0][0]), realpathSync(join(r.root, 'mcp/trajectory-server')));
            }
        });
        it('unset CLAUDE_PLUGIN_DATA and no package manager → the same manual-command notice', () => {
            const tools = path.split(':')[1];
            const runs = both('nodata-nopm', { CLAUDE_PLUGIN_DATA: undefined, PATH: tools });
            sameOutput(runs);
            assert.match(context(runs[1].out.stdout), /or run: cd ".*" && bun install --production --ignore-scripts --no-save$/);
        });
    });
});
//# sourceMappingURL=ensure-mcp-deps-installed.test.js.map