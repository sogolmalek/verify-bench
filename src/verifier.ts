/**
 * One verifier's vote (the design, 40.2.1, 40.3): a forced `decide` tool, accept or reject and a reason. It sees the task
 * and the patch, never the PR's tests, their result, the merged diff or another verifier's answer. An error after one
 * retry, or an answer that isn't a valid decision, is a missing vote (40.2.4, rule 4): neither accept nor reject.
 */
import { noUsage, withOneRetry, type ModelClient, type Usage } from './clients.js';
import { taskText, type AuthorTask } from './author.js';

export const VERIFIER_SYSTEM = [
  'You review one patch for one task, before it is merged.',
  'Decide whether the patch correctly does the task, without breaking what already works.',
  'Reject it if you find a defect that would make it wrong. Accept it if you do not.',
  'Answer only by calling the decide tool.',
].join('\n');

export const DECIDE_TOOL = {
  name: 'decide',
  description: 'Record your decision on this patch.',
  parameters: {
    type: 'object',
    properties: { decision: { type: 'string', enum: ['accept', 'reject'] }, reason: { type: 'string', description: 'One or two sentences.' } },
    required: ['decision', 'reason'],
  },
} as const;

export function verifierPrompt(t: AuthorTask, patch: string): string {
  return [`Repository: ${t.repo}`, `Commit: ${t.parentSha}`, '', `Task: ${t.title}`, '', taskText(t), '', 'The patch:', '', patch].join('\n');
}

export type VerifierResult = { vote: 'accept' | 'reject' | null; reason: string | null; usage: Usage; model: string | null; callRef: string | null; error?: string };

export const VERIFIER_MAX_TOKENS = 2_000;

export async function askVerifier(client: ModelClient, task: AuthorTask, patch: string): Promise<VerifierResult> {
  const empty: Usage = noUsage();
  try {
    const r = await withOneRetry(() => client.call({ system: VERIFIER_SYSTEM, messages: [{ role: 'user', text: verifierPrompt(task, patch) }], tools: [DECIDE_TOOL], forceTool: 'decide', maxTokens: VERIFIER_MAX_TOKENS }));
    const d = r.toolCalls.find((t) => t.name === 'decide')?.args ?? {};
    const vote = d.decision === 'accept' || d.decision === 'reject' ? d.decision : null;
    return { vote, reason: typeof d.reason === 'string' ? d.reason.slice(0, 1_000) : null, usage: r.usage, model: r.model, callRef: r.callRef, ...(vote ? {} : { error: 'no valid decision' }) };
  } catch (err) {
    return { vote: null, reason: null, usage: empty, model: null, callRef: null, error: (err as Error).message };
  }
}
