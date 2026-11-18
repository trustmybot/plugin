/**
 * The SessionStart Change impact lines (GH 2600): the regressed changes of the
 * cache the server's detached change-impact CLI wrote next to the DB, each
 * shown once. `change-impact-shown.json` in the same dir records the shown
 * changes, and a change prints only once that record is written. Any missing,
 * oversized, unreadable or malformed file adds nothing; this never throws.
 */
import { join } from 'node:path';
import { CACHE_MAX_BYTES, CACHE_SOURCES, changeImpactLine, changeKey, parseRegressionsCache, readCapped, REGRESSIONS_FILE, SHOWN_FILE, writeFileAtomic, } from '../../change-impact/regressions-cache.js';
export const CHANGE_IMPACT_MAX_LINES = 3;
const SHOWN_MAX = 500;
const SHOWN_KEY = new RegExp(`^(${CACHE_SOURCES.join('|')}):[A-Za-z0-9._:/-]{1,64}$`);
function shownKeys(dir) {
    const text = readCapped(join(dir, SHOWN_FILE), CACHE_MAX_BYTES);
    if (text === null)
        return [];
    try {
        const doc = JSON.parse(text);
        const shown = doc?.shown;
        return Array.isArray(shown) ? shown.filter((k) => typeof k === 'string' && SHOWN_KEY.test(k)) : [];
    }
    catch {
        return [];
    }
}
/** The lines for the changes in <stateDir>'s cache not shown before, at most three. */
export function changeImpactLines(stateDir) {
    try {
        const text = readCapped(join(stateDir, REGRESSIONS_FILE), CACHE_MAX_BYTES);
        if (text === null)
            return [];
        const shown = shownKeys(stateDir);
        const seen = new Set(shown);
        const fresh = parseRegressionsCache(text).filter((c) => {
            const key = changeKey(c);
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        const picked = fresh.slice(0, CHANGE_IMPACT_MAX_LINES);
        if (picked.length === 0)
            return [];
        const record = [...shown, ...picked.map(changeKey)].slice(-SHOWN_MAX);
        writeFileAtomic(join(stateDir, SHOWN_FILE), `${JSON.stringify({ shown: record })}\n`);
        return picked.map(changeImpactLine);
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=change-impact-line.js.map