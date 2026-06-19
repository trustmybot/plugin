import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
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
// Locate a scripts/<name> file relative to this compiled module. Plugin layout:
//   <plugin>/mcp/trajectory-server/dist/tools/cheatcode.js
//   <plugin>/scripts/<name>
// Walking up four levels lands at the plugin root (mirrors scan.ts).
function resolveScriptsFile(name) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', '..', '..', 'scripts', name),
        join(here, '..', '..', '..', 'scripts', name),
    ];
    for (const c of candidates)
        if (existsSync(c))
            return c;
    const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
    if (pluginRoot) {
        const c = join(pluginRoot, 'scripts', name);
        if (existsSync(c))
            return c;
    }
    throw new Error(`${name} not found — expected at <plugin>/scripts/${name}`);
}
const resolveSearchScript = () => resolveScriptsFile('cheatcode-search.sh');
const resolveVetScript = () => resolveScriptsFile('cheatcode-vet.sh');
const SEARCH_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout
const VET_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout
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
const VALID_TIERS = new Set([
    'trusted',
    'caution',
    'untrusted',
    'unknown',
]);
export function runVetWithScript(script, candidate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [script, '--candidate', JSON.stringify(candidate)], {
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
            reject(new Error('cheatcode-vet.sh timed out after 60 seconds'));
        }, timeoutMs);
        child.on('error', (e) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            reject(new Error(`cheatcode-vet.sh spawn error: ${e.message}`));
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
            if (code !== 0) {
                reject(new Error(`cheatcode-vet.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch {
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
export function runInstallWithScript(script, candidate, scope, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [script, '--candidate', JSON.stringify(candidate), '--scope', scope], { stdio: ['ignore', 'pipe', 'pipe'] });
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
            reject(new Error('cheatcode-install.sh timed out after 60 seconds'));
        }, timeoutMs);
        child.on('error', (e) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            reject(new Error(`cheatcode-install.sh spawn error: ${e.message}`));
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
            if (code !== 0) {
                reject(new Error(`cheatcode-install.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch {
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
const resolveInstallScript = () => resolveScriptsFile('cheatcode-install.sh');
const INSTALL_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout
export function runUninstallWithScript(script, candidate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [script, '--candidate', JSON.stringify(candidate)], {
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
            reject(new Error('cheatcode-uninstall.sh timed out after 60 seconds'));
        }, timeoutMs);
        child.on('error', (e) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            reject(new Error(`cheatcode-uninstall.sh spawn error: ${e.message}`));
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(killTimer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
            if (code !== 0) {
                reject(new Error(`cheatcode-uninstall.sh failed (exit ${code ?? '?'}): ${stderr || 'unknown error'}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch {
                reject(new Error(`cheatcode-uninstall.sh emitted non-JSON output (first 500 chars): ${stdout.slice(0, 500)}`));
                return;
            }
            if (!parsed || typeof parsed !== 'object' || typeof parsed.method !== 'string') {
                reject(new Error('cheatcode-uninstall.sh emitted unexpected shape (missing method)'));
                return;
            }
            resolve(parsed);
        });
    });
}
const resolveUninstallScript = () => resolveScriptsFile('cheatcode-uninstall.sh');
const UNINSTALL_TIMEOUT_MS = 60 * 1000; // 1-minute hard timeout
const INSTALLABLE_KINDS = new Set(['skill', 'mcp', 'plugin']);
const VALID_KINDS = new Set(['skill', 'mcp', 'plugin', 'any']);
// Derive the provenance enum (#152) from the install source. A marketplace ref
// is a `<name>@<marketplace>` token or a marketplace-relative `./` path — never
// a raw URL. Everything else (an https/git@ repo URL) is an external source the
// install registered as a marketplace first. Lifecycle never lives in origin.
function deriveOrigin(sourceUrl) {
    const url = sourceUrl.trim();
    if (url.startsWith('./'))
        return 'marketplace';
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^@\s]+@[^:\s]+:/.test(url);
    if (!isUrl && url.includes('@'))
        return 'marketplace';
    return 'external';
}
// Parse + validate a candidate for install/approve. Unlike search/vet, install
// requires a concrete installable kind — 'any' is rejected.
function parseInstallCandidate(raw) {
    if (!raw || typeof raw !== 'object')
        return { error: 'candidate is required' };
    const obj = raw;
    const name = obj['name']?.trim();
    const sourceUrl = obj['source_url']?.trim();
    const rawKind = obj['kind']?.trim();
    if (!name)
        return { error: 'candidate.name is required' };
    if (!sourceUrl)
        return { error: 'candidate.source_url is required' };
    if (!rawKind || !INSTALLABLE_KINDS.has(rawKind)) {
        return { error: 'candidate.kind must be one of skill|mcp|plugin' };
    }
    const tierVal = obj['tier'];
    return {
        name,
        kind: rawKind,
        sourceUrl,
        tier: typeof tierVal === 'number' ? tierVal : undefined,
    };
}
// The consuming-agent prompt surface lives on an agent md (swe / pr-reviewer /
// a consultant) for everyone but bro, whose surface is CLAUDE.md. A non-bro
// target materializes the agent md global→local + a skills: entry; bro
// materializes a project-local CLAUDE.md reference.
// Derive the PROJECT ROOT (the dir that owns .claude/) from the trajectory DB
// path. The DB lives at <root>/.claude/<plugin>/trajectory.db, so the root is
// the parent of the first `.claude` segment. Returns null for an in-memory DB
// or a path with no `.claude` segment (e.g. a bespoke TRAJECTORY_DB_PATH).
function projectRootFromDbPath(dbPath) {
    if (!dbPath || dbPath === ':memory:')
        return null;
    const segments = dbPath.split(sep);
    const idx = segments.indexOf('.claude');
    if (idx <= 0)
        return null;
    return segments.slice(0, idx).join(sep) || sep;
}
// Resolve the GLOBAL agent md the install copies from. The plugin ships its
// agents at ${CLAUDE_PLUGIN_ROOT}/agents/<target>.md; fall back to the on-disk
// layout four levels up from this compiled module (mirrors resolveScriptsFile).
function resolveGlobalAgentMd(target) {
    const pluginRoot = process.env['CLAUDE_PLUGIN_ROOT'];
    if (pluginRoot) {
        const c = join(pluginRoot, 'agents', `${target}.md`);
        if (existsSync(c))
            return c;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const c = join(here, '..', '..', '..', '..', 'agents', `${target}.md`);
    if (existsSync(c))
        return c;
    return null;
}
// Add `skillName` to the `skills:` frontmatter array of an agent md, idempotently.
// Creates the skills: key (inside the leading --- frontmatter block) when absent,
// never duplicates an existing entry, and preserves the rest of the file verbatim.
function addSkillToAgentFrontmatter(content, skillName) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
        // No frontmatter — prepend a minimal block carrying the skill.
        return `---\nskills: [${skillName}]\n---\n\n${content}`;
    }
    const fm = fmMatch[1];
    const skillsLine = fm.match(/^skills:\s*\[(.*)\]\s*$/m);
    if (skillsLine) {
        const entries = skillsLine[1]
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (entries.includes(skillName))
            return content; // idempotent
        entries.push(skillName);
        const rebuilt = `skills: [${entries.join(', ')}]`;
        const newFm = fm.replace(/^skills:\s*\[.*\]\s*$/m, rebuilt);
        return content.replace(fm, newFm);
    }
    // No skills: key — append one to the end of the frontmatter block.
    const newFm = `${fm}\nskills: [${skillName}]`;
    return content.replace(fm, newFm);
}
// Remove `skillName` from the `skills:` frontmatter array of an agent md — the
// inverse of addSkillToAgentFrontmatter. Idempotent: an absent entry (or no
// skills: key, or no frontmatter) leaves the content unchanged; an empty result
// renders as `skills: []`. Preserves the rest of the file verbatim.
function removeSkillFromAgentFrontmatter(content, skillName) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch)
        return content;
    const fm = fmMatch[1];
    const skillsLine = fm.match(/^skills:\s*\[(.*)\]\s*$/m);
    if (!skillsLine)
        return content;
    const entries = skillsLine[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (!entries.includes(skillName))
        return content; // idempotent
    const remaining = entries.filter((s) => s !== skillName);
    const rebuilt = `skills: [${remaining.join(', ')}]`;
    const newFm = fm.replace(/^skills:\s*\[.*\]\s*$/m, rebuilt);
    return content.replace(fm, newFm);
}
// Materialize the consuming-agent prompt surface for an installed skill. This is
// an install action against the USER PROJECT's .claude/ (like /tmb:agent-create)
// — it NEVER writes into the plugin's shipped agents/ or the plugin's CLAUDE.md.
// Idempotent: re-install adds no duplicate skill entry / CLAUDE.md line and never
// clobbers a customized file (edits in place). Returns null when it can't resolve
// a project root or the global source.
function materializeConsumingAgent(dbPath, target, skillName) {
    const projectRoot = projectRootFromDbPath(dbPath);
    if (!projectRoot)
        return null;
    const claudeDir = join(projectRoot, '.claude');
    if (target === 'bro') {
        // bro's surface is the project-local CLAUDE.md, not an agent md.
        const claudeMd = join(claudeDir, 'CLAUDE.md');
        const reference = `Installed skill: ${skillName} — load it when its capability is needed.`;
        let body = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
        if (!body.includes(reference)) {
            const prefix = body.length === 0 || body.endsWith('\n') ? '' : '\n';
            body = body.length === 0 ? `${reference}\n` : `${body}${prefix}${reference}\n`;
            mkdirSync(claudeDir, { recursive: true });
            writeFileSync(claudeMd, body);
        }
        return { target: 'bro', artifact: 'claude-md:.claude/CLAUDE.md', path: claudeMd };
    }
    const localAgentMd = join(claudeDir, 'agents', `${target}.md`);
    let content;
    if (existsSync(localAgentMd)) {
        // Never clobber a customized local agent — edit it in place.
        content = readFileSync(localAgentMd, 'utf8');
    }
    else {
        const globalAgentMd = resolveGlobalAgentMd(target);
        if (!globalAgentMd)
            return null;
        content = readFileSync(globalAgentMd, 'utf8');
    }
    const updated = addSkillToAgentFrontmatter(content, skillName);
    mkdirSync(dirname(localAgentMd), { recursive: true });
    writeFileSync(localAgentMd, updated);
    return {
        target,
        artifact: `agent-md:.claude/agents/${target}.md`,
        path: localAgentMd,
    };
}
// Reverse the materialized prompt surface for an uninstalled skill — the inverse
// of materializeConsumingAgent. Edits the SAME project files materialize wrote:
//   agent-md:<rel>  → remove skillName from that file's skills: header
//   claude-md:<rel> → remove the materialized reference line bro added
// Fail-soft: a missing project root / missing file / absent entry is a no-op,
// never throws (uninstall stays idempotent). Only runs on a successful teardown.
function dematerializeAttachment(dbPath, artifact, skillName) {
    const projectRoot = projectRootFromDbPath(dbPath);
    if (!projectRoot)
        return;
    if (artifact.startsWith('agent-md:')) {
        const rel = artifact.slice('agent-md:'.length);
        const filePath = join(projectRoot, rel);
        if (!existsSync(filePath))
            return;
        const content = readFileSync(filePath, 'utf8');
        const updated = removeSkillFromAgentFrontmatter(content, skillName);
        if (updated !== content)
            writeFileSync(filePath, updated);
        return;
    }
    if (artifact.startsWith('claude-md:')) {
        const rel = artifact.slice('claude-md:'.length);
        const filePath = join(projectRoot, rel);
        if (!existsSync(filePath))
            return;
        const reference = `Installed skill: ${skillName} — load it when its capability is needed.`;
        const body = readFileSync(filePath, 'utf8');
        if (!body.includes(reference))
            return;
        const updated = body
            .split('\n')
            .filter((line) => line !== reference)
            .join('\n');
        writeFileSync(filePath, updated);
    }
}
export function cheatcodeTools(db) {
    const definitions = [
        {
            name: 'cheatcode_search',
            description: 'Discover + deterministically rank Claude Code cheatcodes (skills, MCP toolkits, plugins) for a capability the project lacks. Forks scripts/cheatcode-search.sh (query tiered registries, rank by tier + relevance, no LLM), records a cheatcode_search audit row, returns ranked candidates.',
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
            description: 'Gather reputation + security-surface signals for ONE cheatcode candidate and emit a deterministic trust_tier (trusted|caution|untrusted|unknown) + rationale + capabilities[]. Forks scripts/cheatcode-vet.sh, records a cheatcode_vet audit row. The tier is a reproducible classification, NOT an install verdict (that stays bro + Human).',
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
            description: 'Record the human approval for installing ONE cheatcode. Writes a cheatcode_approved audit row keyed by source_url; the PreToolUse install gate fails closed until it exists. Per-candidate, per-session — the human decision, not bro self-authorizing.',
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
            description: 'Install ONE approved cheatcode via the marketplace path (no seeding). Forks scripts/cheatcode-install.sh, records the cheatcodes + attachment row(s) in one transaction, emits cheatcode_install + cheatcode_installed audit rows. Installs in local (project) scope by default — pass scope=global for a user-wide install. Idempotent on (name, source_url). Blocked by a PreToolUse gate without a cheatcode_approve record. Pass target=<bro|swe|pr-reviewer|consultant> to materialize the consuming agent for a skill: it copies the global agent md into the PROJECT .claude/agents/<target>.md (if absent) and adds the skill to its skills: frontmatter (target=bro materializes the project .claude/CLAUDE.md instead). Materialization writes the user project, never the plugin repo. A skill install REQUIRES a target — without one it is hard-rejected (an unattached skill is an orphan no agent loads); mcp/plugin installs need no target (their registration is the binding).',
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
                    scope: {
                        type: 'string',
                        enum: ['local', 'global'],
                        description: 'Install scope. local (default) = project-scoped, so no global/local prompt; global = user-wide. Forwarded to the install script and persisted on the cheatcodes row.',
                    },
                    target: {
                        type: 'string',
                        description: 'The consuming agent to materialize for a skill: bro | swe | pr-reviewer | a consultant name. For a non-bro target the install copies the global agent md into the PROJECT .claude/agents/<target>.md (if absent) and adds the skill to its skills: frontmatter; target=bro materializes the project .claude/CLAUDE.md. Idempotent; writes the user project only. Omit to skip materialization.',
                    },
                },
                required: ['agent', 'candidate'],
            },
        },
        {
            name: 'cheatcode_uninstall',
            description: 'Uninstall ONE installed cheatcode by cheatcode_id. Reverses the install in one transaction: forks scripts/cheatcode-uninstall.sh to reverse each attachment via the marketplace/plugin uninstall path (no manual file deletion), deletes the cheatcodes + cheatcode_attachments rows, emits a cheatcode_uninstalled audit row. Idempotent — an absent or partial install no-ops without error. Bro-proposed + Human-confirmed (AskUserQuestion), not PreToolUse-gated.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    cheatcode_id: {
                        type: 'number',
                        description: 'The id of the cheatcodes row to tear down (from cheatcode_install).',
                    },
                },
                required: ['agent', 'cheatcode_id'],
            },
        },
        {
            name: 'cheatcode_activate',
            description: 'Hot-load ONE installed cheatcode by cheatcode_id and return a deterministic activation verdict. Skill-kind attachments are usable in-session (activated); plugin/MCP kinds load on the next claude -p cold start, so they return restart_required + a reason (docs/architecture/CHEATCODES.md §Hot-load #660). Never throws on a known install; an unknown cheatcode_id is an error.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    cheatcode_id: {
                        type: 'number',
                        description: 'The id of the cheatcodes row to activate (from cheatcode_install).',
                    },
                },
                required: ['agent', 'cheatcode_id'],
            },
        },
        {
            name: 'cheatcode_list',
            description: 'Read-only inspect of the installed cheatcode registry (the cheatcodes table) — every builtin + installed capability the project knows about, ordered by id. Returns id, name, kind, origin, source_url, version, trust_tier, scope, status, description per row. This is the inspect surface for "do the cheatcodes work / which cheatcodes are installed", distinct from the discovery pipeline (cheatcode_search → vet → install). Optionally filter by kind or status.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    kind: {
                        type: 'string',
                        enum: ['skill', 'mcp', 'plugin'],
                        description: 'Filter to one cheatcode kind. Omit for all kinds.',
                    },
                    status: {
                        type: 'string',
                        enum: ['installed', 'active', 'broken'],
                        description: 'Filter to one lifecycle status. Omit for all statuses.',
                    },
                },
                required: ['agent'],
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
                `Cheatcode search: '${query}' (kind=${kind}) → ${out.candidates.length} ranked candidate(s)`,
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
        cheatcode_vet: requireRoles('cheatcode_vet', ['bro'], wrap(async (args) => {
            const raw = args['candidate'];
            if (!raw || typeof raw !== 'object')
                return err('candidate is required');
            const name = raw['name']?.trim();
            const sourceUrl = raw['source_url']?.trim();
            if (!name)
                return err('candidate.name is required');
            if (!sourceUrl)
                return err('candidate.source_url is required');
            const rawKind = raw['kind'] ?? 'any';
            const kind = VALID_KINDS.has(rawKind)
                ? rawKind
                : 'any';
            const tierVal = raw['tier'];
            const candidate = {
                name,
                kind,
                source_url: sourceUrl,
            };
            if (typeof tierVal === 'number')
                candidate.tier = tierVal;
            const out = await runVetWithScript(resolveVetScript(), candidate, VET_TIMEOUT_MS);
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'cheatcode_vet', ?, ?, ?)`, [
                `Cheatcode vet: '${name}' (kind=${kind}) → trust_tier=${out.trust_tier}`,
                JSON.stringify({
                    candidate: out.candidate,
                    trust_tier: out.trust_tier,
                    capabilities: out.capabilities,
                    rationale: out.rationale,
                }),
                nowISO(),
            ]);
            return ok(out);
        })),
        cheatcode_approve: requireRoles('cheatcode_approve', ['bro'], wrap(async (args) => {
            const parsed = parseInstallCandidate(args['candidate']);
            if ('error' in parsed)
                return err(parsed.error);
            const { name, kind, sourceUrl } = parsed;
            db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
           VALUES (-1, NULL, 'bro', 'cheatcode_approved', ?, ?, ?)`, [
                `Cheatcode approved for install: '${name}' (kind=${kind})`,
                JSON.stringify({ name, kind, source_url: sourceUrl }),
                nowISO(),
            ]);
            return ok({ approved: true, candidate: { name, kind, source_url: sourceUrl } });
        })),
        cheatcode_install: requireRoles('cheatcode_install', ['bro'], wrap(async (args) => {
            const parsed = parseInstallCandidate(args['candidate']);
            if ('error' in parsed)
                return err(parsed.error);
            const { name, kind, sourceUrl, tier } = parsed;
            const trustTier = args['trust_tier']?.trim() ?? null;
            // Default local so bro never hits a global/local AskUserQuestion.
            const rawScope = args['scope']?.trim();
            const scope = rawScope === 'global' ? 'global' : 'local';
            // Optional consuming agent to materialize the prompt surface for.
            const target = args['target']?.trim() || null;
            // Orphan guard: a skill must attach to ≥1 agent to be reachable. Without
            // a target it would install unattached — an orphan no agent ever loads.
            // Hard-reject before any install runs so no orphan row is ever written.
            // mcp/plugin are exempt: their registration/script attachment IS the
            // binding, so a no-target install is still wired in.
            if (kind === 'skill' && !target) {
                return err("a skill install requires a target agent (bro|swe|pr-reviewer|consultant) so it attaches to ≥1 agent; an unattached skill is an orphan no agent loads. Resolve a target (infer by domain or AskUserQuestion) and re-call cheatcode_install with target=<agent>.");
            }
            // Idempotent re-install: the (name, source_url) pair is the candidate
            // identity. If it is already installed, no-op — never duplicate the row
            // or re-run the marketplace install.
            const existing = db.get(`SELECT * FROM cheatcodes WHERE name = ? AND source_url = ? LIMIT 1`, [name, sourceUrl]);
            if (existing) {
                const attachments = db.all(`SELECT target, artifact FROM cheatcode_attachments WHERE cheatcode_id = ? ORDER BY id`, [existing.id]);
                return ok({
                    installed: false,
                    idempotent: true,
                    cheatcode: existing,
                    attachments,
                });
            }
            const candidate = {
                name,
                kind,
                source_url: sourceUrl,
            };
            if (typeof tier === 'number')
                candidate.tier = tier;
            const out = await runInstallWithScript(resolveInstallScript(), candidate, scope, INSTALL_TIMEOUT_MS);
            // No-phantom-row guard (#148): a plugin/mcp install that the marketplace
            // path could not complete (installed=false WITH an error note) leaves
            // nothing wired — recording a cheatcodes row would be a phantom the
            // registry then reports as present. Roll back: skip the row, surface the
            // failure. A skill install legitimately reports installed=false (its
            // surface is the proposed PR, not a marketplace install), so it is exempt.
            if (kind !== 'skill' && out.installed === false && out.error) {
                return err(`cheatcode install failed for '${name}' (${kind}): ${out.error}. No row recorded.`);
            }
            // The unified cheatcodes table (#101) carries the placement enum
            // (global|template|project-local); the install scope's local maps to
            // project-local. The script keeps its own local|global vocabulary.
            const placementScope = scope === 'global' ? 'global' : 'project-local';
            // skill-kind installs land a SKILL.md under the project; the unified
            // CHECK requires every skill row to record its file_path (#101). The
            // canonical project-local skill location is the proposed-PR target.
            // mcp/plugin kinds keep file_path NULL.
            const filePath = kind === 'skill' ? `.claude/skills/${name}/SKILL.md` : null;
            // A non-empty description keeps installed rows legible in cheatcode_list
            // (#111) — the registry default is '' which reads as a blank row. Derive
            // it from the candidate name + kind, enriched with the trust_tier when
            // vetting recorded one.
            const description = trustTier
                ? `${kind} cheatcode '${name}' (installed, vetted ${trustTier})`
                : `${kind} cheatcode '${name}' (installed)`;
            // When a target is named for a skill OR a plugin, materialize the
            // consuming agent's prompt surface in the USER PROJECT's .claude/ (copy
            // global agent md → local + skills: entry, or bro's CLAUDE.md) — never
            // the plugin repo. A plugin installed FOR an agent contributes its
            // cheatcode name to that agent's skills: header, same as a skill.
            // The written path becomes an attachment row + is surfaced in the result.
            const materialized = target && (kind === 'skill' || kind === 'plugin')
                ? materializeConsumingAgent(db.dbPath, target, name)
                : null;
            // Provenance, derived from the source (#152): a marketplace ref →
            // 'marketplace'; a raw external repo URL → 'external'. Never a lifecycle
            // word — the install lifecycle lives in `status`.
            const origin = deriveOrigin(sourceUrl);
            // One transaction: the cheatcodes row + every attachment row + both
            // audit rows land together or not at all.
            const installedAt = nowISO();
            const cheatcodeId = db.transaction(() => {
                const res = db.run(`INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, version, trust_tier, scope, status, installed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?)`, [name, kind, origin, description, sourceUrl, filePath, out.version, trustTier, placementScope, installedAt]);
                const id = Number(res.lastInsertRowid);
                for (const att of out.attachments) {
                    db.run(`INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
               VALUES (?, ?, ?, ?)`, [id, att.target, att.artifact, installedAt]);
                }
                // The materialized prompt surface is its own attachment row, keyed by
                // the consuming agent + the written artifact (agent-md / claude-md).
                if (materialized) {
                    db.run(`INSERT INTO cheatcode_attachments (cheatcode_id, target, artifact, created_at)
               VALUES (?, ?, ?, ?)`, [id, materialized.target, materialized.artifact, installedAt]);
                }
                db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'cheatcode_install', ?, ?, ?)`, [
                    `Cheatcode install: '${name}' (kind=${kind}, method=${out.method})`,
                    JSON.stringify({ name, kind, source_url: sourceUrl, method: out.method }),
                    installedAt,
                ]);
                db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'cheatcode_installed', ?, ?, ?)`, [
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
                ]);
                return id;
            });
            return ok({
                installed: out.installed,
                cheatcode_id: cheatcodeId,
                candidate: out.candidate,
                method: out.method,
                version: out.version,
                scope: placementScope,
                attachments: out.attachments,
                // When a target was named, the materialized prompt-surface path (the
                // .claude/agents/<target>.md or .claude/CLAUDE.md written in the user
                // project). null when no target, or when the surface couldn't resolve.
                materialized: materialized
                    ? { target: materialized.target, artifact: materialized.artifact, path: materialized.path }
                    : null,
                // Skill installs carry the install script's proposed agent-frontmatter
                // PR payload alongside the materialized surface — the canonical
                // upstream contribution, distinct from the project-local materialize.
                proposed_pr: out.proposed_pr,
                error: out.error,
            });
        })),
        cheatcode_uninstall: requireRoles('cheatcode_uninstall', ['bro'], wrap(async (args) => {
            const idVal = args['cheatcode_id'];
            if (typeof idVal !== 'number' || !Number.isInteger(idVal)) {
                return err('cheatcode_id is required (integer)');
            }
            // Idempotent: an absent install no-ops cleanly, never an error. The
            // attachment is a partial install that also tears down without a row.
            const existing = db.get(`SELECT * FROM cheatcodes WHERE id = ? LIMIT 1`, [idVal]);
            if (!existing) {
                return ok({ uninstalled: false, idempotent: true, cheatcode_id: idVal });
            }
            const attachments = db.all(`SELECT id, target, artifact FROM cheatcode_attachments WHERE cheatcode_id = ? ORDER BY id`, [existing.id]);
            // Reverse the attachment via the forked uninstall path (marketplace /
            // plugin uninstall — no manual file deletion). One spawn reverses the
            // candidate; the per-kind method mirrors the install attachment surface.
            const candidate = {
                name: existing.name,
                kind: existing.kind,
                source_url: existing.source_url ?? '',
            };
            const reversal = await runUninstallWithScript(resolveUninstallScript(), candidate, UNINSTALL_TIMEOUT_MS);
            // Honesty gate (#114): only delete the install + attachment rows when the
            // teardown actually removed the artifact. A failed teardown keeps the row,
            // flips status to 'broken' (orphaned install still on disk), and still
            // records the audit row — the tool reports uninstalled:false with the
            // error surfaced rather than lying about a clean removal.
            const uninstalledAt = nowISO();
            const auditContent = JSON.stringify({
                cheatcode_id: existing.id,
                name: existing.name,
                kind: existing.kind,
                source_url: existing.source_url,
                removed: reversal.removed,
                method: reversal.method,
                attachments,
                error: reversal.error,
            });
            const auditSummary = `Cheatcode uninstall: '${existing.name}' (kind=${existing.kind}, method=${reversal.method}, removed=${reversal.removed})`;
            // One transaction: row delete (or status flip) + audit row land together.
            db.transaction(() => {
                if (reversal.removed) {
                    // Reverse the Lego edit: de-materialize each prompt-surface
                    // attachment (remove the name from the consuming agent's skills:
                    // header / drop bro's CLAUDE.md reference line) before the row
                    // deletes. Fail-soft per attachment so a missing file never blocks
                    // the teardown. Skipped on the broken-flip path below (surface kept).
                    for (const att of attachments) {
                        if (att.artifact.startsWith('agent-md:') || att.artifact.startsWith('claude-md:')) {
                            dematerializeAttachment(db.dbPath, att.artifact, existing.name);
                        }
                    }
                    db.run(`DELETE FROM cheatcode_attachments WHERE cheatcode_id = ?`, [existing.id]);
                    db.run(`DELETE FROM cheatcodes WHERE id = ?`, [existing.id]);
                }
                else {
                    db.run(`UPDATE cheatcodes SET status = 'broken', updated_at = ? WHERE id = ?`, [
                        uninstalledAt,
                        existing.id,
                    ]);
                }
                db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'cheatcode_uninstalled', ?, ?, ?)`, [auditSummary, auditContent, uninstalledAt]);
            });
            return ok({
                uninstalled: reversal.removed,
                cheatcode_id: existing.id,
                name: existing.name,
                kind: existing.kind,
                method: reversal.method,
                removed: reversal.removed,
                attachments,
                error: reversal.error,
            });
        })),
        cheatcode_activate: requireRoles('cheatcode_activate', ['bro'], wrap(async (args) => {
            const idVal = args['cheatcode_id'];
            if (typeof idVal !== 'number' || !Number.isInteger(idVal)) {
                return err('cheatcode_id is required (integer)');
            }
            const existing = db.get(`SELECT * FROM cheatcodes WHERE id = ? LIMIT 1`, [idVal]);
            if (!existing)
                return err(`no cheatcode with id ${idVal}`);
            // Deterministic verdict by kind (docs/architecture/CHEATCODES.md
            // §Hot-load #660): a standalone skill is usable in-session; plugin /
            // MCP kinds register on the next claude -p cold start, so they need a
            // restart. Never throws on a known install.
            const restartReason = {
                plugin: 'plugin manifest (skills/hooks/commands) loads on the next claude -p cold start',
                mcp: 'MCP server registers on the next claude -p cold start',
            };
            const verdict = existing.kind === 'skill'
                ? { status: 'activated', reason: null }
                : { status: 'restart_required', reason: restartReason[existing.kind] };
            // Reconcile the row's lifecycle status (#151). A skill confirmed loaded
            // (activated) advances installed→active. plugin/MCP kinds stay 'installed'
            // until the next cold start picks them up — restart_required is not yet
            // active, so the row keeps its status. The row-status flip + the audit row
            // land in one transaction.
            const activatedAt = nowISO();
            const rowStatus = verdict.status === 'activated' ? 'active' : null;
            db.transaction(() => {
                if (rowStatus) {
                    db.run(`UPDATE cheatcodes SET status = ?, updated_at = ? WHERE id = ?`, [
                        rowStatus,
                        activatedAt,
                        existing.id,
                    ]);
                }
                db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (-1, NULL, 'bro', 'cheatcode_activate', ?, ?, ?)`, [
                    `Cheatcode activate: '${existing.name}' (kind=${existing.kind}) → ${verdict.status}`,
                    JSON.stringify({
                        cheatcode_id: existing.id,
                        name: existing.name,
                        kind: existing.kind,
                        status: verdict.status,
                        row_status: rowStatus ?? existing.status,
                        reason: verdict.reason,
                    }),
                    activatedAt,
                ]);
            });
            return ok({
                cheatcode_id: existing.id,
                name: existing.name,
                kind: existing.kind,
                status: verdict.status,
                row_status: rowStatus ?? existing.status,
                reason: verdict.reason,
            });
        })),
        cheatcode_list: requireRoles('cheatcode_list', ['bro'], wrap(async (args) => {
            const rawKind = args['kind']?.trim();
            const rawStatus = args['status']?.trim();
            const where = [];
            const params = [];
            if (rawKind) {
                where.push('kind = ?');
                params.push(rawKind);
            }
            if (rawStatus) {
                where.push('status = ?');
                params.push(rawStatus);
            }
            const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const rows = db.all(`SELECT id, name, kind, origin, source_url, version, trust_tier, scope, status, description
             FROM cheatcodes ${clause} ORDER BY id`, params);
            return ok({ cheatcodes: rows });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=cheatcode.js.map