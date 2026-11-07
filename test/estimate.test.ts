import { describe, expect, it } from 'vitest';
import { costPerTask, decideCase, openWeightHours, patchCost, patchSeconds, tasksAfforded, usageOf } from '../src/estimate.js';
import { costUsd, FRONTIER_CHEAPER, FRONTIER_TOP, type Model } from '../src/models.js';

const OPUS = FRONTIER_TOP[0]!;
const SOL = FRONTIER_TOP[1]!;
const OW = (id: string, vendor: string): Model => ({ id, vendor, tier: 'open-weight', budget: 'nosana', shape: 'openai' });
const VERIFIERS = [...FRONTIER_TOP, OW('a', 'alibaba'), OW('b', 'zhipu')];
const FULL = [...FRONTIER_TOP, ...FRONTIER_CHEAPER, OW('a', 'alibaba'), OW('b', 'zhipu'), OW('c', 'mistral')];
const REDUCED = [...FRONTIER_TOP, ...FRONTIER_CHEAPER].filter((m) => m.vendor !== 'google');

describe('what a patch costs', () => {
  it('prices plain tokens as the list says', () => {
    expect(costUsd(OPUS, { input: 1_000_000, output: 1_000_000, cachedInput: 0, cacheWrite: 0 })).toBe(24);
  });
  it('charges Anthropic the new part as a cache write and the rest as a read', () => {
    const u = usageOf({ contexts: [1000, 3000], output: 100 }, 'anthropic');
    expect(u).toEqual({ input: 4000, output: 100, cachedInput: 1000, cacheWrite: 3000 });
    expect(costUsd(OPUS, u)).toBeCloseTo((1000 * 0.2 + 3000 * 5 + 100 * 20) / 1e6);
  });
  it('charges OpenAI and Google the new part as plain input', () => {
    const u = usageOf({ contexts: [1000, 3000], output: 100 }, 'openai');
    expect(u).toEqual({ input: 4000, output: 100, cachedInput: 1000, cacheWrite: 0 });
    expect(costUsd(SOL, u)).toBeCloseTo((3000 * 2 + 1000 * 0.1 + 100 * 10) / 1e6);
  });
  it('caching makes a long tool loop much cheaper than the same tokens uncached', () => {
    const contexts = Array.from({ length: 10 }, (_, i) => 5_000 * (i + 1));
    const cached = patchCost(OPUS, { contexts, output: 2_000 });
    const plain = costUsd(OPUS, { input: contexts.reduce((a, b) => a + b, 0), output: 2_000, cachedInput: 0, cacheWrite: 0 });
    expect(cached).toBeLessThan(plain / 2);
  });
});

describe('what a task costs, per group', () => {
  const p = { contexts: [1000], output: 100 };
  const v = { input: 5_000, output: 500 };
  it('the full run: nine patches, 37 votes, 21 of them frontier', () => {
    const c = costPerTask(FULL, VERIFIERS, p, v);
    expect(c.frontierVotes).toBe(21);
    expect(c.openWeightVotes).toBe(16);
    expect(c.openWeightAuthors).toBe(3);
    expect(c.frontierTop).toBeGreaterThan(0);
    expect(c.frontier).toBeCloseTo(c.frontierTop + c.frontierCheaper + c.frontierVerifiers);
  });
  it('the reduced run: four patches, 16 votes, 8 of them frontier, no open-weight author', () => {
    const c = costPerTask(REDUCED, VERIFIERS, p, v);
    expect(c.frontierVotes).toBe(8);
    expect(c.openWeightVotes).toBe(8);
    expect(c.openWeightAuthors).toBe(0);
  });
  it('the verifiers\' $0.42 a task at 100 tasks, as 40.4 quotes it', () => {
    expect(costPerTask(FULL, VERIFIERS, p, v).frontierVerifiers * 100).toBeCloseTo(42, 6);
  });
});

describe('GPU time', () => {
  const g = { promptTokensPerSec: 1000, outputTokensPerSec: 50, usdPerHour: 0.4, startupMinutesPerDeployment: 10 };
  it('reads only the new tokens of each call', () => {
    expect(patchSeconds({ contexts: [1000, 3000], output: 500 }, g)).toBe(3 + 10);
  });
  it('adds the authors, the votes and each deployment\'s start', () => {
    const h = openWeightHours(100, { openWeightAuthors: 3, openWeightVotes: 16 }, { contexts: [3000], output: 500 }, { input: 1000, output: 50 }, g, 3);
    expect(h).toBeCloseTo((100 * 3 * 13 + 100 * 16 * 2) / 3600 + 0.5);
  });
});

describe('tasks a budget affords', () => {
  it('keeps back one task\'s worst case', () => {
    expect(tasksAfforded(10, 1, 3)).toBe(8);
    expect(tasksAfforded(3, 1, 3)).toBe(1);
    expect(tasksAfforded(2, 1, 3)).toBe(0);
    expect(tasksAfforded(0, 0, 0)).toBe(Infinity);
  });
});

describe('the decision rule, V-26 with its correction, V-27', () => {
  const costs = (frontierBudgetUsd: number) => ({ fullFrontierUsd: 40, reducedFrontierUsd: 25, frontierBudgetUsd });
  it("at today's $0 frontier budget, neither run can go, however many tasks there are", () => {
    expect(decideCase(100, costs(0)).name).toBe('no-budget');
    expect(decideCase(40, costs(0)).why).toContain('covers neither');
  });
  it('full: at least 60 tasks and a budget that covers it', () => {
    expect(decideCase(60, costs(40)).name).toBe('full');
    expect(decideCase(59, costs(40)).name).toBe('reduced');
  });
  it('reduced: when the budget covers only that, with at least 40 tasks', () => {
    expect(decideCase(60, costs(39.99)).name).toBe('reduced');
    expect(decideCase(40, costs(25)).name).toBe('reduced');
  });
  it('no run: under 40 tasks, whatever the budget', () => {
    expect(decideCase(39, costs(1000)).name).toBe('no-run');
    expect(decideCase(0, costs(0)).name).toBe('no-run');
  });
});
