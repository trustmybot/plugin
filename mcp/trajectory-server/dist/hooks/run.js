function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
export async function runHook(name, findGate, env, io) {
    try {
        const gate = findGate(name);
        if (!gate) {
            io.writeStderr(`TMB hooks: unknown gate '${oneLine(name)}' — not run\n`);
            return 1;
        }
        const result = await gate(io.readStdin(), env);
        io.writeStdout(result.stdout);
        if (result.stderr)
            io.writeStderr(result.stderr);
        return result.code;
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        io.writeStderr(`TMB hooks: gate '${oneLine(name)}' failed: ${oneLine(detail)}\n`);
        return 1;
    }
}
//# sourceMappingURL=run.js.map