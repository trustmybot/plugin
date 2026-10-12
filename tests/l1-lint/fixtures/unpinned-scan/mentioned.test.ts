import { it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { pinScanEnv } from './helpers.js';

// The DB would be pinned by pinScanEnv() or TRAJECTORY_DB_PATH = <fixture>; neither runs here.
/*
 * const scanPin = pinScanEnv();
 */
it('forks the scanner and only mentions the pin', () => {
  execFileSync('bash', ['../../scripts/scan.sh', '.']);
});
