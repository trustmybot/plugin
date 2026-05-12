export function renderChangelog(commits, opts) {
    const totalFiles = countUniqueFiles(commits);
    const lines = [
        `<!-- Auto-rendered ${opts.generatedAt}. Do not edit. -->`,
        '',
        '# Changelog',
        '',
    ];
    if (opts.sinceSha !== null || opts.sinceDate !== null) {
        const shaPart = opts.sinceSha ? `\`${abbrev(opts.sinceSha)}\`` : null;
        const datePart = opts.sinceDate ? `(${isoDateOnly(opts.sinceDate)})` : null;
        const sincePart = [shaPart, datePart].filter(Boolean).join(' ');
        lines.push(`Changes since commit ${sincePart}.`);
    }
    else {
        lines.push('All history.');
    }
    lines.push(`${commits.length} commit${commits.length === 1 ? '' : 's'}, ${totalFiles} file${totalFiles === 1 ? '' : 's'} touched.`);
    if (commits.length === 0) {
        lines.push('');
        return lines.join('\n');
    }
    const byDate = groupByDate(commits);
    const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
    for (const date of sortedDates) {
        const dayCommits = byDate[date];
        const groups = groupWithinDay(dayCommits);
        for (const group of groups) {
            const groupLabel = group.label ? ` — ${group.label}` : '';
            lines.push('');
            lines.push(`## ${date}${groupLabel} (${group.commits.length} commit${group.commits.length === 1 ? '' : 's'})`);
            for (const c of group.commits) {
                lines.push('');
                lines.push(`- \`${abbrev(c.sha)}\` ${c.subject} — ${c.author}`);
                if (c.files_changed.length > 0) {
                    const filePart = c.files_changed.map(f => `\`${f}\``).join(', ');
                    lines.push(`  - Files: ${filePart}`);
                }
            }
        }
    }
    lines.push('');
    return lines.join('\n');
}
function abbrev(sha) {
    return sha.slice(0, 7);
}
function isoDateOnly(iso) {
    return iso.slice(0, 10);
}
function countUniqueFiles(commits) {
    const seen = new Set();
    for (const c of commits) {
        for (const f of c.files_changed) {
            seen.add(f);
        }
    }
    return seen.size;
}
function groupByDate(commits) {
    const map = {};
    for (const c of commits) {
        const day = isoDateOnly(c.date);
        (map[day] ??= []).push(c);
    }
    return map;
}
const CONVENTIONAL_SCOPE_RE = /^[\w!]+(?:\(([^)]+)\))?!?:/;
function extractScope(subject) {
    const m = CONVENTIONAL_SCOPE_RE.exec(subject);
    return m?.[1] ?? null;
}
function groupWithinDay(commits) {
    const grouped = new Map();
    for (const c of commits) {
        const scope = extractScope(c.subject);
        const key = scope ?? c.author;
        const existing = grouped.get(key);
        if (existing) {
            existing.push(c);
        }
        else {
            grouped.set(key, [c]);
        }
    }
    return Array.from(grouped.entries()).map(([label, grpCommits]) => ({ label, commits: grpCommits }));
}
//# sourceMappingURL=changelog.js.map