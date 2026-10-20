import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'tmb-'));
writeFileSync(join(dir, 'x.json'), '{}');
const fake = readFileSync('/tmp/input.json', 'utf8');
const dbPath = '/tmp/.claude/tmb/trajectory.db';
// writeFileSync('/tmp/commented', '');
const msg = 'checks the commit out under the repo, never in /tmp';
