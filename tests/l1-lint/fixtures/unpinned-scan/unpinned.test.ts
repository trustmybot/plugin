import { it } from 'node:test';
import { walkProject } from './scan-walk.js';

it('forks the scanner with no DB pin', () => {
  void walkProject(db, '.', { timeoutMs: 1000 });
});
