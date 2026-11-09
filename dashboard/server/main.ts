import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CHANGE_SOURCES, computeChangeImpact, type ChangeSource } from '../../mcp/trajectory-server/src/change-impact/index.ts';
import { setEmbeddingLoader } from '../../mcp/trajectory-server/src/embeddings/model.ts';
import type { StatsReader } from '../../mcp/trajectory-server/src/tools/stats.ts';
import { resolveClaudeDbPath } from '../../mcp/trajectory-server/src/platform.ts';
import { conceptsApi } from './concepts.ts';
import { efficiency, efficiencyCompare } from './efficiency.ts';
import { clampHistory, freshnessFor, withFreshness, worldModelStatus, type Freshness } from './freshness.ts';
import { cachedGraph, etagMatches, type GraphResponse } from './graph-cache.ts';
import { dbFile, health } from './health.ts';
import { noEmbeddings } from './no-embeddings.ts';
import * as q from './queries.ts';
import { loadReleases } from './releases.ts';
import { IssueWriter, isWriteAction } from './writes.ts';

setEmbeddingLoader(noEmbeddings);

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7477;
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TOKEN_HEADER = 'x-tmb-token';
const CHANGELOG = process.env['TMB_DASHBOARD_CHANGELOG'] || fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url));
const RELEASES = loadReleases(CHANGELOG);
const INTERNAL_ERROR = { error: 'internal_error', message: 'the dashboard server hit an error; its terminal has the details' };

interface Ctx {
  db: DatabaseSync;
  writer: IssueWriter;
  token: string;
  host: string;
}

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

const CHANGE_IMPACT_LIMIT = 20;
const CHANGE_IMPACT_MAX_LIMIT = 100;
const UNKNOWN_CHANGE = /^unknown change /;
const AMBIGUOUS_CHANGE = /^ambiguous change /;

function statsReader(db: DatabaseSync): StatsReader {
  return {
    get<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

function changeImpact(db: DatabaseSync, p: URLSearchParams): { status: number; body: unknown } {
  const source = p.get('source');
  const id = p.get('id');
  const repo = p.get('repo');
  const rawLimit = p.get('limit');
  if (source !== null && !CHANGE_SOURCES.includes(source as ChangeSource)) {
    return { status: 400, body: { error: `source must be one of ${CHANGE_SOURCES.join(', ')}` } };
  }
  if (id !== null && source === null) return { status: 400, body: { error: 'id needs source' } };
  if (id === '') return { status: 400, body: { error: 'id must be non-empty' } };
  if (repo !== null && id === null) return { status: 400, body: { error: 'repo needs id' } };
  if (repo === '') return { status: 400, body: { error: 'repo must be non-empty' } };
  if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) return { status: 400, body: { error: 'limit must be a positive integer' } };
  const limit = rawLimit === null ? CHANGE_IMPACT_LIMIT : Math.min(Number(rawLimit), CHANGE_IMPACT_MAX_LIMIT);
  const reader = statsReader(db);
  try {
    if (id !== null) return { status: 200, body: computeChangeImpact(reader, undefined, { change: { source: source as ChangeSource, id, ...(repo === null ? {} : { repo }) }, series: true }) };
    return { status: 200, body: computeChangeImpact(reader, undefined, { ...(source === null ? {} : { source: source as ChangeSource }), limit }) };
  } catch (err) {
    if (err instanceof Error && UNKNOWN_CHANGE.test(err.message)) return { status: 404, body: { error: err.message } };
    if (err instanceof Error && AMBIGUOUS_CHANGE.test(err.message)) return { status: 400, body: { error: err.message } };
    throw err;
  }
}

function sendGraph(
  res: ServerResponse,
  graph: GraphResponse,
  freshness: () => Freshness | null,
  ifNoneMatch: string | string[] | undefined,
): void {
  if (graph.etag === null) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(withFreshness(graph.body, freshness()));
    return;
  }
  const headers = { etag: graph.etag, 'cache-control': 'no-cache', 'x-tmb-graph-cache': graph.hit ? 'hit' : 'miss' };
  if (etagMatches(ifNoneMatch, graph.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(withFreshness(graph.body, freshness()));
}

async function handleApi(db: DatabaseSync, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, id] = parts;
  const concepts = conceptsApi(db, url);
  if (concepts) return sendJson(res, concepts.status, concepts.body);
  if (parts.length === 1) {
    switch (resource) {
      case 'summary': return sendJson(res, 200, q.summary(db));
      case 'issues': return sendJson(res, 200, q.issues(db));
      case 'tasks': return sendJson(res, 200, q.tasks(db));
      case 'agent-runs': return sendJson(res, 200, q.agentRuns(db));
      case 'gates': return sendJson(res, 200, q.gates(db));
      case 'gate-board': return sendJson(res, 200, q.gateBoard(db));
      case 'audit': return sendJson(res, 200, q.audit(db, clampLimit(url.searchParams.get('limit'))));
      case 'version': return sendJson(res, 200, { data_version: q.dataVersion(db) });
      case 'health': return sendJson(res, 200, health(db, dbFile(db)));
      case 'insights': {
        const filter = q.insightFilter(url.searchParams);
        return 'error' in filter ? sendJson(res, 400, filter) : sendJson(res, 200, q.insights(db, filter));
      }
      case 'world-model': {
        const p = url.searchParams;
        const repo = p.get('repo') || null;
        const body = q.worldModel(db, repo, p.get('path') ?? '', q.clampDepth(p.get('depth')));
        return sendJson(res, 200, { ...body, freshness: freshnessFor(db, repo) });
      }
    }
  }
  if (parts.length === 2 && resource === 'insights' && id === 'explore') {
    const filter = q.insightFilter(url.searchParams);
    const body = 'error' in filter ? filter : q.explore(db, filter, url.searchParams, RELEASES);
    return sendJson(res, 'error' in body ? 400 : 200, body);
  }
  if (parts.length === 3 && resource === 'insights' && id === 'explore' && parts[2] === 'compare') {
    const query = q.compareQuery(url.searchParams);
    const body = 'error' in query ? query : q.exploreCompare(db, query.filter, query.p1, query.p2, url.searchParams, RELEASES);
    return sendJson(res, 'error' in body ? 400 : 200, body);
  }
  if (parts.length === 2 && resource === 'insights' && id === 'efficiency') {
    const filter = q.insightFilter(url.searchParams);
    return 'error' in filter ? sendJson(res, 400, filter) : sendJson(res, 200, await efficiency(db, filter));
  }
  if (parts.length === 3 && resource === 'insights' && id === 'efficiency' && parts[2] === 'compare') {
    const query = q.compareQuery(url.searchParams);
    return 'error' in query ? sendJson(res, 400, query) : sendJson(res, 200, await efficiencyCompare(db, query.filter, query.p1, query.p2));
  }
  if (parts.length === 2 && resource === 'insights' && id === 'change-impact') {
    const result = changeImpact(db, url.searchParams);
    return sendJson(res, result.status, result.body);
  }
  if (parts.length === 2 && resource === 'insights' && id === 'compare') {
    const query = q.compareQuery(url.searchParams);
    return 'error' in query ? sendJson(res, 400, query) : sendJson(res, 200, q.compare(db, query.filter, query.p1, query.p2));
  }
  if (parts.length === 2 && resource === 'world-model' && id === 'search') {
    const p = url.searchParams;
    const body = q.worldModelSearch(db, p.get('q') ?? '', q.clampHits(p.get('limit')));
    return sendJson(res, 200, { ...body, freshness: freshnessFor(db, p.get('repo') || null) });
  }
  if (parts.length === 2 && resource === 'world-model' && id === 'graph') {
    const repo = url.searchParams.get('repo') || null;
    return sendGraph(res, cachedGraph(db, repo), () => freshnessFor(db, repo), req.headers['if-none-match']);
  }
  if (parts.length === 2 && resource === 'world-model' && id === 'status') {
    return sendJson(res, 200, worldModelStatus(db, clampHistory(url.searchParams.get('limit'))));
  }
  if (parts.length === 2 && resource === 'issues' && /^-?\d+$/.test(id!)) {
    const detail = q.issueDetail(db, Number(id));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'issue not found' });
  }
  if (parts.length === 2 && resource === 'tasks' && /^-?\d+$/.test(id!)) {
    const detail = q.taskDetail(db, Number(id));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'task not found' });
  }
  sendJson(res, 404, { error: 'unknown endpoint' });
}

