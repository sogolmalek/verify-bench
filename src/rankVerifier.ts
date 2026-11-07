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

export type RankVote = { vote: 'accept' | 'reject' | null; confidence: number | null; reason: string | null; usage: Usage; model: string | null; seconds: number; error?: string };

export const RANK_MAX_TOKENS = 4_000;

/** Some open-weight servers answer with JSON in the text rather than a tool call. Read it the same way. */
function fromText(text: string): Record<string, unknown> {
  const m = /\{[\s\S]*"decision"[\s\S]*\}/.exec(text);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function askRanker(client: ModelClient, repo: string, task: { title: string; description: string }, patch: string, now: () => number = () => performance.now()): Promise<RankVote> {
  const started = now();
  try {
    const r = await withOneRetry(() => client.call({ system: RANK_SYSTEM, messages: [{ role: 'user', text: rankPrompt(repo, task, patch) }], tools: [RANK_DECIDE_TOOL], forceTool: 'decide', maxTokens: RANK_MAX_TOKENS }));
    const d = r.toolCalls.find((t) => t.name === 'decide')?.args ?? fromText(r.text);
    const vote = d.decision === 'accept' || d.decision === 'reject' ? d.decision : null;
    const c = Number(d.confidence);
    return { vote, confidence: Number.isFinite(c) && c >= 0 && c <= 100 ? c : null, reason: typeof d.reason === 'string' ? d.reason.slice(0, 1_000) : null, usage: r.usage, model: r.model, seconds: (now() - started) / 1000, ...(vote ? {} : { error: 'no valid decision' }) };
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
