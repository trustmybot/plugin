/**
 * `cli.js pre-push` (GH 3281): the entry git's pre-push hook calls, with
 * git's hook contract.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" pre-push <remote-name> <url>
 *
 * stdin carries one `<local-ref> <local-sha> <remote-ref> <remote-sha>` line
 * per ref the push sends. A push from outside an agent session exits 0 with
 * stdin unread and the DB untouched; an agent's push is judged by
 * hooks/pre-push/judge.ts. Exit 0 admits the push; exit 1 denies it, with the
 * reason on stderr. Nothing installs the hook yet (GH 3281 S2).
 */
import { readFileSync } from 'node:fs';
import { isAgentSession, judgePrePush } from '../hooks/pre-push/judge.js';
import { shellPwd } from '../hooks/lib/project-env.js';
import type { CliIo } from './fallback-db.js';

const DENY = 1;

export async function prePush(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  if (!isAgentSession(env)) return 0;
  let stdin: string;
  try {
    stdin = readFileSync(0, 'utf8');
  } catch (error) {
    io.err(`BLOCKED: pre-push gate: could not read git's ref lines on stdin (${(error as Error).message})\n`);
    return DENY;
  }
  // git runs the hook at the top of the checkout being pushed, so the cwd names the repo.
  const verdict = await judgePrePush(argv[0] ?? '', stdin, shellPwd(env), env);
  if (verdict.admit) return 0;
  io.err(`${verdict.reason}\n`);
  return DENY;
}
