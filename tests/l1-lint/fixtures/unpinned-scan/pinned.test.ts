import { after, it } from 'node:test';
import { walkProject } from './scan-walk.js';
import { pinScanEnv } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

it('forks the scanner with the DB pinned', () => {
  void walkProject(db, '.', { timeoutMs: 1000 });
});
