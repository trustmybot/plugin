// Bundles dashboard/server modules with esbuild for tests: their import chain
// reaches mcp/trajectory-server/src files whose `.js` specifiers Node's type
// stripping does not map to `.ts`.
import { build } from 'esbuild';

const DASH = new URL('..', import.meta.url).pathname;
const SERVER = new URL('../dist/server.mjs', import.meta.url).pathname;

export async function importServer(...modules) {
  const out = await build({
    stdin: {
      contents: modules.map((m) => `export * from './server/${m}';`).join('\n'),
      resolveDir: DASH,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(SERVER)});` },
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
