/**
 * The project-environment half of scripts/hooks/lib/query-task.sh (GH 1692):
 * the state host dir, the DB filename, the plugin name and the paths the .sh
 * reads from CLAUDE_PROJECT_DIR, HOME and the shell's working directory, each
 * resolved from the `env` a caller passes (process.env in a gate).
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const TMB_STATE_HOST_DIR = '.claude';
export const TMB_DB_FILENAME = 'trajectory.db';
const DEFAULT_PLUGIN_NAME = 'tmb';

/** `dirname` as macOS prints it: "" → ".", "a/" → ".", "//a" → "/". */
export function posixDirname(path: string): string {
  if (path === '') return '.';
  let p = path.replace(/\/+$/, '');
  if (p === '') return '/';
  const slash = p.lastIndexOf('/');
  if (slash < 0) return '.';
  p = p.slice(0, slash).replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** `basename` as macOS prints it: "/" → "/", "a//" → "a", "" → "". */
export function posixBasename(path: string): string {
  if (path === '') return '';
  const p = path.replace(/\/+$/, '');
  if (p === '') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

/** jq -r's rendering of a non-null JSON value. */
export function jqRawText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** tmb_plugin_name: `.name // "tmb"` of $CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json, else "tmb". */
export function pluginName(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CLAUDE_PLUGIN_ROOT ?? '';
  if (root === '') return DEFAULT_PLUGIN_NAME;
  const manifest = `${root}/.claude-plugin/plugin.json`;
  let text: string;
  try {
    if (!statSync(manifest).isFile()) return DEFAULT_PLUGIN_NAME;
    text = readFileSync(manifest, 'utf8');
  } catch {
    return DEFAULT_PLUGIN_NAME;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_PLUGIN_NAME;
    const name = (parsed as Record<string, unknown>).name;
    return name === undefined || name === null || name === false ? DEFAULT_PLUGIN_NAME : jqRawText(name);
  } catch {
    return DEFAULT_PLUGIN_NAME;
  }
}

/** CLAUDE_PROJECT_DIR, or "" when unset. */
export function claudeProjectDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_DIR ?? '';
}

/** $HOME, or "" when unset. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? '';
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * bash's `pwd`: the logical $PWD when it names the current directory, else
 * the physical one.
 */
export function shellPwd(env: NodeJS.ProcessEnv = process.env): string {
  const cwd = process.cwd();
  const pwd = env.PWD ?? '';
  return pwd !== '' && isAbsolute(pwd) && sameDir(pwd, cwd) ? pwd : cwd;
}

/** <project>/.claude/<plugin>: the state dir a project's DB lives in. */
export function stateDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${root}/${TMB_STATE_HOST_DIR}/${pluginName(env)}`;
}

/** The install root: the ancestor of this module holding .claude-plugin/plugin.json. */
export function installRoot(fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    try {
      if (statSync(join(dir, '.claude-plugin', 'plugin.json')).isFile()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = posixDirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
