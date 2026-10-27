/**
 * tmb_is_harness_turn of scripts/hooks/lib/cmd-analysis.sh (GH 1692): whether
 * a UserPromptSubmit prompt came from the harness, not the Human — a task or
 * system notification, a subagent hand-back, an agent or cross-session
 * message.
 */
const HARNESS_MARKS = [
  '<task-notification>',
  '[SYSTEM NOTIFICATION',
  'Another Claude session sent a message',
  '[Subagent hand-back]',
  '<agent-message',
  '<cross-session-message',
] as const;

export function isHarnessTurn(prompt: string): boolean {
  return HARNESS_MARKS.some((mark) => prompt.includes(mark));
}
