/**
 * The background commands a swe transcript left running (GH 2206). A start is
 * a user tool_result reading `Command running in background with ID: <id>` (or
 * a foreground command `moved to the background (ID: <id>)`) whose
 * `tool_use_id` names an earlier assistant `Bash` tool_use (GH 2688), so a
 * Read, Grep or MCP result quoting the marker is no start; an end is a
 * `<task-notification>` naming `<task-id><id></task-id>` with a `<status>`, in
 * a tool_result, an `attachment.prompt` or user message content, or a
 * `TaskStop` tool_use whose `input.task_id` is the id. Lines that are not JSON
 * are skipped; markers anywhere else do not count.
 */
const START = /Command running in background with ID: ([A-Za-z0-9]+)|moved to the background \(ID: ([A-Za-z0-9]+)\)/g;
const NOTIFICATION = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;
const TASK_ID = /<task-id>([A-Za-z0-9]+)<\/task-id>/;
const STATUS = /<status>[^<]*<\/status>/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function blockTexts(content) {
    if (typeof content === 'string')
        return [content];
    if (!Array.isArray(content))
        return [];
    return content.flatMap((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []));
}
function startIds(text) {
    return [...text.matchAll(START)].map((m) => m[1] ?? m[2]);
}
function endIds(text) {
    const ids = [];
    for (const m of text.matchAll(NOTIFICATION)) {
        const id = TASK_ID.exec(m[1]);
        if (id && STATUS.test(m[1]))
            ids.push(id[1]);
    }
    return ids;
}
export function liveBackgroundIds(transcriptText) {
    const started = [];
    const ended = new Set();
    const bashUses = new Set();
    for (const line of transcriptText.split('\n')) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!isObj(entry))
            continue;
        const attachment = entry.attachment;
        if (isObj(attachment) && typeof attachment.prompt === 'string')
            endIds(attachment.prompt).forEach((id) => ended.add(id));
        const message = entry.message;
        if (!isObj(message))
            continue;
        if (message.role === 'user') {
            const content = message.content;
            for (const text of blockTexts(content))
                endIds(text).forEach((id) => ended.add(id));
            if (!Array.isArray(content))
                continue;
            for (const block of content) {
                if (!isObj(block) || block.type !== 'tool_result')
                    continue;
                const fromBash = typeof block.tool_use_id === 'string' && bashUses.has(block.tool_use_id);
                for (const text of blockTexts(block.content)) {
                    if (fromBash)
                        started.push(...startIds(text));
                    endIds(text).forEach((id) => ended.add(id));
                }
            }
        }
        else if (message.role === 'assistant' && Array.isArray(message.content)) {
            for (const block of message.content) {
                if (!isObj(block) || block.type !== 'tool_use')
                    continue;
                if (block.name === 'Bash' && typeof block.id === 'string')
                    bashUses.add(block.id);
                if (block.name === 'TaskStop' && isObj(block.input) && typeof block.input.task_id === 'string')
                    ended.add(block.input.task_id);
            }
        }
    }
    return [...new Set(started)].filter((id) => !ended.has(id));
}
//# sourceMappingURL=background-wait.js.map