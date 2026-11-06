// /onboard pre-scan (GH 1575): offline, git-only evidence about every `repos`
// row and a branching recommendation derived from it. onboard_state_get runs
// scanWorkspace on every call and persists each result in repos.onboard_scan.
// Never spawns gh/glab: merged-PR targets are approximated by first-parent
// merge commits on each candidate branch.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { remoteProvider, repoRemotes } from '../repos/remotes.js';
import { repoRowPath } from '../utils/repo-paths.js';
const GIT_TIMEOUT_MS = 3000;
const MAX_GIT_CALLS = 6;
const MERGE_WINDOW = 50;
const MAIN_TYPE = ['main', 'master', 'trunk'];
const DEV_TYPE = ['dev', 'develop'];
const LONG_LIVED = ['main', 'master', 'dev', 'develop', 'trunk'];
const CONTRIBUTING_PATHS = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];
function gitRunner(cwd) {
    let calls = 0;
    return (args) => {
        if (calls >= MAX_GIT_CALLS)
            return { ok: false, note: 'git call budget spent' };
        calls++;
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
        if (r.error) {
            const code = r.error.code;
            return { ok: false, note: code === 'ETIMEDOUT' ? 'git timed out' : `git unavailable (${code ?? r.error.message})` };
        }
        if (r.signal)
            return { ok: false, note: 'git timed out' };
        if (r.status !== 0)
            return { ok: false, note: 'not a git work tree' };
        return { ok: true, stdout: r.stdout ?? '' };
    };
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function hasWorkflows(repoPath) {
    try {
        return readdirSync(join(repoPath, '.github', 'workflows')).some((f) => /\.ya?ml$/.test(f));
    }
    catch {
        return false;
    }
}
function ciFiles(repoPath) {
    const found = [];
    if (hasWorkflows(repoPath))
        found.push('.github/workflows');
    if (existsSync(join(repoPath, '.gitlab-ci.yml')))
        found.push('.gitlab-ci.yml');
    return found;
}
function parseRemotes(stdout) {
    const remotes = [];
    for (const line of stdout.split('\n')) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
        if (!m || remotes.some((r) => r.name === m[1]))
            continue;
        remotes.push({ name: m[1], host: remoteProvider(m[2]) });
    }
    return remotes;
}
function pick(types, longLived, originHead) {
    if (originHead && types.includes(originHead) && longLived.includes(originHead))
        return originHead;
    return types.find((b) => longLived.includes(b)) ?? null;
}
export function scanRepoEvidence(repoPath, opts = {}) {
    const started = Date.now();
    const evidence = {
        name: opts.name ?? basename(repoPath),
        path: repoPath,
        in_git: false,
        branches: [],
        long_lived: [],
        origin_head: null,
        remotes: opts.remotes ?? [],
        merges: {},
        ci_files: [],
        contributing: false,
        scanned_at: new Date(started).toISOString(),
        elapsed_ms: 0,
    };
    const done = () => ({ ...evidence, elapsed_ms: Date.now() - started });
    if (!isDirectory(repoPath)) {
        evidence.note = 'path is not a directory';
        return done();
    }
    const git = gitRunner(repoPath);
    const top = git(['rev-parse', '--show-toplevel']);
    if (!top.ok) {
        evidence.note = top.note;
        return done();
    }
    evidence.in_git = true;
    const originBranches = new Set();
    const refs = git(['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/heads', 'refs/remotes/origin']);
    if (refs.ok) {
        const branches = new Set();
        for (const line of refs.stdout.split('\n')) {
            const [ref, symref] = line.split('\t');
            if (!ref)
                continue;
            if (ref === 'refs/remotes/origin/HEAD') {
                evidence.origin_head = symref?.startsWith('refs/remotes/origin/') ? symref.slice('refs/remotes/origin/'.length) : null;
            }
            else if (ref.startsWith('refs/heads/')) {
                branches.add(ref.slice('refs/heads/'.length));
            }
            else if (ref.startsWith('refs/remotes/origin/')) {
                const short = ref.slice('refs/remotes/origin/'.length);
                originBranches.add(short);
                branches.add(short);
            }
        }
        evidence.branches = [...branches];
    }
    evidence.long_lived = LONG_LIVED.filter((b) => evidence.branches.includes(b));
    if (evidence.remotes.length === 0) {
        const remotes = git(['remote', '-v']);
        if (remotes.ok)
            evidence.remotes = parseRemotes(remotes.stdout);
    }
    const dev = pick(DEV_TYPE, evidence.long_lived, evidence.origin_head);
    const main = pick(MAIN_TYPE, evidence.long_lived, evidence.origin_head);
    const candidates = [...new Set([dev, main, ...evidence.long_lived].filter((b) => b !== null))];
    for (const branch of candidates) {
        const ref = originBranches.has(branch) ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`;
        const log = git(['log', '--first-parent', '--merges', '-n', String(MERGE_WINDOW), '--format=%H', ref]);
        if (!log.ok)
            continue;
        evidence.merges[branch] = log.stdout.split('\n').filter((l) => l.trim() !== '').length;
    }
    evidence.ci_files = ciFiles(repoPath);
    evidence.contributing = CONTRIBUTING_PATHS.some((p) => existsSync(join(repoPath, p)));
    return done();
}
function contextLines(e) {
    const lines = [];
    if (e.origin_head)
        lines.push(`origin/HEAD is ${e.origin_head}`);
    if (e.contributing)
        lines.push('CONTRIBUTING.md present');
    if (e.ci_files.length > 0)
        lines.push(`CI: ${e.ci_files.join(', ')}`);
    return lines;
}
export function recommendFromEvidence(e) {
    if (!e.in_git)
        return null;
    const context = contextLines(e);
    if (e.long_lived.length === 0) {
        return {
            branching_model: null,
            pr_target: null,
            confidence: 'none',
            reason: 'no long-lived branch',
            evidence: ['no main, master, dev, develop or trunk branch', ...context],
        };
    }
    if (e.long_lived.length === 1) {
        const branch = e.long_lived[0];
        const merges = e.merges[branch];
        return {
            branching_model: 'github-flow',
            pr_target: branch,
            confidence: 'high',
            reason: 'only one long-lived branch',
            evidence: [
                `only long-lived branch: ${branch}`,
                ...(merges === undefined ? [] : [`${merges} merges into ${branch}`]),
                ...context,
            ],
        };
    }
    const dev = pick(DEV_TYPE, e.long_lived, e.origin_head);
    const main = pick(MAIN_TYPE, e.long_lived, e.origin_head);
    if (dev && main) {
        const d = e.merges[dev] ?? 0;
        const m = e.merges[main] ?? 0;
        const evidence = [`${d} merges into ${dev}, ${m} into ${main}`, ...context];
        if (d >= 2 * m && d >= 3) {
            return { branching_model: 'gitflow', pr_target: dev, confidence: 'high', reason: `merges favour ${dev}: ${d} vs ${m} into ${main}`, evidence };
        }
        if (m >= 2 * d && m >= 3) {
            return { branching_model: 'github-flow', pr_target: main, confidence: 'high', reason: `merges favour ${main}: ${m} vs ${d} into ${dev}`, evidence };
        }
        const target = e.origin_head === dev || e.origin_head === main ? e.origin_head : dev;
        return {
            branching_model: target === dev ? 'gitflow' : 'github-flow',
            pr_target: target,
            confidence: 'low',
            reason: `merges split ${d}/${m}, no clear pattern`,
            evidence,
        };
    }
    const target = e.origin_head && e.long_lived.includes(e.origin_head) ? e.origin_head : e.long_lived[0];
    return {
        branching_model: 'github-flow',
        pr_target: target,
        confidence: 'low',
        reason: `${e.long_lived.length} long-lived branches, no main and dev pair`,
        evidence: [`long-lived branches: ${e.long_lived.join(', ')}`, ...context],
    };
}
export function scanWorkspace(db) {
    const started = Date.now();
    const rows = db.all('SELECT name, path FROM repos ORDER BY name');
    const repos = rows.map((row) => {
        const remotes = repoRemotes(db, row.name).map((r) => ({ name: r.name, host: r.provider }));
        const evidence = scanRepoEvidence(repoRowPath(db, row.path), { name: row.name, remotes });
        return { ...evidence, recommendation: recommendFromEvidence(evidence) };
    });
    db.transaction(() => {
        for (const repo of repos) {
            db.run('UPDATE repos SET onboard_scan = ? WHERE name = ?', [JSON.stringify(repo), repo.name]);
        }
    });
    const recommended = repos.map((r) => r.recommendation).filter((r) => r !== null);
    const first = recommended[0];
    const uniform = first !== undefined &&
        recommended.every((r) => r.confidence === 'high' && r.branching_model === first.branching_model && r.pr_target === first.pr_target);
    return {
        repos,
        summary: {
            repo_count: repos.length,
            hosts: [...new Set(repos.flatMap((r) => r.remotes.map((x) => x.host)))].sort(),
            with_dev_branch: repos.filter((r) => r.long_lived.some((b) => DEV_TYPE.includes(b))).length,
            main_only: repos.filter((r) => r.long_lived.length > 0 && r.long_lived.every((b) => MAIN_TYPE.includes(b))).length,
            uniform,
            elapsed_ms: Date.now() - started,
        },
    };
}
//# sourceMappingURL=onboard-scan.js.map