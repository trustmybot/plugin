import { embed, MODEL_ID } from './model.js';
export function packEmbedding(v) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function unpackEmbedding(b) {
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
export function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++)
        s += a[i] * b[i];
    return s;
}
const INSERT_SQL = {
    discussions: 'INSERT OR REPLACE INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
    audit: 'INSERT OR REPLACE INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
    file_registry: 'INSERT OR REPLACE INTO file_registry_embeddings (file_registry_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
};
const SELECT_SQL = {
    discussions: 'SELECT discussion_id AS rowid, embedding FROM discussions_embeddings',
    audit: 'SELECT audit_id AS rowid, embedding FROM audit_embeddings',
    file_registry: 'SELECT file_registry_id AS rowid, embedding FROM file_registry_embeddings',
};
export async function embedAndStore(db, table, rowid, text) {
    const v = await embed(text);
    if (v === null)
        return;
    const sql = INSERT_SQL[table];
    db.run(sql, [rowid, packEmbedding(v), MODEL_ID, new Date().toISOString()]);
}
export async function topKByCosine(db, table, query, k) {
    const qv = await embed(query);
    if (qv === null)
        return [];
    const sql = SELECT_SQL[table];
    const rows = db.all(sql);
    const scored = rows.map((r) => ({
        rowid: r.rowid,
        score: cosine(qv, unpackEmbedding(r.embedding)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}
//# sourceMappingURL=store.js.map