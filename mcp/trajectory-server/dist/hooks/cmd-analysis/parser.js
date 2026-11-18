/**
 * The parsers of the hook analyzers: bash loaded on the first command that
 * needs one, python and javascript on the first program in that language
 * (GH 1739), each once per process, with V8's wasm tier-up off so a
 * short-lived hook process does not spend its run compiling optimized code it
 * never uses. A program grammar is asked for synchronously: one not loaded yet
 * is recorded as wanted, and `loadWanted` loads it before the caller reruns.
 */
import { setFlagsFromString } from 'node:v8';
let parser = null;
let loads = 0;
const programParsers = new Map();
const programLoads = new Map();
const wanted = new Set();
export function bashParserLoads() {
    return loads;
}
/** How many times a program grammar has been loaded in this process: 0 until a program in it is analyzed, then 1. */
export function programParserLoads(name) {
    return programLoads.get(name) ?? 0;
}
function tierDown() {
    setFlagsFromString('--no-wasm-dynamic-tiering');
    setFlagsFromString('--no-wasm-tier-up');
}
export function bashParser() {
    if (!parser) {
        parser = (async () => {
            tierDown();
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
/** The loaded parser of a program grammar, or undefined after recording it as wanted. */
export function programParser(name) {
    const p = programParsers.get(name);
    if (!p)
        wanted.add(name);
    return p;
}
/** Loads every wanted program grammar; false when none was wanted. */
export async function loadWanted() {
    if (wanted.size === 0)
        return false;
    const names = [...wanted];
    wanted.clear();
    tierDown();
    const { loadParser } = await import('../../parsing/loader.js');
    for (const name of names) {
        if (programParsers.has(name))
            continue;
        programParsers.set(name, await loadParser(name));
        programLoads.set(name, (programLoads.get(name) ?? 0) + 1);
    }
    return true;
}
//# sourceMappingURL=parser.js.map