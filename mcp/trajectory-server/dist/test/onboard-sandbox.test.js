import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLocalSettingsIgnored, isSshRemote, SANDBOX_NETWORK_PROBE, SANDBOX_NETWORK_PROBES, sandboxRecommended, writeProjectSandbox, } from '../tools/onboard-sandbox.js';
// The sandbox writer never writes outside the project: HOME is an empty temp
// dir for the whole file and must still be empty at the end. Git discovery
// stops at the temp root, so a non-git temp dir stays non-git even when the
// temp root sits inside a checkout.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'sandbox-home-'));
process.env['HOME'] = ISOLATED_HOME;
process.env['GIT_CEILING_DIRECTORIES'] = realpathSync(tmpdir());
const ENTRY = '.claude/settings.local.json';
describe('settings.local.json is gitignored when TMB creates it', () => {
    let project;
    const settingsPath = () => join(project, '.claude', 'settings.local.json');
    const gitignorePath = () => join(project, '.gitignore');
    const entryCount = () => readFileSync(gitignorePath(), 'utf8').split('\n').filter((l) => l === ENTRY).length;
    const write = () => writeProjectSandbox({ projectRoot: project, cacheDir: join(project, 'model-cache'), platform: 'linux', previous: null });
    const gitInit = () => {
        const r = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    };
    beforeEach(() => {
        project = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
    });
    afterEach(() => {
        rmSync(project, { recursive: true, force: true });
    });
    it('git work tree: creating the file appends the path once', () => {
        gitInit();
        const res = write();
        assert.equal(res.written, true);
        assert.equal(res.gitignore_appended, true);
        assert.equal(entryCount(), 1);
        const ignored = spawnSync('git', ['-C', project, 'check-ignore', '-q', ENTRY]);
        assert.equal(ignored.status, 0, 'git now ignores the settings file');
    });
    it('a second write appends nothing', () => {
        gitInit();
        write();
        const res = write();
        assert.equal(res.written, true);
        assert.equal(res.gitignore_appended, false);
        assert.equal(entryCount(), 1);
    });
    it('a .gitignore without a trailing newline gets the path on its own line', () => {
        gitInit();
        writeFileSync(gitignorePath(), 'node_modules/');
        assert.equal(write().gitignore_appended, true);
        assert.equal(readFileSync(gitignorePath(), 'utf8'), `node_modules/\n${ENTRY}\n`);
    });
    it('a path git already ignores is left alone', () => {
        gitInit();
        writeFileSync(gitignorePath(), '.claude/\n');
        assert.equal(write().gitignore_appended, false);
        assert.equal(readFileSync(gitignorePath(), 'utf8'), '.claude/\n');
    });
    it('outside a git work tree nothing is appended', () => {
        const res = write();
        assert.equal(res.written, true);
        assert.equal(res.gitignore_appended, false);
        assert.ok(!existsSync(gitignorePath()));
        assert.deepEqual(ensureLocalSettingsIgnored(project), { appended: false });
    });
    it('a settings file that already existed leaves .gitignore untouched', () => {
        gitInit();
        mkdirSync(join(project, '.claude'), { recursive: true });
        writeFileSync(settingsPath(), '{}\n');
        const res = write();
        assert.equal(res.written, true);
        assert.equal(res.gitignore_appended, false);
        assert.ok(!existsSync(gitignorePath()));
    });
    it('never writes under HOME', () => {
        assert.deepEqual(readdirSync(ISOLATED_HOME), []);
    });
});
describe('sandboxRecommended reads the probe recorded for the platform', () => {
    const HTTPS = ['https://github.com/a/b.git'];
    const SSH = ['git@github.com:a/b.git'];
    const linuxPassed = {
        linux: { platform: 'linux', failed: [], cc_version: 'x', date: 'y' },
    };
    it('the shipped records hold darwin only, and SANDBOX_NETWORK_PROBE is the darwin record', () => {
        assert.deepEqual(Object.keys(SANDBOX_NETWORK_PROBES), ['darwin']);
        assert.equal(SANDBOX_NETWORK_PROBES.darwin, SANDBOX_NETWORK_PROBE);
    });
    it('darwin with the shipped record: yes for HTTPS-only or no remotes, no with an SSH remote', () => {
        assert.equal(sandboxRecommended(HTTPS, 'darwin'), true);
        assert.equal(sandboxRecommended([], 'darwin'), true);
        assert.equal(sandboxRecommended(SSH, 'darwin'), false);
        assert.equal(sandboxRecommended(['ssh://git@github.com/a/b.git'], 'darwin'), false);
    });
    it('linux with the shipped record: no', () => {
        assert.equal(sandboxRecommended(HTTPS, 'linux'), false);
        assert.equal(sandboxRecommended([], 'linux'), false);
    });
    it('linux with a passing record: yes for HTTPS-only remotes, no with an SSH remote', () => {
        assert.equal(sandboxRecommended(HTTPS, 'linux', linuxPassed), true);
        assert.equal(sandboxRecommended(SSH, 'linux', linuxPassed), false);
    });
    it('a recorded failure keeps the platform at no', () => {
        const darwinFailed = { darwin: { ...SANDBOX_NETWORK_PROBE, failed: ['bun add is-number'] } };
        assert.equal(sandboxRecommended(HTTPS, 'darwin', darwinFailed), false);
    });
    it('win32 has no record: no', () => {
        assert.equal(sandboxRecommended(HTTPS, 'win32'), false);
        assert.equal(sandboxRecommended(HTTPS, 'win32', linuxPassed), false);
    });
    it('the default platform is the host', () => {
        assert.equal(sandboxRecommended(HTTPS), SANDBOX_NETWORK_PROBES[process.platform] !== undefined);
        assert.equal(isSshRemote(HTTPS[0]), false);
    });
});
//# sourceMappingURL=onboard-sandbox.test.js.map