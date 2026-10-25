/**
 * One hook gate run: the payload read, the gate awaited, its stdout written
 * and its exit code returned. An unknown gate or a gate that throws or
 * rejects writes one stderr line and returns 1, so dispatch.sh fails a
 * fail-closed gate closed; it never allows on error.
 */
import type { Gate } from './gate.js';

export interface HookIo {
  readStdin(): string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function runHook(
  name: string,
  findGate: (name: string) => Gate | undefined,
  env: NodeJS.ProcessEnv,
  io: HookIo,
): Promise<number> {
  try {
    const gate = findGate(name);
    if (!gate) {
      io.writeStderr(`TMB hooks: unknown gate '${oneLine(name)}' — not run\n`);
      return 1;
    }
    const result = await gate(io.readStdin(), env);
    io.writeStdout(result.stdout);
    return result.code;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    io.writeStderr(`TMB hooks: gate '${oneLine(name)}' failed: ${oneLine(detail)}\n`);
    return 1;
  }
}
