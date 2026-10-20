import { after, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { pinScanEnv } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

it('forks the scanner with the DB pinned', () => {
  execFileSync('bash', ['../../scripts/scan.sh', '.']);
});
