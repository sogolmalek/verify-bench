import { describe, expect, it } from 'vitest';
import { drawSample, exclusion, independent, SAMPLE_AGENTS, type Candidate } from '../src/sample.js';
import { benchGeminiKey, countedClient, DailyLimitReached, nextForGemini } from '../src/geminiDaily.js';

const READ = '2026-11-08T00:00:00Z';
const pr = (o: Partial<Candidate> = {}): Candidate => ({ agent: 'Devin', repo: 'o/r', number: 1, state: 'merged', createdAt: '2026-09-10T00:00:00Z', mergedAt: '2026-09-12T00:00:00Z', closedAt: '2026-09-12T00:00:00Z', lines: 100, stars: 500, fork: false, archived: false, ci: 'SUCCESS', body: '', author: { login: 'devin-ai-integration', __typename: 'Bot' }, mergedBy: { login: 'ana', __typename: 'User' }, closedBy: { login: 'ana', __typename: 'User' }, ...o });
const devin = SAMPLE_AGENTS.find((a) => a.name === 'Devin')!;
const note = SAMPLE_AGENTS.find((a) => a.name === 'Claude Code (body note)')!;

describe('the population', () => {
  it('is independently judged: merged or closed by another person, not a bot and not the PR\'s own account', () => {
    expect(independent(pr())).toBe(true);
    expect(independent(pr({ mergedBy: { login: 'devin-ai-integration', __typename: 'Bot' } }))).toBe(false);
    expect(independent(pr({ mergedBy: { login: 'mergify[bot]' } }))).toBe(false);
    expect(independent(pr({ author: { login: 'Ana' }, mergedBy: { login: 'ana' } }))).toBe(false);
    expect(independent(pr({ state: 'closed', mergedAt: null, closedBy: null }))).toBe(false);
    expect(independent(pr({ state: 'closed', mergedAt: null, closedBy: { login: 'bo', __typename: 'User' } }))).toBe(true);
  });
  it('says why a PR is left out', () => {
    const none = new Set<string>();
    expect(exclusion(pr(), devin, READ, none)).toBeNull();
    expect(exclusion(pr(), devin, READ, new Set(['o/r#1']))).toBe('held out for the probe');
    expect(exclusion(pr({ stars: 99 }), devin, READ, none)).toBe('under 100 stars');
    expect(exclusion(pr({ fork: true }), devin, READ, none)).toBe('a fork or archived');
    expect(exclusion(pr({ lines: 2_001 }), devin, READ, none)).toBe('over 2,000 lines');
    expect(exclusion(pr({ ci: null }), devin, READ, none)).toBe('CI not known');
    expect(exclusion(pr({ createdAt: '2026-09-02T23:59:59Z' }), devin, READ, none)).toBe('created before 2026-09-03');
    // Merged at least 30 days before the read.
    expect(exclusion(pr({ mergedAt: '2026-10-10T00:00:00Z' }), devin, READ, none)).toBe('not 30 days old');
    expect(exclusion(pr({ mergedAt: '2026-10-09T00:00:00Z' }), devin, READ, none)).toBeNull();
    expect(exclusion(pr({ agent: note.name, author: { login: 'ana' }, mergedBy: { login: 'bo' } }), note, READ, none)).toBe("the marker isn't in the body");
    expect(exclusion(pr({ agent: note.name, author: { login: 'ana' }, mergedBy: { login: 'bo' }, markerHolds: true }), note, READ, none)).toBeNull();
  });
});

