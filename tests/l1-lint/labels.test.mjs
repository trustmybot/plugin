import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
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
  `### What broke\n\nWrite denied\n\n### Area\n\n${area}\n\n### Impact\n\n${impact}\n\n${marker}\n`;

test('GH 2034 V6: a marker body with no labels gets Bug, the Impact priority and the Area, and no needs-triage', () => {
  const result = triage({ labels: [], body: reportBody('Blocks one task, has a workaround'), catalog });
  assert.deepEqual(result, { add: ['Bug', 'Priority: Medium', 'Area: Hooks'], remove: [] });
});

test('GH 2034 V6: a body without the marker gets no Bug', () => {
  const result = triage({ labels: [], body: reportBody('Blocks all TMB work', 'Hooks', ''), catalog });
  assert.ok(!result.add.includes('Bug'));
  assert.ok(!result.add.includes('Priority: High'));
  assert.deepEqual(result, { add: ['Area: Hooks', 'needs-triage'], remove: [] });
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
