import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { cheatcodeTools } from '../tools/cheatcode.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return h(args) as unknown as RawResult;
}

// Mixed-tier fixture. The curated (tier 2) candidate is given STRICTLY MORE
// relevance than the official (tier 1) one, so a tier-blind ranker would float
// it to the top. Tier dominance (200 base vs 100) must keep official first.
const FIXTURE = JSON.stringify([
  {
    name: 'curated-pdf',
    kind: 'skill',
    source_url: 'https://example.test/curated-pdf',
    description: 'extract pdf table data from documents',
    registry: 'pulsemcp',
    tier: 2,
  },
  {
    name: 'official-pdf',
    kind: 'skill',
    source_url: 'https://example.test/official-pdf',
    description: 'pdf tooling',
    registry: 'mcp-official',
    tier: 1,
  },
  {
    name: 'unrelated-thing',
    kind: 'mcp',
    source_url: 'https://example.test/unrelated',
    description: 'manages kubernetes clusters',
    registry: 'mcp-official',
    tier: 1,
  },
]);

describe('cheatcode_search', () => {
  function withFixture(): { dir: string; path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-'));
    const path = join(dir, 'candidates.json');
    writeFileSync(path, FIXTURE);
    return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('ranks official (tier 1) above curated (tier 2) even when curated is more relevant', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture();
    process.env['TMB_CHEATCODE_SEARCH_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      const r = await call(tools.handlers, 'cheatcode_search', {
        agent: 'bro',
        capability_query: 'pdf table extraction',
      });
      const out = parse(r);
      const candidates = out['candidates'] as Array<{
        name: string;
        score: number;
        signals: { registry: string; tier: number; relevance: number };
      }>;
      assert.ok(candidates.length >= 2, 'at least two candidates returned');
      for (let i = 1; i < candidates.length; i++) {
        assert.ok(
          candidates[i - 1].score >= candidates[i].score,
          `score order violated at index ${i}`,
        );
      }
      // official-pdf (tier 1, relevance 1) must beat curated-pdf (tier 2, relevance 2):
      // tier dominance (200 base) outweighs the curated candidate's extra relevance.
      assert.equal(candidates[0].name, 'official-pdf');
      assert.equal(candidates[0].signals.tier, 1);
      const official = candidates.find((c) => c.name === 'official-pdf')!;
      const curated = candidates.find((c) => c.name === 'curated-pdf')!;
      assert.ok(curated.signals.relevance > official.signals.relevance, 'curated is more relevant');
      assert.ok(official.score > curated.score, 'official still outscores curated by tier');
      assert.equal(official.signals.registry, 'mcp-official');
      assert.equal(curated.signals.registry, 'pulsemcp');
    } finally {
      delete process.env['TMB_CHEATCODE_SEARCH_FIXTURE'];
      cleanup();
    }
  });

  it('filters candidates by kind', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture();
    process.env['TMB_CHEATCODE_SEARCH_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      const r = await call(tools.handlers, 'cheatcode_search', {
        agent: 'bro',
        capability_query: 'pdf',
        kind: 'skill',
      });
      const out = parse(r);
      const candidates = out['candidates'] as Array<{ kind: string }>;
      assert.ok(candidates.every((c) => c.kind === 'skill'), 'all candidates are skills');
      assert.equal(out['kind'], 'skill');
    } finally {
      delete process.env['TMB_CHEATCODE_SEARCH_FIXTURE'];
      cleanup();
    }
  });

  it('writes a cheatcode_search audit row', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture();
    process.env['TMB_CHEATCODE_SEARCH_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      await call(tools.handlers, 'cheatcode_search', {
        agent: 'bro',
        capability_query: 'pdf table extraction',
      });
      const row = db.get<{ event_type: string; content_json: string }>(
        `SELECT event_type, content_json FROM audit WHERE event_type = 'cheatcode_search' ORDER BY id DESC LIMIT 1`,
      );
      assert.ok(row, 'cheatcode_search audit row exists');
      const content = JSON.parse(row!.content_json);
      assert.equal(content.query, 'pdf table extraction');
      assert.ok(typeof content.candidate_count === 'number');
    } finally {
      delete process.env['TMB_CHEATCODE_SEARCH_FIXTURE'];
      cleanup();
    }
  });

  it('rejects a non-bro caller', async () => {
    const db = tempDB();
    const tools = cheatcodeTools(db);
    const r = await call(tools.handlers, 'cheatcode_search', {
      agent: 'swe',
      capability_query: 'pdf',
    });
    assert.equal(r.isError, true);
    const out = parse(r);
    assert.equal(out['error'], 'forbidden');
  });
});

