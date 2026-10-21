import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveClaudeDbPath } from '../../mcp/trajectory-server/src/platform.ts';
import * as q from './queries.ts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7477;
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`TMB_DASHBOARD_PORT must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}

function openDb(path: string): DatabaseSync {
  if (path === ':memory:' || !existsSync(path)) {
    throw new Error(
      `No trajectory DB at ${path}. Run from an onboarded project or set TRAJECTORY_DB_PATH.`,
    );
  }
  return new DatabaseSync(path, { readOnly: true });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? 100);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 1000) : 100;
}

function handleApi(db: DatabaseSync, url: URL, res: ServerResponse): void {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, id] = parts;
  if (parts.length === 1) {
    switch (resource) {
      case 'summary': return sendJson(res, 200, q.summary(db));
      case 'issues': return sendJson(res, 200, q.issues(db));
      case 'tasks': return sendJson(res, 200, q.tasks(db));
      case 'agent-runs': return sendJson(res, 200, q.agentRuns(db));
      case 'gates': return sendJson(res, 200, q.gates(db));
      case 'audit': return sendJson(res, 200, q.audit(db, clampLimit(url.searchParams.get('limit'))));
      case 'version': return sendJson(res, 200, { data_version: q.dataVersion(db) });
    }
  }
  if (parts.length === 2 && resource === 'issues' && /^-?\d+$/.test(id!)) {
    const detail = q.issueDetail(db, Number(id));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'issue not found' });
  }
  sendJson(res, 404, { error: 'unknown endpoint' });
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT) || rel.split(sep).includes('..')) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) file = join(WEB_ROOT, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('dashboard web bundle missing; run `bun run build` in dashboard/');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

function handle(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) handleApi(db, url, res);
    else serveStatic(url.pathname, res);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function main(): void {
  const dbPath = resolveClaudeDbPath();
  const db = openDb(dbPath);
  const server = createServer((req, res) => handle(db, req, res));
  server.on('error', (err) => {
    console.error(`dashboard server failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(parsePort(process.env['TMB_DASHBOARD_PORT']), HOST, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT;
    console.log(`TMB dashboard (read-only) on ${dbPath}`);
    console.log(`http://${HOST}:${port}/`);
  });
  const shutdown = (): void => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
