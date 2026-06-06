import type { TrajectoryDB } from '../db.js';
import { embed, MODEL_ID } from './model.js';

export function packEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function unpackEmbedding(b: Buffer): Float32Array {
  // Copy rather than alias b.buffer: a DB-read Buffer can have a non-4-aligned
  // byteOffset, which makes a zero-copy Float32Array view throw RangeError. (#285)
  const out = new Float32Array(b.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
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
};

const SELECT_SQL: Record<string, string> = {
  discussions: 'SELECT discussion_id AS rowid, embedding FROM discussions_embeddings',
  audit:       'SELECT audit_id AS rowid, embedding FROM audit_embeddings',
};

export type EmbeddableTable = 'discussions' | 'audit';

export async function embedAndStore(
  db: TrajectoryDB,
  table: EmbeddableTable,
  rowid: number,
  text: string,
): Promise<void> {
  const v = await embed(text);
  if (v === null) return;
  const sql = INSERT_SQL[table]!;
  db.run(sql, [rowid, packEmbedding(v), MODEL_ID, new Date().toISOString()]);
}

export async function topKByCosine(
  db: TrajectoryDB,
  table: EmbeddableTable,
  query: string,
  k: number,
): Promise<Array<{ rowid: number; score: number }>> {
  const qv = await embed(query);
  if (qv === null) return [];
  const sql = SELECT_SQL[table]!;
  const rows = db.all<{ rowid: number; embedding: Buffer }>(sql);
  const scored = rows.map((r) => ({
    rowid: r.rowid,
    score: cosine(qv, unpackEmbedding(r.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
