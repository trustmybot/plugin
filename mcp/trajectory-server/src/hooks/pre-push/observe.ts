/**
 * The prepush_observed row (GH 3281 slice 2): for one agent push, the verdict
 * the pre-push hook judge would give beside the one the command-text judge
 * (git-push-guard) gave. observePush is the one place that judges, checks the
 * hook is live and writes the row; its two callers only supply the push.
 * Exactly one row per push: `cli.js pre-push` observes when the push reached
 * git (legacy admit), git-push-guard when it denied the push (legacy deny), so
 * the two callers never see the same push.
 */
import { auditAppend, type WriteResult } from '../lib/audit.js';
import { dbPath } from '../lib/db.js';
import { prepushHookLive } from '../lib/prepush-hook.js';
import { repoGitRoot, repoNameForRoot } from '../lib/repo.js';
import { judgePrePush, parsePushRefs, type PushRef } from './judge.js';

export type HookVerdict = 'admit' | 'deny' | 'error';
export type LegacyVerdict = 'admit' | 'deny';

export interface PushObservation {
  /** The checkout the push runs in. */
  readonly dir: string;
  readonly remote: string;
  /** git's pre-push stdin, real or synthesized; null when it could not be read. */
  readonly refLines: string | null;
  /** Why refLines is null. */
  readonly readError?: string;
  readonly legacyVerdict: LegacyVerdict;
  readonly sessionId: string;
  /** The observing hook's name, from_node `hook:<caller>`. */
  readonly caller: string;
}

type Judge = typeof judgePrePush;

const refJson = (ref: PushRef) => ({ local_ref: ref.localRef, local_sha: ref.localSha, remote_ref: ref.remoteRef, remote_sha: ref.remoteSha });

/** The hook judge's verdict on the push; a read error or a judge throw is 'error'. */
async function hookVerdict(o: PushObservation, env: NodeJS.ProcessEnv, judge: Judge): Promise<{ outcome: HookVerdict; reason: string }> {
  if (o.refLines === null) return { outcome: 'error', reason: `could not read git's ref lines on stdin (${o.readError ?? 'unknown error'})` };
  try {
    const v = await judge(o.remote, o.refLines, o.dir, env);
    return v.admit ? { outcome: 'admit', reason: '' } : { outcome: 'deny', reason: v.reason };
  } catch (error) {
    return { outcome: 'error', reason: `the pre-push judge threw: ${(error as Error).message}` };
  }
}

/**
 * Judges <o>'s push with the hook judge (<judge>, judgePrePush but in a test)
 * and writes its one prepush_observed row; a DB that does not resolve is a
 * failed write.
 */
export async function observePush(o: PushObservation, env: NodeJS.ProcessEnv, judge: Judge = judgePrePush): Promise<WriteResult> {
  const judged = await hookVerdict(o, env, judge);
  const db = dbPath(env) ?? '';
  const root = await repoGitRoot(o.dir, env);
  const repo = (db === '' ? '' : repoNameForRoot(db, root, env)) || root || o.dir;
  const content = {
    repo,
    remote: o.remote,
    refs: (parsePushRefs(o.refLines ?? '') ?? []).map(refJson),
    hook_verdict: judged.outcome,
    reason: judged.reason,
    legacy_verdict: o.legacyVerdict,
    agree: judged.outcome === o.legacyVerdict,
    hook_live: await prepushHookLive(o.dir, env),
    session_id: o.sessionId === '' ? null : o.sessionId,
  };
  return auditAppend(
    db,
    {
      issueId: '-1',
      branchId: '',
      fromNode: `hook:${o.caller}`,
      eventType: 'prepush_observed',
      summary: `push to ${o.remote || 'an unnamed remote'}: hook judge ${judged.outcome}, command-text judge ${o.legacyVerdict}`,
      contentJson: JSON.stringify(content),
    },
    { caller: o.caller, env },
  );
}
