import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formAnswer, formArea, loadCatalog, renderDoc, renderSection, triage } from '../../scripts/maintenance/labels.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalog = loadCatalog(ROOT);
const formBody = (area) => `### What happened\n\nIt broke.\n\n### Area\n\n${area}\n\n### Version\n\n1.2.0\n`;

test('missing area adds needs-triage', () => {
  assert.deepEqual(triage({ labels: ['Bug', 'Priority: High'], body: '', catalog }), { add: ['needs-triage'], remove: [] });
});

test('two types add needs-triage', () => {
  const labels = ['Bug', 'Feature', 'Priority: Low', 'Area: Hooks'];
  assert.deepEqual(triage({ labels, body: '', catalog }), { add: ['needs-triage'], remove: [] });
});

test('form Area answer becomes its label and completes the set', () => {
  const result = triage({ labels: ['Bug', 'Priority: Medium', 'needs-triage'], body: formBody('World Model'), catalog });
  assert.deepEqual(result, { add: ['Area: World Model'], remove: ['needs-triage'] });
});

test('form Area answer is ignored when the issue already has an area', () => {
  const result = triage({ labels: ['Bug', 'Priority: Medium', 'Area: Hooks'], body: formBody('Dashboard'), catalog });
  assert.deepEqual(result, { add: [], remove: [] });
});

test('unknown or empty form answers add no area', () => {
  assert.equal(formArea(formBody('_No response_')), null);
  assert.deepEqual(triage({ labels: ['Bug', 'Priority: Low'], body: formBody('Nope'), catalog }), { add: ['needs-triage'], remove: [] });
});

test('complete set clears needs-triage', () => {
  const labels = ['Improvement', 'Priority: Low', 'Area: Release', 'token-burn', 'needs-triage'];
  assert.deepEqual(triage({ labels, body: '', catalog }), { add: [], remove: ['needs-triage'] });
});

test('every required group has labels and every area form value maps to a label', () => {
  for (const group of ['type', 'priority', 'area']) assert.ok(catalog.some((l) => l.group === group), group);
  for (const form of ['bug', 'improvement', 'feature', 'research']) {
    const yml = readFileSync(join(ROOT, `.github/ISSUE_TEMPLATE/${form}.yml`), 'utf8');
    const areas = catalog.filter((l) => l.group === 'area').map((l) => l.name.replace(/^Area: /, ''));
    for (const area of areas) assert.match(yml, new RegExp(`^\\s+- ${area}$`, 'm'), `${form}.yml lacks ${area}`);
    assert.match(yml, /required: true/, `${form}.yml must require Area`);
  }
});

test('LABELS.md tables match .github/labels.json', () => {
  const doc = readFileSync(join(ROOT, 'docs/contributing/LABELS.md'), 'utf8');
  assert.equal(doc, renderDoc(doc, catalog), 'run: node scripts/maintenance/labels.mjs --doc');
});

function cells(row) {
  const out = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\') {
      current += row.slice(i, i + 2);
      i++;
    } else if (row[i] === '|') {
      out.push(current);
      current = '';
    } else {
      current += row[i];
    }
  }
  out.push(current);
  return out.slice(1, -1).map((c) => c.trim());
}

test('a backslash cannot undo the pipe escape in a table cell', () => {
  const entry = { name: 'Area: X', color: '000000', description: 'ends in \\| then more', group: 'area' };
  const row = renderSection([entry]).split('\n').find((line) => line.startsWith('| **Area: X**'));
  assert.equal(row, '| **Area: X** | ends in \\\\\\| then more |');
  assert.deepEqual(cells(row), ['**Area: X**', 'ends in \\\\\\| then more']);
});

const MARKER = '<!-- tmb-report v1 sig=0123456789ab -->';
const reportBody = (impact, area = 'Hooks', marker = MARKER) =>
  `### What went wrong\n\nWrite denied\n\n### Area\n\n${area}\n\n### Impact\n\n${impact}\n\n${marker}\n`;

test('GH 2034 V6: a marker body with no labels gets Bug, the Impact priority and the Area, and no needs-triage', () => {
  const result = triage({ labels: [], body: reportBody('Blocks one task, has a workaround'), catalog });
  assert.deepEqual(result, { add: ['Bug', 'Priority: Medium', 'Area: Hooks'], remove: [] });
});

