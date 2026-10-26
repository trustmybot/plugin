// Cross-links test: seed a temp trajectory DB from schema.sql with repos and
// repo_remotes (a GitHub origin, a GitLab mirror, a repo with only an
// unparseable or provider-mismatched remote), issues with gh_iid / gl_iid,
// tasks with commits, a verification run and discussions with and without a
// task_id; start the built dashboard server and check remote_web_url,
// remote_provider and discussion task_id on the API; then bundle the views with
// esbuild, render them to static HTML and check every id is an <a href> in the
// shared ENTITY_LINK style, remote issue and commit links open in a new tab,
// the URL normaliser table, and the search box re-sync with the hash q.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const GH = 'https://github.com/acme/alpha';
const GL = 'https://gitlab.com/acme/group/alpha';

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = new Date().toISOString();
  const repo = db.prepare("INSERT INTO repos (name, path) VALUES (?, '.')");
  for (const name of ['alpha', 'beta', 'gamma']) repo.run(name);
  const remote = db.prepare('INSERT INTO repo_remotes (repo, name, provider, url, is_primary, sync) VALUES (?, ?, ?, ?, ?, ?)');
  remote.run('alpha', 'aaa-fork', 'github', 'https://github.com/someone/alpha.git', 0, 0);
  remote.run('alpha', 'origin', 'github', 'git@github.com:acme/alpha.git', 1, 1);
  remote.run('alpha', 'mirror', 'gitlab', 'ssh://git@gitlab.com/acme/group/alpha.git', 0, 0);
  remote.run('beta', 'origin', 'github', 'http://github.com/acme/beta', 1, 1);
  remote.run('beta', 'mirror', 'gitlab', 'https://gitlab.com/acme/beta', 0, 0);
  const issue = db.prepare('INSERT INTO issues (objective, repo, gh_iid, gl_iid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const ghIssue = Number(issue.run('GitHub issue', 'alpha', 42, null, now, now).lastInsertRowid);
  const glIssue = Number(issue.run('GitLab issue', 'alpha', null, 7, now, now).lastInsertRowid);
  const bareIssue = Number(issue.run('Beta issue', 'beta', 5, null, now, now).lastInsertRowid);
  const task = db.prepare(
    "INSERT INTO tasks (issue_id, branch_id, title, description, status, repo, commit_sha, created_at, updated_at) VALUES (?, ?, ?, 'd', 'completed', ?, ?, ?, ?)",
  );
  const linked = Number(task.run(ghIssue, 'feat/alpha work', 'Alpha task', 'alpha', SHA, now, now).lastInsertRowid);
  const plain = Number(task.run(bareIssue, 'feat/gamma', 'Gamma task', 'gamma', SHA, now, now).lastInsertRowid);
  db.prepare(
    `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
     VALUES (?, ?, 'gate', ?, ?, 0, 600, 0)`,
  ).run(linked, SHA, now, now);
  const discussion = db.prepare('INSERT INTO discussions (issue_id, author, kind, body, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  discussion.run(ghIssue, 'bro', 'decision', 'A decision long enough and with a second line.\n\nIt belongs to a task.', linked, now);
  discussion.run(ghIssue, 'human', 'note', 'Short note', null, now);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { ghIssue, glIssue, bareIssue, linked, plain };
}

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TRAJECTORY_DB_PATH: dbPath, TMB_DASHBOARD_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)?.[0];
      if (url) resolve({ url, stop: () => new Promise((done) => (child.once('exit', done), child.kill())) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

async function loadViews() {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { remoteWebUrl } from './server/queries.ts';
        import { ENTITY_LINK, entityLink, TASK_ID_COLUMN, TASK_TITLE_COLUMN } from './web/shared/columns.tsx';
        import { EntityList, syncSearch, typedSearch } from './web/shared/list/EntityList.tsx';
        import { AUDIT_COLUMNS } from './web/views/AuditView.tsx';
        import { AGENT_RUN_COLUMNS } from './web/views/RunsView.tsx';
        import { IssueList } from './web/views/issues/IssueList.tsx';
        import { Sidebar } from './web/views/issues/Sidebar.tsx';
        import { Timeline } from './web/views/issues/Timeline.tsx';
        import { WriteError } from './web/views/issues/WriteError.tsx';
        import { TaskSidebar } from './web/views/tasks/TaskSidebar.tsx';
        import { VerificationSection } from './web/views/tasks/sections.tsx';
        import { ApiError } from './web/api.ts';
        import { IssueOpenedIcon } from '@primer/octicons-react';
        const html = (el) => renderToStaticMarkup(el);
        const withWindow = (hash, fn) => {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {} };
          try { return fn(); } finally { delete globalThis.window; }
        };
        const column = (cols, key) => cols.find((c) => c.key === key);
        export const cell = (cols, key, row) => html(column(cols, key).cell(row));
        export const cols = { AUDIT_COLUMNS, AGENT_RUN_COLUMNS, TASK: [TASK_ID_COLUMN, TASK_TITLE_COLUMN] };
        export const hasColumn = (cols, key) => column(cols, key);
        export const link = (kind, idKey, labelKey, row) => html(entityLink(kind, idKey, labelKey)(row));
        export const issueList = (rows) => withWindow('#/issues', () => html(createElement(IssueList, { rows, state: 'open' })));
        export const sidebar = (issue, tasks) => html(createElement(Sidebar, { issue, labels: [], tasks }));
        export const timeline = (discussions) => html(createElement(Timeline, { discussions }));
        export const writeError = (body) => html(createElement(WriteError, { error: new ApiError(409, body) }));
        export const taskSidebar = (task) => html(createElement(TaskSidebar, { task }));
        export const verification = (runs, web, provider) => html(createElement(VerificationSection, { runs, web, provider }));
        export const searchBox = (hash) => withWindow(hash, () => html(createElement(EntityList, {
          rows: [], tabs: [{ key: 'all', label: 'All', icon: IssueOpenedIcon, filter: () => true }], sorts: { id: { label: 'Id', key: 'id', dir: 1 } },
          matches: () => true, renderRow: () => null, tab: 'all', path: 'tasks', noun: ['task', 'tasks'], emptyIcon: IssueOpenedIcon, searchPlaceholder: 'Search',
        })));
        export { ENTITY_LINK, remoteWebUrl, syncSearch, typedSearch };`,
      resolveDir: DASH,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(SERVER)});` },
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const internal = (html, href) => {
  const m = new RegExp(`<a href="${escapeRe(href)}" class="([^"]*)"`).exec(html);
  assert.ok(m, `no <a href="${href}"> in ${html}`);
  return m[1];
};
const external = (html, href) => {
  const m = new RegExp(`<a href="${escapeRe(href)}"[^>]*>([\\s\\S]*?)</a>`).exec(html);
  assert.ok(m, `no <a href="${href}"> in ${html}`);
  assert.match(m[0], /target="_blank"/);
  assert.match(m[0], /rel="noopener noreferrer"/);
  assert.match(m[1], /<svg[^>]*aria-hidden="true"/);
  assert.match(m[1], /<span class="sr-only">\(opens in new tab\)<\/span>/);
  return m[0];
};

let views;
before(async () => {
  views = await loadViews();
});

describe('remote URL normaliser', () => {
  test('accepts https, scp-style and ssh:// forms, strips .git and trailing /', () => {
    const accepted = {
      'https://github.com/acme/alpha': GH,
      'https://github.com/acme/alpha.git': GH,
      'https://github.com/acme/alpha/': GH,
      'https://GitHub.com/acme/alpha.git/': GH,
      'git@github.com:acme/alpha.git': GH,
      'ssh://git@github.com/acme/alpha.git': GH,
      'ssh://git@gitlab.com/acme/group/alpha': GL,
      'git@gitlab.com:acme/group/alpha.git': GL,
    };
    for (const [url, want] of Object.entries(accepted)) assert.equal(views.remoteWebUrl(url), want, url);
  });

  test('rejects every other form', () => {
    const rejected = [
      'http://github.com/acme/alpha',
      '/srv/git/alpha.git',
      'file:///srv/git/alpha.git',
      'https://user:token@github.com/acme/alpha.git',
      'https://github.com/acme/alpha?x=1',
      'https://github.com/acme/alpha#frag',
      'https://github.com/acme/al pha',
      'https://github.com/acme/<script>',
      'https://github.com/alpha',
      'https://github.com/acme/../evil',
      'https://github.com:8443/acme/alpha',
      'javascript:alert(1)//github.com/a/b',
      'ssh://root@github.com/acme/alpha',
      'git@github.com/acme/alpha',
      '',
      null,
    ];
    for (const url of rejected) assert.equal(views.remoteWebUrl(url), null, String(url));
  });
});

describe('cross-links against a seeded DB', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-links-'));
  const dbPath = join(tmp, 'trajectory.db');
  const ids = seed(dbPath);
  let server;
  const get = async (path) => (await fetch(`${server.url}api/${path}`)).json();

  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('GET /api/issues carries remote_web_url matched to the iid provider', async () => {
    const rows = await get('issues');
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(ids.ghIssue).remote_web_url, GH);
    assert.equal(byId.get(ids.glIssue).remote_web_url, GL);
    assert.equal(byId.get(ids.bareIssue).remote_web_url, null);
  });

  test('GET /api/issues/:id carries remote_web_url and discussion task_id', async () => {
    const detail = await get(`issues/${ids.ghIssue}`);
    assert.equal(detail.issue.remote_web_url, GH);
    assert.deepEqual(detail.discussions.map((d) => d.task_id), [ids.linked, null]);
    assert.equal((await get(`issues/${ids.bareIssue}`)).issue.remote_web_url, null);
  });

  test('GET /api/tasks/:id carries remote_web_url and remote_provider (sync remote first)', async () => {
    const { task } = await get(`tasks/${ids.linked}`);
    assert.equal(task.remote_web_url, GH);
    assert.equal(task.remote_provider, 'github');
    const plain = (await get(`tasks/${ids.plain}`)).task;
    assert.equal(plain.remote_web_url, null);
    assert.equal(plain.remote_provider, null);
  });

  test('IssueList meta links GH n / GL n out, plain text without a remote', async () => {
    const html = views.issueList(await get('issues'));
    assert.match(external(html, `${GH}/issues/42`), />GH 42</);
    assert.match(external(html, `${GL}/-/issues/7`), />GL 7</);
    assert.match(html, /GH 5/);
    assert.ok(!html.includes('/issues/5"'), 'beta issue must not link out');
  });

  test('issue Sidebar: Remote links out, task rows and branches are anchors', async () => {
    const detail = await get(`issues/${ids.ghIssue}`);
    const html = views.sidebar(detail.issue, detail.tasks);
    assert.match(external(html, `${GH}/issues/42`), />GH 42</);
    assert.ok(internal(html, `#/tasks/${ids.linked}`).includes(views.ENTITY_LINK));
    assert.match(html, new RegExp(`<a href="#/tasks/${ids.linked}"[^>]*>[\\s\\S]*?Alpha task[\\s\\S]*?<span[^>]*>completed</span>[\\s\\S]*?</a>`));
    assert.ok(internal(html, '#/tasks?branch=feat%2Falpha%20work').includes(views.ENTITY_LINK));
    const bare = await get(`issues/${ids.bareIssue}`);
    const plain = views.sidebar(bare.issue, bare.tasks);
    assert.match(plain, /GH 5/);
    assert.ok(!plain.includes('target="_blank"'));
  });

  test('Timeline shows a task chip only where task_id is set', async () => {
    const { discussions } = await get(`issues/${ids.ghIssue}`);
    const html = views.timeline(discussions);
    const chips = html.match(/data-task-chip/g) ?? [];
    assert.equal(chips.length, 1);
    const cls = internal(html, `#/tasks/${ids.linked}`);
    assert.ok(cls.includes(views.ENTITY_LINK) && /(^| )underline( |$)/.test(cls));
    assert.match(html, new RegExp(`>task ${ids.linked}</a>`));
    assert.equal((views.timeline([discussions[1]]).match(/data-task-chip/g) ?? []).length, 0);
  });

  test('TaskSidebar links the branch and the commit (7 chars, full sha in title)', async () => {
    const { task } = await get(`tasks/${ids.linked}`);
    const html = views.taskSidebar(task);
    assert.ok(internal(html, '#/tasks?branch=feat%2Falpha%20work').includes(views.ENTITY_LINK));
    const a = external(html, `${GH}/commit/${SHA}`);
    assert.match(a, new RegExp(`title="${SHA}"`));
    assert.match(a, new RegExp(`>${SHA.slice(0, 7)}</code>`));
    const plain = views.taskSidebar((await get(`tasks/${ids.plain}`)).task);
    assert.ok(!plain.includes('/commit/'));
    assert.match(plain, new RegExp(`<span title="${SHA}"><code[^>]*>${SHA.slice(0, 7)}</code></span>`));
  });

  test('verification run sha links to the commit on GitHub and GitLab', async () => {
    const { verifications } = await get(`tasks/${ids.linked}`);
    external(views.verification(verifications, GH, 'github'), `${GH}/commit/${SHA}`);
    external(views.verification(verifications, GL, 'gitlab'), `${GL}/-/commit/${SHA}`);
    const plain = views.verification(verifications, null, null);
    assert.ok(!plain.includes('<a '));
    assert.match(plain, new RegExp(`title="${SHA}"`));
  });
});

