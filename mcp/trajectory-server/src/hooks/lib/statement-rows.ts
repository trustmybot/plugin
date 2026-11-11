/**
 * The `while IFS=$'\t' read -r dir stmt; do …; done < <(tmb_cmd_statements …)`
 * loop and the tmb_payload_cwd capture the git branch guards share (GH 1692).
 */
import { type Statement, withSource } from '../cmd-analysis/git.js';
import { stripTrailingNewlines } from './db.js';
import { jqCapture, type JqInput } from './jq-raw.js';
import { shellPwd } from './project-env.js';

/** `IFS=$'\t' read -r f1 … fn` of one line: tab runs split, the last field keeps the rest. */
export function readTabFields(line: string, n: number): string[] {
  let s = line.replace(/^\t+/, '');
  const fields: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const tab = s.indexOf('\t');
    if (tab < 0) {
      fields.push(s);
      s = '';
      continue;
    }
    fields.push(s.slice(0, tab));
    s = s.slice(tab).replace(/^\t+/, '');
  }
  fields.push(s.replace(/\t+$/, ''));
  return fields;
}

/** Per `${dir}\t${stmt}` line of <statements>: the statement that line is all of, undefined for a line of a statement that spans more (GH 2536). */
export function lineStatements(statements: readonly Statement[]): Array<Statement | undefined> {
  return statements.flatMap((statement) => {
    const n = `${statement.dir}\t${statement.stmt}`.split('\n').length;
    return n === 1 ? [statement] : new Array<undefined>(n).fill(undefined);
  });
}

/** The `dir` / `stmt` pairs the .sh's read loop sees from tmb_cmd_statements' lines, a row of a one-line statement keeping that statement's `cut` and `literals` and reading its `src`. */
export function statementRows(statements: readonly Statement[]): Statement[] {
  const text = stripTrailingNewlines(statements.map(({ dir, stmt }) => `${dir}\t${stmt}`).join('\n'));
  if (text === '') return [];
  const owners = lineStatements(statements);
  return text.split('\n').map((line, i) => {
    const [dir, stmt] = readTabFields(line, 2);
    const owner = owners[i];
    const row = { dir, stmt, ...(owner?.cut ? { cut: owner.cut } : {}), ...(owner?.literals ? { literals: owner.literals } : {}) };
    return owner && 'src' in owner ? withSource(row, () => owner.src) : row;
  });
}

/** tmb_payload_cwd: the payload's `.cwd // empty`, else $PWD. */
export function payloadCwdOf(input: JqInput, env: NodeJS.ProcessEnv = process.env): string {
  return jqCapture(input, ['cwd'], true) || shellPwd(env);
}
