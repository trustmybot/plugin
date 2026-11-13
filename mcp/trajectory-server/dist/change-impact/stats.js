/**
 * The statistics behind a change-impact verdict (GH 2600): medians and means,
 * a seeded percentile bootstrap CI on the ratio of medians, a two-sided
 * Mann-Whitney U test (tie-corrected normal approximation with continuity
 * correction) and Holm's step-down correction.
 */
export const BOOTSTRAP_RESAMPLES = 2000;
export function median(values) {
    if (values.length === 0)
        return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export function mean(values) {
    if (values.length === 0)
        return null;
    return values.reduce((s, v) => s + v, 0) / values.length;
}
export function ratioOfMedians(before, after) {
    const b = median(before);
    const a = median(after);
    if (a === null || b === null || b === 0)
        return null;
    return a / b;
}
/** FNV-1a 32-bit hash of <s>. */
export function hashSeed(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** The median of one resample with replacement of the ascending <sorted>, in O(n) via draw counts. */
function resampleMedian(sorted, counts, rand) {
    const n = sorted.length;
    counts.fill(0);
    for (let i = 0; i < n; i++)
        counts[Math.floor(rand() * n)]++;
    const lo = (n - 1) >> 1;
    const hi = n >> 1;
    let seen = 0;
    let loVal = null;
    for (let i = 0; i < n; i++) {
        seen += counts[i];
        if (loVal === null && seen > lo)
            loVal = sorted[i];
        if (seen > hi)
            return (loVal + sorted[i]) / 2;
    }
    return sorted[n - 1];
}
function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
/** 95% percentile bootstrap CI on after/before median, each side resampled; null when no resample has a non-zero before median. */
export function bootstrapRatioCi(before, after, seed, resamples = BOOTSTRAP_RESAMPLES) {
    if (before.length === 0 || after.length === 0)
        return null;
    const rand = mulberry32(seed);
    const b = [...before].sort((x, y) => x - y);
    const a = [...after].sort((x, y) => x - y);
    const bCounts = new Uint32Array(b.length);
    const aCounts = new Uint32Array(a.length);
    const ratios = [];
    for (let i = 0; i < resamples; i++) {
        const bm = resampleMedian(b, bCounts, rand);
        const am = resampleMedian(a, aCounts, rand);
        if (bm !== 0)
            ratios.push(am / bm);
    }
    if (ratios.length === 0)
        return null;
    ratios.sort((x, y) => x - y);
    return [quantile(ratios, 0.025), quantile(ratios, 0.975)];
}
/** Complementary error function (Numerical Recipes erfcc, fractional error < 1.2e-7). */
function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t *
        Math.exp(-z * z -
            1.26551223 +
            t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
}
/** Two-sided Mann-Whitney U of <x> against <y>: U of x, tie-corrected normal approximation with continuity correction. */
export function mannWhitneyU(x, y) {
    const n1 = x.length;
    const n2 = y.length;
    const all = [...x.map((v) => ({ v, g: 0 })), ...y.map((v) => ({ v, g: 1 }))].sort((a, b) => a.v - b.v);
    const n = all.length;
    let r1 = 0;
    let tieSum = 0;
    for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && all[j + 1].v === all[i].v)
            j++;
        const rank = (i + j + 2) / 2;
        const t = j - i + 1;
        tieSum += t * t * t - t;
        for (let k = i; k <= j; k++)
            if (all[k].g === 0)
                r1 += rank;
        i = j + 1;
    }
    const u = r1 - (n1 * (n1 + 1)) / 2;
    const mu = (n1 * n2) / 2;
    const variance = ((n1 * n2) / 12) * (n + 1 - tieSum / (n * (n - 1)));
    if (!(variance > 0))
        return { u, z: 0, p: 1 };
    const diff = Math.abs(u - mu);
    const z = Math.max(0, diff - 0.5) / Math.sqrt(variance);
    return { u, z: u >= mu ? z : -z, p: Math.min(1, erfc(z / Math.SQRT2)) };
}
/** Holm step-down adjusted p-values, in the order of <ps>. */
export function holm(ps) {
    const m = ps.length;
    const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
    const out = new Array(m);
    let running = 0;
    order.forEach(({ p, i }, rank) => {
        running = Math.max(running, Math.min(1, (m - rank) * p));
        out[i] = running;
    });
    return out;
}
//# sourceMappingURL=stats.js.map