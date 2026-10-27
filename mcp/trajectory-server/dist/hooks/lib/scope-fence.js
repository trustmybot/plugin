/**
 * TypeScript port of scripts/hooks/lib/scope-fence.sh (GH 1692): a task's
 * typed files[] as a path list, used to note, never deny, a write outside it.
 * Each entry, trailing slashes stripped, covers itself and everything beneath
 * it; any tests/ entry covers all of tests/.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { gateRead, GATE_READ_ERROR, sqlInt, stateDir } from './db.js';
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 24;
        for (let k = 0; k < 8; k++)
            c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
        table[i] = c >>> 0;
    }
    return table;
})();
/** The first field of POSIX `cksum`: the CRC-32 of the bytes, then of their length. */
export function cksum(text) {
    const bytes = Buffer.from(text, 'utf8');
    let crc = 0;
    const step = (b) => {
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
    };
    for (const b of bytes)
        step(b);
    for (let n = bytes.length; n > 0; n = Math.floor(n / 256))
        step(n & 0xff);
    return String(~crc >>> 0);
}
/** `jq -r '.[]?'`: each element (or object value) as jq prints it raw. */
function rawElements(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return [];
    }
    let items = [];
    if (Array.isArray(parsed))
        items = parsed;
    else if (parsed !== null && typeof parsed === 'object')
        items = Object.values(parsed);
    return items.map((v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
}
/** Whether `sort` collates by the locale's LC_COLLATE table rather than by byte. */
export function localeCollates(env) {
    const locale = env.LC_ALL || env.LC_COLLATE || env.LANG || 'C';
    return !locale.includes('/') && locale !== 'C' && locale !== 'POSIX' && existsSync(`/usr/share/locale/${locale}/LC_COLLATE`);
}
/** `sort -u` over <items> under <env>'s locale. */
export function sortUnique(items, env = process.env) {
    const compare = localeCollates(env)
        ? new Intl.Collator('en').compare
        : (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    const out = [];
    for (const item of [...items].sort(compare)) {
        if (out.length === 0 || compare(out[out.length - 1], item) !== 0)
            out.push(item);
    }
    return out;
}
export class ScopeFence {
    env;
    state = 'none';
    dirs = [];
    tests = false;
    constructor(env = process.env) {
        this.env = env;
    }
    /** tmb_scope_fence_load <db> <task_id>. */
    load(db, taskId) {
        this.state = 'none';
        this.dirs = [];
        this.tests = false;
        const task = sqlInt(taskId);
        if (task === '')
            return;
        const files = gateRead(db, `SELECT COALESCE(files, '[]') FROM tasks WHERE id = ${task} LIMIT 1;`, this.env);
        if (files === GATE_READ_ERROR) {
            this.state = 'error';
            return;
        }
        if (files === '')
            return;
        for (const line of rawElements(files).join('\n').split('\n')) {
            const dir = line.replace(/\/+$/, '');
            if (dir === '')
                continue;
            this.dirs.push(dir);
            if (dir === 'tests' || dir.startsWith('tests/'))
                this.tests = true;
        }
        this.state = this.dirs.length === 0 ? 'empty' : 'ok';
    }
    /** tmb_scope_fence_allows <rel>: the path is a listed entry or beneath one. */
    allows(rel) {
        if (this.dirs.some((allowed) => rel === allowed || rel.startsWith(`${allowed}/`)))
            return true;
        return this.tests && (rel === 'tests' || rel.startsWith('tests/'));
    }
    /** tmb_scope_fence_note <task_id> <rel>: the note the first time this task writes <rel>, "" after. */
    note(taskId, rel) {
        const task = sqlInt(taskId);
        if (task === '' || rel === '')
            return '';
        const state = stateDir(this.env);
        if (state === null)
            return '';
        const parent = `${state}/locks/scope-notes/${task}`;
        try {
            mkdirSync(parent, { recursive: true });
            mkdirSync(`${parent}/${cksum(rel)}`);
        }
        catch {
            return '';
        }
        const dirs = sortUnique(this.dirs, this.env).join(',').replaceAll(',', ', ');
        return `${rel} is outside this task's files[] (${dirs}); list it and why in your report`;
    }
}
//# sourceMappingURL=scope-fence.js.map