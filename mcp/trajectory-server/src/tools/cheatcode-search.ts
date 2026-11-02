// cheatcode_search's engine: discovers cheatcode candidates from tiered registries (or a fixture) and ranks them deterministically.
import {
  alt,
  asciiLower,
  CheatcodeInputError,
  concatStrings,
  fetchText,
  fixturePath,
  get,
  iterate,
  jqCmp,
  jqEq,
  parseJson,
  readFixture,
  requireProjectRoot,
  uriEncode,
  type CheatcodeRunOptions,
  type Json,
} from './cheatcode-runtime.js';

export interface RankedCandidate {
  name: string;
  kind: string;
  source_url: string;
  score: number;
  signals: { registry: string; tier: number; relevance: number };
}

export interface SearchOutput {
  query: string;
  kind: string;
  candidates: RankedCandidate[];
}

const SEARCH_KINDS = new Set(['skill', 'mcp', 'plugin', 'any']);
export const SEARCH_FIXTURE_ENV = 'TMB_CHEATCODE_SEARCH_FIXTURE';
export const SEARCH_FIXTURE_FILE = '.tmb-cheatcode-fixture.json';

const stringOr = (v: Json): string => (typeof v === 'string' ? v : '');

// A registry adapter yields [] on any failure: no body, bad JSON, or an unexpected shape.
async function adapter(url: string, opts: CheatcodeRunOptions, map: (body: Json) => Json[]): Promise<Json[]> {
  const body = await fetchText(url, opts);
  if (!body) return [];
  const parsed = parseJson(body);
  if (parsed === null) return [];
  try {
    return map(parsed.value);
  } catch {
    return [];
  }
}

function mcpOfficial(query: string, opts: CheatcodeRunOptions): Promise<Json[]> {
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${uriEncode(query)}&limit=50`;
  return adapter(url, opts, (body) =>
    iterate(alt(get(body, 'servers'), [])).map((entry) => {
      const s = alt(get(entry, 'server'), entry);
      return {
        name: alt(get(s, 'name'), ''),
        description: alt(get(s, 'description'), ''),
        source_url: stringOr(alt(get(get(s, 'repository'), 'url'), get(s, 'websiteUrl'), '')),
        kind: 'mcp',
        registry: 'mcp-official',
        tier: 1,
      };
    }),
  );
}

function anthropicMarketplace(opts: CheatcodeRunOptions): Promise<Json[]> {
  const url = 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json';
  return adapter(url, opts, (body) =>
    iterate(alt(get(body, 'plugins'), [])).map((p) => {
      const source = get(p, 'source');
      const fromSource = source !== null && typeof source === 'object' && !Array.isArray(source) ? get(source, 'url') : source;
      return {
        name: alt(get(p, 'name'), ''),
        description: alt(get(p, 'description'), ''),
        source_url: stringOr(alt(get(p, 'source_url'), fromSource, get(p, 'homepage'), '')),
        kind: 'plugin',
        registry: 'anthropic-official',
        tier: 1,
      };
    }),
  );
}

function pulseMcp(query: string, opts: CheatcodeRunOptions): Promise<Json[]> {
  const url = `https://api.pulsemcp.com/v0beta/servers?query=${uriEncode(query)}&count_per_page=50`;
  return adapter(url, opts, (body) =>
    iterate(alt(get(body, 'servers'), get(body, 'results'), [])).map((s) => ({
      name: alt(get(s, 'name'), ''),
      description: alt(get(s, 'description'), ''),
      source_url: stringOr(
        alt(get(s, 'source_code_url'), get(s, 'source_url'), get(s, 'external_url'), get(s, 'url'), ''),
      ),
      kind: 'mcp',
      registry: 'pulsemcp',
      tier: 2,
    })),
  );
}

function tokens(s: string): string[] {
  return asciiLower(s).match(/[a-z0-9]+/g) ?? [];
}

// Dedupe by source_url keeping the lowest tier, filter by kind, score, then sort by score desc and name asc.
export function rankCandidates(candidates: Json, query: string, kind: string): RankedCandidate[] {
  const qtok = new Set(tokens(query));
  const deduped = new Map<string, Json>();
  for (const c of iterate(candidates)) {
    const u = alt(get(c, 'source_url'), '');
    if (u === '') continue;
    if (typeof u !== 'string') throw new Error(`Cannot index object with ${typeof u}`);
    const existing = deduped.get(u);
    if (existing === undefined || jqCmp(get(c, 'tier'), get(existing, 'tier')) < 0) deduped.set(u, c);
  }
  const ranked: RankedCandidate[] = [];
  for (const c of deduped.values()) {
    if (kind !== 'any' && !jqEq(get(c, 'kind'), kind)) continue;
    const htok = new Set(tokens(concatStrings(alt(get(c, 'name'), ''), ' ', alt(get(c, 'description'), ''))));
    const relevance = [...qtok].filter((t) => htok.has(t)).length;
    const tier = alt(get(c, 'tier'), 2);
    ranked.push({
      name: alt(get(c, 'name'), '') as string,
      kind: alt(get(c, 'kind'), 'any') as string,
      source_url: alt(get(c, 'source_url'), '') as string,
      score: (jqEq(tier, 1) ? 200 : 100) + relevance * 10,
      signals: { registry: alt(get(c, 'registry'), '') as string, tier: tier as number, relevance },
    });
  }
  return ranked.sort((a, b) => jqCmp([-a.score, a.name], [-b.score, b.name]));
}

export async function cheatcodeSearch(input: { query: string; kind?: string }, opts: CheatcodeRunOptions): Promise<SearchOutput> {
  const query = input.query ?? '';
  const kind = input.kind || 'any';
  if (!query) throw new CheatcodeInputError({ error: '--query is required' });
  if (!SEARCH_KINDS.has(kind)) throw new CheatcodeInputError({ error: `invalid kind: ${kind}` });
  requireProjectRoot(opts.projectRoot);

  const fixture = fixturePath(SEARCH_FIXTURE_ENV, SEARCH_FIXTURE_FILE, opts);
  let candidates: Json;
  if (fixture !== null) {
    const parsed = parseJson(readFixture(fixture, opts.projectRoot));
    if (parsed === null || !Array.isArray(parsed.value)) {
      throw new CheatcodeInputError({ error: 'fixture is not a JSON array of candidates' });
    }
    candidates = parsed.value;
  } else {
    candidates = [
      ...(await mcpOfficial(query, opts)),
      ...(await anthropicMarketplace(opts)),
      ...(await pulseMcp(query, opts)),
    ];
  }
  return { query, kind, candidates: rankCandidates(candidates, query, kind) };
}
