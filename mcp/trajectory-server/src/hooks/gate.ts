/**
 * The contract every TypeScript hook gate implements: the hook payload as read
 * from stdin in, the gate's stdout and exit code out.
 */
export interface GateResult {
  stdout: string;
  code: number;
}

export type Gate = (payload: string, env: NodeJS.ProcessEnv) => GateResult;

export const ALLOW: GateResult = Object.freeze({ stdout: '', code: 0 });