describe('the draw', () => {
  const many = (n: number, o: (i: number) => Partial<Candidate>) => Array.from({ length: n }, (_, i) => pr({ number: i + 1, ...o(i) }));
  it('keeps the natural share, the per-agent cap, and the per-repository cap', () => {
    const c = [...many(400, (i) => ({ repo: `o/r${i % 40}` })), ...many(100, (i) => ({ number: 1000 + i, repo: `o/c${i % 20}`, state: 'closed', mergedAt: null }))];
    const s = drawSample(c, { seed: 's', readAt: READ, heldOut: new Set(), agents: [devin], perAgent: 100 });
    expect(s.counts.Devin).toMatchObject({ merged: 79, closed: 21, short: { merged: 0, closed: 0 } });
    const perRepo = new Map<string, number>();
    for (const d of s.drawn) perRepo.set(d.repo, (perRepo.get(d.repo) ?? 0) + 1);
    expect(Math.max(...perRepo.values())).toBeLessThanOrEqual(15);
  });
  it('leaves a short state short, rather than filling it from the other', () => {
    const c = [...many(200, (i) => ({ repo: `o/r${i % 40}` })), ...many(5, (i) => ({ number: 1000 + i, repo: `o/c${i}`, state: 'closed', mergedAt: null }))];
    const s = drawSample(c, { seed: 's', readAt: READ, heldOut: new Set(), agents: [devin], perAgent: 100 });
    expect(s.counts.Devin).toMatchObject({ merged: 79, closed: 5, short: { closed: 16 } });
  });
  it('is the same from the same seed, different from another, and draws a PR once', () => {
    const c = many(300, (i) => ({ repo: `o/r${i % 40}` }));
    const a = drawSample(c, { seed: 's', readAt: READ, heldOut: new Set(), agents: [devin], perAgent: 50 });
    expect(drawSample([...c].reverse(), { seed: 's', readAt: READ, heldOut: new Set(), agents: [devin], perAgent: 50 }).drawn.map((d) => d.id)).toEqual(a.drawn.map((d) => d.id));
    expect(drawSample(c, { seed: 't', readAt: READ, heldOut: new Set(), agents: [devin], perAgent: 50 }).drawn.map((d) => d.id)).not.toEqual(a.drawn.map((d) => d.id));
    const twice = drawSample([...c, ...c.map((x) => ({ ...x, agent: 'Claude Code (body note)', markerHolds: true }))], { seed: 's', readAt: READ, heldOut: new Set(), agents: [devin, note], perAgent: 50 });
    expect(new Set(twice.drawn.map((d) => d.id)).size).toBe(twice.drawn.length);
    expect(JSON.stringify(a.drawn)).not.toContain('"body"');
  });
});

describe("Gemini's daily side run", () => {
  it('uses only the bench\'s own key, never the other quota', () => {
    expect(() => benchGeminiKey({ GEMINI_API_KEY: 'core' })).toThrow(/never used here/);
    expect(benchGeminiKey({ GEMINI_API_KEY: 'core', BENCH_GEMINI_API_KEY: 'bench' })).toBe('bench');
  });
  it('takes the sample in order, skips what it voted and Google\'s own agent, and never passes the day\'s requests, retries included', async () => {
    const order = [{ id: 'a', agent: 'Devin' }, { id: 'b', agent: 'Jules' }, { id: 'c', agent: 'Devin' }, { id: 'd', agent: 'Devin' }];
    expect(nextForGemini(order, new Set(['a']), (x) => (x === 'Jules' ? 'google' : 'other'), 2).map((p) => p.id)).toEqual(['c', 'd']);
    const c = countedClient({ call: async () => ({ text: '', toolCalls: [], usage: { input: 0, output: 0, cachedInput: 0, cacheWrite: 0 }, model: null, id: null, stop: null, callRef: null }) }, 2);
    await c.call({} as any);
    await c.call({} as any);
    await expect(c.call({} as any)).rejects.toBeInstanceOf(DailyLimitReached);
    expect(c.used()).toBe(2);
  });
});

import { canDeploy, commonPrefix, gateFailure, remaining, type VoteRow } from '../src/run.js';
describe('the run', () => {
  const v = (verifier: string, id: string, vote: VoteRow['vote'] = 'accept', error?: string): VoteRow => ({ verifier, id, vote, seconds: 1, ...(error ? { error } : {}) });
  it('starts a deployment only when its whole timeout fits under the cap', () => {
    expect(canDeploy(7.3)).toBe(true); // + 0.576
    expect(canDeploy(7.31)).toBe(false);
    expect(canDeploy(0)).toBe(true);
  });
  it('stops at the gate when more than 10% of a verifier\'s first 30 are missing, and says why', () => {
    const ok = Array.from({ length: 30 }, (_, i) => v('q', `p${i}`, i < 3 ? null : 'accept', i < 3 ? 'ran out of tokens' : undefined));
    expect(gateFailure(ok, 'q')).toBeNull();
    const bad = Array.from({ length: 30 }, (_, i) => v('q', `p${i}`, i < 4 ? null : 'accept', i < 4 ? 'ran out of tokens' : undefined));
    expect(gateFailure(bad, 'q')).toBe('q: 4 of its first 30 votes missing (ran out of tokens 4)');
    expect(gateFailure(bad.slice(0, 29), 'q')).toBeNull();
  });
  it('is scored on the PRs every verifier answered, from the start of the order', () => {
    const rows = [v('a', '1'), v('b', '1'), v('a', '2'), v('b', '2', null, 'no valid decision'), v('a', '3'), v('b', '4')];
    expect(commonPrefix(['1', '2', '3', '4'], rows, ['a', 'b'])).toBe(2);
    expect(remaining(['1', '2', '3', '4'], rows, 'b')).toEqual(['3']);
  });
});
