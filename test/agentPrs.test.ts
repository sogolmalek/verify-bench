import { describe, expect, it } from 'vitest';
import { AGENT_VERIFIERS, broadProblem, codeownersPatterns, quality1, quality2, riskPatternsOf, strictProblem, stripTask, type PrFacts } from '../src/agentPrs.js';
import { coAuthoredBy, readAgentPatch } from '../src/agentPatch.js';
import { answerRoom, askRanker, pCorrect, riskScore } from '../src/rankVerifier.js';
import { baseRate, crossFittedPoint, precisionCoverageCurve, rankingClaimHolds, recallAt, recallResult, SIZE, thresholdFor, type CurveRow, type RankRow } from '../src/ranking.js';
import { eligibleVerifiers } from '../src/quorum.js';

const facts = (o: Partial<PrFacts> = {}): PrFacts => ({ agent: 'a', repo: 'r', state: 'merged', independent: true, ciGreenAtMerge: true, personCommits: 0, changesRequested: false, reverted: false, fixedForward: false, laterIssues: 0, touches: [], linesChanged: 10, ...o });

describe('what a verifier may read', () => {
  it('strips markers, links and claims about tests or CI, and keeps the task', () => {
    const t = stripTask('[Copilot] Retry webhooks', 'Retry failed deliveries up to 3 times.\n\nAll tests pass ✅\nCI is green.\n🤖 Generated with Claude Code\nSee [the doc](https://x.y/z) and https://a.b/c\n<!-- hidden -->\nCo-authored-by: Bot <b@c>');
    expect(t.title).toBe('Retry webhooks');
    expect(t.description).toContain('Retry failed deliveries');
    expect(t.description).toContain('See the doc');
    expect(t.description).not.toMatch(/pass|green|Generated|https|hidden|Co-authored/i);
  });
  it('caps the length, and survives no body', () => {
    expect(stripTask('t', null).description).toBe('');
    expect(stripTask('t', 'x'.repeat(9000)).description).toHaveLength(4000);
  });
});

describe('risk patterns are mechanical', () => {
  it('reads CODEOWNERS beside the fixed list, leaving out a catch-all', () => {
    expect(codeownersPatterns('# c\n* @all\n/api/ @a\ndocs/*.md @b # note\n')).toEqual(['api/**', 'docs/*.md']);
    expect(riskPatternsOf(null)).toContain('.github/workflows/**');
    expect(riskPatternsOf('/api/ @a')).toContain('api/**');
  });
});

describe('the two truths', () => {
  it('quality@1 is an upper bound, and quality@2 lowers it', () => {
    expect(quality1(facts())).toBe(true);
    expect(quality1(facts({ state: 'closed' }))).toBe(false);
    expect(quality1(facts({ personCommits: 1 }))).toBe(false);
    const fixedLater = facts({ touches: [{ byOther: true, fixMessage: true, test: false }] });
    expect(quality1(fixedLater)).toBe(true);
    expect(quality2(fixedLater)).toBe(false);
  });
  it('strict is primary: a refactor is broad and not strict', () => {
    const refactor = facts({ touches: [{ byOther: true, fixMessage: false, test: false }] });
    expect(broadProblem(refactor)).toBe(true);
    expect(strictProblem(refactor)).toBe(false);
    expect(quality2(refactor)).toBe(true);
    expect(strictProblem(facts({ touches: [{ byOther: true, fixMessage: false, test: true }] }))).toBe(true);
    expect(strictProblem(facts({ laterIssues: 1 }))).toBe(true);
    expect(strictProblem(facts({ reverted: true }))).toBe(true);
    // The agent's own later commit isn't anyone else's finding, and a closed PR has no later life.
    expect(strictProblem(facts({ touches: [{ byOther: false, fixMessage: true, test: true }] }))).toBe(false);
    expect(strictProblem(facts({ state: 'closed', laterIssues: 1 }))).toBe(false);
  });
});

describe('the vendor rule', () => {
  it('removes Gemini on Jules', () => {
    expect(eligibleVerifiers(AGENT_VERIFIERS, 'google').map((v) => v.id)).toEqual(['qwen3.8:27b', 'glm-4.7-flash', 'devstral']);
    expect(eligibleVerifiers(AGENT_VERIFIERS, 'github')).toHaveLength(4);
  });
});

