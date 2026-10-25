import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formArea, loadCatalog, renderDoc, triage } from '../../scripts/maintenance/labels.mjs';

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
