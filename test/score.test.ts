import { describe, expect, it } from 'vitest';
import { armRates, bootstrapLower, isSkim, seeded, tierScore, triageBy, triageScore, wilson, type Row } from '../src/score.js';
import { changedFiles, globMatch, riskPaths, triage } from '../src/triage.js';

const row = (o: Partial<Row>): Row => ({ task: 't1', repo: 'o/r', author: 'a', vendor: 'anthropic', tier: 'top', applied: true, correct: true, armB: 'accept', armC: 'accept', frontier: 'accept', openWeight: 'accept', riskPaths: 0, decisionConflicts: 0, ...o });

describe('Wilson, against the figures the pre-registration quotes', () => {
  it('clears 0.95 at 73 of 73 and not at 72 of 72; 110 with one wrong, not 109', () => {
    expect(wilson(73, 73).lower!).toBeGreaterThanOrEqual(0.95);
    expect(wilson(72, 72).lower!).toBeLessThan(0.95);
    expect(wilson(109, 110).lower!).toBeGreaterThanOrEqual(0.95);
    expect(wilson(108, 109).lower!).toBeLessThan(0.95);
  });
  it('clears 0.80 at 16 of 16, 24 of 25, 31 of 33, 37 of 40 and 49 of 54', () => {
    for (const [k, n] of [[16, 16], [24, 25], [31, 33], [37, 40], [49, 54]] as const) expect(wilson(k, n).lower!).toBeGreaterThanOrEqual(0.8);
    expect(wilson(15, 15).lower!).toBeLessThan(0.8);
  });
  it('says nothing about no data', () => {
    expect(wilson(0, 0)).toMatchObject({ share: null, lower: null });
  });
});

describe('skim: the three rules of 40.2.6', () => {
  it('needs an acceptance, no risk path and no conflict', () => {
    expect(triage({ outcome: 'accept', riskPaths: [], decisionConflicts: 0 })).toBe('skim');
    expect(triage({ outcome: 'reject', riskPaths: [], decisionConflicts: 0 })).toBe('careful');
    expect(triage({ outcome: 'accept', riskPaths: ['src/auth.ts'], decisionConflicts: 0 })).toBe('careful');
    expect(triage({ outcome: 'accept', riskPaths: [], decisionConflicts: 1 })).toBe('careful');
  });
  it('a split or a patch below the floor is careful review, not skim', () => {
    expect(triage({ outcome: 'split', riskPaths: [], decisionConflicts: 0 })).toBe('careful');
    expect(triage({ outcome: 'below-floor', riskPaths: [], decisionConflicts: 0 })).toBe('careful');
    expect(isSkim(row({ armC: 'split' }), 'armC')).toBe(false);
    expect(isSkim(row({ armC: 'below-floor' }), 'armC')).toBe(false);
  });
  it("arm A's baseline uses the other two rules alone", () => {
    expect(isSkim(row({ armC: null, armB: null }), 'armA')).toBe(true);
    expect(isSkim(row({ riskPaths: 1 }), 'armA')).toBe(false);
    expect(triage({ outcome: null, riskPaths: [], decisionConflicts: 0 })).toBe('skim');
  });
  it('a patch that does not apply is never skim', () => {
    expect(isSkim(row({ applied: false }), 'armC')).toBe(false);
  });
});

