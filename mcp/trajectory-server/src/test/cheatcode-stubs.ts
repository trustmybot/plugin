// Offline stand-ins for the cheatcode engines' registry fetches and the claude CLI, shared by the cheatcode suites.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FetchStub {
  fetchImpl: typeof fetch;
  requests: string[];
}

// A fetch that records every URL and answers route(url), or a 404 when route returns null.
export function stubFetch(route: (url: string) => string | null): FetchStub {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    const body = route(url);
    return body === null ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

// GitHub REST bodies read from <dir>/<owner>_<repo>.{repo,contents,trees,contents.<path with / as _>}.json.
export function githubDirFetch(dir: string): FetchStub {
  return stubFetch((url) => {
    const m = /^https?:\/\/api\.github\.com\/repos\/(.*)$/.exec(url);
    if (!m) return null;
    const rest = (m[1] ?? '').replace(/\?.*$/, '').replace(/\/+$/, '');
    const [owner = '', repo = '', ...tailParts] = rest.split('/');
    const tail = tailParts.join('/');
    const base = join(dir, `${owner}_${repo}`);
    let file: string;
    if (tail === '') file = `${base}.repo.json`;
    else if (tail === 'contents') file = `${base}.contents.json`;
    else if (tail.startsWith('contents/')) file = `${base}.contents.${tail.slice('contents/'.length).replace(/\//g, '_')}.json`;
    else if (tail.startsWith('git/trees/')) file = `${base}.trees.json`;
    else return null;
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  });
}

export interface ClaudeShim {
  dir: string;
  argvLog: string;
  pwdLog: string;
  env: NodeJS.ProcessEnv;
  calls(): string[];
  cwds(): string[];
  reset(): void;
}

// A `claude` on PATH that logs each call's argv and cwd, then runs body (a bash case on "$*").
export function claudeShim(root: string, body = ''): ClaudeShim {
  const dir = join(root, 'shim');
  mkdirSync(dir, { recursive: true });
  const argvLog = join(root, 'claude-argv.log');
  const pwdLog = join(root, 'claude-pwd.log');
  const shim = join(dir, 'claude');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CLAUDE_ARGV_LOG"\npwd -P >> "$CLAUDE_PWD_LOG"\n${body}\nexit 0\n`,
  );
  chmodSync(shim, 0o755);
  const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l !== '') : []);
  const reset = (): void => {
    writeFileSync(argvLog, '');
    writeFileSync(pwdLog, '');
  };
  reset();
  return {
    dir,
    argvLog,
    pwdLog,
    env: cleanEnv({ PATH: `${dir}:/usr/bin:/bin`, CLAUDE_ARGV_LOG: argvLog, CLAUDE_PWD_LOG: pwdLog }),
    calls: () => lines(argvLog),
    cwds: () => lines(pwdLog),
    reset,
  };
}

// The process env with every cheatcode fixture variable removed, so a suite never inherits one.
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TMB_CHEATCODE_')) delete env[k];
  return { ...env, ...extra };
}

export function tempWorkspace(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
