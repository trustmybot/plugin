import { homedir } from 'node:os';
import { join } from 'node:path';
// The embedding model cache is the one path TMB uses outside the project: a
// shared, re-downloadable user cache, overridable via TMB_MODEL_CACHE_DIR.
export const TMB_MODEL_CACHE_DIR = process.env['TMB_MODEL_CACHE_DIR'] ?? process.env['HF_HOME'] ?? join(homedir(), '.cache', 'huggingface');
export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
/** Re-attempt delays after entering the degraded state: 1 min, 5 min, then every 10 min. */
export const EMBED_RETRY_SCHEDULE_MS = [60_000, 300_000, 600_000];
export const EMBED_FAIL_THRESHOLD_DEFAULT = 5;
async function defaultLoader() {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = TMB_MODEL_CACHE_DIR;
    return (await pipeline('feature-extraction', MODEL_ID));
}
let now = Date.now;
let loader = defaultLoader;
let pipePromise = null;
let loadingSince = null;
let readySince = null;
let consecutiveFailures = 0;
let degraded = null;
let retrying = false;
const listeners = new Set();
export function embedRetryDelayMs(retries, env = process.env) {
    const raw = env['TMB_EMBED_RETRY_MS'];
    const override = raw === undefined || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(override) && override >= 0)
        return override;
    return EMBED_RETRY_SCHEDULE_MS[Math.min(retries, EMBED_RETRY_SCHEDULE_MS.length - 1)];
}
export function embedFailThreshold(env = process.env) {
    const raw = Number(env['TMB_EMBED_FAIL_THRESHOLD']);
    return Number.isInteger(raw) && raw > 0 ? raw : EMBED_FAIL_THRESHOLD_DEFAULT;
}
/** Subscribe to degraded / recovered transitions; returns the unsubscribe. */
export function onEmbeddingTransition(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
function emit(t) {
    for (const l of listeners) {
        try {
            l(t);
        }
        catch (e) {
            console.error('[embeddings] transition listener failed:', e);
        }
    }
}
function message(e) {
    return e instanceof Error ? e.message : String(e);
}
function loadPipe() {
    if (!pipePromise) {
        loadingSince = new Date(now()).toISOString();
        readySince = null;
        const p = loader();
        pipePromise = p;
        p.then(() => {
            if (pipePromise === p)
                readySince = new Date(now()).toISOString();
        }, () => {
            if (pipePromise === p)
                pipePromise = null;
        });
    }
    return pipePromise;
}
function enterDegraded(reason) {
    if (degraded)
        return;
    degraded = { since: new Date(now()).toISOString(), reason, retries: 0, nextRetryAt: now() + embedRetryDelayMs(0) };
    emit({ kind: 'degraded', reason, consecutive_failures: consecutiveFailures });
}
async function retry(text) {
    const d = degraded;
    retrying = true;
    pipePromise = null;
    try {
        const pipe = await loadPipe();
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        consecutiveFailures = 0;
        degraded = null;
        emit({ kind: 'recovered', degraded_since: d.since, reason: d.reason, retries: d.retries + 1 });
        return new Float32Array(result.data);
    }
    catch (e) {
        console.error('[embeddings] re-attempt failed:', e);
        consecutiveFailures++;
        d.retries++;
        d.reason = `re-attempt failed: ${message(e)}`;
        d.nextRetryAt = now() + embedRetryDelayMs(d.retries);
        return null;
    }
    finally {
        retrying = false;
    }
}
/**
 * Embeds `text`, or returns null when the model is unavailable. A model that
 * cannot load enters the degraded state at once; a call that fails is counted,
 * and TMB_EMBED_FAIL_THRESHOLD (default 5) consecutive failures enter it too.
 * While degraded every call returns null until the next re-attempt is due.
 */
export async function embed(text) {
    if (degraded) {
        if (retrying || now() < degraded.nextRetryAt)
            return null;
        return retry(text);
    }
    let pipe;
    try {
        pipe = await loadPipe();
    }
    catch (e) {
        if (degraded)
            return null;
        console.error('[embeddings] model load failed:', e);
        consecutiveFailures++;
        enterDegraded(`model load failed: ${message(e)}`);
        return null;
    }
    try {
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        consecutiveFailures = 0;
        return new Float32Array(result.data);
    }
    catch (e) {
        console.error('[embeddings] embed failed:', e);
        if (degraded)
            return null;
        consecutiveFailures++;
        if (consecutiveFailures >= embedFailThreshold()) {
            enterDegraded(`${consecutiveFailures} consecutive embed failures: ${message(e)}`);
        }
        return null;
    }
}
export function embeddingStatus() {
    if (degraded) {
        return {
            state: 'degraded',
            since: degraded.since,
            reason: degraded.reason,
            consecutive_failures: consecutiveFailures,
            ...(retrying ? {} : { next_retry_at: new Date(degraded.nextRetryAt).toISOString() }),
        };
    }
    if (readySince)
        return { state: 'ready', since: readySince, consecutive_failures: consecutiveFailures };
    if (pipePromise)
        return { state: 'loading', since: loadingSince ?? undefined, consecutive_failures: consecutiveFailures };
    return { state: 'disabled', consecutive_failures: consecutiveFailures };
}
/** Test seam: swap the model loader and reset every state; `null` restores the real loader. */
export function resetEmbeddingModelForTests(next = null) {
    loader = next ?? defaultLoader;
    pipePromise = null;
    loadingSince = null;
    readySince = null;
    consecutiveFailures = 0;
    degraded = null;
    retrying = false;
    listeners.clear();
}
/** Test seam: replace the clock behind `since`, `next_retry_at` and the re-attempt gate; no argument restores `Date.now`. */
export function __setClockForTests(fn = Date.now) {
    now = fn;
}
//# sourceMappingURL=model.js.map