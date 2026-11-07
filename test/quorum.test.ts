import { describe, expect, it } from 'vitest';
import { analyses, decide, eligibleVerifiers, FLOORS, loneOpenWeightVote, type Verifier, type Vote } from '../src/quorum.js';

const FIVE: Verifier[] = [
  { id: 'claude', vendor: 'anthropic', group: 'frontier' },
  { id: 'gpt', vendor: 'openai', group: 'frontier' },
  { id: 'gemini', vendor: 'google', group: 'frontier' },
  { id: 'ow-a', vendor: 'alibaba', group: 'open-weight' },
  { id: 'ow-b', vendor: 'deepseek', group: 'open-weight' },
];
const RANKING = [FIVE[3]!, FIVE[4]!];
const votes = (authorVendor: string, list: Record<string, 'accept' | 'reject' | null>): Vote[] =>
  eligibleVerifiers(FIVE, authorVendor).map((v) => ({ verifier: v.id, vendor: v.vendor, group: v.group, vote: v.id in list ? list[v.id]! : 'accept' }));

describe('40.2.4: the bar is a strict majority of the votes cast', () => {
  it('3 of 5, 3 of 4, 2 of 3, 2 of 2; an even split decides nothing', () => {
    const v = (r: number, a: number) => [...Array(r).fill({ vote: 'reject' }), ...Array(a).fill({ vote: 'accept' })];
    expect(decide(v(3, 2), 4).outcome).toBe('reject');
    expect(decide(v(2, 3), 4).outcome).toBe('accept');
    expect(decide(v(3, 1), 4).outcome).toBe('reject');
    expect(decide(v(2, 2), 4).outcome).toBe('split');
    expect(decide(v(2, 1), 2).outcome).toBe('reject');
    expect(decide(v(2, 0), 2).outcome).toBe('reject');
    expect(decide(v(1, 1), 2).outcome).toBe('split');
  });
  it('a missing vote is neither accept nor reject, and below the floor is not scored', () => {
    expect(decide([{ vote: 'reject' }, { vote: 'reject' }, { vote: 'accept' }, { vote: null }], FLOORS.armC)).toMatchObject({ outcome: 'below-floor', cast: 3 });
    expect(decide([{ vote: 'reject' }, { vote: null }], FLOORS.frontier).outcome).toBe('below-floor');
  });
});

describe('the table in 40.2.4, by the author of the patch', () => {
  it('a frontier author removes its own vendor, whichever tier wrote the patch', () => {
    expect(eligibleVerifiers(FIVE, 'anthropic').map((v) => v.id)).toEqual(['gpt', 'gemini', 'ow-a', 'ow-b']);
    const a = analyses(votes('anthropic', {}), RANKING, 'anthropic');
    expect(a.armC.cast).toBe(4);
    expect(a.frontier.cast).toBe(2);
    expect(a.openWeight.cast).toBe(2);
  });
  it('an open-weight author that is also a verifier: 4 votes, 3 frontier, and one open-weight vote with no quorum', () => {
    const v = votes('alibaba', {});
    const a = analyses(v, RANKING, 'alibaba');
    expect(a.armC.cast).toBe(4);
    expect(a.frontier.cast).toBe(3);
    expect(a.openWeight.outcome).toBe('below-floor');
    expect(loneOpenWeightVote(v)?.verifier).toBe('ow-b');
  });
  it('the third open-weight author: all five vote', () => {
    const a = analyses(votes('mistral', {}), RANKING, 'mistral');
    expect(a.armC.cast).toBe(5);
    expect(a.frontier.cast).toBe(3);
    expect(a.openWeight.cast).toBe(2);
    expect(loneOpenWeightVote(votes('mistral', {}))).toBeNull();
  });
  it('rejects at 3 of 4 and of 5; 2 against 2 does not reject', () => {
    expect(analyses(votes('openai', { claude: 'reject', gemini: 'reject', 'ow-a': 'reject' }), RANKING, 'openai').armC.outcome).toBe('reject');
    expect(analyses(votes('openai', { claude: 'reject', gemini: 'reject' }), RANKING, 'openai').armC.outcome).toBe('split');
    expect(analyses(votes('mistral', { claude: 'reject', gpt: 'reject', 'ow-b': 'reject' }), RANKING, 'mistral').armC.outcome).toBe('reject');
  });
  it('frontier only: both of two must reject on a frontier author; 2 of 3 otherwise', () => {
    expect(analyses(votes('anthropic', { gpt: 'reject' }), RANKING, 'anthropic').frontier.outcome).toBe('split');
    expect(analyses(votes('anthropic', { gpt: 'reject', gemini: 'reject' }), RANKING, 'anthropic').frontier.outcome).toBe('reject');
    expect(analyses(votes('alibaba', { claude: 'reject', gpt: 'reject' }), RANKING, 'alibaba').frontier.outcome).toBe('reject');
  });
  it('an author from every vendor loses at most one verifier', () => {
    for (const vendor of ['anthropic', 'openai', 'google', 'alibaba', 'deepseek', 'mistral']) expect(FIVE.length - eligibleVerifiers(FIVE, vendor).length).toBeLessThanOrEqual(1);
  });
});

describe('arm B: the probe winner, falling to the next from another vendor', () => {
  it('is the winner unless the winner wrote the patch', () => {
    expect(analyses(votes('anthropic', {}), RANKING, 'anthropic').armB.verifier).toBe('ow-a');
    expect(analyses(votes('alibaba', {}), RANKING, 'alibaba').armB.verifier).toBe('ow-b');
  });
  it('uses the same call as that verifier\'s vote in arm C, and a missing vote is not scored', () => {
    expect(analyses(votes('anthropic', { 'ow-a': 'reject' }), RANKING, 'anthropic').armB.outcome).toBe('reject');
    expect(analyses(votes('anthropic', { 'ow-a': null }), RANKING, 'anthropic').armB.outcome).toBe('below-floor');
  });
});

describe('the reduced run (V-26): only Anthropic and OpenAI authors', () => {
  it('every patch has 4 votes in arm C, 2 frontier and 2 open-weight, and no lone vote', () => {
    for (const vendor of ['anthropic', 'openai']) {
      const v = votes(vendor, {});
      const a = analyses(v, RANKING, vendor);
      expect([a.armC.cast, a.frontier.cast, a.openWeight.cast]).toEqual([4, 2, 2]);
      expect(loneOpenWeightVote(v)).toBeNull();
    }
  });
});
