/**
 * Host probes the health hooks share (GH 1692): `command -v` on PATH, a
 * blocking `sleep`, and the payload as bash's `$(cat)` leaves it.
 */
import { accessSync, constants, statSync } from 'node:fs';
/** `command -v <name>` for a plain command: an executable file in a PATH dir ("" is "."). */
export function commandOnPath(name, env = process.env) {
    for (const dir of (env.PATH ?? '').split(':')) {
        const candidate = `${dir === '' ? '.' : dir}/${name}`;
        try {
            if (!statSync(candidate).isFile())
                continue;
            accessSync(candidate, constants.X_OK);
            return true;
        }
        catch {
            /* next dir */
        }
    }
    return false;
}
/** `sleep <seconds>`: a non-negative decimal, anything else sleeps not at all (sleep fails). */
export function sleepSeconds(raw) {
    if (!/^(\d+\.?\d*|\.\d+)$/.test(raw))
        return;
    const ms = Math.round(Number(raw) * 1000);
    if (ms > 0)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** bash's `$(cat)`: NUL bytes dropped, trailing newlines stripped. */
export function commandSubstitution(text) {
    return text.replaceAll('\0', '').replace(/\n+$/, '');
}
/** The first line of <text> as `sed -n 1p` prints it, without its newline. */
export function firstLine(text) {
    const nl = text.indexOf('\n');
    return nl < 0 ? text : text.slice(0, nl);
}
/** Byte-order comparison of two strings (sort under LC_ALL=C). */
export function byteCompare(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
//# sourceMappingURL=host.js.map