describe('a vote', () => {
  const client = (answer: Record<string, unknown>) => ({ call: async () => ({ text: typeof answer.text === 'string' ? answer.text : '', toolCalls: answer.text ? [] : [{ id: '1', name: 'decide', args: answer }], usage: { input: 10, output: 5, cachedInput: 0, cacheWrite: 0 }, model: 'm', id: null, stop: null, callRef: null }) });
  it('reads the tool call, or JSON in the text, and times it', async () => {
    let t = 0;
    const now = () => (t += 2000);
    expect(await askRanker(client({ decision: 'reject', confidence: 20, reason: 'bug' }), 'o/r', { title: 't', description: '' }, 'diff', now)).toMatchObject({ vote: 'reject', confidence: 20, seconds: 2 });
    expect(await askRanker(client({ text: 'ok {"decision":"accept","confidence":90,"reason":"fine"}' }), 'o/r', { title: 't', description: '' }, 'diff')).toMatchObject({ vote: 'accept', confidence: 90 });
  });
  it('no valid decision, or an error after its retry, is a missing vote', async () => {
    expect(await askRanker(client({ decision: 'maybe' }), 'o/r', { title: 't', description: '' }, 'diff')).toMatchObject({ vote: null, error: 'no valid decision' });
    expect(await askRanker({ call: async () => { throw new Error('boom'); } }, 'o/r', { title: 't', description: '' }, 'diff')).toMatchObject({ vote: null, error: 'boom' });
  });
  // The probe's 11 missing votes (2026-11-07): 9 stopped at the 4,000-token limit while thinking; Ollama ignores tool_choice, so text answers count.
  const raw = (text: string, stop: string | null = 'stop', calls: { name: string; args: Record<string, unknown> }[] = []) => {
    const seen: number[] = [];
    return { seen, client: { call: async (r: { maxTokens: number }) => (seen.push(r.maxTokens), { text, toolCalls: calls.map((c, i) => ({ id: String(i), ...c })), usage: { input: 10, output: 5, cachedInput: 0, cacheWrite: 0 }, model: 'm', id: null, stop, callRef: null }) } };
  };
  const ask = (c: { call: (r: any) => Promise<any> }, patch = 'diff') => askRanker(c as any, 'o/r', { title: 't', description: '' }, patch);
  it('reads an answer written in text, in the forms open-weight servers use', async () => {
    expect(await ask(raw('[TOOL_CALLS]decide[ARGS]{"decision": "accept", "confidence": 80, "reason": "fine"}').client)).toMatchObject({ vote: 'accept', confidence: 80 });
    expect(await ask(raw('```json\n{"name": "decide", "arguments": {"decision": "Reject", "confidence": 30, "reason": "off by one"}}\n```').client)).toMatchObject({ vote: 'reject', reason: 'off by one' });
    expect(await ask(raw('{"name":"decide","arguments":"{\\"decision\\":\\"accept\\",\\"confidence\\":70,\\"reason\\":\\"ok\\"}"}').client)).toMatchObject({ vote: 'accept', confidence: 70 });
    // Code in the reason with braces, and a first draft before the answer: the last object with a decision wins.
    expect(await ask(raw('Draft: {"decision":"accept"} then, on reflection: {"decision":"REJECT","confidence":10,"reason":"if (x) { y } is wrong"}').client)).toMatchObject({ vote: 'reject', confidence: 10 });
    expect(await ask(raw('', 'stop', [{ name: 'decide', args: { decision: 'Accept', confidence: 60, reason: 'r' } }]).client)).toMatchObject({ vote: 'accept' });
  });
  it('prose with no decision is still missing, and says which kind', async () => {
    expect(await ask(raw('I would accept this patch, it looks fine.').client)).toMatchObject({ vote: null, error: 'no valid decision', excerpt: 'I would accept this patch, it looks fine.' });
    expect(await ask(raw('', 'length').client)).toMatchObject({ vote: null, error: 'ran out of tokens', stop: 'length' });
  });
  it('gives the answer 16,000 tokens, less where the context would overflow, and never cuts a prompt', async () => {
    const small = raw('{"decision":"accept","confidence":90,"reason":"x"}');
    await ask(small.client);
    expect(small.seen).toEqual([16_000]);
    const big = raw('{"decision":"accept","confidence":90,"reason":"x"}');
    await ask(big.client, 'x'.repeat(3 * 20_000));
    expect(big.seen[0]).toBeGreaterThanOrEqual(4_000);
    expect(big.seen[0]! + Math.ceil((3 * 20_000) / 3)).toBeLessThanOrEqual(32_768);
    const huge = raw('{"decision":"accept"}');
    expect(await ask(huge.client, 'x'.repeat(3 * 30_000))).toMatchObject({ vote: null, error: 'too long for the context' });
    expect(huge.seen).toEqual([]);
    expect(answerRoom('short')).toBe(16_000);
  });
  it('the vote sets the side, and the ranking takes the mean of the votes cast', () => {
    expect(pCorrect({ vote: 'accept', confidence: 20 })).toBe(0.5);
    expect(pCorrect({ vote: 'reject', confidence: 90 })).toBe(0.5);
    expect(pCorrect({ vote: null, confidence: 90 })).toBeNull();
    expect(riskScore([{ vote: 'accept', confidence: 90 }, { vote: 'reject', confidence: 10 }, { vote: null, confidence: null }])).toBeCloseTo(0.5);
    expect(riskScore([])).toBeNull();
  });
});

