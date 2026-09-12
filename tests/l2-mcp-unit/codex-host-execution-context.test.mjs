import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { evaluatePreToolUse, makeRestrictedCommand } from "../../adapters/codex/hooks/repo-policy.mjs";

const PLUGIN_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const GIT_READ = "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null status --short";
const OPTIONS = { pluginRoot: PLUGIN_ROOT };
let fixtures;
let root;
let otherRoot;
let alias;
let wrapper;

before(() => {
  fixtures = realpathSync(mkdtempSync(join(tmpdir(), "tmb-host-execution-context-")));
  root = join(fixtures, "checkout");
  otherRoot = join(fixtures, "other-checkout");
  for (const cwd of [root, otherRoot]) {
    mkdirSync(cwd);
    execFileSync("/usr/bin/git", ["init", "-q", "-b", "feature/host-context"], {
      cwd, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    writeFileSync(join(cwd, "probe.test.mjs"), "// Policy fixture; this file is never executed.\n");
    writeFileSync(join(cwd, "marker.txt"), cwd === root ? "REVIEWED-CHECKOUT-MARKER\n" : "OTHER-CHECKOUT-MARKER\n");
  }
  alias = join(fixtures, "checkout-alias");
  symlinkSync(root, alias);
  wrapper = makeRestrictedCommand(GIT_READ, root, OPTIONS);
});

after(() => { if (fixtures) rmSync(fixtures, { recursive: true, force: true }); });

function context(command = wrapper, changes = {}) {
  return {
    kind: "exec_command", argv: ["/bin/sh", "-c", command], cwd: root,
    tty: false, login: false, environment_id: "local-test-environment",
    is_remote: false, shell_mode: "direct", ...changes,
  };
}

function event(command = wrapper, changes = {}) {
  return {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command },
    cwd: root, permission_mode: "default", execution_context: context(command), ...changes,
  };
}

async function denied(input, label) {
  const result = await evaluatePreToolUse(input, OPTIONS);
  assert.equal(result.decision, "deny", `${label}: ${JSON.stringify(result)}`);
}

test("prepared local /bin/sh metadata admits only the installed restricted wrapper", async () => {
  for (const command of [GIT_READ, "node --test probe.test.mjs"]) {
    const restricted = makeRestrictedCommand(command, root, OPTIONS);
    const result = await evaluatePreToolUse(event(restricted), OPTIONS);
    assert.equal(result.decision, process.platform === "darwin" ? "allow" : "deny", result.reason);
    if (process.platform !== "darwin") assert.match(result.reason, /qualified macOS/);
  }
});

test("every host execution field is required", async () => {
  for (const command of [wrapper, "cat marker.txt"]) {
    for (const key of Object.keys(context(command))) {
      const incomplete = context(command);
      delete incomplete[key];
      await denied(event(command, { execution_context: incomplete }), `${command}: missing ${key}`);
    }
    for (const execution_context of [undefined, null, [], "local", {}]) {
      await denied(event(command, { execution_context }), `${command}: invalid context ${JSON.stringify(execution_context)}`);
    }
  }
});

test("host execution rejects remote, alternate shell, login, tty and rewritten command metadata", async () => {
  const mutations = [
    { kind: "shell" }, { kind: "exec_command " },
    { argv: ["/bin/zsh", "-c", wrapper] }, { argv: ["/bin/bash", "-c", wrapper] },
    { argv: ["/bin/sh", "-lc", wrapper] }, { argv: ["/bin/sh", "-c", `${wrapper} && true`] },
    { argv: ["/bin/sh", "-c", wrapper, "extra"] }, { argv: ["/bin/sh", "-c"] },
    { argv: { 0: "/bin/sh", 1: "-c", 2: wrapper, length: 3 } },
    { argv: ["pwsh", "-Command", wrapper] },
    { login: true }, { login: null }, { tty: true }, { tty: 0 },
    { is_remote: true }, { is_remote: "false" },
    { shell_mode: "zsh_fork" }, { shell_mode: "powershell" }, { shell_mode: "Direct" },
    { environment_id: "" }, { environment_id: "   " }, { environment_id: 1 },
    { environment_id: "x".repeat(257) }, { environment_id: "界".repeat(86) },
    { environment_id: "local\nother" }, { environment_id: "local\0other" },
    { env: { BASH_ENV: "/unreviewed/profile" } }, { extra: false },
  ];
  for (const mutation of mutations) {
    await denied(event(wrapper, { execution_context: context(wrapper, mutation) }), JSON.stringify(mutation));
  }
});

test("host execution cwd must be the same canonical directory used by policy", async () => {
  mkdirSync(join(root, "subdirectory"));
  for (const cwd of [otherRoot, alias, `${root}/.`, join(root, "subdirectory"), "checkout", null]) {
    await denied(event(wrapper, { execution_context: context(wrapper, { cwd }) }), String(cwd));
  }
  const otherWrapper = makeRestrictedCommand(GIT_READ, otherRoot, OPTIONS);
  await denied(event(otherWrapper, { execution_context: context(otherWrapper, { cwd: otherRoot }) }), "different checkout and matching alternate wrapper");
});

test("a relative read runs only in the reviewed checkout and never starts with a different host cwd", async () => {
  const command = "cat marker.txt";
  for (const cwd of [root, otherRoot]) {
    const prepared = context(command, { cwd });
    const result = await evaluatePreToolUse(event(command, { execution_context: prepared }), OPTIONS);
    let started = false;
    let output = null;
    if (result.decision === "allow") {
      started = true;
      output = execFileSync(prepared.argv[0], prepared.argv.slice(1), {
        cwd: prepared.cwd, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 2_000,
      });
    }
    assert.deepEqual({ decision: result.decision, started, output }, cwd === root
      ? { decision: "allow", started: true, output: "REVIEWED-CHECKOUT-MARKER\n" }
      : { decision: "deny", started: false, output: null });
  }
});

test("invalid startup metadata cannot fall through to the raw read allowlist", async () => {
  const command = "cat marker.txt";
  for (const changes of [
    { login: true }, { tty: true }, { is_remote: true }, { shell_mode: "zsh_fork" },
    { argv: ["/bin/sh", "-c", "cat probe.test.mjs"] }, { argv: ["/bin/zsh", "-c", command] },
    { cwd: otherRoot }, { cwd: alias }, { environment_id: "" }, { env: {} },
  ]) {
    await denied(event(command, { execution_context: context(command, changes) }), JSON.stringify(changes));
  }
});

test("model-supplied context and extra command arguments cannot attest a Bash invocation", async () => {
  const fakeInputs = [
    { command: wrapper, execution_context: context() },
    { command: wrapper, shell: "/bin/sh", login: false, tty: false },
    { command: wrapper, env: {} },
    { cmd: wrapper },
  ];
  for (const tool_input of fakeInputs) {
    await denied(event(wrapper, { tool_input }), "extra or alternate tool arguments");
    await denied(event(wrapper, { tool_input, execution_context: undefined }), "model-supplied context only");
  }
  for (const tool_name of ["bash", "exec_command", "functions.exec_command", "local_shell"]) {
    await denied(event(wrapper, { tool_name }), `unobserved tool name ${tool_name}`);
  }
});

test("nested JSON never inherits host execution metadata from its outer call", async () => {
  for (const toolInput of [{ command: wrapper }, { command: wrapper, execution_context: context() }]) {
    const source = `text(JSON.stringify(await tools.Bash(${JSON.stringify(toolInput)})));`;
    await denied(event(wrapper, { tool_name: "functions.exec", tool_input: source }), "nested Bash with outer metadata");
  }
  const source = `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
    cmd: wrapper, workdir: root, shell: "/bin/sh", login: false, tty: false, execution_context: context(),
  })})));`;
  await denied(event(wrapper, { tool_name: "functions.exec", tool_input: source }), "nested exec_command self-attestation");
  for (const command of ["cat marker.txt", "pwd", "true"]) {
    const nested = `text(JSON.stringify(await tools.Bash(${JSON.stringify({ command })})));`;
    await denied(event(command, { tool_name: "functions.exec", tool_input: nested }), "nested read with outer host metadata");
  }
});

test("legacy command-only CLI payloads cannot run Bash, including reads and diagnostic builtins", async () => {
  for (const command of [wrapper, "cat marker.txt", "head marker.txt", "ls", "pwd", "true", "false", "test -n present"]) {
    const legacy = event(command);
    delete legacy.execution_context;
    const result = await evaluatePreToolUse(legacy, OPTIONS);
    assert.equal(result.decision, "deny", command);
    assert.match(result.reason, /host execution metadata/);
    assert.match(result.reason, /Command-only CLI payloads are not supported/);
  }
});

test("complete host metadata still denies raw Git and validation", async () => {
  for (const command of [GIT_READ, "git add -- probe.test.mjs", "node --test probe.test.mjs"]) {
    const result = await evaluatePreToolUse(event(command), OPTIONS);
    assert.equal(result.decision, "deny", command);
    assert.match(result.reason, /installed restricted runner/);
  }
});

test("native reads, Codex diagnostics and plugin removal remain usable without Bash metadata", async () => {
  for (const [tool_name, tool_input] of [
    ["Read", { file_path: join(root, "marker.txt") }],
    ["view_image", { path: join(root, "image.png") }],
    ["mcp__codex_app__list_projects", {}],
    ["mcp__codex_app__uninstall_plugin", { plugin: "tmb" }],
  ]) {
    for (const execution_context of [undefined, { cwd: otherRoot, login: true }]) {
      const result = await evaluatePreToolUse(event("", { tool_name, tool_input, execution_context }), OPTIONS);
      assert.deepEqual(result, { decision: "allow" }, tool_name);
    }
  }
});

test("the existing explicit nested exec_command wrapper remains compatible", async () => {
  const source = `text(JSON.stringify(await tools.exec_command(${JSON.stringify({
    cmd: wrapper, workdir: root, shell: "/bin/sh", login: false, tty: false,
  })})));`;
  const result = await evaluatePreToolUse(event(wrapper, {
    tool_name: "functions.exec", tool_input: source, execution_context: undefined,
  }), OPTIONS);
  assert.equal(result.decision, process.platform === "darwin" ? "allow" : "deny", result.reason);
});

test("nested raw reads require every explicit startup control and the same canonical workdir", async () => {
  for (const command of ["cat marker.txt", "pwd", "true"]) {
    const complete = { cmd: command, shell: "/bin/sh", login: false, tty: false, workdir: root };
    const variants = [{ label: "complete", fields: complete, expected: "allow" }];
    for (const field of ["shell", "login", "tty", "workdir"]) {
      const fields = { ...complete };
      delete fields[field];
      variants.push({ label: `missing ${field}`, fields, expected: "deny" });
    }
    for (const changes of [
      { shell: "/bin/zsh" }, { shell: null }, { login: true }, { login: null },
      { tty: true }, { tty: null }, { workdir: otherRoot }, { workdir: alias },
      { workdir: `${root}/.` }, { workdir: "checkout" }, { workdir: null },
    ]) {
      variants.push({ label: JSON.stringify(changes), fields: { ...complete, ...changes }, expected: "deny" });
    }
    for (const { label, fields, expected } of variants) {
      const source = `text(JSON.stringify(await tools.exec_command(${JSON.stringify(fields)})));`;
      const result = await evaluatePreToolUse(event(command, {
        tool_name: "functions.exec", tool_input: source, execution_context: undefined,
      }), OPTIONS);
      assert.equal(result.decision, expected, `${command}, ${label}: ${result.reason ?? ""}`);
    }
  }
});

test("host metadata with inherited fields, accessors or symbol keys is rejected without invoking accessors", async () => {
  const inherited = Object.assign(Object.create({ kind: "exec_command" }), context());
  const accessor = context();
  Object.defineProperty(accessor, "kind", { get() { throw new Error("untrusted accessor ran"); }, enumerable: true });
  const symbolKey = { ...context(), [Symbol("extra")]: true };
  for (const execution_context of [inherited, accessor, symbolKey]) {
    await denied(event(wrapper, { execution_context }), "non-ordinary metadata");
  }
});
