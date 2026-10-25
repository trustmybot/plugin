// Calls only a helper that never denies; fxDenyVia( in a comment is ignored.
import { fxNote } from './fx-helpers.js';

export const fxTsObserve = (payload: { tool_name?: string }) => {
  if (payload.tool_name !== 'Bash') return { stdout: '', code: 0 };
  return fxNote('fx');
};
