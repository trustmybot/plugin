/**
 * tmb_git_commit_message of scripts/hooks/lib/cmd-analysis.sh (GH 1692): the
 * first `git commit` statement of a command's executable skeleton and the
 * message its argv carries. git.ts keeps its statement listing private, so the
 * listing is repeated here on the same encode.ts / statements.ts skeleton.
 */
import type { Parser } from 'web-tree-sitter';
import { decode, encode } from './encode.js';
import { gitSubcommand } from './git.js';
import { bashParser } from './parser.js';
import { statementsEnc } from './statements.js';

const MAX_DEPTH = 3;
const SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;

export type CommitMessage =
  | { ok: true; subcommand: string; message: string }
  | { ok: false };

function readWords(s: string): string[] {
  return (s.split('\n')[0] ?? '').split(/[ \t]+/).filter((w) => w !== '');
}

function readStmt(stmt: string): string {
  return stmt.replace(/^\t+|\t+$/g, '');
}

function inner(stmt: string): string {
  const words = readWords(stmt);
  const argv0 = words[0] ?? '';
  if (SHELL.test(argv0)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-c' || /^-[a-zA-Z].*c$/s.test(w) || /^-c[a-zA-Z]/.test(w)) return words[i + 1] ?? '';
      if (!w.startsWith('-')) return '';
    }
    return '';
  }
  if (argv0 === 'eval') return (stmt.startsWith('eval') ? stmt.slice(4) : stmt).replace(/^ /, '');
  return '';
}

/** _tmb_cmd_statements_enc <cmd> <base> <depth>: the encoded statements, null when a body does not parse. */
function statements(parser: Parser, cmd: string, base: string, depth: number, home: string): string[] | null {
  if (cmd.trim() === '') return [];
  const encoded = encode(parser, cmd);
  if (!encoded.ok) return null;
  const out: string[] = [];
  for (const record of statementsEnc(encoded.text, base, home, false)) {
    const stmt = readStmt(record.stmt);
    if (stmt === '') continue;
    const body = depth < MAX_DEPTH && !record.dir.startsWith('=') ? inner(stmt) : '';
    if (body === '') {
      out.push(stmt);
      continue;
    }
    const nested = statements(parser, decode(body).replace(/\n+$/, ''), record.dir, depth + 1, home);
    if (nested === null) return null;
    out.push(...nested);
  }
  return out;
}

/** The -m / -m<msg> / --message[=]<msg> / -<flags>m argument of a commit subcommand's words, "" when none. */
function messageArg(subcommand: string): string {
  const words = readWords(subcommand).slice(1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '-m' || w === '--message') return words[i + 1] ?? '';
    if (w.startsWith('--message=')) return w.slice('--message='.length);
    if (w.startsWith('-m')) return w.slice(2);
    if (/^-[a-zA-Z].*m$/s.test(w)) return words[i + 1] ?? '';
  }
  return '';
}

/**
 * The first `git commit` statement's subcommand ("" when the command has
 * none) and its decoded message ("" when there is none or it is built by
 * $( ) or backticks); ok false when tree-sitter-bash cannot parse it.
 */
export async function gitCommitMessage(command: string, env: NodeJS.ProcessEnv = process.env): Promise<CommitMessage> {
  const parser = await bashParser();
  const listed = statements(parser, command, '-', 0, env.HOME ?? '');
  if (listed === null) return { ok: false };
  for (const stmt of listed) {
    const subcommand = gitSubcommand(stmt);
    if (subcommand !== 'commit' && !subcommand.startsWith('commit ')) continue;
    const message = decode(messageArg(subcommand)).replace(/\n+$/, '');
    const built = message.includes('$(') || message.includes('`');
    return { ok: true, subcommand, message: built ? '' : message };
  }
  return { ok: true, subcommand: '', message: '' };
}
