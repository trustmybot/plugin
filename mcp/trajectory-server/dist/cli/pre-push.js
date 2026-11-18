/**
 * `cli.js pre-push` (GH 3281): the entry git's pre-push hook calls, with
 * git's hook contract.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" pre-push <remote-name> <url>
 *
 * stdin carries one `<local-ref> <local-sha> <remote-ref> <remote-sha>` line
 * per ref the push sends. A push from outside an agent session exits 0 with
 * stdin unread and the DB untouched. Slice 2 is observe mode: an agent's push
 * is judged by hooks/pre-push/judge.ts and the verdict recorded as one
 * prepush_observed row, legacy verdict admit (the command-text judge let the
 * push reach git); it exits 0 whatever the verdict, a judge throw or a stdin
 * read error recorded as hook verdict error.
 */
import { readFileSync } from 'node:fs';
import { isAgentSession } from '../hooks/pre-push/judge.js';
import { observePush } from '../hooks/pre-push/observe.js';
import { shellPwd } from '../hooks/lib/project-env.js';
const CALLER = 'pre-push';
function readRefLines() {
    try {
        return { refLines: readFileSync(0, 'utf8') };
    }
    catch (error) {
        return { refLines: null, readError: error.message };
    }
}
export async function prePush(argv, env, io) {
    if (!isAgentSession(env))
        return 0;
    // git runs the hook at the top of the checkout being pushed, so the cwd names the repo.
    const dir = shellPwd(env);
    try {
        const r = await observePush({ dir, remote: argv[0] ?? '', ...readRefLines(), legacyVerdict: 'admit', sessionId: env.CLAUDE_CODE_SESSION_ID ?? '', caller: CALLER }, env);
        if (!r.ok)
            io.err(`tmb: pre-push observe row not written: ${r.error}\n`);
    }
    catch (error) {
        io.err(`tmb: pre-push observe row not written: ${error.message}\n`);
    }
    return 0;
}
//# sourceMappingURL=pre-push.js.map