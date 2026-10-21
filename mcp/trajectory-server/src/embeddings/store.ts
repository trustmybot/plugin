import type { TrajectoryDB } from '../db.js';
import { embed, MODEL_ID } from './model.js';

export function packEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function unpackEmbedding(b: Uint8Array): Float32Array {
  // node:sqlite returns BLOBs as Uint8Array, which has no Buffer methods like
  // readFloatLE. DataView reads floats from any ArrayBuffer-backed view
  // regardless of byteOffset alignment (the zero-copy Float32Array view would
  // throw RangeError on a non-4-aligned offset). LE matches packEmbedding. (#285)
  const out = new Float32Array(b.byteLength / 4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const INSERT_SQL: Record<string, string> = {
  discussions: 'INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
  audit:       'INSERT OR REPLACE INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
  wm_directories: 'INSERT OR REPLACE INTO wm_directories_embeddings (dir_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
  wm_files:       'INSERT OR REPLACE INTO wm_files_embeddings (file_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
};

const SELECT_SQL: Record<string, string> = {
  discussions: 'SELECT discussion_id AS rowid, embedding FROM discussions_embeddings WHERE model_id = ?',
  audit:       'SELECT audit_id AS rowid, embedding FROM audit_embeddings WHERE model_id = ?',
  wm_directories:
    'SELECT e.dir_id AS rowid, e.embedding FROM wm_directories_embeddings e JOIN wm_directories d ON d.id = e.dir_id WHERE e.model_id = ? AND d.repo = ?',
  wm_files:
    'SELECT e.file_id AS rowid, e.embedding FROM wm_files_embeddings e JOIN wm_files f ON f.id = e.file_id WHERE e.model_id = ? AND f.repo = ?',
};

export type EmbeddableTable = 'discussions' | 'audit' | 'wm_directories' | 'wm_files';

export type WorldModelEmbeddableTable = Extract<EmbeddableTable, `wm_${string}`>;

/** World-model text is the path plus its summary or purpose, untrusted-content framing removed. */
export function worldModelEmbedText(path: string, body: string | null): string {
  const text = (body ?? '').replace(/<\/?untrusted-content[^>]*>/g, '').trim();
  return text ? `${path}: ${text}` : path;
}

export function auditEmbedText(summary: string, contentJson: string | null): string {
  return contentJson && contentJson !== '{}' ? `${summary} ${contentJson}` : summary;
}

export async function embedAndStore(
  db: TrajectoryDB,
  table: EmbeddableTable,
  rowid: number,
  text: string,
): Promise<void> {
  const v = await embed(text);
  if (v === null || !db.isOpen) return;
  const sql = INSERT_SQL[table]!;
  db.run(sql, [rowid, packEmbedding(v), MODEL_ID, new Date().toISOString()]);
}

export async function topKByCosine(
  db: TrajectoryDB,
  table: EmbeddableTable,
  query: string,
  k: number,
  filterParams: unknown[] = [],
): Promise<Array<{ rowid: number; score: number }>> {
  const qv = await embed(query);
  if (qv === null) return [];
  const sql = SELECT_SQL[table]!;
  const rows = db.all<{ rowid: number; embedding: Buffer }>(sql, [MODEL_ID, ...filterParams]);
  const scored = rows
    .map((r) => {
      const v = unpackEmbedding(r.embedding);
      if (v.length !== qv.length) return null;
      return { rowid: r.rowid, score: cosine(qv, v) };
    })
    .filter((r): r is { rowid: number; score: number } => r !== null);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
