/**
 * The TypeScript write-path analyzer (GH 1692): tmb_cmd_write_paths of
 * scripts/hooks/lib/cmd-analysis.sh on tree-sitter-bash. Importing it loads no
 * parser; the first non-blank command does.
 */
import { bashParser } from './parser.js';
import { writePathsWith } from './write-paths.js';

export { bashParserLoads } from './parser.js';
export { pathCanonical, payloadCwd } from './path.js';

export interface WritePathsOptions {
  cwd?: string;
  raw?: boolean;
  root?: string;
  env?: NodeJS.ProcessEnv;
}

/** The lines `tmb_cmd_write_paths "$command" "$cwd" [raw] "$root"` prints. */
export async function writePaths(command: string, options: WritePathsOptions = {}): Promise<string[]> {
  if (command.trim() === '') return [];
  const parser = await bashParser();
  return writePathsWith(parser, command, {
    cwd: options.cwd ?? '',
    raw: options.raw ?? false,
    root: options.root ?? '',
    env: options.env ?? process.env,
  });
}
