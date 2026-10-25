// Shared tree-sitter runtime (ADR 0001): web-tree-sitter plus the TS, TSX, JS,
// bash and python grammars, shipped as .wasm files in dist/parsing/. Nothing
// loads at server start; the first loadParser(name) / loadParsers() call
// imports the runtime and compiles what it asks for, and every later call
// reuses them. loadParsers() compiles the four the symbol index reads; python
// serves only the write-path analyzer (GH 1739).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Parser } from 'web-tree-sitter';

type Runtime = typeof import('web-tree-sitter');

export type IndexedGrammar = 'typescript' | 'tsx' | 'javascript' | 'bash';

export type GrammarName = IndexedGrammar | 'python';

export type Parsers = Record<IndexedGrammar, Parser>;

const RUNTIME_WASM = 'tree-sitter.wasm';

const GRAMMAR_WASM: Record<GrammarName, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  bash: 'tree-sitter-bash.wasm',
  python: 'tree-sitter-python.wasm',
};

const INDEXED: IndexedGrammar[] = ['typescript', 'tsx', 'javascript', 'bash'];

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

let runtime: Promise<Runtime> | null = null;
const grammars = new Map<GrammarName, Promise<Parser>>();

function memo<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  promise.catch(forget);
  return promise;
}

function loadRuntime(): Promise<Runtime> {
  runtime ??= memo(
    (async () => {
      const dir = wasmDir();
      const mod = await import('web-tree-sitter');
      await mod.Parser.init({ locateFile: (file: string) => join(dir, file) });
      return mod;
    })(),
    () => {
      runtime = null;
    },
  );
  return runtime;
}

// One grammar's parser, compiled once per process.
export function loadParser(name: GrammarName): Promise<Parser> {
  let parser = grammars.get(name);
  if (!parser) {
    parser = memo(
      (async () => {
        const { Parser, Language } = await loadRuntime();
        const p = new Parser();
        p.setLanguage(await Language.load(join(wasmDir(), GRAMMAR_WASM[name])));
        return p;
      })(),
      () => grammars.delete(name),
    );
    grammars.set(name, parser);
  }
  return parser;
}

async function load(): Promise<Parsers> {
  const parsers = {} as Parsers;
  for (const name of INDEXED) parsers[name] = await loadParser(name);
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
