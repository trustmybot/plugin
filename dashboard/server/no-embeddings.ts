// The dashboard's embedding loader: the model never loads here, so a Human
// comment is stored without its embedding and the trajectory server's backfill
// embeds it on its next start.
import type { EmbeddingLoader } from '../../mcp/trajectory-server/src/embeddings/model.ts';

export const noEmbeddings: EmbeddingLoader = () => Promise.reject(new Error('embeddings are not loaded in the dashboard'));
