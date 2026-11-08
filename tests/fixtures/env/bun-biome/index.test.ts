import { expect, test } from 'bun:test';
import { port } from './index.ts';

test('port', () => {
  expect(port).toBe(3000);
});