test('GH 2034 V6: a body without the marker gets no Bug', () => {
  const result = triage({ labels: [], body: reportBody('Blocks all TMB work', 'Hooks', ''), catalog });
  assert.ok(!result.add.includes('Bug'));
  assert.deepEqual(result, { add: ['Priority: High', 'Area: Hooks', 'needs-triage'], remove: [] });
});

test('GH 3318: a web form body (no marker) gets the Impact priority', () => {
  const result = triage({ labels: ['Bug', 'needs-triage'], body: reportBody('Blocks one task, has a workaround', 'Hooks', ''), catalog });
  assert.deepEqual(result, { add: ['Priority: Medium', 'Area: Hooks'], remove: ['needs-triage'] });
});

test('GH 3318: a body with no Impact answer gets no priority', () => {
  for (const body of [reportBody('_No response_', 'Hooks', ''), formBody('Hooks'), reportBody('Blocks everything', 'Hooks', '')]) {
    const result = triage({ labels: ['Bug'], body, catalog });
    assert.deepEqual(result, { add: ['Area: Hooks', 'needs-triage'], remove: [] }, body);
  }
});

test('GH 3318: a report drafted with every field filled gets Bug, the Impact priority and the Area, and no needs-triage', async () => {
  const { render } = await import('../../mcp/trajectory-server/dist/bug-report/render.js');
  const ctx = { home: '/Users/a', projectRoot: '/Users/a/p', remoteUrls: [], repoNames: [], branchNames: ['main'], titles: [] };
  const input = {
    tool: 'scan_run',
    error_class: 'TypeError',
    summary: 'scan fails',
    'what-happened': 'Expected a scan, got an error.',
    impact: 'Blocks all TMB work',
    error: 'TypeError: x is undefined',
    frequency: 'Every time',
    area: 'World Model',
    reproduce: 'Run /scan.',
    'repro-script': 'tmb scan',
    doctor: 'all green',
    workaround: 'none',
  };
  const report = render(input, { os: 'darwin' }, ctx);
  const result = triage({ labels: [], body: report.body, catalog });
  assert.deepEqual(result, { add: ['Bug', 'Priority: High', 'Area: World Model'], remove: [] });
});

test('GH 2034 V6: an existing Priority: Low survives an Impact of "Blocks all TMB work"', () => {
  const result = triage({ labels: ['Bug', 'Priority: Low'], body: reportBody('Blocks all TMB work'), catalog });
  assert.deepEqual(result, { add: ['Area: Hooks'], remove: [] });
});

test('GH 2034 V6: an existing type label is never replaced by Bug', () => {
  const result = triage({ labels: ['Improvement'], body: reportBody('Annoying or cosmetic'), catalog });
  assert.deepEqual(result, { add: ['Priority: Low', 'Area: Hooks'], remove: [] });
});

test('GH 2034 V6: each Impact string maps to its priority', () => {
  const expected = {
    'Blocks all TMB work': 'Priority: High',
    'Blocks one task, has a workaround': 'Priority: Medium',
    'Annoying or cosmetic': 'Priority: Low',
  };
  for (const [impact, priority] of Object.entries(expected)) {
    assert.equal(formAnswer(reportBody(impact), 'Impact'), impact);
    const result = triage({ labels: ['Bug', 'Area: Hooks'], body: reportBody(impact), catalog });
    assert.deepEqual(result, { add: [priority], remove: [] }, impact);
  }
});

test('GH 2034 V6: the labels.mjs README row names the tmb-report marker and Impact triage', () => {
  const readme = readFileSync(join(ROOT, 'scripts', 'maintenance', 'README.md'), 'utf8');
  const row = readme.split('\n').find((line) => line.startsWith('| `labels.mjs`'));
  assert.ok(row, 'labels.mjs row missing from scripts/maintenance/README.md');
  assert.match(row, /tmb-report/);
  assert.match(row, /Impact/);
});

test('GH 2533: run through a symlinked directory, labels.mjs still runs main()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-labels-link-'));
  try {
    const link = join(dir, 'plugin');
    symlinkSync(ROOT, link);
    const run = spawnSync(
      process.execPath,
      [join(link, 'scripts', 'maintenance', 'labels.mjs'), '--check', '--root', join(dir, 'missing')],
      { encoding: 'utf8' },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
