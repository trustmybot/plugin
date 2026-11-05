// A refusing sqlite3 on PATH for test runners, so no test can open the real
// project's trajectory DB.
//
// The real project is the TMB workspace that holds the checkout: the protected
// set is <dir>/.claude/tmb for the checkout, its main checkout (git
// --git-common-dir) and every ancestor of both, plus the toplevel of the
// checkout's parent when that is a git repo. The shim logs every invocation and
// refuses (exit 1 + stderr) any argument under a protected dir (a path, a
// file: URI, a relative path against the caller's cwd, or a quoted path inside
// SQL such as ATTACH); every other invocation runs the real sqlite3 with the
// same arguments, stdio and exit status. After the suite, liveDbShimCheck fails
// with the refusal list.
//
// Usage:
//   import { liveDbShimStart, liveDbShimCheck } from '../lib/live-db-shim.mjs';
//   liveDbShimStart('<checkout>', '<state dir>');   // prepends the shim to PATH
//   ...run the suite...
//   if (!liveDbShimCheck('<suite name>')) fail = 1;
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

function ancestors(dir) {
  const out = [];
  for (let d = dir; d; d = dirname(d)) {
    out.push(d);
    if (d === '/') break;
  }
  return out;
}

function gitLine(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.replace(/\n+$/, '') : '';
}

function physicalDir(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return '';
  }
}

/** Every protected `<dir>/.claude/tmb` for <checkout>, deduped. */
export function protectedDirs(checkout) {
  const real = realpathSync(checkout);
  const common = gitLine(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common ? physicalDir(dirname(common)) : '';
  const parentTop = gitLine(dirname(real), ['rev-parse', '--show-toplevel']);
  const dirs = [...ancestors(real), ...(main ? ancestors(main) : []), ...(parentTop ? [parentTop] : [])];
  return [...new Set(dirs)].map((d) => `${d === '/' ? '' : d}/.claude/tmb`);
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return '';
}

const SHIM = String.raw`(async () => {
  const { appendFileSync, statSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const args = process.argv.slice(2);
  const here = process.cwd();
  let cwd = here;
  const pwd = process.env.PWD;
  if (pwd && pwd.startsWith('/')) {
    try {
      const a = statSync(pwd);
      const b = statSync(here);
      if (a.dev === b.dev && a.ino === b.ino) cwd = pwd;
    } catch {}
  }
  const line = cwd + '\t' + args.join(' ') + '\n';
  appendFileSync(LOG, line);
  const stripUri = (s) => s.split('?')[0];
  for (const arg of args) {
    let abs;
    if (arg.startsWith('file://')) abs = stripUri(arg.slice(7));
    else if (arg.startsWith('file:')) abs = stripUri(arg.slice(5));
    else if (arg.startsWith('/')) abs = arg;
    else if (arg.startsWith('-')) abs = '';
    else abs = cwd + '/' + arg;
    for (const p of PROTECTED) {
      const under = abs === p || abs.startsWith(p + '/');
      const inside = ["'", '"', ' ', '='].some((c) => arg.endsWith(c + p) || arg.includes(c + p + '/'));
      if (!under && !inside) continue;
      appendFileSync(REFUSALS, line);
      process.stderr.write('sqlite3-shim: refused ' + arg + ' (under the real project DB dir ' + p + ')\n');
      process.exit(1);
    }
  }
  const r = spawnSync(REAL, args, { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write('sqlite3-shim: ' + r.error.message + '\n');
    process.exit(127);
  }
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
})();
`;

/**
 * Writes <state>/bin/sqlite3 (a node executable) and prepends <state>/bin to PATH.
 * Sets LIVE_DB_SHIM_LOG and LIVE_DB_SHIM_REFUSALS; does nothing else when no real sqlite3 is on PATH.
 */
export function liveDbShimStart(checkout, state) {
  const real = onPath('sqlite3');
  const log = join(state, 'sqlite3-calls.log');
  const refusals = join(state, 'sqlite3-refusals.log');
  process.env.LIVE_DB_SHIM_LOG = log;
  process.env.LIVE_DB_SHIM_REFUSALS = refusals;
  if (!real) return;
  const bin = join(state, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');
  writeFileSync(refusals, '');
  const dirs = protectedDirs(checkout);
  writeFileSync(join(state, 'protected'), dirs.map((d) => `${d}\n`).join(''));
  const consts = [
    `const LOG = ${JSON.stringify(log)};`,
    `const REFUSALS = ${JSON.stringify(refusals)};`,
    `const REAL = ${JSON.stringify(real)};`,
    `const PROTECTED = ${JSON.stringify(dirs)};`,
  ].join('\n');
  const shim = join(bin, 'sqlite3');
  writeFileSync(shim, `#!/usr/bin/env node\n${consts}\n${SHIM}`);
  chmodSync(shim, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
}

function lineCount(path) {
  if (!path || !existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').length - 1;
}

/** Prints the live-DB verdict for <suite>; false when the shim refused any call. */
export function liveDbShimCheck(suite) {
  const refusals = process.env.LIVE_DB_SHIM_REFUSALS ?? '';
  if (refusals && existsSync(refusals) && statSync(refusals).size > 0) {
    writeSync(1, `\nFAIL live DB: ${suite} ran sqlite3 against the real project DB (${lineCount(refusals)} refusals; cwd<TAB>args):\n`);
    writeSync(1, readFileSync(refusals, 'utf8'));
    return false;
  }
  writeSync(1, `live DB: 0 sqlite3 refusals from ${suite} (${lineCount(process.env.LIVE_DB_SHIM_LOG)} calls checked)\n`);
  return true;
}
