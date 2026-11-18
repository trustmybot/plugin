// Strips tokens, emails, remotes, paths, branch, repo and issue names from bug-report free text before anyone sees it.
export const REDACT_RULES = ['token', 'email', 'remote', 'project', 'home', 'path', 'branch', 'repo', 'title'];
export const TOKEN_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----|[\s\S]*$)/g,
    /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bglpat-[A-Za-z0-9_-]{16,}/g,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
export const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const URL_TAIL = String.raw `[^\s<>"'\`()\[\]{}]*`;
const USERINFO = String.raw `(?:(?:[^\s/@<>]|<redacted>)+@)?`;
const GIT_URL_RE = new RegExp([
    String.raw `\b(?:git\+ssh|ssh|git)://${USERINFO}${URL_TAIL}`,
    String.raw `\bhttps?://${USERINFO}[\w.-]*(?:git|bitbucket|codeberg|azure|sr\.ht)[\w.-]*(?::\d+)?(?:/${URL_TAIL})?`,
    String.raw `\bhttps?://${USERINFO}${URL_TAIL}\.git\b${URL_TAIL}`,
    String.raw `(?<![\w.@-])[\w.-]+@[\w-]+(?:\.[\w-]+)+:(?!//)[\w.~/-]+`,
].join('|'), 'g');
const KEPT_REMOTE_RE = /^(?:https?:\/\/(?:www\.)?|ssh:\/\/git@|git@)github\.com[:/]trustmybot\/plugin(?:\.git)?(?:[/?#].*)?$/i;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
const PLACEHOLDER_RE = /<(?:redacted|email|repo|project|path|branch|title)>/g;
const KEPT_BRANCHES = new Set(['main', 'master', 'dev', 'develop', 'HEAD']);
const KEPT_REPO_NAMES = new Set(['plugin', 'tmb', 'trustmybot']);
const PATH_SEG = String.raw `[^\s/\\:*?"<>|'\`,;()\[\]{}]+`;
const WINDOWS_PATH_RE = new RegExp(String.raw `(?<![\w])(?:[A-Za-z]:[\\/](?:${PATH_SEG}[\\/])*${PATH_SEG}|\\\\${PATH_SEG}(?:\\${PATH_SEG})+)`, 'g');
const POSIX_PATH_RE = new RegExp(String.raw `(?<=^|[\s'"\`(\[{=,;|:]|file://)/(?:${PATH_SEG}/)+${PATH_SEG}`, 'g');
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function emptyCounts() {
    return Object.fromEntries(REDACT_RULES.map((r) => [r, 0]));
}
function byLengthDesc(values) {
    return [...new Set(values)].sort((a, b) => b.length - a.length);
}
function outsidePlaceholders(text, fn) {
    let out = '';
    let last = 0;
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
        out += fn(text.slice(last, m.index)) + m[0];
        last = m.index + m[0].length;
    }
    return out + fn(text.slice(last));
}
function redactTokens(text, counts) {
    let out = text;
    for (const re of TOKEN_PATTERNS) {
        out = out.replace(re, () => {
            counts.token++;
            return '<redacted>';
        });
    }
    return out;
}
function redactEmails(text, counts) {
    const urlSpans = [...text.matchAll(GIT_URL_RE)].map((m) => [m.index, m.index + m[0].length]);
    return text.replace(EMAIL_RE, (match, offset) => {
        if (urlSpans.some(([start, end]) => offset >= start && offset < end))
            return match;
        counts.email++;
        return '<email>';
    });
}
function isKeptRemote(url) {
    return KEPT_REMOTE_RE.test(url);
}
function redactRemotes(text, remoteUrls, counts) {
    let out = text;
    const literals = byLengthDesc(remoteUrls.map((u) => redactTokens(u.trim(), emptyCounts())))
        .filter((u) => u.length > 0 && !isKeptRemote(u));
    for (const literal of literals) {
        out = out.replace(new RegExp(escapeRe(literal), 'g'), () => {
            counts.remote++;
            return '<repo>';
        });
    }
    return out.replace(GIT_URL_RE, (match) => {
        const tail = TRAILING_PUNCT_RE.exec(match)?.[0] ?? '';
        const url = match.slice(0, match.length - tail.length);
        if (isKeptRemote(url))
            return match;
        counts.remote++;
        return '<repo>' + tail;
    });
}
function pathVariants(p) {
    const forward = p.replace(/\\/g, '/');
    const back = p.replace(/\//g, '\\');
    return [p, forward, back, back.replace(/\\/g, '\\\\')];
}
function isUsableRoot(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    return trimmed.length >= 2 && !/^[A-Za-z]:$/.test(trimmed);
}
function redactRoots(text, ctx, counts) {
    const roots = [];
    for (const [raw, replacement, rule] of [
        [ctx.projectRoot, '<project>', 'project'],
        [ctx.home, '~', 'home'],
    ]) {
        if (!raw || !isUsableRoot(raw))
            continue;
        const base = raw.replace(/[\\/]+$/, '');
        for (const literal of new Set(pathVariants(base)))
            roots.push({ literal, replacement, rule });
    }
    roots.sort((a, b) => b.literal.length - a.literal.length);
    let out = text;
    for (const { literal, replacement, rule } of roots) {
        const caseInsensitive = /^[A-Za-z]:/.test(literal) || literal.startsWith('\\\\');
        const re = new RegExp(escapeRe(literal) + String.raw `(?![\w-]|\.[\w-])`, caseInsensitive ? 'gi' : 'g');
        out = out.replace(re, () => {
            counts[rule]++;
            return replacement;
        });
    }
    return out;
}
function basename(path) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
}
function redactPaths(text, counts) {
    const replace = (match) => {
        counts.path++;
        return `<path>/${basename(match)}`;
    };
    return text.replace(WINDOWS_PATH_RE, replace).replace(POSIX_PATH_RE, replace);
}
function redactWords(text, words, pattern, flags, replacement, rule, counts) {
    if (words.length === 0)
        return text;
    const re = new RegExp(byLengthDesc(words).map((w) => pattern(escapeRe(w))).join('|'), flags);
    return outsidePlaceholders(text, (segment) => segment.replace(re, () => {
        counts[rule]++;
        return replacement;
    }));
}
const MAX_PASSES = 8;
export function redact(text, ctx) {
    const counts = emptyCounts();
    let out = text;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const next = redactOnce(out, ctx, counts);
        if (next === out)
            break;
        out = next;
    }
    return { text: out, counts };
}
function redactOnce(text, ctx, counts) {
    let out = redactTokens(text, counts);
    out = redactEmails(out, counts);
    out = redactRemotes(out, ctx.remoteUrls, counts);
    out = redactRoots(out, ctx, counts);
    out = redactPaths(out, counts);
    out = redactWords(out, ctx.branchNames.map((b) => b.trim()).filter((b) => b.length > 0 && !KEPT_BRANCHES.has(b)), (w) => String.raw `(?<![\w.-])${w}(?![\w-]|\.[\w-])`, 'g', '<branch>', 'branch', counts);
    out = redactWords(out, ctx.repoNames.map((r) => r.trim()).filter((r) => r.length >= 3 && !KEPT_REPO_NAMES.has(r.toLowerCase())), (w) => String.raw `(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`, 'gi', '<repo>', 'repo', counts);
    out = redactWords(out, ctx.titles.map((t) => t.trim()).filter((t) => t.length >= 4), (w) => w, 'g', '<title>', 'title', counts);
    return out;
}
//# sourceMappingURL=redact.js.map