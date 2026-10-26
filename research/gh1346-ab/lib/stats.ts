export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

function incBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value of Student's t with df degrees of freedom. */
export function tTwoSided(t: number, df: number): number {
  return incBeta(df / 2, 0.5, df / (df + t * t));
}

function tCrit95(df: number): number {
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > 0.05) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface PairedTest {
  n: number;
  meanA: number;
  meanB: number;
  sdA: number;
  sdB: number;
  meanDiff: number;
  ci95: [number, number];
  pctChange: number;
  t: number;
  p: number;
  wilcoxonP: number;
}

/** Paired comparison of B against control A: paired t-test plus a Wilcoxon signed-rank check. */
export function paired(a: number[], b: number[]): PairedTest {
  const n = Math.min(a.length, b.length);
  const d = Array.from({ length: n }, (_, i) => b[i]! - a[i]!);
  const md = mean(d);
  const se = sd(d) / Math.sqrt(n);
  const t = se === 0 ? (md === 0 ? 0 : Infinity) : md / se;
  const p = se === 0 ? (md === 0 ? 1 : 0) : tTwoSided(t, n - 1);
  const half = se * tCrit95(n - 1);
  return {
    n,
    meanA: mean(a),
    meanB: mean(b),
    sdA: sd(a),
    sdB: sd(b),
    meanDiff: md,
    ci95: [md - half, md + half],
    pctChange: (100 * (mean(b) - mean(a))) / mean(a),
    t,
    p,
    wilcoxonP: wilcoxon(d),
  };
}

function normalTwoSided(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 1 - erf;
}

export function wilcoxon(d: number[]): number {
  const nz = d.filter((x) => x !== 0);
  const n = nz.length;
  if (n === 0) return 1;
  const ranked = nz.map((x) => ({ x, abs: Math.abs(x) })).sort((p, q) => p.abs - q.abs);
  const ranks: number[] = new Array(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && ranked[j + 1]!.abs === ranked[i]!.abs) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const wPlus = ranked.reduce((s, r, i) => s + (r.x > 0 ? ranks[i]! : 0), 0);
  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  return normalTwoSided((wPlus - mu) / sigma);
}

function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const lo = Math.min(k, n - k);
  let p = 0;
  let c = 1;
  for (let i = 0; i <= lo; i++) {
    p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

export interface BinaryTest {
  n: number;
  accA: number;
  accB: number;
  ciA: [number, number];
  ciB: [number, number];
  onlyA: number;
  onlyB: number;
  p: number;
}

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const ph = k / n;
  const den = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / den;
  return [c - h, c + h];
}

/** Paired correctness of B against control A: exact McNemar test on the discordant pairs. */
export function mcnemar(a: boolean[], b: boolean[]): BinaryTest {
  const n = Math.min(a.length, b.length);
  let onlyA = 0;
  let onlyB = 0;
  let kA = 0;
  let kB = 0;
  for (let i = 0; i < n; i++) {
    if (a[i]) kA++;
    if (b[i]) kB++;
    if (a[i] && !b[i]) onlyA++;
    if (!a[i] && b[i]) onlyB++;
  }
  return { n, accA: kA / n, accB: kB / n, ciA: wilson(kA, n), ciB: wilson(kB, n), onlyA, onlyB, p: binomTwoSided(onlyB, onlyA + onlyB) };
}

export function fisherExact(a: number, b: number, c: number, d: number): number {
  const lf = (k: number): number => (k < 2 ? 0 : logGamma(k + 1));
  const n = a + b + c + d;
  const r1 = a + b;
  const c1 = a + c;
  const prob = (x: number): number =>
    Math.exp(lf(r1) + lf(n - r1) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(n - r1 - c1 + x));
  const p0 = prob(a);
  let p = 0;
  for (let x = Math.max(0, r1 + c1 - n); x <= Math.min(r1, c1); x++) {
    const px = prob(x);
    if (px <= p0 * (1 + 1e-9)) p += px;
  }
  return Math.min(1, p);
}

export function fmt(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString('en-US');
  return x.toFixed(digits);
}

export function fmtP(p: number): string {
  return p < 0.001 ? '<0.001' : p.toFixed(3);
}
