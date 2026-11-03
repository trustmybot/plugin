import { it } from 'node:test';
import { walkProject } from './scan-walk.js';
import { pinScanEnv } from './helpers.js';

// The DB would be pinned by pinScanEnv() or TRAJECTORY_DB_PATH = <fixture>; neither runs here.
/*
 * const scanPin = pinScanEnv();
 */
it('forks the scanner and only mentions the pin', () => {
  void walkProject(db, '.', { timeoutMs: 1000 });
});
