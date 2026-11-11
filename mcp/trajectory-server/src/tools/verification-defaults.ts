// GH 2570: a repo's .config/tmb/verification-defaults.json {"version":1,"commands":["..."]},
// read at the cut base, appends its commands to every task_provision / task_retry / task_reopen /
// task_update_spec verification[] (the last two since GH 2866).
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { gitUnanswered, runGit } from '../utils/git-run.js';

export const VERIFICATION_DEFAULTS_FILE = '.config/tmb/verification-defaults.json';

export type VerificationDefaults = { commands: string[] } | { error: string };

function gitFailure(res: { error?: Error; stderr?: string | null; status: number | null }): string {
  return res.error?.message.split('\n')[0] || (res.stderr ?? '').trim().split('\n')[0] || `git exited ${res.status}`;
}

function parseDefaults(raw: string): VerificationDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'must be a JSON object {"version":1,"commands":[...]}' };
  }
  const { version, commands } = parsed as { version?: unknown; commands?: unknown };
  if (version !== 1) return { error: `version must be 1, got ${JSON.stringify(version) ?? 'none'}` };
  if (!Array.isArray(commands) || commands.length === 0 || !commands.every((c) => typeof c === 'string' && c.trim() !== '')) {
    return { error: 'commands must be a non-empty array of non-empty strings' };
  }
  return { commands: commands as string[] };
}

// The file as committed at `ref`; the working tree never counts. No repo, no
// ref or no file at a resolving ref means no defaults.
export function readVerificationDefaults(repoPath: string | null, ref: string | null): VerificationDefaults {
  if (!repoPath || !ref) return { commands: [] };
  const shown = runGit(repoPath, ['show', `${ref}:${VERIFICATION_DEFAULTS_FILE}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitUnanswered(shown)) return { error: `git show failed: ${gitFailure(shown)}` };
  if (shown.status === 0) return parseDefaults(shown.stdout);
  const head = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (gitUnanswered(head) || head.status !== 0) return { error: `git cannot resolve ${ref}: ${gitFailure(shown)}` };
  return { commands: [] };
}

export function appendVerificationDefaults(
  verification: readonly string[],
  defaults: readonly string[],
): { verification: string[]; added: string[] } {
  const present = new Set(verification);
  const added: string[] = [];
  for (const command of defaults) {
    if (present.has(command)) continue;
    present.add(command);
    added.push(command);
  }
  return { verification: [...verification, ...added], added };
}

export function verificationDefaultsResult(tool: string, ref: string | null, problem: string): CallToolResult {
  const message =
    `${tool}: ${VERIFICATION_DEFAULTS_FILE} at ${ref ?? '(no ref)'} is invalid: ${problem}. ` +
    `Fix the file on the base branch (format {"version":1,"commands":["..."]}) or remove it. Nothing was written.`;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: 'verification_defaults_invalid', message, ref, file: VERIFICATION_DEFAULTS_FILE }) }],
  };
}
