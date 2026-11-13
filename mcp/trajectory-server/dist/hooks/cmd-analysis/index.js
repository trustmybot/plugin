/**
 * The write-path analyzer on tree-sitter-bash (GH 1692). Importing it loads no
 * parser; the first non-blank command loads bash, and the first inline
 * program in python or node loads its grammar, after which the command is
 * analyzed again (GH 1739).
 */
import { bashParser, loadWanted } from './parser.js';
import { writePathsWith } from './write-paths.js';
export { ANALYSIS_WORK_CAP, CAP_FIX, CAP_REASON, isCapLine } from './write-paths.js';
export { bashParserLoads, programParserLoads } from './parser.js';
export { gitWorkTreeTop, pathCanonical, payloadCwd } from './path.js';
export { GIT_MOVE_PREFIX, REFS_MAY_MOVE, parseGitMoveLine } from './git-moves.js';
export { braceEdge, braceExpand, braceWords } from './brace.js';
export { ghMutation, ghMutationFrom } from './forge.js';
export { isPromptSurfacePath, surfaceRoot, WRITE_SHAPES, writeShapes } from './surface.js';
export { stripLiterals } from './strip-literals.js';
export { ambiguousSubcommandReason, cmdStatements, cwdState, denyAmbiguousGitTarget, gitBesideExpansion, gitSubcommand, gitSubcommandOf, gitSubcommandUnknown, prefilterPasses, stmtRepoRoot, unquotedCommand, withSource, } from './git.js';
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
        treeWrites: options.treeWrites ?? false,
        gitMoves: options.gitMoves ?? false,
    };
    let lines = writePathsWith(parser, command, opts);
    while (await loadWanted())
        lines = writePathsWith(parser, command, opts);
    return lines;
}
//# sourceMappingURL=index.js.map