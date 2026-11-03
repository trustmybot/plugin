// Concepts endpoint test: seed a temp trajectory DB from schema.sql with a
// small symbol index (5 symbols in 3 directories, exact calls edges, one test
// path) and a 3-step concept whose third anchor is gone, start the built
// dashboard server against it and check /api/concepts, /api/concepts/:id,
// /graph and /api/symbols/:id/neighbourhood; then check a v44 DB answers
// available:false and that the server left both DB files unchanged. Then
// render the concept badges, the copy button, the map search field in concept
// scope and the ConceptSearch body to static HTML and check ui/Label variants,
// invisible Button tokens, the field copy and a listbox with no repo select.
// `node dashboard/test/concepts.test.mjs --seed <path>` only writes the seeded
// DB, for viewing the Concepts scope of the Project map against it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SCHEMA = join(DASH, '../mcp/trajectory-server/src/schema.sql');
const SERVER = join(DASH, 'dist/server.mjs');
const REPO = 'plugin';

const SYMBOLS = [
  ['src/boot/start.ts', 'startServer', 'start server function'],
  ['src/boot/start.ts', 'loadConfig', 'load config function'],
  ['src/db/open.ts', 'openDatabase', 'open database function'],
  ['lib/flags.ts', 'parseFlags', 'parse flags function'],
  ['lib/log.ts', 'writeLog', 'write log function'],
  ['test/start.test.ts', 'checkStart', 'check start function'],
];
const CALLS = [
  ['startServer', 'loadConfig'],
  ['startServer', 'openDatabase'],
  ['loadConfig', 'parseFlags'],
  ['openDatabase', 'writeLog'],
  ['checkStart', 'startServer'],
];

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function seed(path, version) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  const now = new Date().toISOString();
  const ids = {};
  const symbol = db.prepare(
    `INSERT INTO wm_symbols (repo, path, kind, qualified_name, signature, start_line, end_line, body_hash, terms)
     VALUES (?, ?, 'function', ?, ?, ?, ?, ?, ?)`,
  );
  SYMBOLS.forEach(([file, name, terms], i) => {
    ids[name] = Number(symbol.run(REPO, file, name, `function ${name}()`, i * 10 + 1, i * 10 + 8, `h${i}`, terms).lastInsertRowid);
  });
  const edge = db.prepare(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution, line) VALUES (?, ?, ?, 'calls', 'exact', ?)`);
  CALLS.forEach(([src, dst], i) => edge.run(ids[src], ids[dst], dst, i + 1));
  const steps = [
    ['src/boot/start.ts', 'startServer', 'Boots the warmup sequence and reads settings', 'calls'],
    ['src/db/open.ts', 'openDatabase', 'Opens the trajectory store', 'calls'],
    ['src/gone.ts', 'vanished', 'Hands off to a function that was deleted', null],
  ];
  const concept = Number(
    db
      .prepare(
        `INSERT INTO wm_concepts (repo, kind, name, body, status, created_at, updated_at, steps_text)
         VALUES (?, 'flow', 'cold start', 'How the server comes up', 'verified', ?, ?, ?)`,
      )
      .run(REPO, now, now, steps.map((s) => s[2]).join('\n')).lastInsertRowid,
  );
  const step = db.prepare(
    `INSERT INTO wm_concept_steps (concept_id, ordinal, repo, path, kind, qualified_name, description, handoff, hash_at_verify)
     VALUES (?, ?, ?, ?, 'function', ?, ?, ?, 'h')`,
  );
  steps.forEach(([file, name, description, handoff], i) => step.run(concept, i + 1, REPO, file, name, description, handoff));
  db.prepare('UPDATE plugin_meta SET schema_version = ? WHERE id = 1').run(version);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { ids, concept };
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

const seedOnly = process.argv[2] === '--seed' ? process.argv[3] : undefined;
if (seedOnly) {
  seed(seedOnly, 45);
  console.log(`seeded ${seedOnly}`);
} else describe('dashboard concepts API', () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-concepts-'));
  const dbPath = join(tmp, 'trajectory.db');
  const oldPath = join(tmp, 'trajectory-v44.db');
  const { ids, concept } = seed(dbPath, 45);
  seed(oldPath, 44);
  const before45 = sha(dbPath);
  const before44 = sha(oldPath);
  let server;
  const get = async (path) => {
    const res = await fetch(`${server.url}api/${path}`);
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    server = await startServer(dbPath);
  });
  after(async () => {
    await server?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('a word only in a step description finds the concept', async () => {
    const { status, body } = await get('concepts?q=warmup');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.deepEqual(body.repos, [REPO]);
    assert.deepEqual(body.concepts.map((c) => c.id), [concept]);
    assert.equal(body.concepts[0].step_count, 3);
    assert.equal(body.derived, null);
  });

  test('no concept match returns a derived chain', async () => {
    const { body } = await get('concepts?q=parseFlags');
    assert.deepEqual(body.concepts, []);
    assert.notEqual(body.derived, null);
    assert.equal(body.derived.steps[0].symbol.qualified_name, 'parseFlags');
  });

  test('a one-character query returns nothing', async () => {
    const { body } = await get('concepts?q=a');
    assert.deepEqual(body.concepts, []);
    assert.equal(body.derived, null);
  });

  test('the concept detail keeps step order and marks the gone anchor broken', async () => {
    const { status, body } = await get(`concepts/${concept}`);
    assert.equal(status, 200);
    assert.deepEqual(body.steps.map((s) => s.ordinal), [1, 2, 3]);
    assert.equal(body.steps[2].symbol, null);
    assert.equal(body.steps[2].trust, 'broken');
    assert.equal(body.steps[0].symbol.qualified_name, 'startServer');
  });

  test('the graph keeps every step node, drops test paths and has calls edges', async () => {
    const { status, body } = await get(`concepts/${concept}/graph`);
    assert.equal(status, 200);
    const steps = body.nodes.filter((n) => n.step_ordinal !== null);
    assert.deepEqual(steps.map((n) => [n.id, n.step_ordinal]), [[ids.startServer, 1], [ids.openDatabase, 2]]);
    assert.ok(body.nodes.every((n) => !n.path.startsWith('test/')));
    assert.ok(body.nodes.some((n) => n.id === ids.loadConfig && n.dir === 'src/boot'));
    assert.ok(body.edges.some((e) => e.kind === 'calls' && e.src === ids.startServer && e.dst === ids.openDatabase));
    assert.equal(body.truncated, false);
  });

  test('the graph limit truncates neighbours, never steps', async () => {
    const { body } = await get(`concepts/${concept}/graph?limit=1`);
    assert.equal(body.nodes.filter((n) => n.step_ordinal !== null).length, 2);
    assert.equal(body.nodes.length, 2);
    assert.equal(body.truncated, true);
  });

  test('a symbol neighbourhood lists its 1-hop neighbours', async () => {
    const { status, body } = await get(`symbols/${ids.loadConfig}/neighbourhood`);
    assert.equal(status, 200);
    assert.deepEqual(body.nodes.map((n) => n.label).sort(), ['loadConfig', 'parseFlags', 'startServer']);
    assert.ok(body.nodes.every((n) => n.step_ordinal === null));
  });

  test('unknown ids are 404 JSON', async () => {
    for (const path of ['concepts/9999', 'concepts/9999/graph', 'concepts/abc', 'symbols/9999/neighbourhood', 'concepts/1/nope']) {
      const { status, body } = await get(path);
      assert.equal(status, 404, path);
      assert.equal(typeof body.error, 'string');
    }
  });

  test('a v44 DB answers available:false with 200', async () => {
    await server.stop();
    server = await startServer(oldPath);
    for (const path of ['concepts?q=warmup', `concepts/${concept}`, `concepts/${concept}/graph`]) {
      const { status, body } = await get(path);
      assert.equal(status, 200, path);
      assert.equal(body.available, false, path);
    }
    await server.stop();
    server = null;
  });

  test('the server left both DB files unchanged', () => {
    assert.equal(sha(dbPath), before45);
    assert.equal(sha(oldPath), before44);
  });
});

if (!seedOnly) describe('concepts view markup', () => {
  let ui;
  before(async () => {
    const out = await build({
      stdin: {
        contents: `import { renderToStaticMarkup } from 'react-dom/server';
          import { createElement } from 'react';
          import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
          import { TrustBadge, DerivedBadge } from './web/views/concepts/badges.tsx';
          import { ConceptSearch } from './web/views/concepts/ConceptSearch.tsx';
          import { CONCEPT_COPY } from './web/views/concepts/copy.ts';
          import { SearchField } from './web/views/map/MapSearch.tsx';
          import { CopyButton } from './web/ui/CopyButton.tsx';
          import { LABEL_COLORS } from './web/ui/Label.tsx';
          export const render = (el) => renderToStaticMarkup(el);
          export function withData(seed, el) {
            const client = new QueryClient();
            for (const [key, data] of Object.entries(seed)) client.setQueryData([key], data);
            return renderToStaticMarkup(createElement(QueryClientProvider, { client }, el));
          }
          export const h = createElement;
          export { TrustBadge, DerivedBadge, ConceptSearch, CONCEPT_COPY, SearchField, CopyButton, LABEL_COLORS };`,
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
    ui = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  });
  const html = (component, props) => ui.render(ui.h(ui[component], props));
  const HIT = { id: 7, name: 'Cold start', body: 'Boot the server.', step_count: 3, trust: { verified: 2, suspect: 0, broken: 1 } };

  test('a concept badge renders a ui/Label variant class', () => {
    for (const [trust, variant] of [['verified', 'success'], ['suspect', 'attention'], ['broken', 'danger']]) {
      const out = html('TrustBadge', { trust, count: 2 });
      assert.ok(out.includes(ui.LABEL_COLORS[variant]), `${trust} → ${variant}`);
      assert.match(out, /rounded-full/);
    }
    assert.ok(html('DerivedBadge', {}).includes(ui.LABEL_COLORS.secondary));
  });

  test('the copy button uses the invisible Button tokens and a copy octicon', () => {
    const out = html('CopyButton', { value: 'src/a.ts:1', label: 'Copy src/a.ts:1' });
    assert.match(out, /^<button type="button"/);
    assert.match(out, /--button-invisible-bgColor-rest/);
    assert.doesNotMatch(out, /--button-default-|min-h-6/);
    assert.match(out, /aria-label="Copy src\/a.ts:1"/);
    assert.match(out, /octicon-copy/);
  });

  test('the map search field in concept scope has an accessible name, the concepts placeholder and the help text', () => {
    const out = html('SearchField', { scope: 'concepts', value: '', onChange: () => {} });
    assert.match(out, /^<label[^>]*>.*<span class="sr-only">Search concepts<\/span>.*<input type="search"/s);
    assert.ok(out.includes(`placeholder="${ui.CONCEPT_COPY.placeholder}"`), out);
    assert.match(out, /aria-describedby="concepts-help"/);
    assert.doesNotMatch(out, /outline-blue/);
  });

  test('the unavailable copy has no dash', () => {
    assert.equal(ui.CONCEPT_COPY.unavailable, 'Concepts need a fresh scan. Run /scan in a Claude Code session.');
    assert.ok(!ui.CONCEPT_COPY.unavailable.includes('—'));
  });

  test('the concept search body queries the picked repo and renders the listbox with no field or repo select', () => {
    const seed = { 'concepts?q=cold&repo=site': { available: true, repos: ['plugin', 'site'], repo: 'site', concepts: [HIT], derived: null } };
    const out = ui.withData(seed, ui.h(ui.ConceptSearch, { term: 'cold', repo: 'site', id: undefined, onSelect: () => {} }));
    assert.match(out, /<ul role="listbox" tabindex="0" aria-label="Concepts" aria-activedescendant="concept-option-7"/);
    assert.match(out, /<li id="concept-option-7" role="option" aria-selected="false"/);
    assert.match(out, />Cold start</);
    assert.match(out, /<p id="concepts-help"/);
    assert.match(out, /role="status" aria-live="polite"[^>]*>1 concept found\./);
    assert.doesNotMatch(out, /<select|<input/);
    const other = ui.withData(seed, ui.h(ui.ConceptSearch, { term: 'cold', repo: 'plugin', id: undefined, onSelect: () => {} }));
    assert.doesNotMatch(other, /Cold start/);
  });

  test('a DB without concepts keeps the No Concepts Yet Blankslate', () => {
    const seed = { 'concepts?q=&repo=plugin': { available: false, repos: [], repo: null, concepts: [], derived: null } };
    const out = ui.withData(seed, ui.h(ui.ConceptSearch, { term: '', repo: 'plugin', id: undefined, onSelect: () => {} }));
    assert.match(out, /<h2[^>]*>No Concepts Yet<\/h2>/);
    assert.ok(out.includes(ui.CONCEPT_COPY.unavailable));
  });
});
