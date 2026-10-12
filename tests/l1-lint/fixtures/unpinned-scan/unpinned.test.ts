import { it } from 'node:test';
import { execFileSync } from 'node:child_process';

it('forks the scanner with no DB pin', () => {
  execFileSync('bash', ['../../scripts/scan.sh', '.']);
});
