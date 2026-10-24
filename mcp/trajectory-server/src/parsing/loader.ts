// Shared tree-sitter runtime (ADR 0001): web-tree-sitter plus the TS, TSX, JS
// and bash grammars, shipped as .wasm files in dist/parsing/. Nothing loads at
// server start; the first loadParsers() call imports the runtime and compiles
// the grammars, and every later call reuses them.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Parser } from 'web-tree-sitter';

export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'bash';

export type Parsers = Record<GrammarName, Parser>;

const RUNTIME_WASM = 'tree-sitter.wasm';

const GRAMMAR_WASM: Record<GrammarName, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  bash: 'tree-sitter-bash.wasm',
};

let pending: Promise<Parsers> | null = null;
let loads = 0;

// How many times the grammars have been loaded in this process: 0 until the
// first index call, 1 after it.
export function parserLoadCount(): number {
  return loads;
}

// The bundle (dist/index.js) finds the files in dist/parsing/; the tsc build
// (dist/parsing/loader.js) finds them beside itself.
export function wasmDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, 'parsing'), here]) {
    if (existsSync(join(dir, RUNTIME_WASM))) return dir;
  }
  throw new Error(`tree-sitter runtime not found: no ${RUNTIME_WASM} in ${join(here, 'parsing')} or ${here}`);
}

async function load(): Promise<Parsers> {
  const dir = wasmDir();
  const { Parser, Language } = await import('web-tree-sitter');
  await Parser.init({ locateFile: (file: string) => join(dir, file) });
  const parsers = {} as Parsers;
  for (const [name, file] of Object.entries(GRAMMAR_WASM) as Array<[GrammarName, string]>) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(join(dir, file)));
    parsers[name] = parser;
  }
  loads++;
  return parsers;
}

export function loadParsers(): Promise<Parsers> {
  if (!pending) {
    pending = load();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}
