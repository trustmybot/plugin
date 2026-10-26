/**
 * tmb_cmd_strip_literals of scripts/hooks/lib/cmd-analysis.sh in its plain
 * mode (GH 1692), the awk scanner ported state for state: heredoc bodies and
 * comments dropped, quotes removed, a quoted blank or operator shown as `_`,
 * `$(` / backtick substitutions inside double quotes kept as `$(...)`, and a
 * line that ends inside a quote joined to the next by `_`.
 */

const NEUTRAL = new Set([' ', '\t', '<', '>', '|', ';', '&', '(', ')', '`']);
const COMMENT_BEFORE = new Set([' ', '\t', ';', '&', '|', '(']);
const WORD_END = new Set([' ', '\t', ';', '&', '|', '<', '>', '(', ')']);
const SQ = "'";

function neutral(c: string): string {
  return NEUTRAL.has(c) ? '_' : c;
}

/** The text `tmb_cmd_strip_literals "$cmd"` prints, trailing newline included. */
export function stripLiterals(cmd: string): string {
  let state = '';
  let inbody = false;
  let cur = 0;
  let sp = 0;
  const delim: string[] = [];
  const tabs: boolean[] = [];
  const pd: number[] = [];
  const subBt: boolean[] = [];
  let printed = '';

  const subopen = (bt: boolean): string => {
    sp += 1;
    pd[sp] = 0;
    subBt[sp] = bt;
    return '$(';
  };
  const subclose = (): string => {
    sp -= 1;
    state = 'd';
    return ')';
  };

  for (const line of cmd.split('\n')) {
    if (inbody) {
      const t = tabs[cur] ? line.replace(/^\t+/, '') : line;
      if (t === delim[cur]) {
        cur += 1;
        if (cur >= delim.length) {
          inbody = false;
          delim.length = 0;
          tabs.length = 0;
          cur = 0;
        }
      }
      continue;
    }
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      const next = line[i + 1] ?? '';
      if (state === 's') {
        if (c === SQ) state = '';
        else out += neutral(c);
        i += 1;
        continue;
      }
      if (state === 'a') {
        if (c === '\\') {
          out += neutral(next);
          i += 2;
          continue;
        }
        if (c === SQ) state = '';
        else out += neutral(c);
        i += 1;
        continue;
      }
      if (state === 'd') {
        if (c === '\\') {
          out += neutral(next);
          i += 2;
          continue;
        }
        if (c === '$' && next === '(') {
          out += subopen(false);
          state = '';
          i += 2;
          continue;
        }
        if (c === '`') {
          out += subopen(true);
          state = '';
          i += 1;
          continue;
        }
        if (c === '"') state = '';
        else out += neutral(c);
        i += 1;
        continue;
      }
      if (sp > 0) {
        if (subBt[sp] && c === '`') {
          out += subclose();
          i += 1;
          continue;
        }
        if (!subBt[sp] && c === '(') pd[sp] += 1;
        if (!subBt[sp] && c === ')') {
          if (pd[sp] === 0) {
            out += subclose();
            i += 1;
            continue;
          }
          pd[sp] -= 1;
        }
      }
      if (c === '$' && next === SQ) {
        state = 'a';
        i += 2;
        continue;
      }
      if (c === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (c === SQ) {
        state = 's';
        i += 1;
        continue;
      }
      if (c === '"') {
        state = 'd';
        i += 1;
        continue;
      }
      if (c === '#' && (i === 0 || COMMENT_BEFORE.has(line[i - 1]))) break;
      if (line.startsWith('<<<', i)) {
        out += '<<<';
        i += 3;
        continue;
      }
      if (line.startsWith('<<', i)) {
        let j = i + 2;
        let strip = false;
        if (line[j] === '-') {
          strip = true;
          j += 1;
        }
        while (j < n && (line[j] === ' ' || line[j] === '\t')) j += 1;
        let w = '';
        while (j < n) {
          const d = line[j];
          if (WORD_END.has(d)) break;
          if (d !== SQ && d !== '"' && d !== '\\') w += d;
          j += 1;
        }
        if (w !== '') {
          delim.push(w);
          tabs.push(strip);
        }
        out += `<<${w}`;
        i = j;
        continue;
      }
      out += c;
      i += 1;
    }
    printed += state === '' ? `${out}\n` : `${out}_`;
    if (delim.length > 0 && state === '') {
      inbody = true;
      cur = 0;
    }
  }
  return printed;
}
