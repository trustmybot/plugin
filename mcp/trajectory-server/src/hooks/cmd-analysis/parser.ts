/**
 * The bash parser of the hook analyzers: loaded on the first command that
 * needs one, once per process, with V8's wasm tier-up off so a short-lived
 * hook process does not spend its run compiling optimized code it never uses.
 */
import { setFlagsFromString } from 'node:v8';
import type { Parser } from 'web-tree-sitter';

let parser: Promise<Parser> | null = null;
let loads = 0;

export function bashParserLoads(): number {
  return loads;
}

export function bashParser(): Promise<Parser> {
  if (!parser) {
    parser = (async () => {
      setFlagsFromString('--no-wasm-dynamic-tiering');
      setFlagsFromString('--no-wasm-tier-up');
      const { loadParser } = await import('../../parsing/loader.js');
      const p = await loadParser('bash');
      loads++;
      return p;
    })();
    parser.catch(() => {
      parser = null;
    });
  }
  return parser;
}
