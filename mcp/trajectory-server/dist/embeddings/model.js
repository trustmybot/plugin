let pipelinePromise = null;
let loadFailed = false;
export async function embed(text) {
    if (loadFailed)
        return null;
    if (!pipelinePromise) {
        try {
            const { pipeline } = await import('@huggingface/transformers');
            pipelinePromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
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
        return null;
    }
}
export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
//# sourceMappingURL=model.js.map