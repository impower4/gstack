import { spawn } from 'child_process';
import type { RunResult, ToolTimelineEntry } from './types';

/** Usage, turns and the latest text from `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export interface ClaudeStreamState {
  totals: { input: number; output: number; cached: number };
  /** The message each stream (main thread or a tool's subagent) is currently receiving. */
  open: Map<string, { input: number; output: number; cached: number }>;
  /** Subagent messages, by message id: claude prints them only as `assistant` events tagged with their Agent call. */
  subagents: Map<string, { input: number; output: number; cached: number }>;
  turns: number;
  /** Turns summed over every `result` event: a background subagent's completion gives the main thread another result. */
  resultTurns: number;
  lastText: string;
  result?: Record<string, unknown>;
  invalidLines: number;
  startedAt: number;
  /** Content-free: each tool call's name, start and end offsets and thread, never its input or output. */
  toolTimeline: ToolTimelineEntry[];
  /** Timeline index by tool-use id, for recorded calls only, so it stays within the timeline cap. */
  toolUseIndex: Map<string, number>;
}

export function claudeStreamState(): ClaudeStreamState {
  return { totals: { input: 0, output: 0, cached: 0 }, open: new Map(), subagents: new Map(), turns: 0, resultTurns: 0, lastText: '', invalidLines: 0, startedAt: Date.now(), toolTimeline: [], toolUseIndex: new Map() };
}

const TOOL_TIMELINE_LIMIT = 4096;

const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

function recordToolUse(state: ClaudeStreamState, block: { id?: unknown; name?: unknown }, agent: 'main' | 'subagent'): void {
  if (typeof block.id !== 'string' || state.toolUseIndex.has(block.id) || state.toolTimeline.length >= TOOL_TIMELINE_LIMIT) return;
  state.toolUseIndex.set(block.id, state.toolTimeline.length);
  state.toolTimeline.push({
    atMs: Date.now() - state.startedAt,
    tool: typeof block.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(block.name) ? block.name : 'other',
    agent,
  });
}

function recordToolResult(state: ClaudeStreamState, block: { tool_use_id?: unknown }): void {
  const index = typeof block.tool_use_id === 'string' ? state.toolUseIndex.get(block.tool_use_id) : undefined;
  if (index !== undefined && state.toolTimeline[index].endMs === undefined) state.toolTimeline[index].endMs = Date.now() - state.startedAt;
}

function close(state: ClaudeStreamState, key: string): void {
  const message = state.open.get(key);
  if (!message) return;
  state.totals.input += message.input; state.totals.output += message.output; state.totals.cached += message.cached;
  state.open.delete(key);
}

export function consumeClaudeStreamLine(state: ClaudeStreamState, line: string): void {
  if (!line.trim()) return;
  let event: any;
  try { event = JSON.parse(line); } catch { state.invalidLines++; return; }
  if (!event || typeof event !== 'object') { state.invalidLines++; return; }
  if (event.type === 'result') {
    state.result = event;
    if (Number.isSafeInteger(event.num_turns) && event.num_turns >= 0) state.resultTurns += event.num_turns;
    return;
  }
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) if (block?.type === 'tool_use') recordToolUse(state, block, typeof event.parent_tool_use_id === 'string' ? 'subagent' : 'main');
  }
  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) if (block?.type === 'tool_result') recordToolResult(state, block);
    return;
  }
  if (event.type === 'assistant' && typeof event.parent_tool_use_id === 'string') {
    const usage = event.message?.usage;
    if (typeof event.message?.id === 'string' && usage) state.subagents.set(event.message.id, { input: count(usage.input_tokens), output: count(usage.output_tokens), cached: count(usage.cache_read_input_tokens) });
    return;
  }
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) state.lastText = block.text;
    return;
  }
  if (event.type !== 'stream_event' || !event.event) return;
  const key = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : 'main';
  const stream = event.event;
  if (stream.type === 'message_start') {
    close(state, key);
    const usage = stream.message?.usage ?? {};
    state.open.set(key, { input: count(usage.input_tokens), output: count(usage.output_tokens), cached: count(usage.cache_read_input_tokens) });
    if (key === 'main') state.turns++;
  } else if (stream.type === 'content_block_start' && stream.content_block?.type === 'tool_use') {
    recordToolUse(state, stream.content_block, key === 'main' ? 'main' : 'subagent');
  } else if (stream.type === 'message_delta' && stream.usage) {
    const message = state.open.get(key);
    if (!message) return;
    // Anthropic message_delta usage is cumulative for the message.
    if (stream.usage.output_tokens !== undefined) message.output = count(stream.usage.output_tokens);
    if (stream.usage.input_tokens !== undefined) message.input = count(stream.usage.input_tokens);
    if (stream.usage.cache_read_input_tokens !== undefined) message.cached = count(stream.usage.cache_read_input_tokens);
  } else if (stream.type === 'message_stop') {
    close(state, key);
  }
}