function serveStatic(ctx: Ctx, pathname: string, res: ServerResponse): void {
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
  if (file.endsWith('index.html')) {
    const html = readFileSync(file, 'utf8').replace(
      '</head>',
      `<meta name="tmb-token" content="${ctx.token}" />\n  </head>`,
    );
    res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

function tokenMatches(expected: string, given: string | string[] | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// POST /api/issues/:id/<edit|comment|close>. Every other POST path is a 404:
// tasks, plugin_config and issue create have no write endpoint.
async function handleWrite(ctx: Ctx, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const origin = `http://${ctx.host}`;
  if (req.headers.origin !== origin) {
    return sendJson(res, 403, { error: 'forbidden_origin', message: `writes are accepted only from ${origin}/` });
  }
  if (!tokenMatches(ctx.token, req.headers[TOKEN_HEADER])) {
    return sendJson(res, 403, { error: 'bad_token', message: 'missing or wrong dashboard token; reload the page' });
  }
  const match = /^\/api\/issues\/([1-9]\d*)\/([a-z]+)$/.exec(url.pathname);
  const action = match?.[2];
  if (!match || action === undefined || !isWriteAction(action)) return sendJson(res, 404, { error: 'unknown endpoint' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'unsupported_media_type', message: 'send application/json' });
  }
  const raw = await readBody(req);
  if (raw === null) {
    res.setHeader('connection', 'close');
    return sendJson(res, 413, { error: 'body_too_large', message: `the body is over ${MAX_BODY_BYTES} bytes` });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return sendJson(res, 400, { error: 'invalid_json', message: 'body must be a JSON object' });
  }
  const result = await ctx.writer.perform(action, Number(match[1]), body as Record<string, unknown>);
  sendJson(res, result.status, result.body);
}

async function handle(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  try {
    if (req.headers.host !== ctx.host) {
      return sendJson(res, 403, { error: 'forbidden_host', message: `requests are accepted only for host ${ctx.host}` });
    }
    if (req.method === 'POST') return await handleWrite(ctx, req, url, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' }).end();
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(ctx.db, req, url, res);
    else serveStatic(ctx, url.pathname, res);
  } catch (err) {
    console.error('dashboard request failed:', err);
    if (res.headersSent) res.end();
    else sendJson(res, 500, INTERNAL_ERROR);
  }
}

function main(): void {
  const dbPath = resolveClaudeDbPath();
  const db = openDb(dbPath);
  const ctx: Ctx = { db, writer: new IssueWriter(dbPath, db), token: randomBytes(32).toString('hex'), host: '' };
  const server = createServer((req, res) => void handle(ctx, req, res));
  server.on('error', (err) => {
    console.error(`dashboard server failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(parsePort(process.env['TMB_DASHBOARD_PORT']), HOST, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : DEFAULT_PORT;
    ctx.host = `${HOST}:${port}`;
    console.log(`TMB dashboard on ${dbPath}`);
    console.log(`http://${HOST}:${port}/`);
  });
  const shutdown = (): void => {
    server.close();
    ctx.writer.close();
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
