/**
 * The author harness (the design, 40.2.1; V-18): every author, whichever model, gets the same prompt, the same read-only
 * tools over the parent commit, and the same caps, and answers with one unified diff. A difference between authors then
 * comes from the model. It holds keys, so it never runs the repository's code; the sandbox does that, without keys.
 */
import { createHash } from 'node:crypto';
import { noUsage, withOneRetry, type Message, type ModelClient, type Usage } from './clients.js';
import { AUTHOR_TOOLS, GitTree, runTool, TREE_LIMITS } from './gitTree.js';

export const AUTHOR_SYSTEM = [
  'You are a software engineer working on one task in a repository, at one commit.',
  'You can read the repository with the tools you are given. You cannot run anything, and you cannot see anything after this commit.',
  'When you are ready, answer with one unified diff in git apply format, with paths relative to the repository root, and nothing else.',
  'Change what the task needs. Your answer is the patch: it is applied as it is, and nobody edits it afterwards.',
].join('\n');

export type AuthorTask = { repo: string; parentSha: string; title: string; description: string };

/** A long PR description is cut here, for authors and verifiers alike, and the cut is said. */
export const MAX_DESCRIPTION_CHARS = 16_000;
export const taskText = (t: Pick<AuthorTask, 'description'>) => (t.description.length > MAX_DESCRIPTION_CHARS ? `${t.description.slice(0, MAX_DESCRIPTION_CHARS)}\n[description cut]` : t.description);

/** The task as its author wrote it, at its parent commit. Nothing from the PR's own diff or tests. */
export function authorPrompt(t: AuthorTask): string {
  return [`Repository: ${t.repo}`, `Commit: ${t.parentSha}`, '', `Task: ${t.title}`, '', taskText(t)].join('\n');
}

export type AuthorCaps = {
  /** Tool calls over the whole patch. */
  maxToolCalls: number;
  /** Input tokens summed over the patch's turns, as the provider reports them. */
  maxInputTokens: number;
  /** Output tokens summed over the patch's turns. */
  maxOutputTokens: number;
  /** Output tokens allowed in one call. */
  maxTokensPerCall: number;
  /** Turns, so a model that answers with neither a tool call nor a diff can't loop. */
  maxTurns: number;
};

/** Set from the dry run, and fixed in the pre-registration (40.3). */
export const DEFAULT_CAPS: AuthorCaps = { maxToolCalls: 15, maxInputTokens: 300_000, maxOutputTokens: 16_000, maxTokensPerCall: 8_000, maxTurns: 20 };

/** Dense text can be this few characters a token; used only for an upper bound. */
const CHARS_PER_TOKEN_AT_WORST = 2.5;

/**
 * A true upper bound on one patch's input tokens, for a reservation. The input cap is checked between calls, so the call
 * that crosses it and the last call asking for the diff both come after it, each at most one full context: the prompt
 * plus every tool result the tool-call cap allows.
 */
export function worstCaseInputTokens(caps: AuthorCaps): number {
  const prompt = (AUTHOR_SYSTEM.length + MAX_DESCRIPTION_CHARS + 2_000) / CHARS_PER_TOKEN_AT_WORST;
  const tools = (caps.maxToolCalls * TREE_LIMITS.readBytes) / CHARS_PER_TOKEN_AT_WORST;
  return Math.ceil(caps.maxInputTokens + 2 * (prompt + tools));
}

export type AuthorResult = {
  /** The diff, or null when the answer had none. */
  patch: string | null;
  status: 'patch' | 'no-diff' | 'error';
  error?: string;
  capHit: 'tool-calls' | 'input-tokens' | 'output-tokens' | 'turns' | null;
  toolCalls: number;
  turns: number;
  usage: Usage;
  models: string[];
  callRefs: string[];
  /** The tool calls made, without their results, for the report and the contamination check. */
  trace: { name: string; args: Record<string, unknown> }[];
};

/** The diff in an answer: a fenced block, else the text from the first `diff --git` or `--- `. */
export function extractPatch(text: string): string | null {
  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.search(/^(diff --git |--- )/m);
  if (start < 0) return null;
  const patch = body.slice(start).trimEnd();
  return `${patch}\n`;
}

export const LAST_CALL = 'The budget for reading is used up. Answer now with your unified diff, and nothing else.';

export async function writePatch(client: ModelClient, tree: GitTree, task: AuthorTask, caps: AuthorCaps = DEFAULT_CAPS): Promise<AuthorResult> {
  const messages: Message[] = [{ role: 'user', text: authorPrompt(task) }];
  const out: AuthorResult = { patch: null, status: 'no-diff', capHit: null, toolCalls: 0, turns: 0, usage: noUsage(), models: [], callRefs: [], trace: [] };
  const overCap = (): AuthorResult['capHit'] =>
    out.toolCalls >= caps.maxToolCalls ? 'tool-calls' : out.usage.input >= caps.maxInputTokens ? 'input-tokens' : out.usage.output >= caps.maxOutputTokens ? 'output-tokens' : out.turns >= caps.maxTurns - 1 ? 'turns' : null;
  let last = false;
  while (out.turns < caps.maxTurns) {
    const hit = overCap();
    if (hit && !last) {
      out.capHit = hit;
      messages.push({ role: 'user', text: LAST_CALL });
      last = true;
    }
    let r;
    try {
      r = await withOneRetry(() => client.call({ system: AUTHOR_SYSTEM, messages, cache: true, ...(last ? {} : { tools: AUTHOR_TOOLS }), maxTokens: Math.max(1, Math.min(caps.maxTokensPerCall, caps.maxOutputTokens - out.usage.output)) }));
    } catch (err) {
      out.status = 'error';
      out.error = (err as Error).message;
      return out;
    }
    out.turns++;
    out.usage.input += r.usage.input;
    out.usage.output += r.usage.output;
    out.usage.cachedInput += r.usage.cachedInput;
    out.usage.cacheWrite += r.usage.cacheWrite;
    if (r.model && !out.models.includes(r.model)) out.models.push(r.model);
    if (r.callRef) out.callRefs.push(r.callRef);
    if (!r.toolCalls.length || last) {
      out.patch = extractPatch(r.text);
      out.status = out.patch ? 'patch' : 'no-diff';
      return out;
    }
    messages.push({ role: 'assistant', text: r.text, toolCalls: r.toolCalls });
    // A model can ask for many tools in one turn. Past the cap each still gets an answer, as the APIs require, but nothing runs.
    for (const call of r.toolCalls) {
      if (out.toolCalls >= caps.maxToolCalls) {
        messages.push({ role: 'tool', id: call.id, name: call.name, result: 'refused: the budget for reading is used up' });
        continue;
      }
      out.toolCalls++;
      out.trace.push({ name: call.name, args: call.args });
      messages.push({ role: 'tool', id: call.id, name: call.name, result: await runTool(tree, call.name, call.args) });
    }
  }
  return out;
}

/** The hashes of the fixed text, recorded in the pre-registration, so a change of prompt after it is visible. */
export const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
