/**
 * The primary result (PREREGISTRATION.md): recall at k of a risk ranking, against random and against size alone, with a bootstrap over
 * repositories; and the base rate. Secondary: skim's precision-coverage curve, and its operating points with thresholds cross-fitted by
 * repository. Pure functions, with seeded randomness.
 */
import { createHash } from 'node:crypto';
import { seeded, wilson, type Interval } from './score.js';

export type RankRow = { id: string; repo: string; problem: boolean; lines: number; scores: Record<string, number | null> };

/** A seeded hash in [0, 1), for ties and for the random ranking. */
export const tieBreak = (id: string, seed = 'ranking') => createHash('sha256').update(`${seed}|${id}`).digest().readUInt32BE(0) / 2 ** 32;

/** Highest risk first. A row with no score goes last. */
export function ranked(rows: readonly RankRow[], score: (r: RankRow) => number | null): RankRow[] {
  return [...rows].sort((a, b) => (score(b) ?? -Infinity) - (score(a) ?? -Infinity) || tieBreak(a.id) - tieBreak(b.id));
}
export const RANDOM = (r: RankRow) => tieBreak(r.id, 'random');
export const SIZE = (r: RankRow) => r.lines;
export const scoreOf = (arm: string) => (r: RankRow) => r.scores[arm] ?? null;

/** The share of problems in the top k of a ranking. Null when there are none to find. */
export function recallAt(rows: readonly RankRow[], score: (r: RankRow) => number | null, k: number): number | null {
  const problems = rows.filter((r) => r.problem).length;
  if (!problems) return null;
  const top = ranked(rows, score).slice(0, Math.max(1, Math.floor(rows.length * k)));
  return top.filter((r) => r.problem).length / problems;
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
};

/** Resampling repositories, not PRs: PRs of a repository aren't independent. */
function byRepo(rows: readonly RankRow[]): RankRow[][] {
  const m = new Map<string, RankRow[]>();
  for (const r of rows) m.set(r.repo, [...(m.get(r.repo) ?? []), r]);
  return [...m.values()];
}
function resample(groups: RankRow[][], rand: () => number): RankRow[] {
  const out: RankRow[] = [];
  groups.forEach((_, g) => {
    const pick = groups[Math.floor(rand() * groups.length)]!;
    pick.forEach((r) => out.push({ ...r, id: `${r.id}#${g}` }));
  });
  return out;
}

export type RecallResult = { k: number; recall: number | null; low: number | null; high: number | null; againstSize: { point: number; low: number; high: number } | null; againstRandom: { point: number; low: number; high: number } | null };

export function recallResult(rows: readonly RankRow[], arm: string, k: number, resamples = 1_000, seed = 41): RecallResult {
  const score = scoreOf(arm);
  const recall = recallAt(rows, score, k);
  const groups = byRepo(rows);
  const rand = seeded(seed);
  const own: number[] = [];
  const size: number[] = [];
  const random: number[] = [];
  for (let i = 0; i < resamples && recall !== null; i++) {
    const s = resample(groups, rand);
    const a = recallAt(s, score, k);
    const b = recallAt(s, SIZE, k);
    const c = recallAt(s, RANDOM, k);
    if (a === null || b === null || c === null) continue;
    own.push(a);
    size.push(a - b);
    random.push(a - c);
  }
  const iv = (xs: number[], point: number) => (xs.length ? { point, low: percentile(xs, 0.025), high: percentile(xs, 0.975) } : null);
  return {
    k,
    recall,
    low: own.length ? percentile(own, 0.025) : null,
    high: own.length ? percentile(own, 0.975) : null,
    againstSize: recall === null ? null : iv(size, recall - recallAt(rows, SIZE, k)!),
    againstRandom: recall === null ? null : iv(random, recall - recallAt(rows, RANDOM, k)!),
  };
}

/** The claim holds for an arm only if, at k = 20%, its difference from size has a lower bound above zero. */
export const rankingClaimHolds = (r: RecallResult) => r.k === 0.2 && !!r.againstSize && r.againstSize.low > 0;

export type CurveRow = { id: string; repo: string; correct: boolean; riskPath: boolean; pCorrect: number | null };
export type CurvePoint = { threshold: number; skim: number; coverage: number; precision: Interval };
const skimAt = (rows: readonly CurveRow[], t: number) => rows.filter((r) => !r.riskPath && r.pCorrect !== null && r.pCorrect >= t);

/** Skim's precision against its coverage, at every threshold the scores take. Descriptive: a threshold read off this curve isn't a claim. */
export function precisionCoverageCurve(rows: readonly CurveRow[]): CurvePoint[] {
  const ts = [...new Set(rows.map((r) => r.pCorrect).filter((x): x is number => x !== null))].sort((a, b) => b - a);
  return ts.map((threshold) => {
    const s = skimAt(rows, threshold);
    return { threshold, skim: s.length, coverage: rows.length ? s.length / rows.length : 0, precision: wilson(s.filter((r) => r.correct).length, s.length) };
  });
}

/** The highest threshold reaching a coverage on these rows, or null. */
export function thresholdFor(rows: readonly CurveRow[], coverage: number): number | null {
  const ts = [...new Set(rows.map((r) => r.pCorrect).filter((x): x is number => x !== null))].sort((a, b) => b - a);
  for (const t of ts) if (skimAt(rows, t).length / rows.length >= coverage) return t;
  return null;
}

/** Five folds by repository: each fold's threshold is set on the other four, and applied to it. */
export function crossFittedPoint(rows: readonly CurveRow[], coverage: number, folds = 5): { coverageTarget: number; skim: number; coverage: number; precision: Interval; holds: boolean } {
  const foldOf = (repo: string) => Math.floor(tieBreak(repo, 'fold') * folds);
  const chosen: CurveRow[] = [];
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((r) => foldOf(r.repo) !== f);
    const test = rows.filter((r) => foldOf(r.repo) === f);
    const t = train.length ? thresholdFor(train, coverage) : null;
    if (t !== null) chosen.push(...skimAt(test, t));
  }
  const precision = wilson(chosen.filter((r) => r.correct).length, chosen.length);
  const reached = rows.length ? chosen.length / rows.length : 0;
  return { coverageTarget: coverage, skim: chosen.length, coverage: reached, precision, holds: reached >= coverage && (precision.lower ?? 0) >= 0.95 };
}

/** The share of independently judged PRs that were clean, per agent, with a Wilson interval. */
export function baseRate<T extends { agent: string; independent: boolean }>(rows: readonly T[], clean: (r: T) => boolean): Record<string, Interval> {
  const out: Record<string, Interval> = {};
  const judged = rows.filter((r) => r.independent);
  for (const a of new Set(judged.map((r) => r.agent))) {
    const mine = judged.filter((r) => r.agent === a);
    out[a] = wilson(mine.filter(clean).length, mine.length);
  }
  return out;
}
