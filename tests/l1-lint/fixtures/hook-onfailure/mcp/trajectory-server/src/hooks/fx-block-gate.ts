// Blocks a non-PreToolUse event.
export const fxBlockGate = () => ({ stdout: `${JSON.stringify({ decision: 'block', reason: 'fx' })}\n`, code: 0 });
