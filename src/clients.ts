/**
 * One neutral call to a model, in the two wire shapes the roster uses: Anthropic's Messages, and OpenAI's chat
 * completions (OpenAI, Google's OpenAI-compatible endpoint, and an Ollama deployment on Nosana).
 * A key goes only in a header. Nothing here logs a request or an answer.
 */
export type ToolDef = { name: string; description: string; parameters: unknown };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; id: string; name: string; result: string };
/** `input` is every input token of the call, cached or not; the other two say how many of them were cache reads and writes. */
export type Usage = { input: number; output: number; cachedInput: number; cacheWrite: number };
export const noUsage = (): Usage => ({ input: 0, output: 0, cachedInput: 0, cacheWrite: 0 });
export type CallRequest = {
  system: string;
  messages: Message[];
  tools?: readonly ToolDef[];
  forceTool?: string;
  maxTokens: number;
  /** A multi-turn loop resends its context, so it asks to cache it. A single call doesn't: a cache write costs more than none. */
  cache?: boolean;
};
export type CallResult = { text: string; toolCalls: ToolCall[]; usage: Usage; model: string | null; id: string | null; stop: string | null; callRef: string | null };
export interface ModelClient {
  call(r: CallRequest): Promise<CallResult>;
}
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export type ClientOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Sent with every call: the gateway's agent key and provider, when the call goes through the gateway. */
  headers?: Record<string, string>;
  /** OpenAI's newer models take `max_completion_tokens`; Google's and Ollama's endpoints take `max_tokens`. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const parseArgs = (s: unknown): Record<string, unknown> => {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  try {
    const v = JSON.parse(String(s ?? '{}'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

async function post(o: ClientOptions, url: string, headers: Record<string, string>, body: unknown): Promise<{ json: any; callRef: string | null }> {
  const f = o.fetch ?? fetch;
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...o.headers, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 300_000) });
  // A provider's error body can echo a request; only its status leaves this function.
  if (!res.ok) throw new ModelCallError(`HTTP ${res.status}`, res.status);
  return { json: await res.json(), callRef: res.headers.get('x-call-ref') };
}

export function anthropicClient(o: ClientOptions): ModelClient {
  const toWire = (m: Message) => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.result }] };
    const content: unknown[] = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
    return { role: 'assistant', content };
  };
  // Consecutive tool results belong in one user turn.
  const merge = (ms: ReturnType<typeof toWire>[]) => {
    const out: any[] = [];
    for (const m of ms) {
      const last = out.at(-1);
      if (last && last.role === 'user' && m.role === 'user' && Array.isArray(last.content) && Array.isArray(m.content)) last.content.push(...(m.content as unknown[]));
      else out.push({ ...m });
    }
    return out;
  };
  // One moving breakpoint on the newest block caches everything before it, the system prompt and tools included.
  const withCache = (ms: any[]) => {
    const last = ms.at(-1);
    if (!last) return ms;
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b: any) => ({ ...b }));
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    return [...ms.slice(0, -1), { ...last, content }];
  };
  return {
    async call(r) {
      const wire = merge(r.messages.map(toWire));
      const { json, callRef } = await post(o, `${o.baseUrl.replace(/\/+$/, '')}/messages`, { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' }, {
        model: o.model,
        max_tokens: r.maxTokens,
        system: r.system,
        messages: r.cache ? withCache(wire) : wire,
        ...(r.tools?.length ? { tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        ...(r.forceTool ? { tool_choice: { type: 'tool', name: r.forceTool } } : {}),
      });
      const blocks: any[] = Array.isArray(json.content) ? json.content : [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), args: parseArgs(b.input) })),
        usage: {
          input: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_read_input_tokens ?? 0) + (json.usage?.cache_creation_input_tokens ?? 0),
          output: json.usage?.output_tokens ?? 0,
          cachedInput: json.usage?.cache_read_input_tokens ?? 0,
          cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
        },
        model: json.model ?? null,
        id: json.id ?? null,
        stop: json.stop_reason ?? null,
        callRef,
      };
    },
  };
}

export function openaiClient(o: ClientOptions): ModelClient {
  const toWire = (m: Message) => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: m.result };
    return {
      role: 'assistant',
      content: m.text || null,
      ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
    };
  };
  return {
    async call(r) {
      const { json, callRef } = await post(o, `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`, { authorization: `Bearer ${o.apiKey}` }, {
        model: o.model,
        [o.tokenParam ?? 'max_tokens']: r.maxTokens,
        messages: [{ role: 'system', content: r.system }, ...r.messages.map(toWire)],
        ...(r.tools?.length ? { tools: r.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        ...(r.forceTool ? { tool_choice: { type: 'function', function: { name: r.forceTool } } } : {}),
      });
      const msg = json.choices?.[0]?.message ?? {};
      const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      return {
        text: typeof msg.content === 'string' ? msg.content : '',
        toolCalls: calls.map((c, i) => ({ id: String(c.id ?? `call_${i}`), name: String(c.function?.name ?? ''), args: parseArgs(c.function?.arguments) })),
        usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0, cachedInput: json.usage?.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: 0 },
        model: json.model ?? null,
        id: json.id ?? null,
        stop: json.choices?.[0]?.finish_reason ?? null,
        callRef,
      };
    },
  };
}

/** One retry after an error, as 40.3 fixes. Anything else is the caller's to record. */
export async function withOneRetry<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    return f();
  }
}
