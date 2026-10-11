import { homedir } from 'node:os';
import { join } from 'node:path';
// The embedding model cache is the one path TMB uses outside the project: a
// shared, re-downloadable user cache, overridable via TMB_MODEL_CACHE_DIR.
export const TMB_MODEL_CACHE_DIR = process.env['TMB_MODEL_CACHE_DIR'] ?? process.env['HF_HOME'] ?? join(homedir(), '.cache', 'huggingface');
let pipelinePromise = null;
let loadFailed = false;
export async function embed(text) {
    if (loadFailed)
        return null;
    if (!pipelinePromise) {
        try {
            const { pipeline, env } = await import('@huggingface/transformers');
            env.cacheDir = TMB_MODEL_CACHE_DIR;
            pipelinePromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
            pipelinePromise.catch(() => {
                loadFailed = true;
                pipelinePromise = null;
            });
        }
        catch (e) {
            console.error('[embeddings] model load failed:', e);
            loadFailed = true;
            return null;
        }
    }
    try {
        const pipe = await pipelinePromise;
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        return new Float32Array(result.data);
    }
    catch (e) {
        console.error('[embeddings] embed failed:', e);
        loadFailed = true;
        pipelinePromise = null;
        return null;
    }
}
export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
//# sourceMappingURL=model.js.map