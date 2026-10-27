/**
 * `node dist/hooks.js <gate>`: runs a registered TypeScript hook gate on the
 * payload read from stdin, writes its stdout and exits with its code
 * (runHook). An unknown gate or an uncaught error prints one stderr line and
 * exits 1, so dispatch.sh fails a fail-closed gate closed; it never allows on
 * error. `node dist/hooks.js ensure-mcp-deps-installed --install` is that
 * gate's detached install worker, which reads no payload.
 * `node dist/hooks.js <event>` (an event of ROUTER_GROUPS, e.g. PreToolUse)
 * is the router: every gate of the groups matching the payload, one process
 * (router/main.ts). It exits once its decision and records are written, so a
 * gate left running past its budget never holds the hook open.
 */
import { readFileSync } from 'node:fs';
import { GATE_NAME as DEPS_GATE, INSTALL_FLAG, runInstallWorker } from './ensure-mcp-deps-installed.js';
import { findGate, routerEvents } from './registry.js';
import { routerMain } from './router/main.js';
import { runHook } from './run.js';
const name = process.argv[2] ?? '';
if (routerEvents().has(name)) {
    const code = await routerMain(name, process.env, {
        readStdin: () => readFileSync(0, 'utf8'),
        writeStdout: (text) => new Promise((resolve) => (text === '' ? resolve() : process.stdout.write(text, () => resolve()))),
        writeStderr: (text) => {
            if (text !== '')
                process.stderr.write(text);
        },
    });
    await new Promise((resolve) => process.stderr.write('', () => resolve()));
    process.exit(code);
}
const installWorker = name === DEPS_GATE && process.argv[3] === INSTALL_FLAG;
const worker = (_payload, env) => ({ stdout: '', code: runInstallWorker(env) });
process.exitCode = await runHook(name, installWorker ? () => worker : findGate, process.env, {
    readStdin: () => (installWorker ? '' : readFileSync(0, 'utf8')),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
});
//# sourceMappingURL=index.js.map