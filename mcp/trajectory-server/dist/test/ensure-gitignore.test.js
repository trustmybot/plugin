/**
 * ensure-gitignore end to end (GH 1692), the SessionStart gate that keeps
 * `.claude/` in each repo's .gitignore:
 *   1. outside a git repo it is silent and writes no .gitignore;
 *   2. a fresh repo gets a .gitignore holding `.claude/`;
 *   3. an existing .gitignore without the rule gets it appended, its entries kept;
 *   4. a .gitignore already holding `.claude/` or bare `.claude` is left byte-identical;
 *   5. it covers the project and the repos the trajectory DB registers, never
 *      the cwd's repo (GH 1550), and a relative repos.path resolves against
 *      the project root (GH 1553).
 * Each case runs `node dist/hooks.js ensure-gitignore` in a sandbox with its own HOME.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { checksum, makeSandbox, runGate } from './hook-sandbox.js';
const GATE = 'ensure-gitignore';
describe('ensure-gitignore: .claude/ in every TMB repo .gitignore', () => {
    let sb;
    before(() => {
        sb = makeSandbox(GATE);
    });
    after(() => sb.remove());
    function repo(name) {
        const path = join(sb.dir, name);
        mkdirSync(path, { recursive: true });
        const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env: sb.env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return path;
    }
    function runIn(cwd, env = {}) {
        const r = runGate(GATE, { cwd, env: { ...sb.env, CLAUDE_PROJECT_DIR: cwd, ...env }, input: '{}' });
        return r.stdout + r.stderr;
    }
    const ruleLines = (path) => readFileSync(path, 'utf8').split('\n');
    const listsRule = (path) => existsSync(path) && ruleLines(path).includes('.claude/');
    it('not a git repo: silent, and no .gitignore is written', () => {
        const dir = join(sb.dir, 'notrepo');
        mkdirSync(dir);
        assert.equal(runIn(dir), '');
        assert.equal(existsSync(join(dir, '.gitignore')), false);
    });
    it('a fresh repo with no .gitignore gets one holding .claude/', () => {
        const r = repo('repo1');
        runIn(r);
        assert.ok(listsRule(join(r, '.gitignore')));
    });
    it('an existing .gitignore without .claude/ gets it appended, its entries kept', () => {
        const r = repo('repo2');
        writeFileSync(join(r, '.gitignore'), 'node_modules/\ndist/\n');
        runIn(r);
        assert.ok(listsRule(join(r, '.gitignore')));
        assert.ok(ruleLines(join(r, '.gitignore')).includes('node_modules/'));
    });
    for (const [name, body] of [
        ['.claude/', 'node_modules/\n.claude/\ndist/\n'],
        ['bare .claude', '.claude\n'],
    ]) {
        it(`an existing .gitignore with ${name} is left byte-identical`, () => {
            const r = repo(`repo-${name.replace(/[^a-z]/g, '')}`);
            writeFileSync(join(r, '.gitignore'), body);
            const before = checksum(join(r, '.gitignore'));
            runIn(r);
            assert.equal(checksum(join(r, '.gitignore')), before);
        });
    }
    describe('the project and its registered repos, never the cwd\'s repo', () => {
        let ws;
        let db;
        let cwdRepo;
        before(() => {
            ws = repo('ws');
            mkdirSync(join(ws, '.claude/tmb'), { recursive: true });
            db = join(ws, '.claude/tmb/trajectory.db');
            cwdRepo = repo('cwd-repo');
            const d = new DatabaseSync(db);
            try {
                d.exec('CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL)');
            }
            finally {
                d.close();
            }
        });
        function register(name, path) {
            const d = new DatabaseSync(db);
            try {
                d.prepare('INSERT INTO repos VALUES (?, ?)').run(name, path);
            }
            finally {
                d.close();
            }
        }
        function runFromCwdRepo() {
            runGate(GATE, { cwd: cwdRepo, env: { ...sb.env, CLAUDE_PROJECT_DIR: ws, TRAJECTORY_DB_PATH: db }, input: '{}' });
        }
        it('GH 1550: the project\'s repo and a registered repo outside it get the rule; the cwd\'s repo is untouched', () => {
            const svc = repo('elsewhere/svc');
            register('svc', svc);
            runFromCwdRepo();
            assert.ok(listsRule(join(ws, '.gitignore')), 'the project\'s repo');
            assert.ok(listsRule(join(svc, '.gitignore')), 'a registered repo outside the project');
            assert.equal(existsSync(join(cwdRepo, '.gitignore')), false, 'the cwd\'s repo is untouched');
        });
        it('GH 1553: a relative repos.path resolves against the project root', () => {
            repo('ws/rel');
            register('rel', 'rel');
            runFromCwdRepo();
            assert.ok(listsRule(join(ws, 'rel/.gitignore')), '<project>/rel, not <project>/.claude/tmb/rel');
        });
    });
});
//# sourceMappingURL=ensure-gitignore.test.js.map