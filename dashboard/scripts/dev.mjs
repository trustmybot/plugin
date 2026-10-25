// Watch-mode dev loop: rebuilds the server, web and CSS bundles into the
// gitignored dist-dev/ on save and restarts the server when its bundle changes.
// dist/ is only ever written by `bun run build`.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const DASH = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(DASH, 'dist-dev');
const WEB_OUT = join(OUT, 'web');
const SCHEMA_DIR = join(DASH, '../mcp/trajectory-server/src');
const SERVER_OUT = join(OUT, 'server.mjs');

process.env.TMB_DASHBOARD_PORT ??= '7488';

mkdirSync(WEB_OUT, { recursive: true });
copyFileSync(join(DASH, 'web/index.html'), join(WEB_OUT, 'index.html'));
for (const file of ['schema.sql', 'schema-eval.sql']) copyFileSync(join(SCHEMA_DIR, file), join(OUT, file));

const serverCtx = await esbuild.context({
  absWorkingDir: DASH,
  entryPoints: ['server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: SERVER_OUT,
  logLevel: 'info',
});
const webCtx = await esbuild.context({
  absWorkingDir: DASH,
  entryPoints: ['web/main.tsx'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: 'inline',
  outfile: join(WEB_OUT, 'app.js'),
  logLevel: 'info',
});

const children = [];
function run(command, args) {
  const child = spawn(command, args, { cwd: DASH, env: process.env, stdio: ['pipe', 'inherit', 'inherit'] });
  children.push(child);
  return child;
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([serverCtx.dispose(), webCtx.dispose()]);
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? undefined
        : new Promise((done) => {
            child.once('exit', done);
            child.kill('SIGTERM');
          }),
    ),
  );
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run(join(DASH, 'node_modules/.bin/tailwindcss'), ['-i', 'web/styles.css', '-o', join(WEB_OUT, 'app.css'), '--watch']);
await Promise.all([serverCtx.rebuild(), webCtx.rebuild()]);
await Promise.all([serverCtx.watch(), webCtx.watch()]);
if (!stopping) run(process.execPath, [`--watch-path=${SERVER_OUT}`, SERVER_OUT]);
