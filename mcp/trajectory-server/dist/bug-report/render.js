// Renders a redacted TMB bug report: title, GitHub-form body, signature, dedup marker and prefilled new-issue link.
import { createHash } from 'node:crypto';
import { CHECK_OPTIONS, FORM_FIELDS } from './form.js';
import { REDACT_RULES, redact } from './redact.js';
export const NEW_ISSUE_URL = 'https://github.com/trustmybot/plugin/issues/new';
export const PREFILL_MAX_CHARS = 8000;
export const TITLE_MAX_CHARS = 80;
const TITLE_PREFIX = '🐛 ';
const NO_RESPONSE = '_No response_';
const PREFILL_DROP_ORDER = ['repro-script', 'doctor', 'workaround'];
export function redactFields(input, env, ctx) {
    const counts = Object.fromEntries(REDACT_RULES.map((r) => [r, 0]));
    const scrub = (text) => {
        const result = redact(text, ctx);
        for (const rule of REDACT_RULES)
            counts[rule] += result.counts[rule];
        return result.text;
    };
    const fields = {};
    for (const field of FORM_FIELDS) {
        const id = field.id;
        if (id === 'environment' || id === 'checks')
            continue;
        const raw = (input[id] ?? '').trim();
        if (field.type === 'dropdown') {
            const options = field.options;
            if (raw && !options.includes(raw)) {
                throw new RangeError(`${id} must be one of: ${options.join(', ')}`);
            }
            fields[id] = raw;
        }
        else {
            fields[id] = scrub(raw).trim();
        }
    }
    const envLines = Object.entries(env)
        .filter(([key]) => key !== 'signature')
        .map(([key, value]) => `${key}: ${scrub(String(value).replace(/\s*[\r\n]+\s*/g, ' ').trim())}`);
    fields.environment = '';
    fields.checks = '';
    return { fields, envLines, counts };
}
export function computeSignature(tool, errorClass, redactedError) {
    const normalized = redactedError.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
    return createHash('sha256').update([tool, errorClass, normalized].join('\n')).digest('hex').slice(0, 12);
}
export function reportMarker(signature) {
    return `<!-- tmb-report v1 sig=${signature} -->`;
}
function buildTitle(summary) {
    const chars = Array.from(summary.replace(/\s+/g, ' ').trim());
    const room = TITLE_MAX_CHARS - Array.from(TITLE_PREFIX).length;
    const text = chars.length > room ? chars.slice(0, room - 1).join('').trimEnd() + '…' : chars.join('');
    return TITLE_PREFIX + text;
}
function fence(value, lang) {
    const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length));
    const ticks = '`'.repeat(Math.max(3, longestRun + 1));
    return `${ticks}${lang}\n${value}\n${ticks}`;
}
function renderValue(field, value) {
    if (field.type === 'checkboxes') {
        return CHECK_OPTIONS.map((option, i) => `- [${i === 0 ? 'x' : ' '}] ${option.label}`).join('\n');
    }
    if (!value)
        return NO_RESPONSE;
    return field.render ? fence(value, field.render) : value;
}
function buildPrefillUrl(title, fields, dropped) {
    const params = [`template=bug.yml`, `title=${encodeURIComponent(title)}`];
    for (const field of FORM_FIELDS) {
        const id = field.id;
        if (field.type === 'checkboxes' || dropped.has(id))
            continue;
        params.push(`${id}=${encodeURIComponent(fields[id])}`);
    }
    return `${NEW_ISSUE_URL}?${params.join('&')}`;
}
export function render(input, env, ctx) {
    const { fields, envLines } = redactFields(input, env, ctx);
    const signature = computeSignature(input.tool ?? '', input.error_class ?? '', fields.error);
    const marker = reportMarker(signature);
    fields.environment = [...envLines, `signature: ${signature}`].join('\n');
    const title = buildTitle(fields.summary);
    const blocks = FORM_FIELDS.map((field) => `### ${field.label}\n\n${renderValue(field, fields[field.id])}`);
    const body = [...blocks, marker].join('\n\n');
    const dropped = new Set();
    let prefill_url = buildPrefillUrl(title, fields, dropped);
    for (const id of PREFILL_DROP_ORDER) {
        if (prefill_url.length <= PREFILL_MAX_CHARS)
            break;
        dropped.add(id);
        prefill_url = buildPrefillUrl(title, fields, dropped);
    }
    return { title, body, signature, marker, prefill_url, prefill_truncated: dropped.size > 0 };
}
//# sourceMappingURL=render.js.map