/** Every message seen so far, subagents' included, and ones a kill interrupted mid-stream. */
export function claudeStreamUsage(state: ClaudeStreamState): { input: number; output: number; cached: number } {
  const totals = { ...state.totals };
  for (const message of [...state.open.values(), ...state.subagents.values()]) { totals.input += message.input; totals.output += message.output; totals.cached += message.cached; }
  return totals;
}

/** `modelUsage` is the session total across models, subagents included; `usage` covers only the main thread's last turn. */
function resultTokens(result: Record<string, unknown>): { input: number; output: number; cached: number } | undefined {
  const models = result.modelUsage;
  if (models && typeof models === 'object' && Object.keys(models).length) {
    const totals = { input: 0, output: 0, cached: 0 };
    for (const usage of Object.values(models as Record<string, Record<string, unknown>>)) {
      totals.input += count(usage?.inputTokens); totals.output += count(usage?.outputTokens); totals.cached += count(usage?.cacheReadInputTokens);
    }
    return totals;
  }
  const usage = result.usage as Record<string, unknown> | undefined;
  return usage ? { input: count(usage.input_tokens), output: count(usage.output_tokens), cached: count(usage.cache_read_input_tokens) } : undefined;
}

/**
 * The final `result` event is authoritative for usage (its `modelUsage` session totals) and its text; turns sum over
 * every result. Without one (a killed run) the per-message stream usage stands in. A paid producer still needs a
 * successful result event with a nonblank `result`.
 */
export function resultFromClaudeStream(state: ClaudeStreamState, opts: { model: string; durationMs: number; error?: RunResult['error'] }): RunResult {
  const result = state.result;
  const tokens = (result && resultTokens(result)) ?? claudeStreamUsage(state);
  const toolCalls = result ? state.resultTurns : state.turns;
  const modelUsed = typeof result?.model === 'string' && result.model ? result.model : opts.model;
  const base = { tokens, durationMs: opts.durationMs, toolCalls, toolTimeline: state.toolTimeline, modelUsed };
  if (opts.error) return { ...base, output: typeof result?.result === 'string' ? result.result : state.lastText, error: opts.error };
  const explicitError = result?.is_error === true || (typeof result?.subtype === 'string' && result.subtype !== 'success');
  if (!result || explicitError || typeof result.result !== 'string' || !result.result.trim()) {
    return { ...base, output: '', error: { code: 'unknown', reason: 'empty or invalid output from claude CLI (exit 0)' } };
  }
  return { ...base, output: result.result };
}

const LINE_LIMIT = 32 * 1024 * 1024, STDERR_LIMIT = 64 * 1024, KILL_GRACE_MS = 10_000;

/** Run the producer's claude, folding its event stream as it arrives so a timeout still leaves usage behind. */
export function runClaudeProducerStream(command: string, args: string[], opts: { input: string; cwd: string; env: Record<string, string>; timeoutMs: number; model: string }): Promise<RunResult> {
  return new Promise(resolve => {
    const started = Date.now(), state = claudeStreamState();
    let pending = '', stderr = '', timedOut = false, overflow = false, spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) { consumeClaudeStreamLine(state, pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (pending.length > LINE_LIMIT && !overflow) { overflow = true; pending = ''; stop(); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length); });
    child.stdin.on('error', () => {});
    let settled = false, exitTimer: ReturnType<typeof setTimeout> | undefined;
    child.on('error', error => { spawnError = error; if (child.pid === undefined) finish(null, null); });
    // A grandchild that inherited stdout must not hold the result open after claude itself exits.
    child.on('exit', (code, signal) => { exitTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, 2000); });
    child.on('close', (code, signal) => finish(code, signal));
    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (exitTimer) clearTimeout(exitTimer);
      if (!overflow) consumeClaudeStreamLine(state, pending);
      const durationMs = Date.now() - started;
      const fail = (error: NonNullable<RunResult['error']>) => resolve(resultFromClaudeStream(state, { model: opts.model, durationMs, error }));
      if (timedOut) return fail({ code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` });
      if (overflow) return fail({ code: 'unknown', reason: `claude stream-json line exceeded ${LINE_LIMIT} bytes` });
      if (spawnError) return fail({ code: 'unknown', reason: spawnError.message.slice(0, 400) });
      if (code !== 0) {
        if (/unauthorized|auth|login/i.test(stderr)) return fail({ code: 'auth', reason: stderr.slice(0, 400) });
        if (/rate[- ]?limit|429/i.test(stderr)) return fail({ code: 'rate_limit', reason: stderr.slice(0, 400) });
        return fail({ code: 'unknown', reason: `Command failed: ${[command, ...args].join(' ')}${signal ? ` (signal ${signal})` : ''}\n${stderr}`.slice(0, 400) });
      }
      resolve(resultFromClaudeStream(state, { model: opts.model, durationMs }));
    }
    child.stdin.end(opts.input);
  });
}
