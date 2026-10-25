import { fxDenyCore, fxDescribe } from './lib/fx-db.js';

export function fxDenyVia(reason: string): { stdout: string; code: number } {
  return { stdout: `${fxDenyCore(fxDescribe(reason))}\n`, code: 0 };
}

export function fxNote(reason: string): { stdout: string; code: number } {
  return { stdout: `${fxDescribe(reason)}\n`, code: 0 };
}
