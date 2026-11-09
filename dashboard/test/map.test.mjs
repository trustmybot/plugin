// Project map test: bundle ProjectMapView with esbuild, seed a react-query
// cache with a fixture world-model tree, render it to static HTML and check
// the directory tree is an ARIA tree of treeitems carrying aria-expanded, the
// listing shows a breadcrumb and one row per child with its summary, and a
// missing or empty world model renders a Blankslate with the existing copy;
// then check the #/map URL helpers, the #/concepts redirect and the Files | Concepts
// scope toggle with the field placeholder each scope shows; check the
// world-model query returns commits_behind and dead_refs, the List | Treemap
// toggle, the treemap cells and their click target, and the README drift
// markers in the listing, the tree and the treemap.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { importServer } from './server-module.mjs';

const DASH = new URL('..', import.meta.url).pathname;
const SERVER = join(DASH, 'dist/server.mjs');

const REPO = 'plugin';
const node = (path, parent_path, summary, file_count) => ({ repo: REPO, path, parent_path, summary, file_count });
const ROOT = node('', null, 'Plugin root.', 4);
const DASHBOARD = node('dashboard', '', 'Read-only web dashboard over the trajectory DB.', 6);
const HOOKS = node('hooks', '', 'PreToolUse and PostToolUse guards.', 12);
const WEB = node('dashboard/web', 'dashboard', 'React app.', 9);

const FIXTURE = {
  'world-model?repo=&depth=0': { available: true, repos: [REPO, 'site'], nodes: [ROOT] },
  'world-model?repo=plugin&path=&depth=1': { available: true, repos: [REPO, 'site'], nodes: [ROOT, DASHBOARD, HOOKS] },
  'world-model?repo=plugin&path=dashboard&depth=1': { available: true, repos: [REPO, 'site'], nodes: [DASHBOARD, WEB] },
  'world-model/graph?repo=plugin': { available: false, repo: null, repos: [], files: [], edges: [] },
};

