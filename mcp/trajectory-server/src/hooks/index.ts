/**
 * `node dist/hooks.js <gate>`: runs a registered TypeScript hook gate on the
 * payload read from stdin, writes its stdout and exits with its code
 * (runHook). An unknown gate or an uncaught error prints one stderr line and
 * exits 1, so dispatch.sh fails a fail-closed gate closed; it never allows on
 * error. `node dist/hooks.js ensure-mcp-deps-installed --install` is that
 * gate's detached install worker, which reads no payload.
 */
import { readFileSync } from 'node:fs';
import type { Gate } from './gate.js';
import { GATE_NAME as DEPS_GATE, INSTALL_FLAG, runInstallWorker } from './ensure-mcp-deps-installed.js';
import { findGate } from './registry.js';
import { runHook } from './run.js';

const name = process.argv[2] ?? '';
const installWorker = name === DEPS_GATE && process.argv[3] === INSTALL_FLAG;
const worker: Gate = (_payload, env) => ({ stdout: '', code: runInstallWorker(env) });

process.exitCode = await runHook(name, installWorker ? () => worker : findGate, process.env, {
  readStdin: () => (installWorker ? '' : readFileSync(0, 'utf8')),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
});
