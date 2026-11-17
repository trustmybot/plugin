// Non-blocking spawn with spawnSync's options and result shape, for gh/glab calls from the MCP server (GH 3232).
import { execFile, type SpawnSyncOptions } from 'node:child_process';

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The MCP server is one Node process for every lane, so a remote CLI call must
// not block its event loop. Takes spawnSync-style options (input goes to stdin,
// which then closes as under spawnSync) and returns the spawnSync result shape:
// exit code, or null when the child was killed (timeout, maxBuffer) or never started.
export function spawnAsync(cmd: string, args: string[], opts: SpawnSyncOptions = {}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      killSignal: opts.killSignal,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({
        status: error === null ? 0 : typeof code === 'number' ? code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
    // A child that exits before reading its stdin makes the write fail with
    // EPIPE; the exit callback above already reports the outcome.
    child.stdin?.on('error', () => {});
    const input = opts.input;
    if (input === undefined) child.stdin?.end();
    else child.stdin?.end(typeof input === 'string' ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}
