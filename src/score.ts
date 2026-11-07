/**
 * The scoring (the design, 40.2.5, 40.2.6, 40.3): pure functions over one row per patch. Every result carries its counts,
 * so a threshold missed is shown as plainly as one met. Nothing here chooses which arm or analysis "counts".
 */
import type { Outcome } from './quorum.js';
import type { Tier } from './models.js';

const Z = 1.959964;

export type Interval = { k: number; n: number; share: number | null; lower: number | null; upper: number | null };

export function wilson(k: number, n: number): Interval {
  if (n === 0) return { k, n, share: null, lower: null, upper: null };
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const c = p + (Z * Z) / (2 * n);
  const m = Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
  return { k, n, share: p, lower: Math.max(0, (c - m) / d), upper: Math.min(1, (c + m) / d) };
}

/** One patch, as the sandbox and the verifiers left it. */
export type Row = {
  task: string;
  repo: string;
  author: string;
  vendor: string;
  tier: Tier;
  /** False when it was no diff, or didn't apply: incorrect for its author, and it never reaches a verifier or a reviewer. */
  applied: boolean;
  correct: boolean;
  armB: Outcome | null;
  armC: Outcome | null;
  frontier: Outcome | null;
  openWeight: Outcome | null;
  riskPaths: number;
  decisionConflicts: number;
};

export type Arm = 'armA' | 'armB' | 'armC' | 'frontier' | 'openWeight';

const outcomeOf = (r: Row, arm: Arm): Outcome | null => (arm === 'armA' ? null : r[arm]);

export function isSkim(r: Row, arm: Arm): boolean {
  const accepted = arm === 'armA' || outcomeOf(r, arm) === 'accept';
  return r.applied && accepted && r.riskPaths === 0 && r.decisionConflicts === 0;
}

/** A small seeded generator (mulberry32), so a bootstrap gives the same interval from the same data and seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The share's 2.5th percentile, resampling whole tasks, because patches of one task aren't independent (40.2.6). */
export function bootstrapLower(perTask: readonly { k: number; n: number }[], resamples = 2_000, seed = 40): number | null {
  if (!perTask.length) return null;
  const rand = seeded(seed);
  const shares: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let k = 0;
    let n = 0;
    for (let j = 0; j < perTask.length; j++) {
      const t = perTask[Math.floor(rand() * perTask.length)]!;
      k += t.k;
      n += t.n;
    }
    if (n) shares.push(k / n);
  }
  shares.sort((a, b) => a - b);
  return shares.length ? shares[Math.floor(shares.length * 0.025)]! : null;
}

export const PRECISION_BAR = 0.95;
export const COVERAGE_BAR = 0.4;
export const TIER_BAR = 0.8;

export type TriageScore = {
  arm: Arm;
  /** Patches that apply: a patch that doesn't never reaches a reviewer. */
  patches: number;
  notApplied: number;
  skim: number;
  /** The share of all applying patches that are correct: precision rises with this alone. */
  baseRate: Interval;
  precision: Interval;
  /** Beside Wilson, resampling whole tasks. */
  precisionBootstrapLower: number | null;
  coverage: number | null;
  precisionHolds: boolean;
  coverageHolds: boolean;
  holds: boolean;
};

export function triageScore(rows: readonly Row[], arm: Arm): TriageScore {
  const applied = rows.filter((r) => r.applied);
  const skim = applied.filter((r) => isSkim(r, arm));
  const correctSkim = skim.filter((r) => r.correct).length;
  const precision = wilson(correctSkim, skim.length);
  const byTask = new Map<string, { k: number; n: number }>();
  for (const r of skim) {
    const t = byTask.get(r.task) ?? { k: 0, n: 0 };
    t.n++;
    if (r.correct) t.k++;
    byTask.set(r.task, t);
  }
  const boot = bootstrapLower([...byTask.values()]);
  const coverage = applied.length ? skim.length / applied.length : null;
  const precisionHolds = precision.lower !== null && precision.lower >= PRECISION_BAR && boot !== null && boot >= PRECISION_BAR;
  const coverageHolds = coverage !== null && coverage >= COVERAGE_BAR;
  return {
    arm,
    patches: applied.length,
    notApplied: rows.length - applied.length,
    skim: skim.length,
    baseRate: wilson(applied.filter((r) => r.correct).length, applied.length),
    precision,
    precisionBootstrapLower: boot,
    coverage,
    precisionHolds,
    coverageHolds,
    holds: precisionHolds && coverageHolds,
  };
}

