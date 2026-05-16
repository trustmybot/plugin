import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { resolveDefaultRepoPath, resolveDefaultRepo } from '../utils/repo-paths.js';
function md5OfPath(absPath) {
    const buf = readFileSync(absPath);
    return createHash('md5').update(buf).digest('hex');
}
function md5OfBuffer(buf) {
    return createHash('md5').update(buf).digest('hex');
}
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function wrapHandler(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            const msg = e.message;
            const code = e.code;
            if (code === 'SQLITE_CONSTRAINT_CHECK' || code === 'SQLITE_CONSTRAINT') {
                return err(`DB constraint violation: ${msg}`);
            }
            return err(msg);
        }
    };
}
const VALID_TYPES = new Set(['source', 'test', 'config', 'doc', 'unknown']);
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
function validatePath(path) {
    if (typeof path !== 'string' || path.length === 0) {
        return 'path is required and must be a non-empty string';
    }
    if (path.length > 1024) {
        return 'path must be 1024 characters or fewer';
    }
    const segments = path.split('/');
    if (segments.includes('..')) {
        return 'path must not contain ".." path-traversal segments';
    }
    return null;
}
function decodeRow(row) {
    return {
        repo: row.repo,
        path: row.path,
        type: row.type,
        content_md5: row.content_md5,
        summary: row.summary,
        summary_updated_at: row.summary_updated_at,
    };
}
export function fileRegistryTools(db, dbPath = '') {
    function resolveProjectPath(path) {
        if (isAbsolute(path))
            return path;
        const projectRoot = resolveDefaultRepoPath(db, dbPath);
        if (projectRoot)
            return resolve(projectRoot, path);
        return resolve(process.cwd(), path);
    }
    const definitions = [
        {
            name: 'file_registry_upsert',
            description: 'INSERT OR REPLACE a file record in file_registry. Idempotent — calling twice with the same (repo, path) replaces the row.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path (primary key with repo). Max 1024 chars. No ".." segments.',
                    },
                    type: {
                        type: 'string',
                        description: 'One of: source | test | config | doc | unknown',
                    },
                    repo: {
                        type: 'string',
                        description: 'Repo name from repos table. Defaults to empty string (single-repo project).',
                    },
                },
                required: ['path', 'type'],
            },
        },
        {
            name: 'file_registry_list',
            description: 'SELECT from file_registry with optional filters. Returns { rows, count, total }.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        description: 'Filter by file type (source | test | config | doc | unknown)',
                    },
                    limit: {
                        type: 'number',
                        description: `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
                    },
                    offset: { type: 'number', description: 'Row offset for pagination (default 0)' },
                },
            },
        },
        {
            name: 'file_registry_delete',
            description: 'DELETE a file record by (repo, path). Returns { deleted: 0 } if not found, { deleted: 1 } on success.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to delete' },
                    repo: { type: 'string', description: 'Repo name (primary key with path). Defaults to empty string.' },
                },
                required: ['path', 'repo'],
            },
        },
        {
            name: 'file_registry_verify',
            description: 'Per-path drift check (#45): re-md5 each file from disk, compare against stored content_md5. Returns { verdicts: [{ repo, path, verdict, current_md5? }] } where verdict is "match" | "mismatch" | "missing" | "new". If `repo` is provided, only verifies rows for that repo. If `paths` is provided, also flags any registry rows whose path is NOT in the list as "missing" and any input path not in the registry as "new". If `paths` is absent, verifies every registry row (no "new" detection). Read-only; safe for any caller.',
            inputSchema: {
                type: 'object',
                properties: {
                    repo: {
                        type: 'string',
                        description: 'Optional: filter to a specific repo. When omitted, verifies all repos.',
                    },
                    paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional: project-relative paths to check (typically from `git ls-files`). When omitted, verifies every registry row.',
                    },
                },
            },
        },
        {
            name: 'file_registry_update_summaries',
            description: 'Atomic-close write path (#45): for each {path, summary, repo?}, read the file from disk, md5 it, INSERT OR REPLACE the row with content_md5 + summary + summary_updated_at = now. Optionally advance plugin_config.last_verified_sha so the next session can trust the index. Bro + SWE only.',
            inputSchema: {
                type: 'object',
                properties: {
                    updates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                summary: { type: 'string' },
                                repo: {
                                    type: 'string',
                                    description: 'Optional repo name from repos table. When omitted, server uses tmb_default_repo.',
                                },
                            },
                            required: ['path', 'summary'],
                        },
                        description: 'List of path + summary pairs (with optional per-update repo). Server reads each path from disk to compute md5.',
                    },
                    advance_verified_sha: {
                        type: 'string',
                        description: 'Optional: also UPSERT plugin_config.last_verified_sha to this git SHA (the HEAD at which the registry was made consistent).',
                    },
                },
                required: ['updates'],
            },
        },
    ];
    const handlers = {
        file_registry_upsert: requireRoles('file_registry_upsert', ['bro'], wrapHandler(async (args) => {
            const pathErr = validatePath(args['path']);
            if (pathErr)
                return err(pathErr);
            const path = args['path'];
            const type = args['type'];
            if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
                return err(`Invalid type ${JSON.stringify(type)}: must be one of source | test | config | doc | unknown`);
            }
            const repo = typeof args['repo'] === 'string' ? args['repo'] : '';
            db.run(`INSERT INTO file_registry (repo, path, type)
         VALUES (?, ?, ?)
         ON CONFLICT(repo, path) DO UPDATE SET type = excluded.type`, [repo, path, type]);
            const row = db.get(`SELECT * FROM file_registry WHERE repo = ? AND path = ?`, [repo, path]);
            return ok(decodeRow(row));
        })),
        file_registry_list: wrapHandler(async (args) => {
            const filterType = args['type'];
            if (filterType !== undefined && filterType !== null) {
                if (typeof filterType !== 'string' || !VALID_TYPES.has(filterType)) {
                    return err(`Invalid type filter ${JSON.stringify(filterType)}: must be one of source | test | config | doc | unknown`);
                }
            }
            let limit = DEFAULT_LIMIT;
            if (args['limit'] !== undefined && args['limit'] !== null) {
                const rawLimit = args['limit'];
                if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 0) {
                    return err('limit must be a non-negative integer');
                }
                limit = Math.min(rawLimit, MAX_LIMIT);
            }
            let offset = 0;
            if (args['offset'] !== undefined && args['offset'] !== null) {
                const rawOffset = args['offset'];
                if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0) {
                    return err('offset must be a non-negative integer');
                }
                offset = rawOffset;
            }
            const conditions = [];
            const params = [];
            if (filterType) {
                conditions.push('type = ?');
                params.push(filterType);
            }
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const totalRow = db.get(`SELECT COUNT(*) AS n FROM file_registry ${where}`, params);
            const total = totalRow?.n ?? 0;
            const rows = db.all(`SELECT * FROM file_registry ${where} ORDER BY path LIMIT ? OFFSET ?`, [...params, limit, offset]);
            return ok({
                rows: rows.map(decodeRow),
                count: rows.length,
                total,
            });
        }),
        file_registry_delete: requireRoles('file_registry_delete', ['bro'], wrapHandler(async (args) => {
            const pathErr = validatePath(args['path']);
            if (pathErr)
                return err(pathErr);
            const path = args['path'];
            const repo = typeof args['repo'] === 'string' ? args['repo'] : '';
            const result = db.run(`DELETE FROM file_registry WHERE repo = ? AND path = ?`, [repo, path]);
            return ok({ deleted: result.changes > 0 ? 1 : 0 });
        })),
        file_registry_verify: wrapHandler(async (args) => {
            const repoFilter = typeof args['repo'] === 'string' ? args['repo'] : null;
            const inputPaths = args['paths'];
            let pathFilter = null;
            if (inputPaths !== undefined && inputPaths !== null) {
                if (!Array.isArray(inputPaths) || inputPaths.some((p) => typeof p !== 'string')) {
                    return err('paths must be an array of strings');
                }
                for (const p of inputPaths) {
                    const e = validatePath(p);
                    if (e)
                        return err(`Invalid path ${JSON.stringify(p)}: ${e}`);
                }
                pathFilter = new Set(inputPaths);
            }
            const rows = repoFilter !== null
                ? db.all(`SELECT repo, path, content_md5 FROM file_registry WHERE repo = ?`, [repoFilter])
                : db.all(`SELECT repo, path, content_md5 FROM file_registry`);
            const registryPaths = new Set(rows.map((r) => r.path));
            const verdicts = [];
            for (const row of rows) {
                const abs = resolveProjectPath(row.path);
                if (!existsSync(abs)) {
                    verdicts.push({ repo: row.repo, path: row.path, verdict: 'missing' });
                    continue;
                }
                try {
                    const stat = statSync(abs);
                    if (!stat.isFile()) {
                        verdicts.push({ repo: row.repo, path: row.path, verdict: 'missing' });
                        continue;
                    }
                    const currentMd5 = md5OfPath(abs);
                    if (row.content_md5 === null) {
                        verdicts.push({ repo: row.repo, path: row.path, verdict: 'mismatch', current_md5: currentMd5 });
                    }
                    else if (currentMd5 === row.content_md5) {
                        verdicts.push({ repo: row.repo, path: row.path, verdict: 'match' });
                    }
                    else {
                        verdicts.push({ repo: row.repo, path: row.path, verdict: 'mismatch', current_md5: currentMd5 });
                    }
                }
                catch (e) {
                    verdicts.push({ repo: row.repo, path: row.path, verdict: 'missing' });
                }
            }
            if (pathFilter !== null) {
                for (const p of pathFilter) {
                    if (!registryPaths.has(p)) {
                        const repo = repoFilter ?? '';
                        verdicts.push({ repo, path: p, verdict: 'new' });
                    }
                }
            }
            return ok({ verdicts, count: verdicts.length });
        }),
        file_registry_update_summaries: requireRoles('file_registry_update_summaries', ['bro'], wrapHandler(async (args) => {
            const updates = args['updates'];
            if (!Array.isArray(updates) || updates.length === 0) {
                return err('updates must be a non-empty array of { path, summary }');
            }
            for (const u of updates) {
                if (typeof u !== 'object' || u === null) {
                    return err('each update must be an object with { path, summary }');
                }
                const update = u;
                const pathErr = validatePath(update.path);
                if (pathErr)
                    return err(pathErr);
                if (typeof update.summary !== 'string') {
                    return err('each update.summary must be a string');
                }
                if (update.summary.trim().length === 0) {
                    return err('each update.summary must be a non-empty 1–2 line description (got empty / whitespace-only)');
                }
                if (update.repo !== undefined && update.repo !== null) {
                    if (typeof update.repo !== 'string' || update.repo.length === 0) {
                        return err('each update.repo must be a non-empty string when provided');
                    }
                    if (update.repo.length > 128) {
                        return err('each update.repo must be 128 characters or fewer');
                    }
                    if (update.repo.includes('..') || update.repo.includes('/')) {
                        return err('each update.repo must not contain ".." or "/" characters');
                    }
                }
            }
            const advance = args['advance_verified_sha'];
            if (advance !== undefined && advance !== null && typeof advance !== 'string') {
                return err('advance_verified_sha must be a string SHA');
            }
            const now = nowISO();
            let updated = 0;
            const errors = [];
            const commitSha = typeof advance === 'string' && advance.length > 0 ? advance : null;
            for (const u of updates) {
                const explicitRepo = typeof u.repo === 'string' && u.repo.length > 0 ? u.repo : null;
                let resolvedRepoName = null;
                let repoRoot = null;
                if (explicitRepo !== null) {
                    const repoRow = db.get(`SELECT path FROM repos WHERE name = ?`, [explicitRepo]);
                    if (!repoRow?.path) {
                        errors.push({
                            path: u.path,
                            error: `repo '${explicitRepo}' not found in repos table — run /scan to populate`,
                        });
                        continue;
                    }
                    resolvedRepoName = explicitRepo;
                    repoRoot = repoRow.path;
                }
                else {
                    const defaultRepo = resolveDefaultRepo(db, dbPath);
                    if (defaultRepo) {
                        resolvedRepoName = defaultRepo.name;
                        repoRoot = defaultRepo.path;
                    }
                    else if (!dbPath) {
                        resolvedRepoName = '';
                        repoRoot = process.cwd();
                    }
                    else {
                        errors.push({
                            path: u.path,
                            error: 'no repo specified and tmb_default_repo not set — pass repo or run /scan first',
                        });
                        continue;
                    }
                }
                const abs = isAbsolute(u.path) ? u.path : resolve(repoRoot, u.path);
                let md5 = null;
                // Try the resolved repo disk path first (cheap; covers the steady
                // state where the file has merged back to main).
                if (existsSync(abs)) {
                    try {
                        md5 = md5OfPath(abs);
                    }
                    catch {
                        // fall through to git-show below
                    }
                }
                // Fallback for worktree-only files (bro is updating from a SWE
                // commit whose changes live in .claude/worktrees/<slug>/, not at
                // the project root). Read the committed content via `git show`.
                if (md5 === null && commitSha !== null) {
                    const buf = (() => {
                        try {
                            return execFileSync('git', ['show', `${commitSha}:${u.path}`], {
                                cwd: repoRoot,
                                stdio: ['ignore', 'pipe', 'ignore'],
                                maxBuffer: 64 * 1024 * 1024,
                            });
                        }
                        catch {
                            return null;
                        }
                    })();
                    if (buf !== null)
                        md5 = md5OfBuffer(buf);
                }
                if (md5 === null) {
                    errors.push({
                        path: u.path,
                        error: commitSha
                            ? `file not found on disk and not in commit ${commitSha}`
                            : 'file not found on disk (pass advance_verified_sha to read from a git commit)',
                    });
                    continue;
                }
                db.run(`INSERT INTO file_registry (repo, path, type, content_md5, summary, summary_updated_at)
             VALUES (?, ?, 'unknown', ?, ?, ?)
             ON CONFLICT(repo, path) DO UPDATE SET
               content_md5        = excluded.content_md5,
               summary            = excluded.summary,
               summary_updated_at = excluded.summary_updated_at`, [resolvedRepoName, u.path, md5, u.summary, now]);
                updated += 1;
            }
            if (typeof advance === 'string' && advance.length > 0) {
                db.run(`INSERT INTO plugin_config (key, value_json)
             VALUES ('last_verified_sha', ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, [JSON.stringify(advance)]);
            }
            return ok({ updated, errors, advance_verified_sha: typeof advance === 'string' ? advance : null });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=file-registry.js.map