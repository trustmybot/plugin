/**
 * The TypeScript write-path analyzer (GH 1692): tmb_cmd_write_paths of
 * scripts/hooks/lib/cmd-analysis.sh on tree-sitter-bash. Importing it loads no
 * parser; the first non-blank command loads bash, and the first inline
 * program in python or node loads its grammar, after which the command is
 * analyzed again (GH 1739).
 */
import { bashParser, loadWanted } from './parser.js';
import { writePathsWith } from './write-paths.js';
export { bashParserLoads, programParserLoads } from './parser.js';
export { pathCanonical, payloadCwd } from './path.js';
export { stripLiterals } from './strip-literals.js';
export { cmdStatements, cwdState, denyAmbiguousGitTarget, gitSubcommand, stmtRepoRoot, } from './git.js';
/** The lines `tmb_cmd_write_paths "$command" "$cwd" [raw] "$root"` prints. */
export async function writePaths(command, options = {}) {
    if (command.trim() === '')
        return [];
    const parser = await bashParser();
    const opts = {
        cwd: options.cwd ?? '',
        raw: options.raw ?? false,
        root: options.root ?? '',
        env: options.env ?? process.env,
    };
    let lines = writePathsWith(parser, command, opts);
    while (await loadWanted())
        lines = writePathsWith(parser, command, opts);
    return lines;
}
//# sourceMappingURL=index.js.map