/**
 * One verifier's vote on a PR an agent wrote (PREREGISTRATION.md): a `decide` tool, with accept or reject, a reason, and how sure it is that
 * the patch is correct. It sees the stripped task and the agent's diff, never the PR's state, comments, reviews, CI, later commits or author.
 * An error after one retry, or no valid decision, is a missing vote.
 */
import { noUsage, withOneRetry, type ModelClient, type Usage } from './clients.js';

export const RANK_SYSTEM = [
  'You review one pull request before it is merged. You see what it was asked to do, and its diff.',
  'Decide whether the patch correctly does the task, without breaking what already works.',
  'Reject it if you find a defect that would make it wrong. Accept it if you do not.',
  'Say how confident you are, from 0 to 100, that the patch is correct.',
  'Answer only by calling the decide tool.',
].join('\n');

export const RANK_DECIDE_TOOL = {
  name: 'decide',
  description: 'Record your decision on this patch.',
  parameters: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['accept', 'reject'] },
      confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'How confident you are, 0 to 100, that the patch is correct.' },
      reason: { type: 'string', description: 'One or two sentences.' },
    },
    required: ['decision', 'confidence', 'reason'],
  },
} as const;

export const rankPrompt = (repo: string, t: { title: string; description: string }, patch: string) => [`Repository: ${repo}`, '', `Task: ${t.title}`, '', t.description || '(no description)', '', 'The patch:', '', patch].join('\n');

export type RankVote = { vote: 'accept' | 'reject' | null; confidence: number | null; reason: string | null; usage: Usage; model: string | null; seconds: number; stop?: string | null; error?: string; excerpt?: string };

/**
 * The answer's room. The probe's 4,000 ran out: Ollama counts a thinking model's reasoning in the output, and all 9 of Qwen's and
 * GLM's missing votes stopped at exactly 4,000 with no decision. 16,000 lets them finish, inside the server's context.
 */
export const RANK_MAX_TOKENS = 16_000;
/** The context the Nosana deployments are started with (OLLAMA_CONTEXT_LENGTH). Past it, Ollama cuts the prompt without saying so. */
export const RANK_CONTEXT = 32_768;
/** Below this much room for the answer a vote isn't asked for, and the PR is counted as too long, for every verifier alike. */
export const RANK_MIN_ANSWER = 4_000;
/** A conservative count of a prompt's tokens: about 3 characters a token for code. */
export const promptTokens = (system: string, prompt: string) => Math.ceil((system.length + prompt.length) / 3) + 200;
/** The room for the answer: 16,000, or less where the prompt would push the total past the context. Null when under the minimum. */
export function answerRoom(prompt: string, o: { context?: number; max?: number; min?: number } = {}): number | null {
  const room = Math.min(o.max ?? RANK_MAX_TOKENS, (o.context ?? RANK_CONTEXT) - promptTokens(RANK_SYSTEM, prompt));
  return room >= (o.min ?? RANK_MIN_ANSWER) ? room : null;
}

/**
 * Ollama's OpenAI-compatible endpoint doesn't honour `tool_choice`, so a model may answer in its text instead of the tool: as JSON, inside
 * a template marker such as `[TOOL_CALLS]decide[ARGS]{...}`, or in a code block. Every balanced JSON object in the text is tried, the
 * last with a decision wins, and the decision is read regardless of case. Nothing else in prose counts as a vote.
 */
export function fromText(text: string): Record<string, unknown> {
  const found: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const o = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
          const inner = (o.arguments ?? o.parameters ?? o.args) as Record<string, unknown> | string | undefined;
          const args = typeof inner === 'string' ? (JSON.parse(inner) as Record<string, unknown>) : inner;
          if (args && typeof args === 'object' && 'decision' in args) found.push(args);
          else if ('decision' in o) found.push(o);
        } catch {
          // not JSON: keep looking
        }
        break;
      }
    }
  }
  return found.at(-1) ?? {};
}
const decisionOf = (d: Record<string, unknown>) => {
  const x = typeof d.decision === 'string' ? d.decision.trim().toLowerCase() : '';
  return x === 'accept' || x === 'reject' ? x : null;
};

export async function askRanker(client: ModelClient, repo: string, task: { title: string; description: string }, patch: string, now: () => number = () => performance.now()): Promise<RankVote> {
  const started = now();
  const prompt = rankPrompt(repo, task, patch);
  const room = answerRoom(prompt);
  if (room === null) return { vote: null, confidence: null, reason: null, usage: noUsage(), model: null, seconds: 0, error: 'too long for the context' };
  try {
    const r = await withOneRetry(() => client.call({ system: RANK_SYSTEM, messages: [{ role: 'user', text: prompt }], tools: [RANK_DECIDE_TOOL], forceTool: 'decide', maxTokens: room }));
    const call = r.toolCalls.find((t) => t.name === 'decide')?.args;
    const d = call && decisionOf(call) ? call : fromText(r.text);
    const vote = decisionOf(d);
    const c = Number(d.confidence);
    // A missing vote says why: the room ran out, or the model answered without a decision. Its first words are kept to show which.
    const why = vote ? {} : { error: r.stop === 'length' ? 'ran out of tokens' : 'no valid decision', excerpt: r.text.slice(0, 500) };
    return { vote, confidence: Number.isFinite(c) && c >= 0 && c <= 100 ? c : null, reason: typeof d.reason === 'string' ? d.reason.slice(0, 1_000) : null, usage: r.usage, model: r.model, seconds: (now() - started) / 1000, stop: r.stop, ...why };
  } catch (err) {
    return { vote: null, confidence: null, reason: null, usage: noUsage(), model: null, seconds: (now() - started) / 1000, error: (err as Error).message };
  }
}

/** Its estimate that the patch is correct, in [0, 1]. A rejection with no stated confidence is low, an acceptance high. */
export function pCorrect(v: Pick<RankVote, 'vote' | 'confidence'>): number | null {
  if (v.vote === null) return null;
  if (v.confidence === null) return v.vote === 'accept' ? 0.75 : 0.25;
  // A vote and a number can disagree; the vote sets the side.
  const c = v.confidence / 100;
  return v.vote === 'accept' ? Math.max(c, 0.5) : Math.min(c, 0.5);
}
/** A risk score for the ranking: arm C's is the mean over the votes cast. */
export function riskScore(votes: readonly Pick<RankVote, 'vote' | 'confidence'>[]): number | null {
  const ps = votes.map(pCorrect).filter((x): x is number => x !== null);
  return ps.length ? 1 - ps.reduce((a, x) => a + x, 0) / ps.length : null;
}
