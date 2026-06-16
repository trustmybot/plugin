import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function wrap(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
// Locate scripts/cheatcode-search.sh relative to this compiled module. Plugin layout:
//   <plugin>/mcp/trajectory-server/dist/tools/cheatcode.js
//   <plugin>/scripts/cheatcode-search.sh
// Walking up four levels lands at the plugin root (mirrors scan.ts).
function resolveSearchScript() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', '..', '..', 'scripts', 'cheatcode-search.sh'),
        join(here, '..', '..', '..', 'scripts', 'cheatcode-search.sh'),
    ];
    for (const c of candidates)
        if (existsSync(c))
            return c;
    const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
    if (pluginRoot) {
        const c = join(pluginRoot, 'scripts', 'cheatcode-search.sh');
        if (existsSync(c))
            return c;
    }
    throw new Error('cheatcode-search.sh not found — expected at <plugin>/scripts/cheatcode-search.sh');
}
const SEARCH_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout
export function runSearchWithScript(script, query, kind, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [script, '--query', query, '--kind', kind], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        let settled = false;
        const killTimer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            try {
                child.kill('SIGKILL');
            }
            catch {
                // already exited
            }
            reject(new Error('cheatcode-search.sh timed out after 60 seconds'));
        }, timeoutMs);
        child.on('error', (e) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            reject(new Error(`cheatcode-search.sh spawn error: ${e.message}`));
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
            if (code !== 0) {
                reject(new Error(`cheatcode-search.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch {
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
const VALID_KINDS = new Set(['skill', 'mcp', 'plugin', 'any']);
export function cheatcodeTools(db) {
    const definitions = [
        {
            name: 'cheatcode_search',
            description: 'Discover + deterministically rank 3rd-party Claude Code resources (skills, MCP toolkits, plugins) for a capability the project lacks. Forks scripts/cheatcode-search.sh (query tiered registries, rank by tier + relevance, no LLM), records a cheatcode_search audit row, returns ranked candidates.',
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
                        description: 'Filter to one resource kind. Defaults to any.',
                    },
                },
                required: ['agent', 'capability_query'],
            },
        },
    ];
    const handlers = {
        cheatcode_search: requireRoles('cheatcode_search', ['bro'], wrap(async (args) => {
            const query = args['capability_query']?.trim();
            if (!query)
                return err('capability_query is required');
            const rawKind = args['kind'] ?? 'any';
            const kind = VALID_KINDS.has(rawKind)
                ? rawKind
                : 'any';
            const out = await runSearchWithScript(resolveSearchScript(), query, kind, SEARCH_TIMEOUT_MS);
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'cheatcode_search', ?, ?, ?)`, [
                `Resource search: '${query}' (kind=${kind}) → ${out.candidates.length} ranked candidate(s)`,
                JSON.stringify({
                    query,
                    kind,
                    candidate_count: out.candidates.length,
                    top: out.candidates.slice(0, 5).map((c) => ({ name: c.name, kind: c.kind, score: c.score })),
                }),
                nowISO(),
            ]);
            return ok({ query, kind, candidates: out.candidates });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=cheatcode.js.map