let map;
before(async () => {
  const out = await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server';
        import { createElement } from 'react';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { ProjectMapView } from './web/views/ProjectMapView.tsx';
        import { DirectoryListing } from './web/views/map/DirectoryListing.tsx';
        import { DirectoryTree } from './web/views/map/DirectoryTree.tsx';
        import { DirectoryTreemap, TreemapChart } from './web/views/map/DirectoryTreemap.tsx';
        import { CONCEPT_COPY } from './web/views/concepts/copy.ts';
        import { mapHash, parseMapQuery, legacyConceptsHash } from './web/shared/route.ts';
        import { segmentKey } from './web/ui/SegmentedControl.tsx';
        export function render(seed, el) {
          const client = new QueryClient();
          for (const [key, data] of Object.entries(seed)) client.setQueryData([key], data);
          return renderToStaticMarkup(createElement(QueryClientProvider, { client }, el));
        }
        export function renderAt(hash, seed, el) {
          globalThis.window = { location: { hash }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {} };
          try { return render(seed, el); } finally { delete globalThis.window; }
        }
        export const h = createElement;
        export { ProjectMapView, DirectoryListing, DirectoryTree, DirectoryTreemap, TreemapChart, CONCEPT_COPY, mapHash, parseMapQuery, legacyConceptsHash, segmentKey };`,
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
  map = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
});

const noop = () => {};

const radiogroup = (html, label) => {
  const start = html.indexOf(`<div role="radiogroup" aria-label="${label}"`);
  assert.ok(start >= 0, `radiogroup ${label}`);
  return html.slice(start, html.indexOf('</div>', start));
};

describe('directory tree', () => {
  test('renders role="tree" with treeitems carrying aria-expanded', () => {
    const html = map.render(
      FIXTURE,
      map.h(map.DirectoryTree, { root: ROOT, selected: '', expanded: new Set(['', 'dashboard']), onSelect: noop, onToggle: noop }),
    );
    assert.match(html, /<ul role="tree" aria-label="Directories in plugin"/);
    const items = [...html.matchAll(/<li role="treeitem"([^>]*)>/g)].map((m) => m[1]);
    assert.equal(items.length, 4, 'root, dashboard, dashboard/web, hooks');
    for (const attrs of items) assert.match(attrs, /aria-expanded="(true|false)"/);
    assert.match(items[0], /aria-level="1"[^>]*aria-expanded="true"[^>]*aria-current="true"[^>]*tabindex="0"/);
    assert.match(items[1], /aria-level="2"[^>]*aria-expanded="true"/);
    assert.match(items[2], /aria-level="3"[^>]*aria-expanded="false"[^>]*tabindex="-1"/);
    assert.match(html, /<ul role="group"/);
    assert.match(html, /--control-transparent-bgColor-selected/);
    assert.equal(html.match(/tabindex="0"/g).length, 1, 'exactly one tab stop');
    for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(html.includes(`<span id="${m[1]}"`), m[1]);
  });

  test('a selection hidden in a collapsed directory leaves the first item as the tab stop', () => {
    const html = map.render(
      FIXTURE,
      map.h(map.DirectoryTree, { root: ROOT, selected: 'dashboard/web', expanded: new Set(['']), onSelect: noop, onToggle: noop }),
    );
    const items = [...html.matchAll(/<li role="treeitem"([^>]*)>/g)].map((m) => m[1]);
    assert.equal(items.length, 3, 'root, dashboard, hooks');
    assert.doesNotMatch(html, /aria-current/);
    assert.match(items[0], /tabindex="0"/);
    for (const attrs of items.slice(1)) assert.match(attrs, /tabindex="-1"/);
  });
});

describe('directory listing', () => {
  test('renders a breadcrumb and one row per child with its summary', () => {
    const html = map.render(FIXTURE, map.h(map.DirectoryListing, { repo: REPO, path: 'dashboard', onSelect: noop }));
    assert.match(html, /<nav aria-label="Breadcrumb"/);
    assert.match(html, /<button type="button"[^>]*>plugin<\/button>/);
    assert.match(html, /aria-hidden="true"[^>]*>\/<\/li>/);
    assert.match(html, /<span aria-current="page"[^>]*>dashboard<\/span>/);
    assert.match(html, />6<\/span> files/);
    assert.match(html, />web<\/button>/);
    assert.match(html, />React app\.<\/span>/);
  });

  test('the repo root lists each child directory once with its summary', () => {
    const html = map.render(FIXTURE, map.h(map.DirectoryListing, { repo: REPO, path: '', onSelect: noop }));
    assert.match(html, /<span aria-current="page"[^>]*>plugin<\/span>/);
    for (const child of [DASHBOARD, HOOKS]) {
      assert.equal(html.split(`>${child.path}</button>`).length - 1, 1, child.path);
      assert.ok(html.includes(child.summary), child.summary);
    }
  });
});

describe('project map view', () => {
  test('a missing world model renders a Blankslate with the existing copy', () => {
    const html = map.render({ 'world-model?repo=&depth=0': { available: false, repos: [], nodes: [] } }, map.h(map.ProjectMapView));
    assert.match(html, /<h2[^>]*>World Model Not Built Yet<\/h2>/);
    assert.match(html, /Open a Claude Code session to upgrade the DB and run \/scan\./);
    assert.doesNotMatch(html, /role="tree"/);
  });

  test('an empty world model renders a Blankslate with the existing copy', () => {
    const html = map.render({ 'world-model?repo=&depth=0': { available: true, repos: [], nodes: [] } }, map.h(map.ProjectMapView));
    assert.match(html, /<h2[^>]*>The World Model Is Empty<\/h2>/);
    assert.match(html, /Run \/scan in a Claude Code session\./);
  });

  test('a built world model renders the repo picker, tree, listing and graph slot', () => {
    const html = map.render(FIXTURE, map.h(map.ProjectMapView));
    assert.match(html, /Repository<\/span>/);
    assert.match(html, /<option value="plugin" selected="">plugin<\/option><option value="site">site<\/option>/);
    assert.match(html, /role="tree"/);
    assert.match(html, /<nav aria-label="Breadcrumb"/);
    assert.match(html, /No dependency graph yet/);
  });
});

describe('map routing', () => {
  test('mapHash and parseMapQuery round-trip both scopes', () => {
    for (const query of [{ scope: 'concepts', q: 'cold', concept: '7' }, { scope: 'files', q: 'src' }]) {
      const hash = map.mapHash(query);
      assert.match(hash, /^#\/map\?/);
      assert.deepEqual(map.parseMapQuery(hash.split('?')[1]), query);
    }
    assert.equal(map.mapHash({ scope: 'files', q: 'src' }), '#/map?q=src');
    assert.equal(map.mapHash({ scope: 'concepts', q: 'cold', concept: '7' }), '#/map?scope=concepts&q=cold&concept=7');
    assert.equal(map.mapHash({ scope: 'files', q: '', concept: '7' }), '#/map');
  });

  test('legacyConceptsHash maps #/concepts links to the concept scope and leaves others alone', () => {
    assert.equal(map.legacyConceptsHash('#/concepts/7?q=cold'), '#/map?scope=concepts&q=cold&concept=7');
    assert.equal(map.legacyConceptsHash('#/concepts/derived?q=parseFlags'), '#/map?scope=concepts&q=parseFlags&concept=derived');
    assert.equal(map.legacyConceptsHash('#/concepts?q=cold'), '#/map?scope=concepts&q=cold');
    assert.equal(map.legacyConceptsHash('#/concepts'), '#/map?scope=concepts');
    assert.equal(map.legacyConceptsHash('#/map'), null);
    assert.equal(map.legacyConceptsHash('#/conceptsx'), null);
  });
});

describe('search scope', () => {
  const radios = (html, label = 'Search scope') => [...radiogroup(html, label).matchAll(/<button type="button" role="radio" aria-checked="(true|false)" tabindex="(0|-1)"[^>]*>([^<]+)<\/button>/g)].map((m) => m.slice(1));

  test('concept scope renders the scope radiogroup, the concepts placeholder and only the RepoPicker select', () => {
    const html = map.renderAt('#/map?scope=concepts&q=cold', FIXTURE, map.h(map.ProjectMapView));
    assert.match(html, /<div role="radiogroup" aria-label="Search scope"/);
    assert.deepEqual(radios(html), [['false', '-1', 'Files'], ['true', '0', 'Concepts']]);
    assert.ok(html.includes(`placeholder="${map.CONCEPT_COPY.placeholder}"`), html);
    assert.match(html, /value="cold"/);
    assert.equal(html.match(/<select/g).length, 1);
    assert.match(html, /Repository<\/span>/);
    assert.doesNotMatch(html, /role="tree"/);
    assert.doesNotMatch(html, /No dependency graph yet/);
    assert.doesNotMatch(html, /Dependency Graph/);
    assert.ok(html.indexOf('role="radiogroup"') < html.indexOf('<input type="search"'), 'toggle sits left of the field');
  });

  test('files scope keeps the tree and uses the files placeholder', () => {
    const html = map.renderAt('#/map?q=src', FIXTURE, map.h(map.ProjectMapView));
    assert.deepEqual(radios(html), [['true', '0', 'Files'], ['false', '-1', 'Concepts']]);
    assert.match(html, /placeholder="Search folders and files…"/);
    assert.match(html, /value="src"/);
    assert.match(html, /role="tree"/);
    const graph = html.indexOf('No dependency graph yet');
    assert.ok(graph > html.indexOf('role="tree"'), 'dependency graph sits below the tree');
  });

  test('arrow keys, Home and End move between segments and wrap', () => {
    assert.equal(map.segmentKey(0, 'ArrowRight', 2), 1);
    assert.equal(map.segmentKey(1, 'ArrowRight', 2), 0);
    assert.equal(map.segmentKey(0, 'ArrowLeft', 2), 1);
    assert.equal(map.segmentKey(1, 'ArrowUp', 2), 0);
    assert.equal(map.segmentKey(0, 'ArrowDown', 2), 1);
    assert.equal(map.segmentKey(1, 'Home', 2), 0);
    assert.equal(map.segmentKey(0, 'End', 2), 1);
    assert.equal(map.segmentKey(0, 'Enter', 2), null);
  });
});

const DOCS = { ...node('docs', '', 'Guides.', 5), commits_behind: 3, dead_refs: ['a.md', 'b.md'] };
const EMPTY = node('empty', '', 'Nothing here.', 0);
const childKey = (path) => `world-model?repo=plugin&path=${path}&depth=1`;
const DRIFT_ROOT = childKey('');
const DRIFT = { ...FIXTURE, [DRIFT_ROOT]: { available: true, repos: [REPO], nodes: [ROOT, DASHBOARD, HOOKS, DOCS, EMPTY] } };

function findElement(el, match) {
  if (el === null || typeof el !== 'object') return null;
  if (Array.isArray(el)) {
    for (const child of el) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (el.props && match(el.props)) return el;
  return findElement(el.props?.children, match);
}

describe('world-model query', () => {
  test('directory nodes carry commits_behind and dead_refs, null when unset', async () => {
    const { worldModel } = await importServer('queries.ts');
    const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tmb-dashboard-map-'));
    try {
      const db = new DatabaseSync(join(tmp, 'trajectory.db'));
      db.exec(readFileSync(join(DASH, '../mcp/trajectory-server/src/schema.sql'), 'utf8'));
      const dir = db.prepare(
        `INSERT INTO wm_directories (repo, path, parent_path, summary, summary_source, file_count, commits_behind, dead_refs)
         VALUES ('plugin', ?, ?, 'x', 'readme', 1, ?, ?)`,
      );
      dir.run('', null, null, null);
      dir.run('docs', '', 3, '["a.md"]');
      dir.run('hooks', '', null, null);
      dir.run('bad', '', 0, 'not json');
      const body = worldModel(db, 'plugin', '', 1);
      const by = Object.fromEntries(body.nodes.map((n) => [n.path, n]));
      assert.equal(by.docs.commits_behind, 3);
      assert.deepEqual(by.docs.dead_refs, ['a.md']);
      assert.equal(by.hooks.commits_behind, null);
      assert.equal(by.hooks.dead_refs, null);
      assert.equal(by[''].commits_behind, null);
      assert.equal(by.bad.commits_behind, 0);
      assert.equal(by.bad.dead_refs, null);
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('README drift markers', () => {
  test('the listing marks a drifted directory as text with the dead refs in a tooltip', () => {
    const html = map.render(DRIFT, map.h(map.DirectoryListing, { repo: REPO, path: '', onSelect: noop }));
    assert.match(html, />3 commits behind</);
    assert.match(html, /<span title="a\.md\nb\.md">[^]*?>2 dead refs</);
    assert.equal(html.match(/commits behind/g).length, 1, 'only docs drifted');
    assert.match(html, /--fgColor-attention/);
  });

  test('the tree marks a drifted directory', () => {
    const html = map.render(DRIFT, map.h(map.DirectoryTree, { root: ROOT, selected: '', expanded: new Set(['']), onSelect: noop, onToggle: noop }));
    const docs = html.slice(html.indexOf('>docs<'));
    assert.match(docs.slice(0, docs.indexOf('</li>')), />3 commits behind<[^]*>2 dead refs</);
    assert.equal(html.match(/commits behind/g).length, 1);
  });
});

describe('treemap', () => {
  test('renders one cell per child with files, drift as text and a dashed outline', () => {
    const html = map.render(DRIFT, map.h(map.DirectoryTreemap, { repo: REPO, path: '', onSelect: noop }));
    assert.match(html, /<svg role="group" aria-label="Treemap of plugin by file count"/);
    const cells = [...html.matchAll(/<g role="button" tabindex="0" aria-label="([^"]*)" data-path="([^"]*)"( data-drift="true")?/g)];
    assert.deepEqual(cells.map((m) => m[2]).sort(), ['dashboard', 'docs', 'hooks'], 'the zero-file directory gets no cell');
    const docs = cells.find((m) => m[2] === 'docs');
    assert.equal(docs[1], 'docs, 5 files, 3 commits behind, 2 dead refs: a.md, b.md');
    assert.ok(docs[3], 'docs is marked drifted');
    assert.ok(!cells.find((m) => m[2] === 'hooks')[3]);
    assert.match(html, /<title>docs\n5 files\n3 commits behind\n2 dead refs: a\.md, b\.md<\/title>/);
    assert.match(html, /<title>hooks\n12 files<\/title>/);
    assert.match(html, /stroke-dasharray="6 3"/);
    assert.match(html, /<tspan[^>]*>3 commits behind<\/tspan>/);
  });

  test('clicking or pressing Enter on a cell selects that child', () => {
    const picked = [];
    const kids = DRIFT[DRIFT_ROOT].nodes.slice(1);
    const chart = map.TreemapChart({ kids, title: REPO, clip: 't', onSelect: (p) => picked.push(p), onHover: noop });
    const cell = (path) => findElement(chart, (p) => p['data-path'] === path);
    cell('docs').props.onClick();
    cell('hooks').props.onKeyDown({ key: 'Enter', preventDefault: noop });
    cell('hooks').props.onKeyDown({ key: 'a', preventDefault: noop });
    assert.deepEqual(picked, ['docs', 'hooks']);
    assert.equal(cell('empty'), null);
  });

  test('a directory with no file-bearing children says so', () => {
    const seed = { [childKey('empty')]: { available: true, repos: [REPO], nodes: [EMPTY, node('empty/none', 'empty', null, 0)] } };
    const html = map.render(seed, map.h(map.DirectoryTreemap, { repo: REPO, path: 'empty', onSelect: noop }));
    assert.doesNotMatch(html, /<svg/);
    assert.match(html, /No subdirectories with files\./);
  });

  test('the project map offers a List | Treemap toggle with List selected', () => {
    const html = map.render(FIXTURE, map.h(map.ProjectMapView));
    assert.deepEqual(
      [...radiogroup(html, 'Directory view').matchAll(/aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => m.slice(1)),
      [['true', 'List'], ['false', 'Treemap']],
    );
    assert.match(html, /<nav aria-label="Breadcrumb"/);
  });
});