// Vet fixtures stub the network exactly as TMB_CHEATCODE_VET_FIXTURE intends:
// the {repo, contents} object stands in for the best-effort GitHub responses.
const VET_OFFICIAL = JSON.stringify({
  repo: {
    stargazers_count: 1200,
    forks_count: 80,
    pushed_at: '2026-05-01T00:00:00Z',
    archived: false,
    license: { spdx_id: 'MIT' },
    owner: { login: 'anthropics', type: 'Organization' },
  },
  contents: ['README.md', 'LICENSE'],
});

const VET_EXEC = JSON.stringify({
  repo: {
    stargazers_count: 9000,
    forks_count: 800,
    pushed_at: '2026-06-01T00:00:00Z',
    archived: false,
    license: { spdx_id: 'Apache-2.0' },
    owner: { login: 'someorg', type: 'Organization' },
  },
  contents: ['README.md', 'hooks', 'scripts'],
});

const VET_ARCHIVED = JSON.stringify({
  repo: {
    stargazers_count: 50,
    forks_count: 2,
    pushed_at: '2022-01-01T00:00:00Z',
    archived: true,
    license: { spdx_id: 'MIT' },
    owner: { login: 'x', type: 'User' },
  },
});

const VET_EMPTY = JSON.stringify({});

type VetCand = { name: string; kind: string; source_url: string; tier?: number };
type VetResult = {
  candidate: VetCand;
  signals: {
    reputation: { registry_tier: number | null; stars: number | null; forks: number | null };
    maintenance: { pushed_at: string | null; archived: boolean; active: boolean | null };
    license: string | null;
    maintainer: { login: string | null; type: string | null };
    security_surface: { code_execution: boolean; network: boolean; fs_writes: boolean };
  };
  trust_tier: string;
  rationale: string;
  capabilities: string[];
};

describe('cheatcode_vet', () => {
  function withFixture(body: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-vet-'));
    const path = join(dir, 'signals.json');
    writeFileSync(path, body);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function vet(body: string, candidate: VetCand): Promise<VetResult> {
    const db = tempDB();
    const { path, cleanup } = withFixture(body);
    process.env['TMB_CHEATCODE_VET_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      const r = await call(tools.handlers, 'cheatcode_vet', { agent: 'bro', candidate });
      assert.notEqual(r.isError, true, `vet errored: ${r.content[0]?.text}`);
      return parse(r) as unknown as VetResult;
    } finally {
      delete process.env['TMB_CHEATCODE_VET_FIXTURE'];
      cleanup();
    }
  }

  it('classifies an official tier-1 candidate with no exec surface as trusted', async () => {
    const out = await vet(VET_OFFICIAL, {
      name: 'official-pdf',
      kind: 'skill',
      source_url: 'https://github.com/anthropics/pdf',
      tier: 1,
    });
    assert.equal(out.trust_tier, 'trusted');
    assert.deepEqual(out.capabilities, []);
    assert.equal(out.signals.reputation.registry_tier, 1);
    assert.equal(out.signals.reputation.stars, 1200);
    assert.equal(out.signals.license, 'MIT');
    assert.equal(out.signals.maintainer.login, 'anthropics');
  });

  it('orders tiers: trusted > caution > untrusted > unknown by signal strength', async () => {
    const trusted = await vet(VET_OFFICIAL, {
      name: 'a',
      kind: 'skill',
      source_url: 'https://github.com/anthropics/pdf',
      tier: 1,
    });
    const caution = await vet(VET_EXEC, {
      name: 'b',
      kind: 'skill',
      source_url: 'https://github.com/someorg/hooky',
    });
    const untrusted = await vet(VET_ARCHIVED, {
      name: 'c',
      kind: 'skill',
      source_url: 'https://github.com/x/old',
      tier: 2,
    });
    const unknown = await vet(VET_EMPTY, {
      name: 'd',
      kind: 'skill',
      source_url: 'https://gitlab.com/x/y',
    });
    assert.equal(trusted.trust_tier, 'trusted');
    assert.equal(caution.trust_tier, 'caution');
    assert.equal(untrusted.trust_tier, 'untrusted');
    assert.equal(unknown.trust_tier, 'unknown');
  });

  it('flags code_execution for a candidate that ships hooks/scripts and never trusts it on popularity', async () => {
    const out = await vet(VET_EXEC, {
      name: 'hooky',
      kind: 'skill',
      source_url: 'https://github.com/someorg/hooky',
    });
    assert.ok(out.capabilities.includes('code_execution'), 'code_execution flagged');
    assert.equal(out.signals.security_surface.code_execution, true);
    assert.notEqual(out.trust_tier, 'trusted', 'popular code-executing cheatcode is never trusted');
    assert.equal(out.trust_tier, 'caution');
  });

  it('degrades to unknown on an empty/failed signal set and never throws', async () => {
    const out = await vet(VET_EMPTY, {
      name: 'mystery',
      kind: 'skill',
      source_url: 'https://gitlab.com/x/y',
    });
    assert.equal(out.trust_tier, 'unknown');
    assert.equal(out.signals.reputation.stars, null);
    assert.equal(out.signals.maintainer.login, null);
  });

  it('is deterministic: identical input yields identical output', async () => {
    const cand: VetCand = { name: 'hooky', kind: 'skill', source_url: 'https://github.com/someorg/hooky' };
    const a = await vet(VET_EXEC, cand);
    const b = await vet(VET_EXEC, cand);
    assert.deepEqual(a, b);
  });

  it('writes a cheatcode_vet audit row carrying the candidate + tier', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture(VET_OFFICIAL);
    process.env['TMB_CHEATCODE_VET_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      await call(tools.handlers, 'cheatcode_vet', {
        agent: 'bro',
        candidate: { name: 'official-pdf', kind: 'skill', source_url: 'https://github.com/anthropics/pdf', tier: 1 },
      });
      const row = db.get<{ event_type: string; content_json: string }>(
        `SELECT event_type, content_json FROM audit WHERE event_type = 'cheatcode_vet' ORDER BY id DESC LIMIT 1`,
      );
      assert.ok(row, 'cheatcode_vet audit row exists');
      const content = JSON.parse(row!.content_json);
      assert.equal(content.candidate.name, 'official-pdf');
      assert.equal(content.trust_tier, 'trusted');
      assert.ok(Array.isArray(content.capabilities));
    } finally {
      delete process.env['TMB_CHEATCODE_VET_FIXTURE'];
      cleanup();
    }
  });

  it('rejects a non-bro caller', async () => {
    const db = tempDB();
    const tools = cheatcodeTools(db);
    const r = await call(tools.handlers, 'cheatcode_vet', {
      agent: 'swe',
      candidate: { name: 'x', kind: 'skill', source_url: 'https://github.com/x/y' },
    });
    assert.equal(r.isError, true);
    const out = parse(r);
    assert.equal(out['error'], 'forbidden');
  });
});

