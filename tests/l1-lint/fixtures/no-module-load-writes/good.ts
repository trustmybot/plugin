import { appendFileSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// mkdirSync(logDir) at module scope in a comment is not a call.
/* writeFileSync('x', '') */
const note = 'mkdirSync(logDir, { recursive: true })';
const tpl = `writeFileSync(${note})`;

let ready = false;

function ensureLogDir(dir: string): void {
  if (ready) return;
  try {
    mkdirSync(dir, { recursive: true });
    ready = true;
  } catch {
    ready = false;
  }
}

export function writeLog(dir: string, line: string): void {
  ensureLogDir(dir);
  appendFileSync(join(dir, 'x.log'), line);
}

export async function writeAsync(path: string): Promise<{ ok: boolean }> {
  writeFileSync(path, '');
  return { ok: true };
}

export const writer = (path: string) => writeFileSync(path, '');
export const asyncWriter = async (path: string): Promise<void> => {
  writeFileSync(path, '');
};

const handlers = {
  move: (a: string, b: string) => renameSync(a, b),
  create(dir: string) {
    mkdirSync(dir);
  },
  open: function (p: string) {
    return openSync(p, 'w');
  },
};

export class Store {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  save(): void {
    writeFileSync(join(this.dir, 'x'), readFileSync('y'));
  }
  get path(): string {
    return this.dir;
  }
}

const fd = openSync('/dev/null', 'r');
const items = ['a'].map((x) => {
  return x;
});
const later = setTimeout(() => mkdirSync('x'), 0);

void tpl; void handlers; void fd; void items; void later;