describe('internal links', () => {
  test('entityLink renders an ENTITY_LINK anchor or an em dash', () => {
    assert.equal(internal(views.link('issue', 'issue_id', undefined, { issue_id: 3 }), '#/issues/3'), views.ENTITY_LINK);
    assert.match(views.link('issue', 'issue_id', undefined, { issue_id: null }), /^<span class="text-fg-muted">—<\/span>$/);
    for (const key of ['task_id', 'task_title']) {
      assert.equal(internal(views.cell(views.cols.TASK, key, { task_id: 9, task_title: 'Nine' }), '#/tasks/9'), views.ENTITY_LINK);
    }
    assert.match(views.cell(views.cols.TASK, 'task_title', { task_id: 9, task_title: 'Nine' }), />Nine<\/a>$/);
    assert.match(views.cell(views.cols.TASK, 'task_id', { task_id: null }), /—/);
  });

  test('AuditView issue and branch cells link to the issue and the branch filter', () => {
    const row = { issue_id: 4, branch_id: 'feat/x y' };
    assert.equal(internal(views.cell(views.cols.AUDIT_COLUMNS, 'issue_id', row), '#/issues/4'), views.ENTITY_LINK);
    assert.equal(internal(views.cell(views.cols.AUDIT_COLUMNS, 'branch_id', row), '#/tasks?branch=feat%2Fx%20y'), views.ENTITY_LINK);
    assert.match(views.cell(views.cols.AUDIT_COLUMNS, 'branch_id', { branch_id: null }), /—/);
  });

  test('RunsView agent runs table has an Issue column hidden below md', () => {
    const col = views.hasColumn(views.cols.AGENT_RUN_COLUMNS, 'issue_id');
    assert.equal(col.header, 'Issue');
    assert.equal(col.hideBelow, 'md');
    assert.equal(internal(views.cell(views.cols.AGENT_RUN_COLUMNS, 'issue_id', { issue_id: 8 }), '#/issues/8'), views.ENTITY_LINK);
    assert.match(views.cell(views.cols.AGENT_RUN_COLUMNS, 'issue_id', { issue_id: null }), /—/);
  });

  test('WriteError "task N" links to the task page, underlined', () => {
    const html = views.writeError({ message: 'blocked', tasks: [{ task_id: 12, status: 'running' }] });
    const cls = internal(html, '#/tasks/12');
    assert.ok(cls.includes(views.ENTITY_LINK) && /(^| )underline( |$)/.test(cls));
    assert.match(html, />task 12</);
  });
});

describe('search box and the hash q', () => {
  test('renders the hash q as the input value', () => {
    assert.match(views.searchBox('#/tasks?q=hello%20world'), /<input type="search"[^>]*value="hello world"/);
    assert.match(views.searchBox('#/tasks'), /<input type="search"[^>]*value=""/);
  });

  test('re-syncs when the hash q changes from outside, keeps typed text otherwise', () => {
    let state = views.typedSearch('foo ');
    assert.equal(views.syncSearch(state, 'foo'), state, 'own replaceState write keeps the trailing space');
    state = views.syncSearch(state, 'bar');
    assert.deepEqual(state, { text: 'bar', synced: 'bar' });
    state = views.syncSearch(state, '');
    assert.deepEqual(state, { text: '', synced: '' });
    state = views.typedSearch('   ');
    assert.equal(views.syncSearch(state, ''), state);
  });
});
