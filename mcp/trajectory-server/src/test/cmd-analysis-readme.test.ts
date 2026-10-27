/**
 * src/hooks/cmd-analysis/README.md documents the whole module: its API table
 * names every value index.ts exports, and its Module map lists every .ts file
 * in the directory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../hooks/cmd-analysis/index.js';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/hooks/cmd-analysis');
const README = readFileSync(join(DIR, 'README.md'), 'utf8');

function section(title: string): string {
  const start = README.indexOf(`## ${title}\n`);
  assert.notEqual(start, -1, `README has a "## ${title}" section`);
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end === -1 ? undefined : end);
}

describe('cmd-analysis README', () => {
  it('names every index.ts export in the API table', () => {
    const table = section('API');
    for (const name of Object.keys(api)) {
      assert.ok(table.includes(`| \`${name}(`) || table.includes(`| \`${name}\` |`), `API table lists ${name}`);
    }
  });

  it('lists every .ts file of the directory in the Module map', () => {
    const map = section('Module map');
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
      assert.ok(map.includes(`| \`${file}\` |`), `Module map lists ${file}`);
    }
  });
});
