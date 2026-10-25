// Denies only through fxDenyVia, which denies through fxDenyCore.
import { fxDenyVia } from './fx-helpers.js';

export const fxTsHelperGate = (payload: { tool_name?: string }) => {
  if (payload.tool_name !== 'Bash') return { stdout: '', code: 0 };
  return fxDenyVia('fx');
};
