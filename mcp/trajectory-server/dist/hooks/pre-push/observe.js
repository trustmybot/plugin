/**
 * The prepush_observed row (GH 3281 slice 2), from one of three sources:
 *  - pre_push and legacy_deny: for one agent push, the verdict the pre-push
 *    hook judge would give beside the one the command-text judge
 *    (git-push-guard) gave. observePush is the one place that judges and
 *    writes it; its two callers only supply the push. Exactly one row per
 *    push: `cli.js pre-push` observes when the push reached git (legacy
 *    admit), git-push-guard when it denied the push (legacy deny), so the two
 *    callers never see the same push.
 *  - guard_fail_closed: a prepush-hook-guard deny of a command it could not
 *    read literally (observeGuardDeny), so the cost of failing closed counts.
 * writeObserved, shared by both, adds the repo and the hook's live state.
 */
import { auditAppend } from '../lib/audit.js';
import { dbPath } from '../lib/db.js';
import { prepushHookLive } from '../lib/prepush-hook.js';
import { repoGitRoot, repoNameForRoot } from '../lib/repo.js';
import { judgePrePush, parsePushRefs } from './judge.js';
const refJson = (ref) => ({ local_ref: ref.localRef, local_sha: ref.localSha, remote_ref: ref.remoteRef, remote_sha: ref.remoteSha });
/** The hook judge's verdict on the push; a read error or a judge throw is 'error'. */
async function hookVerdict(o, env, judge) {
    if (o.refLines === null)
        return { outcome: 'error', reason: `could not read git's ref lines on stdin (${o.readError ?? 'unknown error'})` };
    try {
        const v = await judge(o.remote, o.refLines, o.dir, env);
        return v.admit ? { outcome: 'admit', reason: '' } : { outcome: 'deny', reason: v.reason };
    }
    catch (error) {
        return { outcome: 'error', reason: `the pre-push judge threw: ${error.message}` };
    }
}
/** Writes one prepush_observed row of <fields> for the checkout at <dir>; a DB that does not resolve is a failed write. */
async function writeObserved(fields, where, env) {
    const db = dbPath(env) ?? '';
    const root = await repoGitRoot(where.dir, env);
    const repo = (db === '' ? '' : repoNameForRoot(db, root, env)) || root || where.dir;
    const content = {
        repo,
        ...fields,
        hook_live: await prepushHookLive(where.dir, env),
        session_id: where.sessionId === '' ? null : where.sessionId,
    };
    return auditAppend(db, {
        issueId: '-1',
        branchId: '',
        fromNode: `hook:${where.caller}`,
        eventType: 'prepush_observed',
        summary: where.summary,
        contentJson: JSON.stringify(content),
    }, { caller: where.caller, env });
}
/**
 * Judges <o>'s push with the hook judge (<judge>, judgePrePush but in a test)
 * and writes its one prepush_observed row.
 */
export async function observePush(o, env, judge = judgePrePush) {
    const judged = await hookVerdict(o, env, judge);
    return writeObserved({
        source: o.legacyVerdict === 'admit' ? 'pre_push' : 'legacy_deny',
        deny_class: null,
        command_form: null,
        remote: o.remote,
        refs: (parsePushRefs(o.refLines ?? '') ?? []).map(refJson),
        hook_verdict: judged.outcome,
        reason: judged.reason,
        legacy_verdict: o.legacyVerdict,
        agree: judged.outcome === o.legacyVerdict,
    }, {
        dir: o.dir,
        sessionId: o.sessionId,
        caller: o.caller,
        summary: `push to ${o.remote || 'an unnamed remote'}: hook judge ${judged.outcome}, command-text judge ${o.legacyVerdict}`,
    }, env);
}
/** Writes the guard_fail_closed row for one prepush-hook-guard deny of a command it could not read literally. */
export async function observeGuardDeny(o, env) {
    return writeObserved({
        source: 'guard_fail_closed',
        deny_class: o.denyClass,
        command_form: o.commandForm,
        remote: null,
        refs: [],
        hook_verdict: null,
        reason: o.reason,
        legacy_verdict: null,
        agree: null,
    }, { dir: o.dir, sessionId: o.sessionId, caller: o.caller, summary: `hook-skip guard failed closed (${o.denyClass}): ${o.commandForm}` }, env);
}
//# sourceMappingURL=observe.js.map