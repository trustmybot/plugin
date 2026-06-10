import { homedir } from 'node:os';
import { join } from 'node:path';

let pipelinePromise: Promise<unknown> | null = null;
let loadFailed = false;

export async function embed(text: string): Promise<Float32Array | null> {
  if (loadFailed) return null;
  if (!pipelinePromise) {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface');
      pipelinePromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
      pipelinePromise.catch(() => {
        loadFailed = true;
        pipelinePromise = null;
      });
    } catch (e) {
      console.error('[embeddings] model load failed:', e);
      loadFailed = true;
      return null;
    }
  }
  try {
    const pipe = await pipelinePromise as (text: string, opts: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(result.data);
  } catch (e) {
    console.error('[embeddings] embed failed:', e);
    loadFailed = true;
    pipelinePromise = null;
    return null;
  }
}

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
