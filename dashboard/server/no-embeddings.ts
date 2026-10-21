// Stands in for @huggingface/transformers in the dashboard bundle: the model
// never loads here, so a Human comment is stored without its embedding and the
// trajectory server's backfill embeds it on its next start.
export const env: Record<string, unknown> = {};

export function pipeline(): Promise<never> {
  return Promise.reject(new Error('embeddings are not loaded in the dashboard'));
}
