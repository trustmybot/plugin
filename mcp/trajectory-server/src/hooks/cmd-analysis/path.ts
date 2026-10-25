/** tmb_path_canonical and tmb_payload_cwd (cmd-analysis.sh). */
import { existsSync, lstatSync, readlinkSync } from 'node:fs';

const MAX_HOPS = 40;

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * An absolute path with every symlink of its existing prefix followed (at
 * most 40 hops) and `.` / `..` collapsed, the missing tail kept as written
 * (realpath -m): /tmp/x and /private/tmp/x are one path on macOS. A relative
 * path comes back unchanged.
 */
export function pathCanonical(path: string): string {
  if (!path.startsWith('/')) return path;
  let cur = '';
  let tail = '';
  let rest = path;
  let hops = 0;
  while (rest !== '') {
    rest = rest.replace(/^\//, '');
    const slash = rest.indexOf('/');
    const part = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? '' : rest.slice(slash + 1);
    if (part === '' || part === '.') continue;
    if (tail !== '') {
      tail = part === '..' ? tail.replace(/\/[^/]*$/, '') : `${tail}/${part}`;
      continue;
    }
    if (part === '..') {
      cur = cur.replace(/\/[^/]*$/, '');
      continue;
    }
    const next = `${cur}/${part}`;
    if (hops < MAX_HOPS && isLink(next)) {
      hops++;
      const link = readlinkSync(next);
      if (link.startsWith('/')) cur = '';
      rest = `${link}/${rest}`;
      continue;
    }
    if (existsSync(next)) cur = next;
    else tail = `/${part}`;
  }
  return cur + tail || '/';
}

/** The hook payload's .cwd when it is a non-empty string, else $PWD. */
export function payloadCwd(json: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const cwd: unknown = (JSON.parse(json) as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === 'string') {
      const c = cwd.replace(/\n+$/, '');
      if (c !== '') return c;
    }
  } catch {
    // not JSON: jq prints nothing for it either
  }
  return env.PWD ?? '';
}
