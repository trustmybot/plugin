// src/hooks/index.ts
import { readFileSync } from "node:fs";

// src/hooks/askuserquestion-length-lint.ts
import { existsSync } from "node:fs";

// src/hooks/gate.ts
var ALLOW = Object.freeze({ stdout: "", code: 0 });

// src/hooks/askuserquestion-length-lint.ts
var LABEL_MAX_WORDS = 5;
var DESC_MAX_WORDS = 15;
var PREVIEW_MAX_LINES = 4;
var JqError = class extends Error {
};
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function jqField(v, key) {
  if (v === null) return null;
  if (!isObject(v)) throw new JqError(`cannot index ${typeof v} with "${key}"`);
  return Object.hasOwn(v, key) ? v[key] : null;
}
function jqAlt(v, fallback) {
  return v === null || v === false ? fallback : v;
}
function jqEach(v) {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  throw new JqError(`cannot iterate over ${typeof v}`);
}
function jqItems(get) {
  try {
    return jqEach(get());
  } catch (err) {
    if (err instanceof JqError) return [];
    throw err;
  }
}
function jqRaw(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
function shellCapture(text) {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
}
function fieldText(option, key) {
  try {
    return shellCapture(jqRaw(jqAlt(jqField(option, key), "")));
  } catch (err) {
    if (err instanceof JqError) return "";
    throw err;
  }
}
function ctypeLocale(env) {
  return env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
}
function splitsOnNbsp(env) {
  const locale = ctypeLocale(env);
  return /\.utf-8$/i.test(locale) && !locale.includes("/") && existsSync(`/usr/share/locale/${locale}/LC_CTYPE`);
}
function wordCount(text, nbsp) {
  const separators = nbsp ? /[ \t\n\v\f\r ]+/ : /[ \t\n\v\f\r]+/;
  return text.split(separators).filter((word) => word !== "").length;
}
function lineCount(text) {
  return text === "" ? 0 : text.split("\n").length;
}
function toolName(payload) {
  try {
    return shellCapture(jqRaw(jqAlt(jqField(payload, "tool_name"), "")));
  } catch (err) {
    if (err instanceof JqError) return "";
    throw err;
  }
}
function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return void 0;
  }
}
var askuserquestionLengthLint = (payload, env) => {
  const input = parsePayload(payload);
  if (input === void 0 || toolName(input) !== "AskUserQuestion") return ALLOW;
  const nbsp = splitsOnNbsp(env);
  const warnings = [];
  const questions = jqItems(() => jqAlt(jqField(jqField(input, "tool_input"), "questions"), []));
  questions.forEach((question, q) => {
    const options = jqItems(() => jqAlt(jqField(question, "options"), []));
    options.forEach((option, o) => {
      const labelWords = wordCount(fieldText(option, "label"), nbsp);
      const descWords = wordCount(fieldText(option, "description"), nbsp);
      const previewLines = lineCount(fieldText(option, "preview"));
      if (labelWords > LABEL_MAX_WORDS) {
        warnings.push(`q${q}.opt${o} label is ${labelWords} words (target \u2264${LABEL_MAX_WORDS})`);
      }
      if (descWords > DESC_MAX_WORDS) {
        warnings.push(`q${q}.opt${o} description is ${descWords} words (target \u2264${DESC_MAX_WORDS})`);
      }
      if (previewLines > PREVIEW_MAX_LINES) {
        warnings.push(`q${q}.opt${o} preview is ${previewLines} lines (target \u2264${PREVIEW_MAX_LINES})`);
      }
    });
  });
  if (warnings.length === 0) return ALLOW;
  const message = [
    "AskUserQuestion brevity violations (per feedback_ask_user_question.md):",
    ...warnings.map((w) => `  - ${w}`)
  ].join("\n") + "\n\nTargets: label <=5 words, description <=15 words, preview <=4 lines. See #96.";
  const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } };
  return { stdout: `${JSON.stringify(output)}
`, code: 0 };
};

// src/hooks/registry.ts
var GATES = /* @__PURE__ */ new Map([
  ["askuserquestion-length-lint", askuserquestionLengthLint]
]);
function findGate(name2) {
  return GATES.get(name2);
}

// src/hooks/index.ts
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function main(name2) {
  const gate = findGate(name2);
  if (!gate) {
    process.stderr.write(`TMB hooks: unknown gate '${oneLine(name2)}' \u2014 not run
`);
    return 1;
  }
  const result = gate(readFileSync(0, "utf8"), process.env);
  process.stdout.write(result.stdout);
  return result.code;
}
var name = process.argv[2] ?? "";
try {
  process.exitCode = main(name);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`TMB hooks: gate '${oneLine(name)}' failed: ${oneLine(detail)}
`);
  process.exitCode = 1;
}
//# sourceMappingURL=hooks.js.map
