import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './paths.ts';

export interface ClaudeOpts {
  prompt: string;
  system?: string;
  model?: string;
  tools?: string[];
  allowedTools?: string[];
  mcpConfig?: string;
  cwd?: string;
  jsonSchema?: object;
  effort?: string;
  env?: Record<string, string>;
  tag?: string;
  timeoutMs?: number;
}

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export interface ClaudeRun {
  text: string;
  structured?: unknown;
  isError: boolean;
  usage: Usage;
  totalIn: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  toolCalls: number;
  toolNames: string[];
  toolResultChars: number;
}

const CACHE_DIR = join(RESULTS_DIR, 'cache');

function cacheKey(opts: ClaudeOpts): string {
  const { env: _env, timeoutMs: _t, ...rest } = opts;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 24);
}

function buildArgs(opts: ClaudeOpts): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--model', opts.model ?? 'sonnet',
  ];
  if (opts.system !== undefined) args.push('--system-prompt', opts.system);
  args.push('--tools', opts.tools && opts.tools.length > 0 ? opts.tools.join(',') : '');
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  args.push('--strict-mcp-config');
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  if (opts.effort) args.push('--effort', opts.effort);
  return args;
}

interface StreamEvent {
  type: string;
  message?: { content?: Array<{ type: string; name?: string; content?: unknown }> };
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n: number, c: { text?: string }) => n + (c.text?.length ?? 0), 0);
  }
  return 0;
}

function parse(stdout: string): ClaudeRun {
  const parsed = JSON.parse(stdout) as StreamEvent | StreamEvent[];
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const result = events.findLast((e) => e.type === 'result');
  if (!result) throw new Error('no result event');
  const toolNames: string[] = [];
  let toolResultChars = 0;
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (e.type === 'assistant' && c.type === 'tool_use' && c.name) toolNames.push(c.name);
      if (e.type === 'user' && c.type === 'tool_result') toolResultChars += resultChars(c.content);
    }
  }
  const u = result.usage ?? {};
  const usage: Usage = {
    input: u.input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  return {
    text: result.result ?? '',
    structured: result.structured_output,
    isError: Boolean(result.is_error),
    usage,
    totalIn: usage.input + usage.cacheCreation + usage.cacheRead,
    costUsd: result.total_cost_usd ?? 0,
    durationMs: result.duration_ms ?? 0,
    numTurns: result.num_turns ?? 0,
    toolCalls: toolNames.length,
    toolNames,
    toolResultChars,
  };
}

function exec(opts: ClaudeOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', buildArgs(opts), {
      cwd: opts.cwd ?? RESULTS_DIR,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 15 * 60_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (out.trim().startsWith('[') || out.trim().startsWith('{')) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 500)} ${out.slice(0, 500)}`));
    });
    child.stdin.end(opts.prompt);
  });
}

export async function runClaude(opts: ClaudeOpts, retries = 2): Promise<ClaudeRun> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${opts.tag ?? 'run'}-${cacheKey(opts)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ClaudeRun;
  for (let attempt = 0; ; attempt++) {
    try {
      const run = parse(await exec(opts));
      if (run.isError && /rate|overloaded|api_error|timeout/i.test(run.text) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
        continue;
      }
      if (!run.isError) writeFileSync(file, JSON.stringify(run));
      return run;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
    }
  }
}

export async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
      done++;
      if (done % 10 === 0 || done === items.length) process.stderr.write(`  ${done}/${items.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