/** The same score cut by a field, so a team reads the row for its own vendor. A failing row is never hidden by a pooled pass. */
export function triageBy(rows: readonly Row[], arm: Arm, field: 'vendor' | 'tier' | 'repo' | 'author'): Record<string, TriageScore> {
  const out: Record<string, TriageScore> = {};
  for (const v of new Set(rows.map((r) => r[field]))) out[String(v)] = triageScore(rows.filter((r) => r[field] === v), arm);
  return out;
}

export type TierScore = {
  vendor: string;
  /** Tasks with both tiers' patches. */
  tasks: number;
  /** The two-by-two: top right or wrong against cheaper right or wrong. */
  bothRight: number;
  topOnly: number;
  cheaperOnly: number;
  bothWrong: number;
  /** Of the tasks where the top tier is right, the share where the cheaper tier is too. */
  conditional: Interval;
  topShare: Interval;
  cheaperShare: Interval;
  holds: boolean;
};

/** Tier, per vendor (40.2.5). A patch that doesn't apply counts as incorrect here, so a cheaper tier isn't flattered. */
export function tierScore(rows: readonly Row[], vendor: string): TierScore {
  const mine = rows.filter((r) => r.vendor === vendor);
  const tasks = new Set(mine.map((r) => r.task));
  let bothRight = 0;
  let topOnly = 0;
  let cheaperOnly = 0;
  let bothWrong = 0;
  for (const t of tasks) {
    const top = mine.find((r) => r.task === t && r.tier === 'top');
    const cheaper = mine.find((r) => r.task === t && r.tier === 'cheaper');
    if (!top || !cheaper) continue;
    if (top.correct && cheaper.correct) bothRight++;
    else if (top.correct) topOnly++;
    else if (cheaper.correct) cheaperOnly++;
    else bothWrong++;
  }
  const n = bothRight + topOnly + cheaperOnly + bothWrong;
  const conditional = wilson(bothRight, bothRight + topOnly);
  return {
    vendor,
    tasks: n,
    bothRight,
    topOnly,
    cheaperOnly,
    bothWrong,
    conditional,
    topShare: wilson(bothRight + topOnly, n),
    cheaperShare: wilson(bothRight + cheaperOnly, n),
    holds: conditional.lower !== null && conditional.lower >= TIER_BAR,
  };
}

export type ArmRates = { arm: Arm; caught: Interval; wronglyRejected: Interval; scored: number; unscored: number };

/** Recall on failing patches and wrong rejections (40.2.3), over the patches the analysis scored. A split doesn't reject. */
export function armRates(rows: readonly Row[], arm: Exclude<Arm, 'armA'>): ArmRates {
  const applied = rows.filter((r) => r.applied);
  const scored = applied.filter((r) => {
    const o = outcomeOf(r, arm);
    return o !== null && o !== 'below-floor';
  });
  const wrong = scored.filter((r) => !r.correct);
  const right = scored.filter((r) => r.correct);
  return {
    arm,
    caught: wilson(wrong.filter((r) => outcomeOf(r, arm) === 'reject').length, wrong.length),
    wronglyRejected: wilson(right.filter((r) => outcomeOf(r, arm) === 'reject').length, right.length),
    scored: scored.length,
    unscored: applied.length - scored.length,
  };
}
