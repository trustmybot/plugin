import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from '../lib/paths.ts';
import { callTool } from '../lib/snapshot.ts';
import { pickInputs } from './inputs.ts';

const dir = join(RESULTS_DIR, 'm1m2', 'outputs');
mkdirSync(dir, { recursive: true });
for (const input of pickInputs()) {
  const text = await callTool(input.tool, input.args);
  writeFileSync(join(dir, `${input.id.replace(/[/:]/g, '_')}.json`), text);
  console.log(input.id, text.length);
}
