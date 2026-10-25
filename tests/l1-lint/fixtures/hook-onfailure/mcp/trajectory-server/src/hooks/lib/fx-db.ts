export function fxDenyCore(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

export function fxDescribe(reason: string): string {
  return `fx: ${reason}`;
}
