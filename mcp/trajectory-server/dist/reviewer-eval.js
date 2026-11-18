/**
 * The code-reviewer eval (GH 1955 item e): first-pass rate, mean cycles to
 * pass, wontfix rate, escaped bugs and known-clean tasks, overall and per
 * reviewer arm (model, effort). Escaped bugs come from an SZZ trace
 * (Sliwerski, Zimmermann and Zeller, MSR 2005): each in-scope Bug issue's fix
 * commits on the base are diffed against their parent, the removed or changed
 * code lines are blamed, and the GH numbers in the blamed commits' subjects
 * map to the passed tasks of those issues whose files[] cover the blamed path
 * and that completed by the blamed commit's committer date. Bugs and traced
 * tasks are limited to one repo. Read-only:
 * scripts/maintenance/reviewer-eval.ts runs it on a DB opened read-only.
 */
import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
export class GitError extends Error {
}
export function gitRunner(cwd) {
    return (args) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        if (r.error)
            throw new GitError(`git ${args[0]}: ${r.error.message}`);
        if (r.status !== 0)
            throw new GitError(`git ${args.join(' ')}: ${r.stderr.trim()}`);
        return r.stdout;
    };
}
const GH_REF_RE = /(?:GH ?|#)(\d+)(?!\d)/g;
export function ghRefs(subject) {
    return [...new Set([...subject.matchAll(GH_REF_RE)].map((m) => Number(m[1])))];
}
const SKIP_PATH_RE = /(\.md$|\/test\/|^test\/|tests\/|\.test\.|(^|\/)dist\/|(^|\/)changelog\.d\/)/;
export function isBlamedPath(path) {
    return !SKIP_PATH_RE.test(path);
}
export function removedRanges(diff) {
    const out = [];
    let path = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('--- ')) {
            path = line === '--- /dev/null' ? null : line.slice(4).replace(/^a\//, '');
            continue;
        }
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
        if (!hunk || path === null || !isBlamedPath(path))
            continue;
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        if (count > 0)
            out.push({ path, start: Number(hunk[1]), count });
    }
    return out;
}
const BLAME_HEADER_RE = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/;
export function parseBlame(porcelain) {
    const meta = new Map();
    const out = new Map();
    let sha = null;
    let path = null;
    for (const line of porcelain.split('\n')) {
        const header = BLAME_HEADER_RE.exec(line);
        if (header) {
            sha = header[1];
            path = null;
            if (!meta.has(sha))
                meta.set(sha, { time: 0, subject: '', path: '' });
            continue;
        }
        if (sha === null)
            continue;
        const m = meta.get(sha);
        if (line.startsWith('\t')) {
            const p = path ?? m.path;
            const key = `${sha}\u0000${p}`;
            if (!out.has(key))
                out.set(key, { path: p, committer_time: m.time, refs: ghRefs(m.subject) });
            sha = null;
        }
        else if (line.startsWith('committer-time ')) {
            m.time = Number(line.slice('committer-time '.length));
        }
        else if (line.startsWith('summary ')) {
            m.subject = line.slice('summary '.length);
        }
        else if (line.startsWith('filename ')) {
            path = line.slice('filename '.length);
            m.path = path;
        }
    }
    return [...out.values()];
}
function traceFix(git, sha) {
    const diff = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--unified=0', `${sha}^`, sha]);
    const byPath = new Map();
    for (const r of removedRanges(diff))
        byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
    const blamed = [];
    for (const [path, ranges] of byPath) {
        const args = ['blame', '-w', '--porcelain'];
        for (const r of ranges)
            args.push('-L', `${r.start},${r.start + r.count - 1}`);
        blamed.push(...parseBlame(git([...args, `${sha}^`, '--', path])));
    }
    return blamed;
}
export function filesCover(entries, path) {
    return entries.some((entry) => {
        const dir = entry.replace(/\/+$/, '');
        return dir !== '' && (path === dir || path.startsWith(`${dir}/`));
    });
}
function parseFiles(json) {
    try {
        const v = JSON.parse(json ?? '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    }
    catch {
        return [];
    }
}
export function defaultRepoName(git) {
    return basename(dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()));
}
function hasColumn(db, table, column) {
    return (db.get(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`, [table, column])?.n ?? 0) > 0;
}
function mean(xs) {
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}
export function reviewerEval(db, git, opts) {
    const reviewed = db.all(`SELECT va.task_id,
            (SELECT verdict FROM validation_attempts f WHERE f.task_id = va.task_id ORDER BY attempt_n ASC LIMIT 1) AS first_verdict,
            MIN(CASE WHEN va.verdict = 'pass' THEN va.attempt_n END) AS cycles
       FROM validation_attempts va
      GROUP BY va.task_id ORDER BY va.task_id`);
    const arms = new Map();
    for (const r of db.all(`SELECT ar.task_id, ar.model, ar.effort FROM agent_runs ar
      WHERE ar.agent_type LIKE '%code-reviewer' AND ar.task_id IS NOT NULL
        AND ar.id = (SELECT id FROM agent_runs x WHERE x.task_id = ar.task_id AND x.agent_type LIKE '%code-reviewer'
                      ORDER BY x.started_at ASC, x.id ASC LIMIT 1)`)) {
        arms.set(r.task_id, { model: r.model ?? 'unset', effort: r.effort ?? 'unset' });
    }
    const passedTasksByIssue = new Map();
    for (const r of db.all(`SELECT t.id, t.issue_id, t.files, (julianday(t.completed_at) - 2440587.5) * 86400.0 AS completed_s
       FROM tasks t
      WHERE t.repo = ? AND julianday(t.completed_at) IS NOT NULL
        AND EXISTS (SELECT 1 FROM validation_attempts va WHERE va.task_id = t.id AND va.verdict = 'pass')
      ORDER BY t.id`, [opts.repoName])) {
        const files = parseFiles(r.files);
        if (files.length === 0)
            continue;
        passedTasksByIssue.set(r.issue_id, [...(passedTasksByIssue.get(r.issue_id) ?? []), { id: r.id, files, completed_s: r.completed_s }]);
    }
    const issueByIid = new Map();
    for (const r of db.all(`SELECT id, gh_iid FROM issues WHERE gh_iid IS NOT NULL AND repo = ?`, [opts.repoName])) {
        issueByIid.set(r.gh_iid, [...(issueByIid.get(r.gh_iid) ?? []), r.id]);
    }
    const bugs = db.all(`SELECT id, gh_iid FROM issues
      WHERE gh_iid IS NOT NULL AND repo = ? AND json_valid(labels)
        AND EXISTS (SELECT 1 FROM json_each(issues.labels) WHERE value = 'Bug')
        AND julianday(created_at) > (SELECT julianday(MIN(created_at)) FROM validation_attempts)
      ORDER BY gh_iid`, [opts.repoName]);
    const fixesByIid = new Map();
    if (bugs.length > 0) {
        const wanted = new Set(bugs.map((b) => b.gh_iid));
        for (const line of git(['log', '--no-color', '--format=%H%x09%s', opts.base]).split('\n')) {
            const tab = line.indexOf('\t');
            if (tab < 0)
                continue;
            const sha = line.slice(0, tab);
            for (const n of ghRefs(line.slice(tab + 1))) {
                if (wanted.has(n))
                    fixesByIid.set(n, [...(fixesByIid.get(n) ?? []), sha]);
            }
        }
    }
    const traceCache = new Map();
    const escaped = [];
    const tracedTasks = new Set();
    let untraced = 0;
    for (const bug of bugs) {
        const fixes = fixesByIid.get(bug.gh_iid);
        if (!fixes)
            continue;
        const taskIds = new Set();
        for (const sha of fixes) {
            let blamed = traceCache.get(sha);
            if (!blamed) {
                blamed = traceFix(git, sha);
                traceCache.set(sha, blamed);
            }
            for (const line of blamed) {
                for (const n of line.refs) {
                    for (const issueId of issueByIid.get(n) ?? []) {
                        if (issueId === bug.id)
                            continue;
                        for (const t of passedTasksByIssue.get(issueId) ?? []) {
                            if (t.completed_s <= line.committer_time && filesCover(t.files, line.path))
                                taskIds.add(t.id);
                        }
                    }
                }
            }
        }
        if (taskIds.size === 0)
            untraced++;
        else {
            const ids = [...taskIds].sort((a, b) => a - b);
            escaped.push({ gh_iid: bug.gh_iid, task_ids: ids });
            for (const t of ids)
                tracedTasks.add(t);
        }
    }
    const findings = db.get(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'wontfix'), 0) AS wontfix FROM review_findings`) ?? { total: 0, wontfix: 0 };
    let severity = null;
    if (hasColumn(db, 'review_findings', 'severity')) {
        severity = { blocking: 0, nit: 0, pre_existing: 0 };
        for (const r of db.all(`SELECT severity, COUNT(*) AS n FROM review_findings GROUP BY severity`)) {
            severity[r.severity ?? 'unset'] = r.n;
        }
    }
    const firstPass = reviewed.filter((r) => r.first_verdict === 'pass');
    const armMap = new Map();
    for (const r of reviewed) {
        const arm = arms.get(r.task_id) ?? { model: 'unset', effort: 'unset' };
        const key = `${arm.model}\u0000${arm.effort}`;
        const entry = armMap.get(key) ?? { ...arm, rows: [] };
        entry.rows.push(r);
        armMap.set(key, entry);
    }
    return {
        reviewed_tasks: reviewed.length,
        first_pass: firstPass.length,
        first_pass_pct: reviewed.length === 0 ? 0 : (100 * firstPass.length) / reviewed.length,
        cycles_to_pass_mean: mean(reviewed.flatMap((r) => (r.cycles === null ? [] : [r.cycles]))),
        findings_total: findings.total,
        findings_wontfix: findings.wontfix,
        severity,
        escaped_bugs: escaped.length,
        traced_tasks: tracedTasks.size,
        untraced_bugs: untraced,
        known_clean: firstPass.filter((r) => !tracedTasks.has(r.task_id)).length,
        escaped,
        arms: [...armMap.values()]
            .sort((a, b) => a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort))
            .map((a) => ({
            model: a.model,
            effort: a.effort,
            tasks: a.rows.length,
            first_pass: a.rows.filter((r) => r.first_verdict === 'pass').length,
            cycles_to_pass_mean: mean(a.rows.flatMap((r) => (r.cycles === null ? [] : [r.cycles]))),
            escaped: a.rows.filter((r) => tracedTasks.has(r.task_id)).length,
        })),
    };
}
function fmtMean(x) {
    return x === null ? 'n/a' : x.toFixed(2);
}
export function formatReviewerEval(e) {
    const lines = [
        `first_pass=${e.first_pass}/${e.reviewed_tasks} (${e.first_pass_pct.toFixed(1)}%)`,
        `cycles_to_pass_mean=${fmtMean(e.cycles_to_pass_mean)}`,
        `wontfix_rate=${e.findings_wontfix}/${e.findings_total}`,
        `escaped_bugs=${e.escaped_bugs} traced_tasks=${e.traced_tasks} untraced_bugs=${e.untraced_bugs}`,
        `known_clean=${e.known_clean}`,
    ];
    if (e.severity) {
        lines.push(`severity ${Object.entries(e.severity).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    }
    for (const a of e.arms) {
        lines.push(`arm model=${a.model} effort=${a.effort} tasks=${a.tasks} first_pass=${a.first_pass}/${a.tasks} cycles_to_pass_mean=${fmtMean(a.cycles_to_pass_mean)} escaped=${a.escaped}`);
    }
    return lines.join('\n') + '\n';
}
//# sourceMappingURL=reviewer-eval.js.map