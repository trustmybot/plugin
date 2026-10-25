// Shared tree-sitter runtime (ADR 0001): web-tree-sitter plus the TS, TSX, JS
// and bash grammars, shipped as .wasm files in dist/parsing/. Nothing loads at
// server start; the first loadParser(name) / loadParsers() call imports the
// runtime and compiles what it asks for, and every later call reuses them.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const RUNTIME_WASM = 'tree-sitter.wasm';
const GRAMMAR_WASM = {
    typescript: 'tree-sitter-typescript.wasm',
    tsx: 'tree-sitter-tsx.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    bash: 'tree-sitter-bash.wasm',
};
let pending = null;
let loads = 0;
// How many times the grammars have been loaded in this process: 0 until the
// first index call, 1 after it.
export function parserLoadCount() {
    return loads;
}
// The bundle (dist/index.js) finds the files in dist/parsing/; the tsc build
// (dist/parsing/loader.js) finds them beside itself.
export function wasmDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const dir of [join(here, 'parsing'), here]) {
        if (existsSync(join(dir, RUNTIME_WASM)))
            return dir;
    }
    throw new Error(`tree-sitter runtime not found: no ${RUNTIME_WASM} in ${join(here, 'parsing')} or ${here}`);
}
let runtime = null;
const grammars = new Map();
function memo(promise, forget) {
    promise.catch(forget);
    return promise;
}
function loadRuntime() {
    runtime ??= memo((async () => {
        const dir = wasmDir();
        const mod = await import('web-tree-sitter');
        await mod.Parser.init({ locateFile: (file) => join(dir, file) });
        return mod;
    })(), () => {
        runtime = null;
    });
    return runtime;
}
// One grammar's parser, compiled once per process.
export function loadParser(name) {
    let parser = grammars.get(name);
    if (!parser) {
        parser = memo((async () => {
            const { Parser, Language } = await loadRuntime();
            const p = new Parser();
            p.setLanguage(await Language.load(join(wasmDir(), GRAMMAR_WASM[name])));
            return p;
        })(), () => grammars.delete(name));
        grammars.set(name, parser);
    }
    return parser;
}
async function load() {
    const parsers = {};
    for (const name of Object.keys(GRAMMAR_WASM))
        parsers[name] = await loadParser(name);
    loads++;
    return parsers;
}
export function loadParsers() {
    if (!pending) {
        pending = load();
        pending.catch(() => {
            pending = null;
        });
    }
    return pending;
}
//# sourceMappingURL=loader.js.map