describe('changed files and risk patterns', () => {
  const patch = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y', 'diff --git a/old.ts b/old.ts', '--- a/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n');
  it('reads the new path, and the old one for a deletion', () => {
    expect(changedFiles(patch)).toEqual(['src/a.ts', 'old.ts']);
    expect(changedFiles('--- a/x.py\n+++ b/x.py\n')).toEqual(['x.py']);
    expect(changedFiles('--- /dev/null\n+++ b/new.py\n')).toEqual(['new.py']);
  });
  it('matches globs: ** crosses directories, * does not', () => {
    expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatch('**/auth/**', 'src/auth/x.ts')).toBe(true);
    expect(globMatch('**/auth/**', 'auth/x.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatch('src/*.ts', 'src/b.ts')).toBe(true);
    expect(globMatch('.github/**', '.github/workflows/ci.yml')).toBe(true);
    expect(globMatch('package.json', 'x/package.json')).toBe(false);
    expect(globMatch('a.b', 'axb')).toBe(false);
  });
  it('lists the paths that match', () => {
    expect(riskPaths(['**/auth/**', '.github/**'], ['src/auth/x.ts', 'src/y.ts'])).toEqual(['src/auth/x.ts']);
  });
});

describe('triage on known figures', () => {
  const task = (i: number, rows: Partial<Row>[]) => rows.map((r, n) => row({ task: `t${i}`, author: `a${n}`, ...r }));
  it('counts precision over skim patches and coverage over applying patches', () => {
    const rows = [row({ task: 'a' }), row({ task: 'b', correct: false }), row({ task: 'c', armC: 'reject' }), row({ task: 'd', riskPaths: 2 }), row({ task: 'e', applied: false, correct: false })];
    const s = triageScore(rows, 'armC');
    expect(s).toMatchObject({ patches: 4, notApplied: 1, skim: 2 });
    expect(s.precision).toMatchObject({ k: 1, n: 2 });
    expect(s.coverage).toBe(0.5);
    expect(s.baseRate).toMatchObject({ k: 3, n: 4 });
    expect(s.holds).toBe(false);
  });
  it('holds only when precision on both lower bounds and coverage all clear', () => {
    const many = Array.from({ length: 200 }, (_, i) => row({ task: `t${i}` }));
    expect(triageScore(many, 'armC').holds).toBe(true);
    const lowCoverage = [...many, ...Array.from({ length: 400 }, (_, i) => row({ task: `x${i}`, armC: 'reject' }))];
    const s = triageScore(lowCoverage, 'armC');
    expect(s.precisionHolds).toBe(true);
    expect(s.coverageHolds).toBe(false);
    expect(s.holds).toBe(false);
  });
  it('the bootstrap over tasks can fail where Wilson clears: mistakes that cluster in tasks', () => {
    // Nine patches per task, 100 tasks: 12 wrong patches, all in 2 tasks.
    const rows: Row[] = [];
    for (let i = 0; i < 100; i++) rows.push(...task(i, Array.from({ length: 9 }, (_, n) => ({ correct: !(i < 2 && n < 6) }))));
    const s = triageScore(rows, 'armC');
    expect(s.precision.lower!).toBeGreaterThanOrEqual(0.95);
    expect(s.precisionBootstrapLower!).toBeLessThan(s.precision.lower!);
    // The same figures, with the wrong patches spread one per task, stay tighter than when they cluster.
    const spread: Row[] = [];
    for (let i = 0; i < 100; i++) spread.push(...task(i, Array.from({ length: 9 }, (_, n) => ({ correct: !(i < 12 && n === 0) }))));
    expect(triageScore(spread, 'armC').precisionBootstrapLower!).toBeGreaterThan(s.precisionBootstrapLower!);
  });
  it('the observed figures are there whatever the result, and a failing row shows beside a pooled pass', () => {
    const rows = [...Array.from({ length: 200 }, (_, i) => row({ task: `g${i}`, vendor: 'openai' })), ...Array.from({ length: 6 }, (_, i) => row({ task: `b${i}`, vendor: 'google', correct: false }))];
    const pooled = triageScore(rows, 'armC');
    expect(pooled.precision.share).toBeCloseTo(200 / 206);
    const by = triageBy(rows, 'armC', 'vendor');
    expect(by.google!.precision.share).toBe(0);
    expect(by.google!.holds).toBe(false);
    expect(by.openai!.holds).toBe(true);
  });
  it('is the same from the same data: the bootstrap is seeded', () => {
    const perTask = Array.from({ length: 50 }, (_, i) => ({ k: i % 7 === 0 ? 8 : 9, n: 9 }));
    expect(bootstrapLower(perTask)).toBe(bootstrapLower(perTask));
    expect(bootstrapLower([])).toBeNull();
    const r = seeded(1);
    expect(r()).not.toBe(r());
    expect(seeded(1)()).toBe(seeded(1)());
    expect(seeded(1)()).not.toBe(seeded(2)());
  });
});

describe('tier, per vendor (40.2.5)', () => {
  const pair = (t: string, top: boolean, cheaper: boolean, vendor = 'anthropic') => [row({ task: t, vendor, tier: 'top', author: 'top', correct: top }), row({ task: t, vendor, tier: 'cheaper', author: 'cheap', correct: cheaper })];
  it('conditions on the top tier being right, and keeps the whole two-by-two', () => {
    const rows = [...pair('a', true, true), ...pair('b', true, false), ...pair('c', false, true), ...pair('d', false, false)];
    const s = tierScore(rows, 'anthropic');
    expect(s).toMatchObject({ tasks: 4, bothRight: 1, topOnly: 1, cheaperOnly: 1, bothWrong: 1 });
    expect(s.conditional).toMatchObject({ k: 1, n: 2 });
    expect(s.topShare).toMatchObject({ k: 2, n: 4 });
    expect(s.cheaperShare).toMatchObject({ k: 2, n: 4 });
  });
  it('counts a patch that did not apply as incorrect, so it is not dropped', () => {
    const rows = [row({ task: 'a', tier: 'top', correct: true }), row({ task: 'a', tier: 'cheaper', applied: false, correct: false })];
    expect(tierScore(rows, 'anthropic')).toMatchObject({ topOnly: 1, tasks: 1 });
  });
  it('holds at 16 of 16 and not at 15 of 15; a task missing one tier is left out', () => {
    const at = (n: number) => Array.from({ length: n }, (_, i) => pair(`t${i}`, true, true)).flat();
    expect(tierScore(at(16), 'anthropic').holds).toBe(true);
    expect(tierScore(at(15), 'anthropic').holds).toBe(false);
    expect(tierScore([...at(16), row({ task: 'x', tier: 'top' })], 'anthropic').tasks).toBe(16);
  });
  it('reads one vendor at a time', () => {
    const rows = [...pair('a', true, true, 'openai'), ...pair('b', true, false, 'google')];
    expect(tierScore(rows, 'openai').bothRight).toBe(1);
    expect(tierScore(rows, 'google').topOnly).toBe(1);
  });
});

describe('recall and wrong rejections', () => {
  it('counts over the patches the analysis scored; a split does not reject', () => {
    const rows = [row({ correct: false, armC: 'reject' }), row({ correct: false, armC: 'accept' }), row({ correct: false, armC: 'split' }), row({ correct: true, armC: 'reject' }), row({ correct: true, armC: 'accept' }), row({ correct: true, armC: 'below-floor' }), row({ applied: false, correct: false, armC: null })];
    const r = armRates(rows, 'armC');
    expect(r.caught).toMatchObject({ k: 1, n: 3 });
    expect(r.wronglyRejected).toMatchObject({ k: 1, n: 2 });
    expect(r.scored).toBe(5);
    expect(r.unscored).toBe(1);
  });
});
