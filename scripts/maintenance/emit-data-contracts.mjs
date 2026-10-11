#!/usr/bin/env node
// Writes scripts/hooks/lib/data-contracts.json — the SessionStart banner's copy
// of the trajectory DB data contracts — from the built server's DATA_CONTRACTS.
// --check exits 1 (writing nothing) when the committed file is stale.
// Run after `npm run build` in mcp/trajectory-server.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataContractsJson } from '../../mcp/trajectory-server/dist/data-contracts.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'lib', 'data-contracts.json');
const want = dataContractsJson();
let have = '';
try {
  have = readFileSync(out, 'utf8');
} catch {
  have = '';
}

if (process.argv.includes('--check')) {
  if (have !== want) {
    console.error('data-contracts.json is stale — run: node scripts/maintenance/emit-data-contracts.mjs');
    process.exit(1);
  }
  console.log('data-contracts.json is fresh');
  process.exit(0);
}

if (have !== want) writeFileSync(out, want);
console.log(`wrote ${out}`);