describe('recall at k', () => {
  const row = (i: number, problem: boolean, lines: number, c: number | null, repo = `r${i % 8}`): RankRow => ({ id: `p${i}`, repo, problem, lines, scores: { armC: c } });
  it('is the share of problems in the top k', () => {
    const rows = [row(0, true, 1, 0.9), row(1, true, 1, 0.8), row(2, false, 1, 0.7), row(3, false, 1, 0.6), row(4, true, 1, 0.1), row(5, false, 1, 0.2), row(6, false, 1, 0.3), row(7, false, 1, 0.4), row(8, false, 1, 0.45), row(9, false, 1, 0.5)];
    expect(recallAt(rows, (r) => r.scores.armC!, 0.2)).toBeCloseTo(2 / 3);
    expect(recallAt(rows.map((r) => ({ ...r, problem: false })), SIZE, 0.2)).toBeNull();
  });
  it('a score unrelated to the problems ranks like random; a good one beats size, with an interval over repositories', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(i, i % 4 === 0, 1 + (i * 7) % 90, i % 4 === 0 ? 0.9 : 0.1 + ((i % 13) / 100), `r${i % 40}`));
    const r = recallResult(rows, 'armC', 0.2, 200);
    expect(r.recall).toBeGreaterThan(0.7);
    expect(r.againstSize!.low).toBeGreaterThan(0);
    expect(r.againstRandom!.low).toBeGreaterThan(0);
    expect(rankingClaimHolds(r)).toBe(true);
    expect(rankingClaimHolds({ ...r, k: 0.1 })).toBe(false);
    const noise = recallResult(rows.map((x) => ({ ...x, scores: { armC: ((Number(x.id.slice(1)) * 37) % 100) / 100 } })), 'armC', 0.2, 200);
    expect(rankingClaimHolds(noise)).toBe(false);
  }, 120_000);
});

describe('the curve and its operating points', () => {
  const rows: CurveRow[] = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, repo: `r${i % 25}`, correct: i < 400, riskPath: i % 10 === 9, pCorrect: i < 400 ? 0.9 : 0.5 + ((i % 40) / 100) }));
  it('gives a point for each threshold, with coverage falling as it rises', () => {
    const c = precisionCoverageCurve(rows);
    expect(c.length).toBeGreaterThan(5);
    expect(c[0]!.coverage).toBeLessThanOrEqual(c[c.length - 1]!.coverage);
    expect(thresholdFor(rows, 0.15)).toBeGreaterThanOrEqual(0.5);
  });
  it('sets each fold’s threshold on the others, and a claim needs both precision and coverage', () => {
    const clean: CurveRow[] = rows.map((r) => ({ ...r, pCorrect: r.correct ? 0.95 : 0.2 }));
    const p = crossFittedPoint(clean, 0.15);
    expect(p.precision.share).toBe(1);
    expect(p.holds).toBe(true);
    const noisy = crossFittedPoint(rows, 0.4);
    expect(noisy.precision.share!).toBeLessThan(0.95);
    expect(noisy.holds).toBe(false);
  });
});