// Install fixtures stub the marketplace exactly as TMB_CHEATCODE_INSTALL_FIXTURE
// intends: the {installed, version} object stands in for the marketplace call.
const INSTALL_OK = JSON.stringify({ installed: true, version: '1.2.3' });

describe('cheatcode_install', () => {
  function withFixture(body: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-cheatcode-install-'));
    const path = join(dir, 'install.json');
    writeFileSync(path, body);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('writes one cheatcodes row + its attachment row in a single transaction', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture(INSTALL_OK);
    process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      const r = await call(tools.handlers, 'cheatcode_install', {
        agent: 'bro',
        candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf', tier: 1 },
        trust_tier: 'trusted',
      });
      assert.notEqual(r.isError, true, `install errored: ${r.content[0]?.text}`);
      const out = parse(r);
      assert.equal(out['installed'], true);

      const codes = db.all<{ id: number; name: string; trust_tier: string; version: string; status: string }>(
        `SELECT id, name, trust_tier, version, status FROM cheatcodes`,
      );
      assert.equal(codes.length, 1, 'exactly one cheatcodes row');
      assert.equal(codes[0].name, 'pdf-plugin');
      assert.equal(codes[0].trust_tier, 'trusted');
      assert.equal(codes[0].version, '1.2.3');
      assert.equal(codes[0].status, 'installed');

      const atts = db.all<{ cheatcode_id: number; target: string; artifact: string }>(
        `SELECT cheatcode_id, target, artifact FROM cheatcode_attachments`,
      );
      assert.ok(atts.length >= 1, 'at least one attachment row');
      assert.equal(atts[0].cheatcode_id, codes[0].id, 'attachment FKs the cheatcode');
      assert.equal(atts[0].target, 'plugin');
    } finally {
      delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
      cleanup();
    }
  });

  it('is idempotent — re-installing the same candidate no-ops', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture(INSTALL_OK);
    process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      const cand = { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf', tier: 1 };
      await call(tools.handlers, 'cheatcode_install', { agent: 'bro', candidate: cand });
      const r2 = await call(tools.handlers, 'cheatcode_install', { agent: 'bro', candidate: cand });
      const out2 = parse(r2);
      assert.equal(out2['idempotent'], true);
      assert.equal(out2['installed'], false);

      const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cheatcodes`);
      assert.equal(n!.n, 1, 're-install did not duplicate the row');
      const an = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cheatcode_attachments`);
      assert.equal(an!.n, 1, 're-install did not duplicate the attachment');
    } finally {
      delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
      cleanup();
    }
  });

  it('skill-kind returns a proposed-PR payload and writes no cheatcode_attachments md', async () => {
    const db = tempDB();
    // Skill kind with no fixture installs nothing at the marketplace; the
    // attachment is the proposed-PR payload only.
    const tools = cheatcodeTools(db);
    const r = await call(tools.handlers, 'cheatcode_install', {
      agent: 'bro',
      candidate: { name: 'pdf-skill', kind: 'skill', source_url: 'https://github.com/x/pdf-skill' },
    });
    assert.notEqual(r.isError, true, `install errored: ${r.content[0]?.text}`);
    const out = parse(r);
    const proposed = out['proposed_pr'] as Record<string, unknown> | null;
    assert.ok(proposed, 'proposed_pr payload present for skill kind');
    assert.equal(proposed!['kind'], 'agent-frontmatter');
    assert.equal(out['method'], 'skill-proposed-pr');
    assert.equal(out['installed'], false, 'no marketplace install for a standalone skill');

    // The attachment record describes the proposed PR — no agent md is touched.
    const atts = db.all<{ target: string; artifact: string }>(
      `SELECT target, artifact FROM cheatcode_attachments`,
    );
    assert.ok(atts.some((a) => a.target === 'proposed-pr'), 'attachment is the proposed-PR plan');
  });

  it('writes cheatcode_install + cheatcode_installed audit rows', async () => {
    const db = tempDB();
    const { path, cleanup } = withFixture(INSTALL_OK);
    process.env['TMB_CHEATCODE_INSTALL_FIXTURE'] = path;
    try {
      const tools = cheatcodeTools(db);
      await call(tools.handlers, 'cheatcode_install', {
        agent: 'bro',
        candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf', tier: 1 },
      });
      const install = db.get<{ event_type: string }>(
        `SELECT event_type FROM audit WHERE event_type = 'cheatcode_install' ORDER BY id DESC LIMIT 1`,
      );
      const installed = db.get<{ content_json: string }>(
        `SELECT content_json FROM audit WHERE event_type = 'cheatcode_installed' ORDER BY id DESC LIMIT 1`,
      );
      assert.ok(install, 'cheatcode_install audit row exists');
      assert.ok(installed, 'cheatcode_installed audit row exists');
      const content = JSON.parse(installed!.content_json);
      assert.equal(content.name, 'pdf-plugin');
      assert.ok(typeof content.cheatcode_id === 'number');
    } finally {
      delete process.env['TMB_CHEATCODE_INSTALL_FIXTURE'];
      cleanup();
    }
  });

  it('rejects a non-bro caller', async () => {
    const db = tempDB();
    const tools = cheatcodeTools(db);
    const r = await call(tools.handlers, 'cheatcode_install', {
      agent: 'swe',
      candidate: { name: 'x', kind: 'plugin', source_url: 'https://github.com/x/y' },
    });
    assert.equal(r.isError, true);
    const out = parse(r);
    assert.equal(out['error'], 'forbidden');
  });

  it('cheatcode_approve writes a per-candidate cheatcode_approved audit row', async () => {
    const db = tempDB();
    const tools = cheatcodeTools(db);
    const r = await call(tools.handlers, 'cheatcode_approve', {
      agent: 'bro',
      candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://github.com/x/pdf' },
    });
    assert.notEqual(r.isError, true);
    const out = parse(r);
    assert.equal(out['approved'], true);
    const row = db.get<{ content_json: string }>(
      `SELECT content_json FROM audit WHERE event_type = 'cheatcode_approved' ORDER BY id DESC LIMIT 1`,
    );
    assert.ok(row, 'cheatcode_approved audit row exists');
    const content = JSON.parse(row!.content_json);
    assert.equal(content.source_url, 'https://github.com/x/pdf');
  });

  it('cheatcode_approve rejects a non-bro caller', async () => {
    const db = tempDB();
    const tools = cheatcodeTools(db);
    const r = await call(tools.handlers, 'cheatcode_approve', {
      agent: 'swe',
      candidate: { name: 'x', kind: 'plugin', source_url: 'https://github.com/x/y' },
    });
    assert.equal(r.isError, true);
    const out = parse(r);
    assert.equal(out['error'], 'forbidden');
  });
});
