// Denies directly.
export const fxGate = () => ({
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fx' } })}\n`,
  code: 0,
});
