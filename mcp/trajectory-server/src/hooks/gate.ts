/**
 * The contract every TypeScript hook gate implements: the hook payload as read
 * from stdin in, the gate's stdout and exit code out, at once or as a Promise.
 */
export interface GateResult {
  stdout: string;
  code: number;
}

export type SyncGate = (payload: string, env: NodeJS.ProcessEnv) => GateResult;

export type Gate = (payload: string, env: NodeJS.ProcessEnv) => GateResult | Promise<GateResult>;

export const ALLOW: GateResult = Object.freeze({ stdout: '', code: 0 });
