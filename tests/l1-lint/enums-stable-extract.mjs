// Literal extraction for enums-stable.test.mjs.
// Usage: node enums-stable-extract.mjs <enum> <schema.sql> <file>...
// Prints "<value>\t<file>" for every literal of <enum> the schema CHECK lists
// and the code files hold, first occurrence per (value, file). Comments in
// .ts/.mjs/.js files are not code; a prefix test of 'hook:' is no from_node; a
// constant passed as insertAudit's event_type counts as its string value.
//
// Files are read as latin1 so every byte is one character and the ASCII-only
// classes below (S for \s) match the way the original Perl matched bytes.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = String.raw`[ \t\n\r\f\v]`;
const Q = `['"]`;
const TOK = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^ \t\n\r\f\v"'\\]+)`;
const SEP = String.raw`(?:[ \t]|\\\n)+`;
const END = String.raw`(?=[ \t\\\n;)])`;

const CHECK = {
  'tasks.status': ['tasks', 'status'],
  'issues.status': ['issues', 'status'],
  'validation_attempts.verdict': ['validation_attempts', 'verdict'],
  'discussions.kind': ['discussions', 'kind'],
  'milestones.state': ['milestones', 'state'],
  'agent_runs.usage_source': ['agent_runs', 'usage_source'],
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = (source, flags = '') => new RegExp(source, flags);

function slurp(file) {
  try {
    return readFileSync(file, 'latin1');
  } catch {
    return '';
  }
}

const lits = (s) => [...s.matchAll(/'([a-z][a-z0-9_-]*)'/g)].map((m) => m[1]);

const TEMPLATE_TEXT = /((?:[^`\\$]|\\[\s\S]|\$(?!\{))*)/y;
const LINE_COMMENT = /\/\/[^\n]*/y;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/y;
const STRING = /('(?:[^'\\\n]|\\[\s\S])*'?|"(?:[^"\\\n]|\\[\s\S])*"?)/y;
const BACKTICK = /`/y;
const INTERPOLATION_OPEN = /\$\{/y;
const REGEX_CONTEXT = re(String.raw`(?:^|[=(,:;!&|?{}\[+\-*%<>~^]|\breturn|\btypeof)${S}*$`);
const REGEX_LITERAL = /(\/(?:[^/\\\n[]|\\[^\n]|\[(?:[^\]\\\n]|\\[^\n])*\])+\/[a-z]*)/y;
const OPEN_BRACE = /\{/y;
const CLOSE_BRACE = /\}/y;
const ANY = /([\s\S])/y;

/** The source with its comments removed, keeping strings, templates and regex literals, where comment markers are text. */
function stripJsComments(src) {
  let pos = 0;
  let out = '';
  const interpolations = [];
  const at = (sticky) => {
    sticky.lastIndex = pos;
    const m = sticky.exec(src);
    if (m !== null) pos = sticky.lastIndex;
    return m;
  };
  const templateText = () => {
    out += at(TEMPLATE_TEXT)[1];
    if (at(BACKTICK)) out += '`';
    else if (at(INTERPOLATION_OPEN)) {
      out += '${';
      interpolations.push(0);
    }
  };
  while (pos < src.length) {
    if (at(LINE_COMMENT) || at(BLOCK_COMMENT)) {
      out += ' ';
      continue;
    }
    let m = at(STRING);
    if (m) {
      out += m[1];
      continue;
    }
    if (at(BACKTICK)) {
      out += '`';
      templateText();
      continue;
    }
    if (REGEX_CONTEXT.test(out.slice(-20)) && (m = at(REGEX_LITERAL))) {
      out += m[1];
      continue;
    }
    if (interpolations.length > 0 && at(OPEN_BRACE)) {
      interpolations[interpolations.length - 1]++;
      out += '{';
      continue;
    }
    if (interpolations.length > 0 && at(CLOSE_BRACE)) {
      out += '}';
      if (interpolations[interpolations.length - 1]-- === 0) {
        interpolations.pop();
        templateText();
      }
      continue;
    }
    out += at(ANY)[1];
  }
  return out;
}

const IMPORT_LIST = re(String.raw`\b(?:import|export)${S}+(?:type${S}+)?\{([^}]*)\}${S}*from${S}*['"](\.[^'"]+)['"]`, 'g');
const IMPORT_SPEC = re(String.raw`^${S}*(\w+)(?:${S}+as${S}+(\w+))?${S}*$`);

/** The string value of constant <name> as <file> sees it: declared there, or followed through its relative imports and re-exports. */
function constValue(file, name, seen = new Set()) {
  const key = `${file}\t${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const c = stripJsComments(slurp(file));
  const decl = re(
    String.raw`\bconst${S}+${escapeRegExp(name)}\b(?:${S}*:[^=\n]+)?${S}*=${S}*['"]([a-z][a-z0-9_]*)['"]`,
  ).exec(c);
  if (decl) return decl[1];
  for (const [, names, path] of c.matchAll(IMPORT_LIST)) {
    for (const spec of names.split(',')) {
      const m = IMPORT_SPEC.exec(spec);
      if (!m) continue;
      if ((m[2] ?? m[1]) !== name) continue;
      const target = `${dirname(file)}/${path}`.replace(/\.js$/, '.ts');
      return constValue(target, m[1], seen);
    }
  }
  return undefined;
}

const EXTRACTORS = {
  'audit.event_type': [
    [re(String.raw`\b(?:event_type|eventType)${S}*(?:=|==|===|!=|!==|:)${S}*${Q}([a-z][a-z0-9_]*)${Q}`, 'g'), (m) => [m[1]]],
    [re(String.raw`\bevent_type${S}+(?:NOT${S}+)?IN${S}*\(([^)]*)\)`, 'gi'), (m) => lits(m[1])],
    [
      re(String.raw`\binsertAudit\(${S}*(?:\w+${S}*,${S}*)?\{[^;]{0,600}?\bevent_type${S}*:${S}*(\w+)${S}*[,}\n]`, 'g'),
      (m, f) => {
        const value = constValue(f, m[1]);
        return value === undefined ? [] : [value];
      },
    ],
    [re(String.raw`\b(?:auditCheatcode|auditMilestone)\(${S}*(?:db${S}*,${S}*)?'([a-z][a-z0-9_]*)'`, 'g'), (m) => [m[1]]],
    [re(String.raw`\btmb_audit_append${SEP}${TOK}${SEP}${TOK}${SEP}${TOK}${SEP}${TOK}${SEP}(["']?)([a-z][a-z0-9_]*)\1${END}`, 'g'), (m) => [m[2]]],
    [re(String.raw`\btmb_audit_sql${SEP}${TOK}${SEP}${TOK}${SEP}${TOK}${SEP}(["']?)([a-z][a-z0-9_]*)\1${END}`, 'g'), (m) => [m[2]]],
    [
      re(String.raw`\bINSERT INTO audit${S}*\(`, 'g'),
      (m, _f, c) => {
        const tail = c.substr(m.index + m[0].length, 600);
        const t = re(String.raw`'(?:system|hook:[a-z0-9-]+)',${S}*'([a-z][a-z0-9_]*)'`).exec(tail);
        return t ? [t[1]] : [];
      },
    ],
  ],
  'audit.from_node': [
    [re(String.raw`\bfrom_node${S}*(?:=|==|===|:)${S}*${Q}([a-z][a-z0-9:-]*)${Q}`, 'g'), (m) => [m[1]]],
    [
      re(String.raw`\bINSERT INTO audit${S}*\(`, 'g'),
      (m, _f, c) => {
        const tail = c.substr(m.index + m[0].length, 600);
        const t = re(String.raw`'(system|hook:[a-z0-9-]+)',${S}*'[a-z]`).exec(tail);
        return t ? [t[1]] : [];
      },
    ],
    [
      re(String.raw`${Q}(hook:[^"' \n]*)${Q}`, 'g'),
      (m) => [m[1]],
      (c) => c.replace(re(String.raw`\.startsWith\(${S}*${Q}[^"'\n]*${Q}|${Q}hook:${Q}${S}*\+`, 'g'), ''),
    ],
  ],
  'tasks.status': [
    [re(String.raw`\bUPDATE tasks${S}+SET${S}+status${S}*=${S}*'([a-z_]+)'`, 'g'), (m) => [m[1]]],
    [re(String.raw`\b(?:t|tasks|task)\.status${S}*(?:=|==|===|!=|!==|<>)${S}*${Q}([a-z_]+)${Q}`, 'g'), (m) => [m[1]]],
    [re(String.raw`\b(?:t|tasks)\.status${S}+(?:NOT${S}+)?IN${S}*\(([^)]*)\)`, 'gi'), (m) => lits(m[1])],
  ],
  'issues.status': [
    [re(String.raw`\bUPDATE issues${S}+SET${S}+status${S}*=${S}*'([a-z_]+)'`, 'g'), (m) => [m[1]]],
    [re(String.raw`\b(?:i|issues|issue)\.status${S}*(?:=|==|===|!=|!==|<>)${S}*${Q}([a-z_]+)${Q}`, 'g'), (m) => [m[1]]],
    [re(String.raw`\b(?:i|issues)\.status${S}+(?:NOT${S}+)?IN${S}*\(([^)]*)\)`, 'gi'), (m) => lits(m[1])],
  ],
  'validation_attempts.verdict': [
    [re(String.raw`\bverdict${S}*(?:=|==|===|!=|!==|:)${S}*${Q}([a-z_]+)${Q}`, 'g'), (m) => [m[1]]],
    [re(String.raw`\bverdict${S}+(?:NOT${S}+)?IN${S}*\(([^)]*)\)`, 'gi'), (m) => lits(m[1])],
  ],
  'discussions.kind': [
    [re(String.raw`\binsertDiscussion\(${S}*db${S}*,${S}*\{[^;]{0,400}?\bkind:${S}*'([a-z_]+)'`, 'g'), (m) => [m[1]]],
    [
      /[^\n]+/g,
      (m) => !/\bdiscussions\b/.test(m[0]) ? [] : [
        ...[...m[0].matchAll(re(String.raw`\bkind${S}*(?:=|==|===)${S}*'([a-z_]+)'`, 'g'))].map((k) => k[1]),
        ...[...m[0].matchAll(re(String.raw`\bkind${S}+(?:NOT${S}+)?IN${S}*\(([^)]*)\)`, 'gi'))].flatMap((k) => lits(k[1])),
      ],
    ],
  ],
  'milestones.state': [
    [re(String.raw`\bUPDATE milestones${S}+SET${S}+state${S}*=${S}*'([a-z_]+)'`, 'g'), (m) => [m[1]]],
    [re(String.raw`\bm\.state${S}*(?:=|==|===|!=|!==)${S}*${Q}([a-z_]+)${Q}`, 'g'), (m) => [m[1]]],
    [
      re(String.raw`\bstate${S}*(?:=|==|===|!=|!==|:)${S}*${Q}([a-z_]+)${Q}`, 'g'),
      (m, f) => (/milestones\.[a-z]+$/.test(f) ? [m[1]] : []),
    ],
  ],
  'agent_runs.usage_source': [
    [re(String.raw`\busage_source${S}*(?:=|==|===|!=|!==|:)${S}*${Q}([a-z_]+)${Q}`, 'g'), (m) => [m[1]]],
    [re(String.raw`\busage_source${S}+(?:NOT${S}+)?IN${S}*\(([^)]*)\)`, 'gi'), (m) => lits(m[1])],
  ],
};

const utf8 = (text) => Buffer.from(text, 'latin1').toString('utf8');

/** The ordered, first-seen-unique "<value>\t<file>" lines for <enumName> over <schemaPath> and <files>; throws on an unknown enum when <files> is non-empty. */
export function extract(enumName, schemaPath, files) {
  const out = [];
  const emit = (file, values) => out.push(...values.map((value) => `${utf8(value)}\t${file}`));

  const check = CHECK[enumName];
  if (check !== undefined) {
    const [table, col] = check;
    const block = re(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${escapeRegExp(table)}${S}*\(([\s\S]*?)\n${S}*\);`).exec(
      slurp(schemaPath),
    );
    if (block) {
      const checks = re(String.raw`CHECK${S}*\(${S}*${escapeRegExp(col)}${S}+IN${S}*\(([^)]*)\)`, 'g');
      for (const m of block[1].matchAll(checks)) emit(schemaPath, lits(m[1]));
    }
  }

  for (const file of files) {
    let c = slurp(file);
    if (/\.sh$/.test(file)) c = c.replace(/(?<![^\n])[ \t]*#(?!!)[^\n]*/g, '');
    if (/\.(?:ts|mjs|js)$/.test(file)) c = stripJsComments(c);
    const extractors = EXTRACTORS[enumName];
    if (extractors === undefined) throw new Error(`enums-stable-extract: unknown enum ${enumName}`);
    for (const [pattern, values, transform] of extractors) {
      const text = transform === undefined ? c : transform(c);
      for (const m of text.matchAll(pattern)) emit(file, values(m, file, text));
    }
  }

  return [...new Set(out)];
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [enumName, schemaPath, ...files] = process.argv.slice(2);
  try {
    process.stdout.write(extract(enumName, schemaPath, files).map((line) => `${line}\n`).join(''));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 255;
  }
}
