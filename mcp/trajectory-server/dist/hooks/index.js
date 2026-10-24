/**
 * `node dist/hooks.js <gate>`: runs a registered TypeScript hook gate on the
 * payload read from stdin, writes its stdout and exits with its code. An
 * unknown gate or an uncaught error prints one stderr line and exits 1, so
 * dispatch.sh fails a fail-closed gate closed; it never allows on error.
 */
import { readFileSync } from 'node:fs';
import { findGate } from './registry.js';
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function main(name) {
    const gate = findGate(name);
    if (!gate) {
        process.stderr.write(`TMB hooks: unknown gate '${oneLine(name)}' — not run\n`);
        return 1;
    }
    const result = gate(readFileSync(0, 'utf8'), process.env);
    process.stdout.write(result.stdout);
    return result.code;
}
const name = process.argv[2] ?? '';
try {
    process.exitCode = main(name);
}
catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`TMB hooks: gate '${oneLine(name)}' failed: ${oneLine(detail)}\n`);
    process.exitCode = 1;
}
//# sourceMappingURL=index.js.map