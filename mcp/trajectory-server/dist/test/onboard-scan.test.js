import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onboardTools } from '../tools/onboard.js';
import { recommendFromEvidence, scanRepoEvidence, scanWorkspace } from '../tools/onboard-scan.js';
import { tempDB } from './helpers.js';
const tmpDirs = [];
after(() => {
    for (const dir of tmpDirs)
        rmSync(dir, { recursive: true, force: true });
});
function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-scan-'));
    tmpDirs.push(dir);
    return dir;
}
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'scan',
    GIT_AUTHOR_EMAIL: 'scan@example.com',
    GIT_COMMITTER_NAME: 'scan',
    GIT_COMMITTER_EMAIL: 'scan@example.com',
};
function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
}
let commitSeq = 0;
function commit(dir) {
    commitSeq++;
    writeFileSync(join(dir, `f${commitSeq}.txt`), `${commitSeq}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `c${commitSeq}`);
}
function mergeFeatures(dir, target, n) {
    for (let i = 0; i < n; i++) {
        git(dir, 'checkout', '-q', '-b', 'feature', target);
        commit(dir);
        git(dir, 'checkout', '-q', target);
        git(dir, 'merge', '-q', '--no-ff', '-m', `merge feature into ${target}`, 'feature');
        git(dir, 'branch', '-q', '-D', 'feature');
    }
}
function initRepo() {
    const dir = makeTmpDir();
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir);
    return dir;
}
function mainOnlyRepo() {
    const dir = initRepo();
    mergeFeatures(dir, 'main', 2);
    return dir;
}
function gitflowRepo() {
    const dir = initRepo();
    git(dir, 'branch', 'dev');
    mergeFeatures(dir, 'dev', 6);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'release dev into main', 'dev');
    return dir;
}
function splitRepo() {
    const dir = initRepo();
    git(dir, 'branch', 'dev');
    mergeFeatures(dir, 'dev', 3);
    mergeFeatures(dir, 'main', 3);
    return dir;
}
function assertShortEvidence(lines) {
    for (const line of lines) {
        assert.ok(line.split(/\s+/).filter(Boolean).length <= 12, `evidence line over 12 words: "${line}"`);
    }
}
function parse(result) {
    const r = result;
    return JSON.parse(r.content[0].text);
}
describe('onboard pre-scan', () => {
    it('(a) main only → github-flow into main, high confidence', () => {
        const e = scanRepoEvidence(mainOnlyRepo());
        assert.equal(e.in_git, true);
        assert.deepEqual(e.long_lived, ['main']);
        assert.equal(e.merges['main'], 2);
        const rec = recommendFromEvidence(e);
        assert.equal(rec.branching_model, 'github-flow');
        assert.equal(rec.pr_target, 'main');
        assert.equal(rec.confidence, 'high');
        assert.equal(rec.reason, 'only one long-lived branch');
        assertShortEvidence(rec.evidence);
    });
    it('(b) dev with 6 first-parent merges, main with 1 → gitflow into dev, high confidence', () => {
        const e = scanRepoEvidence(gitflowRepo());
        assert.deepEqual(e.long_lived, ['main', 'dev']);
        assert.deepEqual(e.merges, { dev: 6, main: 1 });
        const rec = recommendFromEvidence(e);
        assert.equal(rec.branching_model, 'gitflow');
        assert.equal(rec.pr_target, 'dev');
        assert.equal(rec.confidence, 'high');
        assert.match(rec.reason, /6/);
        assert.match(rec.reason, /1/);
        assert.ok(rec.evidence.some((l) => l.includes('6') && l.includes('1') && l.includes('dev') && l.includes('main')), `an evidence line carries both counts: ${JSON.stringify(rec.evidence)}`);
        assertShortEvidence(rec.evidence);
    });
    it('(c) dev 3 / main 3 → low confidence, no high-confidence pr_target claim', () => {
        const e = scanRepoEvidence(splitRepo());
        assert.deepEqual(e.merges, { dev: 3, main: 3 });
        const rec = recommendFromEvidence(e);
        assert.equal(rec.confidence, 'low');
        assert.equal(rec.reason, 'merges split 3/3, no clear pattern');
        assert.equal(rec.pr_target, 'dev', 'with no origin/HEAD the low-confidence target is the dev-type branch');
        assertShortEvidence(rec.evidence);
    });
    it('(d) a non-git directory → in_git:false and no recommendation', () => {
        const e = scanRepoEvidence(makeTmpDir());
        assert.equal(e.in_git, false);
        assert.equal(typeof e.note, 'string');
        assert.equal(recommendFromEvidence(e), null);
        const missing = scanRepoEvidence(join(makeTmpDir(), 'gone'));
        assert.equal(missing.in_git, false);
        assert.equal(recommendFromEvidence(missing), null);
    });
    it('a clone reads origin/HEAD, origin branches and its remote from git when repo_remotes is empty', () => {
        const source = gitflowRepo();
        const clone = join(makeTmpDir(), 'clone');
        git(source, 'clone', '-q', source, clone);
        writeFileSync(join(clone, 'CONTRIBUTING.md'), 'x\n');
        mkdirSync(join(clone, '.github', 'workflows'), { recursive: true });
        writeFileSync(join(clone, '.github', 'workflows', 'ci.yml'), 'on: push\n');
        const e = scanRepoEvidence(clone);
        assert.equal(e.origin_head, 'main');
        assert.ok(e.branches.includes('dev'), 'origin/dev is listed by its short name');
        assert.equal(e.branches.filter((b) => b === 'main').length, 1, 'local and origin main are deduped');
        assert.deepEqual(e.remotes, [{ name: 'origin', host: 'other' }]);
        assert.deepEqual(e.ci_files, ['.github/workflows']);
        assert.equal(e.contributing, true);
        const rec = recommendFromEvidence(e);
        assert.equal(rec.branching_model, 'gitflow');
        for (const line of ['origin/HEAD is main', 'CONTRIBUTING.md present', 'CI: .github/workflows']) {
            assert.ok(rec.evidence.includes(line), `evidence has "${line}"`);
        }
        assertShortEvidence(rec.evidence);
    });
    it('(e) scanWorkspace writes onboard_scan on every repos row; differing repos are not uniform', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('alpha', ?), ('beta', ?)`, [mainOnlyRepo(), gitflowRepo()]);
        const scan = scanWorkspace(db);
        assert.equal(db.get('SELECT count(*) AS n FROM repos WHERE onboard_scan IS NOT NULL')?.n, 2);
        const stored = JSON.parse(db.get(`SELECT onboard_scan FROM repos WHERE name = 'beta'`).onboard_scan);
        assert.equal(stored.recommendation.branching_model, 'gitflow');
        assert.deepEqual(stored.merges, { dev: 6, main: 1 });
        assert.equal(scan.summary.repo_count, 2);
        assert.equal(scan.summary.uniform, false);
        assert.equal(scan.summary.with_dev_branch, 1);
        assert.equal(scan.summary.main_only, 1);
        assert.deepEqual(scan.repos.map((r) => r.name), ['alpha', 'beta']);
        db.close();
    });
    it('scanWorkspace reports uniform when every repo gets the same high-confidence recommendation', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('one', ?), ('two', ?)`, [mainOnlyRepo(), mainOnlyRepo()]);
        assert.equal(scanWorkspace(db).summary.uniform, true);
        db.close();
    });
    it('takes host kinds from repo_remotes rows and finishes six repos under 2 s', () => {
        const db = tempDB();
        const repo = gitflowRepo();
        for (let i = 0; i < 6; i++)
            db.run(`INSERT INTO repos (name, path) VALUES (?, ?)`, [`r${i}`, repo]);
        db.run(`INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('r0', 'origin', 'github', 'https://github.com/a/b.git', 1)`);
        db.run(`INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('r1', 'origin', 'gitlab', 'https://gitlab.com/a/b.git', 1)`);
        const scan = scanWorkspace(db);
        assert.deepEqual(scan.summary.hosts, ['github', 'gitlab']);
        assert.ok(scan.summary.elapsed_ms < 2000, `six repos took ${scan.summary.elapsed_ms} ms`);
        db.close();
    });
    it('never spawns gh or glab', () => {
        const bin = makeTmpDir();
        const marker = join(bin, 'spawned');
        for (const cli of ['gh', 'glab']) {
            writeFileSync(join(bin, cli), `#!/bin/sh\necho ${cli} >> "${marker}"\n`);
            chmodSync(join(bin, cli), 0o755);
        }
        const savedPath = process.env['PATH'];
        process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
        try {
            const db = tempDB();
            db.run(`INSERT INTO repos (name, path) VALUES ('alpha', ?)`, [gitflowRepo()]);
            scanWorkspace(db);
            db.close();
        }
        finally {
            process.env['PATH'] = savedPath;
        }
        assert.equal(existsSync(marker), false, 'the scan spawned gh/glab');
    });
    it('(f) onboard_state_get carries scan with one entry per repos row, keeping the existing keys', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('alpha', ?), ('ghost', '/nonexistent/tmb-scan-ghost')`, [gitflowRepo()]);
        const saved = { HOME: process.env['HOME'], CLAUDE_PLUGIN_ROOT: process.env['CLAUDE_PLUGIN_ROOT'], CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] };
        process.env['HOME'] = makeTmpDir();
        delete process.env['CLAUDE_PLUGIN_ROOT'];
        delete process.env['CLAUDE_CONFIG_DIR'];
        let data;
        try {
            data = parse(await onboardTools(db).handlers['onboard_state_get']({ agent: 'bro' }));
        }
        finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
        for (const key of ['first_run', 'current', 'probe', 'nesting', 'scan'])
            assert.ok(key in data, `result keeps ${key}`);
        const scan = data['scan'];
        const rows = db.get('SELECT count(*) AS n FROM repos').n;
        assert.ok(scan.summary.repo_count > 0);
        assert.equal(scan.summary.repo_count, rows);
        assert.equal(scan.repos.filter((r) => r.recommendation !== null).length, 1);
        assert.equal(scan.repos.find((r) => r.name === 'ghost')?.in_git, false);
        assert.equal(db.get('SELECT count(*) AS n FROM repos WHERE onboard_scan IS NOT NULL')?.n, rows);
        db.close();
    });
});
//# sourceMappingURL=onboard-scan.test.js.map