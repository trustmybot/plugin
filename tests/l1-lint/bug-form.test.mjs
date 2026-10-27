// L1 lint: .github/ISSUE_TEMPLATE/bug.yml lists the same fields, in the same order, as FORM_FIELDS in the bug-report module (GH 2034).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FORM_FIELDS } from '../../mcp/trajectory-server/dist/bug-report/form.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function scalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

function parseForm(yml) {
  const top = {};
  const fields = [];
  let field = null;
  let section = null;
  let blockIndent = null;
  for (const line of yml.split('\n')) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null && indent >= blockIndent) continue;
    blockIndent = null;
    const item = /^\s*- (.*)$/.exec(line);
    const pair = /^\s*(?:- )?([\w-]+):\s*(.*)$/.exec(line);
    if (indent === 0 && pair) {
      top[pair[1]] = pair[2] === '' ? undefined : pair[2].startsWith('[') ? JSON.parse(pair[2]) : scalar(pair[2]);
      continue;
    }
    if (indent === 2 && item) {
      field = { required: undefined };
      fields.push(field);
      section = null;
    }
    if (section === 'options' && item && indent === 8) {
      const check = /^label:\s*(.*)$/.exec(item[1]);
      field.options.push(check ? { label: scalar(check[1]), required: undefined } : scalar(item[1]));
      continue;
    }
    if (section === 'options' && indent === 10 && pair && pair[1] === 'required') {
      field.options[field.options.length - 1].required = scalar(pair[2]);
      continue;
    }
    if (!pair) continue;
    const [, key, value] = pair;
    if (value === '|' || value === '>') {
      field[key] = null;
      blockIndent = indent + 2;
      continue;
    }
    if (indent === 4 && (key === 'attributes' || key === 'validations')) {
      section = key;
      continue;
    }
    if (key === 'options') {
      field.options = [];
      section = 'options';
      continue;
    }
    if (section === 'options' && indent <= 6) section = 'attributes';
    if (section === 'validations' && key === 'required') field.required = scalar(value);
    else field[key] = scalar(value);
  }
  return { top, fields };
}

test('GH 2034 form: bug.yml matches FORM_FIELDS', () => {
  const { top, fields } = parseForm(readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/bug.yml'), 'utf8'));
  assert.equal(top.name, 'Bug report');
  assert.equal(typeof top.description, 'string');
  assert.deepEqual(top.labels, ['Bug']);
  assert.deepEqual(
    fields.map((f) => f.id),
    FORM_FIELDS.map((f) => f.id),
    'bug.yml field ids and order',
  );
  FORM_FIELDS.forEach((want, i) => {
    const have = fields[i];
    assert.equal(have.label, want.label, `${want.id} label`);
    assert.equal(have.type, want.type, `${want.id} type`);
    assert.equal(have.required, want.required, `${want.id} validations.required`);
    assert.equal(have.render, want.render, `${want.id} render`);
    assert.deepEqual(have.options, want.options && [...want.options].map((o) => (typeof o === 'string' ? o : { ...o })), `${want.id} options`);
    assert.equal(typeof have.description === 'string' || want.type === 'checkboxes', true, `${want.id} description`);
  });
});

test('GH 2034 form: the parser sees a drifted option', () => {
  const yml = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/bug.yml'), 'utf8').replace('        - Sometimes\n', '        - Often\n');
  const frequency = parseForm(yml).fields.find((f) => f.id === 'frequency');
  assert.deepEqual(frequency.options, ['Every time', 'Often', 'Once']);
});