describe('the base rate', () => {
  it('counts independently judged PRs per agent, with intervals', () => {
    const rows = [facts({ agent: 'a' }), facts({ agent: 'a', personCommits: 1 }), facts({ agent: 'a', independent: false }), facts({ agent: 'b', state: 'closed' })];
    const r = baseRate(rows, quality1);
    expect(r.a).toMatchObject({ k: 1, n: 2 });
    expect(r.b).toMatchObject({ k: 0, n: 1 });
    expect(r.a!.lower!).toBeGreaterThanOrEqual(0);
  });
});

describe("the agent's patch", () => {
  const fake = (commits: unknown[], status = 200) =>
    (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/compare/')) return new Response((init?.headers as Record<string, string>).accept?.includes('diff') && status === 200 ? `diff of ${u.split('...')[1]}` : '', { status });
      if (u.endsWith('/commits?per_page=100')) return Response.json(commits);
      return Response.json({ title: '[Claude] Do it', body: 'Do it.\nAll tests pass', base: { sha: 'base' }, user: { login: 'claude[bot]' } });
    }) as unknown as typeof fetch;
  const commit = (sha: string, login: string, type?: string) => ({ sha, author: { login, type }, commit: { author: { name: login } } });
  it('stops at the first person, and strips the task', async () => {
    const p = await readAgentPatch('o/r', 1, { fetch: fake([commit('a1', 'claude[bot]', 'Bot'), commit('a2', 'claude[bot]', 'Bot'), commit('p1', 'ana'), commit('a3', 'claude[bot]', 'Bot')]) });
    expect(p).toMatchObject({ agentCommit: 'a2', commitsDropped: 2, patch: 'diff of a2', task: { title: 'Do it', description: 'Do it.' } });
  });
  const byPerson = (sha: string, login: string, message: string) => ({ sha, author: { login }, commit: { author: { name: login }, message } });
  it('amendment 3: a person’s commit with a co-author line naming the PR’s agent is the agent’s, and the PR is co-authored', async () => {
    const devin = 'Fix it\n\nCo-Authored-By: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>';
    const p = await readAgentPatch('o/r', 1, { coAuthor: /devin/i, fetch: fake([byPerson('d1', 'jesus', devin), byPerson('d2', 'jesus', devin), byPerson('p1', 'jesus', 'Tidy')]) });
    expect(p).toMatchObject({ agentCommit: 'd2', commitsDropped: 1, coAuthored: true });
    // Another agent's line, or none, doesn't count; without the amendment's pattern the rule is as before.
    expect(await readAgentPatch('o/r', 1, { coAuthor: /devin/i, fetch: fake([byPerson('c1', 'ana', 'x\n\nCo-authored-by: Claude <noreply@anthropic.com>')]) })).toBeNull();
    expect(await readAgentPatch('o/r', 1, { fetch: fake([byPerson('d1', 'jesus', devin)]) })).toBeNull();
    // A bot's own commits aren't co-authored.
    expect(await readAgentPatch('o/r', 1, { coAuthor: /claude/i, fetch: fake([commit('a1', 'claude[bot]', 'Bot')]) })).toMatchObject({ coAuthored: false });
  });
  it('reads a co-author line only as a trailer line naming the agent', () => {
    expect(coAuthoredBy('x\n\nCo-authored-by: Claude <noreply@anthropic.com>', /\bclaude\b/i)).toBe(true);
    expect(coAuthoredBy('Asked Claude about it\nCo-authored-by: Ana <a@b.c>', /\bclaude\b/i)).toBe(false);
    expect(coAuthoredBy('no trailer', /devin/i)).toBe(false);
  });
  it('is null when a person wrote the first commit, or the diff can’t be read', async () => {
    expect(await readAgentPatch('o/r', 1, { fetch: fake([commit('p1', 'ana')]) })).toBeNull();
    expect(await readAgentPatch('o/r', 1, { fetch: fake([commit('a1', 'claude[bot]', 'Bot')], 404) })).toBeNull();
  });
});
