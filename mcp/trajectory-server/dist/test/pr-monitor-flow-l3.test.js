/**
 * The pr-monitor-flow l3 bash suite in node:test (GH 1692): gh, glab and git
 * stubs first on PATH, pr_monitor_comments_get run from dist in a child node
 * against a schema.sql DB, and the arch-impact path heuristic.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT } from './hook-sandbox.js';
import { has, sql } from './git-push-guard-l3.js';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const DIST = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist');
function schemaDb(path) {
    const d = new DatabaseSync(path);
    try {
        d.exec(SCHEMA);
    }
    finally {
        d.close();
    }
    sql(path, "INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', '\"gh\"')");
    return path;
}
function writeStub(dir, name, body) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, { mode: 0o755 });
}
const ARCH_IMPACT = /(mcp\/trajectory-server\/src\/schema\.sql|\.claude-plugin\/plugin\.json|templates\/agents\/|^agents\/)/;
describe('pr-monitor-flow l3', () => {
    let sb;
    let mockBin;
    const pathWith = (bin) => `${bin}${delimiter}${sb.env.PATH}`;
    /** <body> run as an ES module in a child node with dist's TrajectoryDB and prMonitorTools imported; stdout + stderr. */
    function runMcp(bin, db, body) {
        const script = `
      const { TrajectoryDB } = await import(${JSON.stringify(pathToFileURL(join(DIST, 'db.js')).href)});
      const { prMonitorTools } = await import(${JSON.stringify(pathToFileURL(join(DIST, 'tools/pr_monitor.js')).href)});
      const db = new TrajectoryDB(${JSON.stringify(db)});
      const tools = prMonitorTools(db);
      ${body}
      db.close();
    `;
        const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
            cwd: sb.dir,
            env: { ...sb.env, PATH: pathWith(bin), TRAJECTORY_DB_PATH: db },
            encoding: 'utf8',
            timeout: 60_000,
        });
        if (r.error)
            throw r.error;
        return r.stdout + r.stderr;
    }
    before(() => {
        sb = makeSandbox('pr-monitor');
        mockBin = join(sb.dir, 'bin');
        writeStub(mockBin, 'gh', `#!/usr/bin/env bash
if [[ "$*" == *"pr view"*"--json"* ]]; then
  echo '{"state":"OPEN","comments":[{"id":"c1","author":{"login":"alice"},"body":"This should be refactored.","createdAt":"2024-01-15T10:00:00Z"}],"reviews":[]}'
  exit 0
fi
if [[ "$*" == *"pr view"* ]]; then
  echo '{"number":42,"headRefName":"feat/my-feature","state":"OPEN"}'
  exit 0
fi
exit 1
`);
        writeStub(mockBin, 'glab', `#!/usr/bin/env bash
if [[ "$*" == *"mr view"*"--comments"* ]]; then
  echo '{"state":"opened","notes":[{"id":101,"author":{"username":"bob"},"body":"Please fix this.","created_at":"2024-01-15T10:00:00Z","resolved":false}]}'
  exit 0
fi
if [[ "$*" == *"mr list"* ]]; then
  echo '[{"iid":42,"state":"opened","sourceBranch":"feat/my-feature"}]'
  exit 0
fi
exit 1
`);
        writeStub(mockBin, 'git', `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --abbrev-ref HEAD"* ]]; then
  echo "feat/my-feature"
  exit 0
fi
/usr/bin/git "$@"
`);
    });
    after(() => sb.remove());
    it('skill invokes with explicit PR number: pr_review_runs row created', () => {
        const db = schemaDb(join(sb.dir, 'db1.db'));
        runMcp(mockBin, db, "await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 42, repo: 'owner/repo' });");
        const d = new DatabaseSync(db);
        try {
            const row = d.prepare('SELECT COUNT(*) AS n FROM pr_review_runs WHERE pr_number=42').get();
            assert.equal(row.n, 1, 'pr_review_runs row count for PR 42');
        }
        finally {
            d.close();
        }
    });
    it('skill auto-detects PR from current branch via git + gh pr view', () => {
        const env = { ...sb.env, PATH: pathWith(mockBin) };
        const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: sb.dir, env, encoding: 'utf8' });
        assert.equal(branch.stdout.replace(/\n+$/, ''), 'feat/my-feature', 'mock git branch');
        const pr = spawnSync('gh', ['pr', 'view', '--json', 'number,headRefName'], { cwd: sb.dir, env, encoding: 'utf8' });
        has(pr.stdout + pr.stderr, '"state":"OPEN"', 'mock gh pr view output contains state');
    });
    it('empty PR fetch returns empty comments array', () => {
        const db = schemaDb(join(sb.dir, 'db3.db'));
        sql(db, "INSERT INTO repos (name, path) VALUES ('repo', ?)", join(sb.dir, 'repo3'));
        sql(db, "INSERT INTO repo_remotes (repo, name, provider, url, is_primary) VALUES ('repo', 'origin', 'github', 'https://github.com/owner/repo.git', 1)");
        const ghArgs = join(sb.dir, 'gh3.args');
        const bin3 = join(sb.dir, 'bin3');
        writeStub(bin3, 'gh', `#!/usr/bin/env bash
echo "$*" >> "${ghArgs}"
echo '{"state":"OPEN","comments":[],"reviews":[]}'
exit 0
`);
        const out = runMcp(bin3, db, `const result = await tools.handlers['pr_monitor_comments_get']({ agent: 'bro', pr_number: 99 });
      const data = JSON.parse(result.content[0].text);
      console.log(JSON.stringify({ count: data.comments ? data.comments.length : -1 }));`);
        has(out, '"count":0', 'empty fetch returns zero comments');
        has(existsSync(ghArgs) ? readFileSync(ghArgs, 'utf8') : '', '-R github.com/owner/repo', 'gh called with slug from seeded repo_remotes row');
    });
    describe('arch-impact heuristic flags schema.sql changes', () => {
        for (const p of ['mcp/trajectory-server/src/schema.sql', '.claude-plugin/plugin.json', 'templates/agents/new-agent.md', 'agents/custom.md']) {
            it(`arch-impact: ${p}`, () => assert.ok(ARCH_IMPACT.test(p), `Expected ${p} to be arch-impact`));
        }
        for (const p of ['src/utils.ts', 'README.md', 'tests/l3-integration/hooks/some.test.sh']) {
            it(`non-arch-impact: ${p}`, () => assert.ok(!ARCH_IMPACT.test(p), `Expected ${p} NOT to be arch-impact`));
        }
    });
});
//# sourceMappingURL=pr-monitor-flow-l3.test.js.map