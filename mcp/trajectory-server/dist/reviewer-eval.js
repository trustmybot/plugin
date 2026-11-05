/**
 * The code-reviewer eval (GH 1955 item e): first-pass rate, mean cycles to
 * pass, wontfix rate, escaped bugs and known-clean tasks, overall and per
 * reviewer arm (model, effort). Escaped bugs come from an SZZ trace
 * (Sliwerski, Zimmermann and Zeller, MSR 2005): each in-scope Bug issue's fix
 * commits on the base are diffed against their parent, the removed or changed
 * code lines are blamed, and the GH numbers in the blamed commits' subjects
 * map to the passed tasks of those issues. Read-only:
 * scripts/maintenance/reviewer-eval.ts runs it on a DB opened read-only.
 */
import { spawnSync } from 'node:child_process';
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
function blamedSubjects(git, rev, path, ranges) {
    const args = ['blame', '-w', '--porcelain'];
    for (const r of ranges)
        args.push('-L', `${r.start},${r.start + r.count - 1}`);
    const out = git([...args, rev, '--', path]);
    const subjects = [];
    for (const line of out.split('\n')) {
        if (line.startsWith('summary '))
            subjects.push(line.slice('summary '.length));
    }
    return subjects;
}
function traceFix(git, sha) {
    const diff = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--unified=0', `${sha}^`, sha]);
    const byPath = new Map();
    for (const r of removedRanges(diff))
        byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
    const refs = new Set();
    for (const [path, ranges] of byPath) {
        for (const subject of blamedSubjects(git, `${sha}^`, path, ranges))
            for (const n of ghRefs(subject))
                refs.add(n);
    }
    return { removedCode: byPath.size > 0, refs };
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
            MIN(CASE WHEN va.verdict = 'pass' THEN va.attempt_n END) AS cycles,
            t.issue_id
       FROM validation_attempts va LEFT JOIN tasks t ON t.id = va.task_id
      GROUP BY va.task_id ORDER BY va.task_id`);
    const arms = new Map();
    for (const r of db.all(`SELECT ar.task_id, ar.model, ar.effort FROM agent_runs ar
      WHERE ar.agent_type LIKE '%code-reviewer' AND ar.task_id IS NOT NULL
        AND ar.id = (SELECT id FROM agent_runs x WHERE x.task_id = ar.task_id AND x.agent_type LIKE '%code-reviewer'
                      ORDER BY x.started_at ASC, x.id ASC LIMIT 1)`)) {
        arms.set(r.task_id, { model: r.model ?? 'unset', effort: r.effort ?? 'unset' });
    }
    const passedTasksByIssue = new Map();
    for (const r of reviewed) {
        if (r.cycles === null || r.issue_id === null)
            continue;
        passedTasksByIssue.set(r.issue_id, [...(passedTasksByIssue.get(r.issue_id) ?? []), r.task_id]);
    }
    const issueByIid = new Map();
    for (const r of db.all(`SELECT id, gh_iid FROM issues WHERE gh_iid IS NOT NULL`)) {
        issueByIid.set(r.gh_iid, [...(issueByIid.get(r.gh_iid) ?? []), r.id]);
    }
    const bugs = db.all(`SELECT id, gh_iid FROM issues
      WHERE gh_iid IS NOT NULL AND json_valid(labels)
        AND EXISTS (SELECT 1 FROM json_each(issues.labels) WHERE value = 'Bug')
        AND julianday(created_at) > (SELECT julianday(MIN(created_at)) FROM validation_attempts)
      ORDER BY gh_iid`);
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
        let removedCode = false;
        const taskIds = new Set();
        for (const sha of fixes) {
            let trace = traceCache.get(sha);
            if (!trace) {
                trace = traceFix(git, sha);
                traceCache.set(sha, trace);
            }
            removedCode ||= trace.removedCode;
            for (const n of trace.refs) {
                for (const issueId of issueByIid.get(n) ?? []) {
                    if (issueId === bug.id)
                        continue;
                    for (const t of passedTasksByIssue.get(issueId) ?? [])
                        taskIds.add(t);
                }
            }
        }
        if (!removedCode)
            untraced++;
        if (taskIds.size > 0) {
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