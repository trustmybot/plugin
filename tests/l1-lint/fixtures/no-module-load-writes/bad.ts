import { appendFileSync, copyFileSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';

const logDir = join(process.cwd(), 'logs');

mkdirSync(logDir, { recursive: true }); // VIOLATION

try {
  mkdirSync(logDir, { recursive: true }); // VIOLATION
} catch {
  writeFileSync(join(logDir, 'failed'), 'x'); // VIOLATION
}

if (process.env['TMB_X']) {
  appendFileSync(join(logDir, 'x.log'), 'x'); // VIOLATION
}

for (const f of ['a', 'b']) {
  rmSync(join(logDir, f), { force: true }); // VIOLATION
}

const fd = openSync(join(logDir, 'y.log'), 'w'); // VIOLATION

export const ready = fs.mkdirSync(logDir, { recursive: true }); // VIOLATION

const config = {
  created: renameSync('a', 'b'), // VIOLATION
};

let copied = [copyFileSync('a', 'b')]; // VIOLATION

export const url = `${logDir}/{`; mkdirSync(logDir); // VIOLATION
const re = /\{[}]/; writeFileSync('x', ''); // VIOLATION

void fd; void config; void copied; void re;
