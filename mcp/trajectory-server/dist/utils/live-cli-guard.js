// gh/glab must never be executed from a test process — a stray live call can
// create or close real remote issues. Spawn wrappers consult this guard and
// fail loudly instead of spawning when it returns a reason.
export function liveCliBlockReason(env = process.env) {
    if (env.TMB_FORBID_LIVE_SYNC === '1')
        return 'TMB_FORBID_LIVE_SYNC=1';
    if (env.NODE_TEST_CONTEXT)
        return `NODE_TEST_CONTEXT=${env.NODE_TEST_CONTEXT}`;
    return null;
}
export function liveCliBlockedMessage(reason, cmd, args) {
    return `live CLI blocked in test context (${reason}) — refused to spawn "${cmd} ${args.join(' ')}"; inject _spawnFn`;
}
//# sourceMappingURL=live-cli-guard.js.map