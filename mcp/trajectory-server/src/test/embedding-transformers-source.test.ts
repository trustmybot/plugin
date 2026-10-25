/** Embeddings import transformers from the plugin data dir before the bare specifier (GH 1748). */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  embed,
  embeddingStatus,
  importTransformers,
  resetEmbeddingModelForTests,
  transformersSources,
} from '../embeddings/model.js';
import { runtimeDepsKey, TRANSFORMERS_PACKAGE } from '../runtime-deps.js';

const STUB_VECTOR = [0.25, 0.5, 0.75];

function stubPackage(dataDir: string): string {
  const pkgDir = join(dataDir, 'deps', runtimeDepsKey(), 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: TRANSFORMERS_PACKAGE,
      version: '0.0.0-stub',
      type: 'module',
      exports: { '.': { node: { import: { default: './stub.mjs' } } } },
    }),
  );
  writeFileSync(
    join(pkgDir, 'stub.mjs'),
    `export const env = {};\nexport async function pipeline() {\n  return async () => ({ data: ${JSON.stringify(STUB_VECTOR)} });\n}\n`,
  );
  return join(pkgDir, 'stub.mjs');
}

describe('transformersSources', () => {
  let scratch: string;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'tmb-transformers-src-'));
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('puts the data-dir entry before the bare specifier', () => {
    const dataDir = join(scratch, 'with-package');
    const entry = stubPackage(dataDir);
    assert.deepEqual(transformersSources(dataDir), {
      specifiers: [pathToFileURL(entry).href, TRANSFORMERS_PACKAGE],
      misses: [],
    });
  });

  it('uses only the bare specifier when CLAUDE_PLUGIN_DATA is unset', () => {
    const saved = process.env['CLAUDE_PLUGIN_DATA'];
    delete process.env['CLAUDE_PLUGIN_DATA'];
    try {
      assert.deepEqual(transformersSources(), {
        specifiers: [TRANSFORMERS_PACKAGE],
        misses: ['CLAUDE_PLUGIN_DATA is unset'],
      });
    } finally {
      if (saved !== undefined) process.env['CLAUDE_PLUGIN_DATA'] = saved;
    }
  });

  it('uses only the bare specifier when the data dir holds no package', () => {
    const dataDir = join(scratch, 'empty');
    mkdirSync(dataDir, { recursive: true });
    const sources = transformersSources(dataDir);
    assert.deepEqual(sources.specifiers, [TRANSFORMERS_PACKAGE]);
    assert.equal(sources.misses.length, 1);
    assert.match(sources.misses[0]!, new RegExp(`${runtimeDepsKey()}/node_modules/@huggingface/transformers`));
  });
});

describe('importTransformers', () => {
  it('names every place it looked when nothing loads', async () => {
    const failing = async (s: string): Promise<never> => {
      throw new Error(`cannot load ${s}`);
    };
    await assert.rejects(
      importTransformers({ specifiers: ['file:///data/entry.mjs', TRANSFORMERS_PACKAGE], misses: [] }, failing),
      (e: Error) =>
        e.message.includes('file:///data/entry.mjs: cannot load file:///data/entry.mjs') &&
        e.message.includes(`${TRANSFORMERS_PACKAGE}: cannot load ${TRANSFORMERS_PACKAGE}`),
    );
    await assert.rejects(
      importTransformers({ specifiers: [TRANSFORMERS_PACKAGE], misses: ['CLAUDE_PLUGIN_DATA is unset'] }, failing),
      (e: Error) =>
        e.message.includes('CLAUDE_PLUGIN_DATA is unset') &&
        e.message.includes(`${TRANSFORMERS_PACKAGE}: cannot load ${TRANSFORMERS_PACKAGE}`),
    );
  });
});

describe('default loader with a data-dir package', () => {
  let scratch: string;
  let savedDataDir: string | undefined;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'tmb-transformers-load-'));
    savedDataDir = process.env['CLAUDE_PLUGIN_DATA'];
  });
  after(() => {
    if (savedDataDir === undefined) delete process.env['CLAUDE_PLUGIN_DATA'];
    else process.env['CLAUDE_PLUGIN_DATA'] = savedDataDir;
    resetEmbeddingModelForTests(null);
    rmSync(scratch, { recursive: true, force: true });
  });

  it('imports the data-dir copy even though the bare specifier resolves', async () => {
    const dataDir = join(scratch, 'plugin-data');
    stubPackage(dataDir);
    process.env['CLAUDE_PLUGIN_DATA'] = dataDir;
    resetEmbeddingModelForTests(null);
    const v = await embed('x');
    assert.deepEqual(v && Array.from(v), STUB_VECTOR);
    const status = embeddingStatus();
    assert.equal(status.state, 'ready');
    assert.equal(status.consecutive_failures, 0);
  });
});
