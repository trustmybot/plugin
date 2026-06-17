import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB, CheatcodeRow } from '../db.js';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

type CheatcodeKind = 'skill' | 'mcp' | 'plugin' | 'any';

interface Candidate {
  name: string;
  kind: string;
  source_url: string;
  score: number;
  signals: {
    registry: string;
    tier: number;
    relevance: number;
  };
}

interface SearchOutput {
  query: string;
  kind: string;
  candidates: Candidate[];
}

type TrustTier = 'trusted' | 'caution' | 'untrusted' | 'unknown';

interface VetCandidate {
  name: string;
  kind: string;
  source_url: string;
  tier: number | null;
}

interface VetOutput {
  candidate: VetCandidate;
  signals: {
    reputation: { registry_tier: number | null; stars: number | null; forks: number | null };
    maintenance: { pushed_at: string | null; archived: boolean; active: boolean | null };
    license: string | null;
    maintainer: { login: string | null; type: string | null };
    security_surface: { code_execution: boolean; network: boolean; fs_writes: boolean };
  };
  trust_tier: TrustTier;
  rationale: string;
  capabilities: string[];
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function wrap(fn: Fn): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

// Locate a scripts/<name> file relative to this compiled module. Plugin layout:
//   <plugin>/mcp/trajectory-server/dist/tools/cheatcode.js
//   <plugin>/scripts/<name>
// Walking up four levels lands at the plugin root (mirrors scan.ts).
function resolveScriptsFile(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', '..', 'scripts', name),
    join(here, '..', '..', '..', 'scripts', name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
  if (pluginRoot) {
    const c = join(pluginRoot, 'scripts', name);
    if (existsSync(c)) return c;
  }
  throw new Error(`${name} not found — expected at <plugin>/scripts/${name}`);
}

const resolveSearchScript = (): string => resolveScriptsFile('cheatcode-search.sh');
const resolveVetScript = (): string => resolveScriptsFile('cheatcode-vet.sh');

const SEARCH_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout
const VET_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout

export function runSearchWithScript(
  script: string,
  query: string,
  kind: CheatcodeKind,
  timeoutMs: number,
): Promise<SearchOutput> {
  return new Promise<SearchOutput>((resolve, reject) => {
    const child = spawn('bash', [script, '--query', query, '--kind', kind], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      reject(new Error('cheatcode-search.sh timed out after 60 seconds'));
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(new Error(`cheatcode-search.sh spawn error: ${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
      if (code !== 0) {
        reject(new Error(`cheatcode-search.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
        return;
      }
      let parsed: SearchOutput;
      try {
        parsed = JSON.parse(stdout) as SearchOutput;
      } catch {
        reject(new Error(`cheatcode-search.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`));
        return;
      }
      if (!Array.isArray(parsed.candidates)) {
        reject(new Error('cheatcode-search.sh emitted unexpected shape (missing candidates[])'));
        return;
      }
      resolve(parsed);
    });
  });
}

const VALID_TIERS: ReadonlySet<TrustTier> = new Set<TrustTier>([
  'trusted',
  'caution',
  'untrusted',
  'unknown',
]);

export function runVetWithScript(
  script: string,
  candidate: { name: string; kind: string; source_url: string; tier?: number },
  timeoutMs: number,
): Promise<VetOutput> {
  return new Promise<VetOutput>((resolve, reject) => {
    const child = spawn('bash', [script, '--candidate', JSON.stringify(candidate)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      reject(new Error('cheatcode-vet.sh timed out after 60 seconds'));
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(new Error(`cheatcode-vet.sh spawn error: ${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
      if (code !== 0) {
        reject(new Error(`cheatcode-vet.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
        return;
      }
      let parsed: VetOutput;
      try {
        parsed = JSON.parse(stdout) as VetOutput;
      } catch {
        reject(new Error(`cheatcode-vet.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !VALID_TIERS.has(parsed.trust_tier)) {
        reject(new Error('cheatcode-vet.sh emitted unexpected shape (missing/invalid trust_tier)'));
        return;
      }
      if (!Array.isArray(parsed.capabilities)) {
        reject(new Error('cheatcode-vet.sh emitted unexpected shape (missing capabilities[])'));
        return;
      }
      resolve(parsed);
    });
  });
}

interface InstallAttachment {
  target: string;
  artifact: string;
}

interface InstallOutput {
  candidate: { name: string; kind: string; source_url: string; tier: number | null };
  installed: boolean;
  version: string | null;
  method: string;
  attachments: InstallAttachment[];
  proposed_pr: Record<string, unknown> | null;
  error: string | null;
}

export function runInstallWithScript(
  script: string,
  candidate: { name: string; kind: string; source_url: string; tier?: number },
  timeoutMs: number,
): Promise<InstallOutput> {
  return new Promise<InstallOutput>((resolve, reject) => {
    const child = spawn('bash', [script, '--candidate', JSON.stringify(candidate)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      reject(new Error('cheatcode-install.sh timed out after 60 seconds'));
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(new Error(`cheatcode-install.sh spawn error: ${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
      if (code !== 0) {
        reject(new Error(`cheatcode-install.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
        return;
      }
      let parsed: InstallOutput;
      try {
        parsed = JSON.parse(stdout) as InstallOutput;
      } catch {
        reject(new Error(`cheatcode-install.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.attachments)) {
        reject(new Error('cheatcode-install.sh emitted unexpected shape (missing attachments[])'));
        return;
      }
      resolve(parsed);
    });
  });
}

const resolveInstallScript = (): string => resolveScriptsFile('cheatcode-install.sh');
const INSTALL_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout

const INSTALLABLE_KINDS = new Set<CheatcodeKind>(['skill', 'mcp', 'plugin']);

const VALID_KINDS = new Set<CheatcodeKind>(['skill', 'mcp', 'plugin', 'any']);

type ParsedInstallCandidate =
  | { name: string; kind: 'skill' | 'mcp' | 'plugin'; sourceUrl: string; tier: number | undefined }
  | { error: string };

// Parse + validate a candidate for install/approve. Unlike search/vet, install
// requires a concrete installable kind — 'any' is rejected.
function parseInstallCandidate(raw: unknown): ParsedInstallCandidate {
  if (!raw || typeof raw !== 'object') return { error: 'candidate is required' };
  const obj = raw as Record<string, unknown>;
  const name = (obj['name'] as string | undefined)?.trim();
  const sourceUrl = (obj['source_url'] as string | undefined)?.trim();
  const rawKind = (obj['kind'] as string | undefined)?.trim();
  if (!name) return { error: 'candidate.name is required' };
  if (!sourceUrl) return { error: 'candidate.source_url is required' };
  if (!rawKind || !INSTALLABLE_KINDS.has(rawKind as CheatcodeKind)) {
    return { error: 'candidate.kind must be one of skill|mcp|plugin' };
  }
  const tierVal = obj['tier'];
  return {
    name,
    kind: rawKind as 'skill' | 'mcp' | 'plugin',
    sourceUrl,
    tier: typeof tierVal === 'number' ? tierVal : undefined,
  };
}

export function cheatcodeTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'cheatcode_search',
      description:
        'Discover + deterministically rank Claude Code cheatcodes (skills, MCP toolkits, plugins) for a capability the project lacks. Forks scripts/cheatcode-search.sh (query tiered registries, rank by tier + relevance, no LLM), records a cheatcode_search audit row, returns ranked candidates.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          capability_query: {
            type: 'string',
            description: 'The needed capability (e.g. "pdf table extraction").',
          },
          kind: {
            type: 'string',
            enum: ['skill', 'mcp', 'plugin', 'any'],
            description: 'Filter to one cheatcode kind. Defaults to any.',
          },
        },
        required: ['agent', 'capability_query'],
      },
    },
    {
      name: 'cheatcode_vet',
      description:
        'Gather reputation + security-surface signals for ONE cheatcode candidate and emit a deterministic trust_tier (trusted|caution|untrusted|unknown) + rationale + capabilities[]. Forks scripts/cheatcode-vet.sh, records a cheatcode_vet audit row. The tier is a reproducible classification, NOT an install verdict (that stays bro + Human).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          candidate: {
            type: 'object',
            description: 'One candidate to vet (e.g. a row from cheatcode_search).',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['skill', 'mcp', 'plugin', 'any'] },
              source_url: { type: 'string', description: 'The repo URL the signals key off.' },
              tier: { type: 'number', description: 'Registry tier carried over from the candidate (optional).' },
            },
            required: ['name', 'kind', 'source_url'],
          },
        },
        required: ['agent', 'candidate'],
      },
    },
    {
      name: 'cheatcode_approve',
      description:
        'Record the human approval for installing ONE cheatcode. Writes a cheatcode_approved audit row keyed by source_url; the PreToolUse install gate fails closed until it exists. Per-candidate, per-session — the human decision, not bro self-authorizing.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          candidate: {
            type: 'object',
            description: 'The candidate the human approved for install (from cheatcode_vet).',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['skill', 'mcp', 'plugin'] },
              source_url: { type: 'string', description: 'The repo URL — the per-candidate approval key.' },
            },
            required: ['name', 'kind', 'source_url'],
          },
        },
        required: ['agent', 'candidate'],
      },
    },
    {
      name: 'cheatcode_install',
      description:
        'Install ONE approved cheatcode via the marketplace path (no seeding). Forks scripts/cheatcode-install.sh, records the cheatcodes + attachment row(s) in one transaction, emits cheatcode_install + cheatcode_installed audit rows. Idempotent on (name, source_url). Blocked by a PreToolUse gate without a cheatcode_approve record. Skill-kind returns a proposed-PR payload, never writes agent md.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          candidate: {
            type: 'object',
            description: 'The approved candidate to install (from cheatcode_vet).',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['skill', 'mcp', 'plugin'] },
              source_url: { type: 'string', description: 'The repo URL the install keys off.' },
              tier: { type: 'number', description: 'Registry tier carried over from the candidate (optional).' },
            },
            required: ['name', 'kind', 'source_url'],
          },
          trust_tier: {
            type: 'string',
            description: 'The cheatcode_vet trust_tier recorded at install time (optional).',
          },
        },
        required: ['agent', 'candidate'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    cheatcode_search: requireRoles(
      'cheatcode_search',
      ['bro'],
      wrap(async (args) => {
        const query = (args['capability_query'] as string | undefined)?.trim();
        if (!query) return err('capability_query is required');
        const rawKind = (args['kind'] as string | undefined) ?? 'any';
        const kind: CheatcodeKind = VALID_KINDS.has(rawKind as CheatcodeKind)
          ? (rawKind as CheatcodeKind)
          : 'any';

        const out = await runSearchWithScript(resolveSearchScript(), query, kind, SEARCH_TIMEOUT_MS);

        db.run(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'cheatcode_search', ?, ?, ?)`,
          [
            `Cheatcode search: '${query}' (kind=${kind}) → ${out.candidates.length} ranked candidate(s)`,
            JSON.stringify({
              query,
              kind,
              candidate_count: out.candidates.length,
              top: out.candidates.slice(0, 5).map((c) => ({ name: c.name, kind: c.kind, score: c.score })),
            }),
            nowISO(),
          ],
        );

        return ok({ query, kind, candidates: out.candidates });
      }),
    ),
    cheatcode_vet: requireRoles(
      'cheatcode_vet',
      ['bro'],
      wrap(async (args) => {
        const raw = args['candidate'] as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== 'object') return err('candidate is required');
        const name = (raw['name'] as string | undefined)?.trim();
        const sourceUrl = (raw['source_url'] as string | undefined)?.trim();
        if (!name) return err('candidate.name is required');
        if (!sourceUrl) return err('candidate.source_url is required');
        const rawKind = (raw['kind'] as string | undefined) ?? 'any';
        const kind: CheatcodeKind = VALID_KINDS.has(rawKind as CheatcodeKind)
          ? (rawKind as CheatcodeKind)
          : 'any';
        const tierVal = raw['tier'];
        const candidate: { name: string; kind: string; source_url: string; tier?: number } = {
          name,
          kind,
          source_url: sourceUrl,
        };
        if (typeof tierVal === 'number') candidate.tier = tierVal;

        const out = await runVetWithScript(resolveVetScript(), candidate, VET_TIMEOUT_MS);

        db.run(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'cheatcode_vet', ?, ?, ?)`,
          [
            `Cheatcode vet: '${name}' (kind=${kind}) → trust_tier=${out.trust_tier}`,
            JSON.stringify({
              candidate: out.candidate,
              trust_tier: out.trust_tier,
              capabilities: out.capabilities,
              rationale: out.rationale,
            }),
            nowISO(),
          ],
        );

        return ok(out);
      }),
    ),
    cheatcode_approve: requireRoles(
      'cheatcode_approve',
      ['bro'],
      wrap(async (args) => {
        const parsed = parseInstallCandidate(args['candidate']);
        if ('error' in parsed) return err(parsed.error);
        const { name, kind, sourceUrl } = parsed;

        db.run(
          `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'cheatcode_approved', ?, ?, ?)`,
          [
            `Cheatcode approved for install: '${name}' (kind=${kind})`,
            JSON.stringify({ name, kind, source_url: sourceUrl }),
            nowISO(),
          ],
        );

        return ok({ approved: true, candidate: { name, kind, source_url: sourceUrl } });
      }),
    ),
    cheatcode_install: requireRoles(
      'cheatcode_install',
      ['bro'],
      wrap(async (args) => {
        const parsed = parseInstallCandidate(args['candidate']);
        if ('error' in parsed) return err(parsed.error);
        const { name, kind, sourceUrl, tier } = parsed;
        const trustTier = (args['trust_tier'] as string | undefined)?.trim() ?? null;

        // Idempotent re-install: the (name, source_url) pair is the candidate
        // identity. If it is already installed, no-op — never duplicate the row
        // or re-run the marketplace install.
        const existing = db.get<CheatcodeRow>(
          `SELECT * FROM cheatcodes WHERE name = ? AND source_url = ? LIMIT 1`,
          [name, sourceUrl],
        );
        if (existing) {
          const attachments = db.all<{ target: string; artifact: string }>(
            `SELECT target, artifact FROM cheatcode_attachments WHERE cheatcode_id = ? ORDER BY id`,
            [existing.id],
          );
          return ok({
            installed: false,
            idempotent: true,
            cheatcode: existing,
            attachments,
          });
        }

        const candidate: { name: string; kind: string; source_url: string; tier?: number } = {
          name,
          kind,
          source_url: sourceUrl,
        };
        if (typeof tier === 'number') candidate.tier = tier;

        const out = await runInstallWithScript(
          resolveInstallScript(),
          candidate,
          INSTALL_TIMEOUT_MS,
        );

        // One transaction: the cheatcodes row + every attachment row + both
        // audit rows land together or not at all.
        const installedAt = nowISO();
        const cheatcodeId = db.transaction(() => {
          const res = db.run(
            `INSERT INTO cheatcodes (name, kind, source_url, version, trust_tier, status, installed_at)
             VALUES (?, ?, ?, ?, ?, 'installed', ?)`,
            [name, kind, sourceUrl, out.version, trustTier, installedAt],
          );
          const id = Number(res.lastInsertRowid);

          for (const att of out.attachments) {
            db.run(
              `INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
               VALUES (?, ?, ?, ?)`,
              [id, att.target, att.artifact, installedAt],
            );
          }

          db.run(
            `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'cheatcode_install', ?, ?, ?)`,
            [
              `Cheatcode install: '${name}' (kind=${kind}, method=${out.method})`,
              JSON.stringify({ name, kind, source_url: sourceUrl, method: out.method }),
              installedAt,
            ],
          );
          db.run(
            `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'cheatcode_installed', ?, ?, ?)`,
            [
              `Cheatcode installed: '${name}' → cheatcode_id=${id}`,
              JSON.stringify({
                cheatcode_id: id,
                name,
                kind,
                source_url: sourceUrl,
                installed: out.installed,
                attachments: out.attachments,
              }),
              installedAt,
            ],
          );
          return id;
        });

        return ok({
          installed: out.installed,
          cheatcode_id: cheatcodeId,
          candidate: out.candidate,
          method: out.method,
          version: out.version,
          attachments: out.attachments,
          // Skill-kind: the agent-frontmatter edit is a Human-reviewed PR, never
          // an automatic write — surface the proposed payload, write no md.
          proposed_pr: out.proposed_pr,
          error: out.error,
        });
      }),
    ),
  };

  return { definitions, handlers };
}
