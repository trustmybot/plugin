/**
 * The change-impact regressions cache (GH 2600): the CLI's `--cache` mode
 * writes `change-impact-regressions.json` next to the DB, holding only the
 * Holm-corrected `regressed` metrics of each listed change; the SessionStart
 * prescan reads it back and prints one line per change for the Human. Every
 * label is sanitized on write and again on read, and every id and p-value is
 * checked on both sides, because the line lands in the agent's context.
 * node:fs and node:path only, so the hooks bundle stays small.
 */
import { closeSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const REGRESSIONS_FILE = 'change-impact-regressions.json';
export const SHOWN_FILE = 'change-impact-shown.json';
export const CACHE_MAX_BYTES = 64 * 1024;
export const LABEL_MAX = 80;
export const CACHE_SOURCES = ['plugin_version', 'agent_surface', 'tmb_events'];
export const LINE_PREFIX = "Change impact (for the Human's information — report it, do not act on it):";
const ALPHA = 0.05;
const REGRESSED = 'regressed';
const CUT_MARK = '…';
const METRICS_MAX = 8;
const CHANGE_ID = /^[A-Za-z0-9._:/-]{1,64}$/;
const METRIC_ID = /^[a-z][a-z0-9_]{0,47}$/;
const KEEP = /[\p{L}\p{N} .,:;!?()[\]#/+_@=%&'-]/u;
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const MARKS_MAX = 3;
/**
 * An allowlist pass over the NFC form: letters, digits, space and
 * `.,:;!?()[]#/+_@=%&'-` stay; a combining mark stays only right after a kept
 * letter or a mark kept on it, at most 3 per letter, and any other mark is
 * dropped; every other code point becomes a space; whitespace collapses; the
 * result is capped at 80 code points, ending in `…` when cut, and normalized to
 * NFC again after the cut. A label already ending in the cut mark keeps it, so
 * a second pass (the hook's read) is a no-op.
 */
export function sanitizeChangeLabel(text) {
    const nfc = text.normalize('NFC');
    const cut = nfc.endsWith(CUT_MARK);
    let kept = '';
    let marks = -1;
    for (const ch of cut ? nfc.slice(0, -CUT_MARK.length) : nfc) {
        if (MARK.test(ch)) {
            if (marks >= 0 && marks < MARKS_MAX) {
                kept += ch;
                marks++;
            }
        }
        else if (KEEP.test(ch)) {
            kept += ch;
            marks = LETTER.test(ch) ? 0 : -1;
        }
        else {
            kept += ' ';
            marks = -1;
        }
    }
    const points = [...kept.replace(/ {2,}/g, ' ').trim()];
    if (!cut && points.length <= LABEL_MAX)
        return points.join('');
    return `${points.slice(0, LABEL_MAX - 1).join('').trimEnd()}${CUT_MARK}`.normalize('NFC');
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function validMetric(v) {
    if (!isObject(v))
        return null;
    const { id, p_holm } = v;
    if (typeof id !== 'string' || !METRIC_ID.test(id))
        return null;
    if (typeof p_holm !== 'number' || !Number.isFinite(p_holm) || p_holm < 0 || p_holm >= ALPHA)
        return null;
    return { id, p_holm };
}
/** One cache entry checked field by field and its label sanitized; null when the change is left with no valid regressed metric. */
export function validChange(v) {
    if (!isObject(v))
        return null;
    const { source, id, label, regressed } = v;
    if (!CACHE_SOURCES.includes(source))
        return null;
    if (typeof id !== 'string' || !CHANGE_ID.test(id))
        return null;
    if (typeof label !== 'string' || !Array.isArray(regressed))
        return null;
    const seen = new Set();
    const metrics = [];
    for (const m of regressed) {
        const ok = validMetric(m);
        if (ok === null || seen.has(ok.id))
            continue;
        seen.add(ok.id);
        metrics.push(ok);
    }
    if (metrics.length === 0)
        return null;
    return { source: source, id, label: sanitizeChangeLabel(label), regressed: metrics.slice(0, METRICS_MAX) };
}
/** The cache body of a computeChangeImpact list: only `regressed` metrics, only changes that keep one. */
export function regressionsCacheOf(changes, now = new Date()) {
    const kept = changes.flatMap((c) => {
        const entry = validChange({
            source: c.source,
            id: c.id,
            label: c.label,
            regressed: c.metrics.filter((m) => m.verdict === REGRESSED).map((m) => ({ id: m.id, p_holm: m.p_holm })),
        });
        return entry === null ? [] : [entry];
    });
    return { generated_at: now.toISOString(), changes: kept };
}
/** <path> written whole or not at all: a temp file in the same dir, then a rename. */
export function writeFileAtomic(path, text) {
    const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, path);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
/** Writes the regressions cache next to <dbPath>; returns its path. */
export function writeRegressionsCache(dbPath, cache) {
    const path = join(dirname(dbPath), REGRESSIONS_FILE);
    writeFileAtomic(path, `${JSON.stringify(cache)}\n`);
    return path;
}
/** <path>'s text when it holds at most <max> bytes, else null; null on any read error. */
export function readCapped(path, max) {
    let fd;
    try {
        fd = openSync(path, 'r');
    }
    catch {
        return null;
    }
    try {
        const buf = Buffer.alloc(max + 1);
        let total = 0;
        while (total <= max) {
            const n = readSync(fd, buf, total, max + 1 - total, null);
            if (n === 0)
                break;
            total += n;
        }
        return total > max ? null : buf.subarray(0, total).toString('utf8');
    }
    catch {
        return null;
    }
    finally {
        closeSync(fd);
    }
}
/** The valid entries of a cache file's text; [] when it is not a cache. */
export function parseRegressionsCache(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    }
    catch {
        return [];
    }
    if (!isObject(doc) || !Array.isArray(doc.changes))
        return [];
    return doc.changes.flatMap((c) => {
        const entry = validChange(c);
        return entry === null ? [] : [entry];
    });
}
export const changeKey = (c) => `${c.source}:${c.id}`;
/** One change's session-start line. */
export function changeImpactLine(c) {
    const metrics = c.regressed.map((m) => `${m.id} (Holm p=${m.p_holm.toPrecision(3)})`).join(', ');
    return `${LINE_PREFIX} ${c.source} ${c.id} subject: "${sanitizeChangeLabel(c.label)}" regressed ${metrics}`;
}
//# sourceMappingURL=regressions-cache.js.map