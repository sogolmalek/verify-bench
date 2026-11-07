/**
 * What a run would cost, priced per group of authors (the design, 40.4; V-13), and which case of the decision rule applies
 * (40.5; V-26). Pure arithmetic over a token profile counted on real tasks. It makes no call.
 */
import type { Usage } from './clients.js';
import { costUsd, type Model } from './models.js';

/** One patch's shape: the input tokens of each call, in order, and the output tokens over the patch. */
export type PatchProfile = { contexts: readonly number[]; output: number };

/**
 * The usage those calls report with prompt caching: each call reads what the last one sent. Anthropic charges the new part
 * as a cache write; OpenAI and Google cache automatically and charge it as plain input.
 */
export function usageOf(p: PatchProfile, shape: Model['shape']): Usage {
  const u: Usage = { input: 0, output: p.output, cachedInput: 0, cacheWrite: 0 };
  let prior = 0;
  for (const c of p.contexts) {
    u.input += c;
    u.cachedInput += Math.min(prior, c);
    if (shape === 'anthropic') u.cacheWrite += Math.max(0, c - prior);
    prior = c;
  }
  return u;
}

export const patchCost = (m: Model, p: PatchProfile) => costUsd(m, usageOf(p, m.shape));

export type VoteProfile = { input: number; output: number };

export const voteCost = (m: Model, v: VoteProfile) => costUsd(m, { input: v.input, output: v.output, cachedInput: 0, cacheWrite: 0 });

/** What one task costs, per group, for a set of authors and verifiers. An author's vendor doesn't vote on its patch. */
export function costPerTask(authors: readonly Model[], verifiers: readonly Model[], p: PatchProfile, v: VoteProfile) {
  const out = { frontierTop: 0, frontierCheaper: 0, frontierVerifiers: 0, frontierVotes: 0, openWeightAuthors: authors.filter((a) => a.tier === 'open-weight').length, openWeightVotes: 0 };
  for (const a of authors) {
    if (a.tier === 'top') out.frontierTop += patchCost(a, p);
    if (a.tier === 'cheaper') out.frontierCheaper += patchCost(a, p);
    for (const m of verifiers) {
      if (m.vendor === a.vendor) continue;
      if (m.budget === 'frontier') {
        out.frontierVerifiers += voteCost(m, v);
        out.frontierVotes++;
      } else out.openWeightVotes++;
    }
  }
  return { ...out, frontier: out.frontierTop + out.frontierCheaper + out.frontierVerifiers };
}

/** GPU time, as an assumption until a deployment measures it: Nosana's templates publish no throughput figures. */
export type GpuAssumption = { promptTokensPerSec: number; outputTokensPerSec: number; usdPerHour: number; startupMinutesPerDeployment: number };

/** Seconds a model spends on one patch: only the new tokens of each call are read again, as the server keeps its cache. */
export function patchSeconds(p: PatchProfile, g: GpuAssumption): number {
  let prior = 0;
  let newTokens = 0;
  for (const c of p.contexts) {
    newTokens += Math.max(0, c - prior);
    prior = c;
  }
  return newTokens / g.promptTokensPerSec + p.output / g.outputTokensPerSec;
}

export function openWeightHours(tasks: number, perTask: { openWeightAuthors: number; openWeightVotes: number }, p: PatchProfile, v: VoteProfile, g: GpuAssumption, deployments: number): number {
  const authorSec = tasks * perTask.openWeightAuthors * patchSeconds(p, g);
  const voteSec = tasks * perTask.openWeightVotes * (v.input / g.promptTokensPerSec + v.output / g.outputTokensPerSec);
  return (authorSec + voteSec) / 3600 + (deployments * g.startupMinutesPerDeployment) / 60;
}

/** How many whole tasks a budget affords, keeping back one task's worst case, because a reservation holds it (40.5). */
export const tasksAfforded = (budget: number, costOfTask: number, worstCaseOfTask: number) => (costOfTask <= 0 ? Infinity : Math.max(0, Math.floor((budget - worstCaseOfTask) / costOfTask) + 1));

export type RunCaseName = 'full' | 'reduced' | 'no-run' | 'no-budget';

/** The tasks in the rule (V-26). The dollars in it were corrected (V-27): the frontier budget is the owner's, and $0 for now. */
export const RULE = { fullMinTasks: 60, runMinTasks: 40 } as const;

/** Which case applies, with the frontier budget the owner has stated. */
export function decideCase(scorableTasks: number, o: { fullFrontierUsd: number; reducedFrontierUsd: number; frontierBudgetUsd: number }): { name: RunCaseName; why: string } {
  if (scorableTasks < RULE.runMinTasks) return { name: 'no-run', why: `${scorableTasks} scorable tasks is under ${RULE.runMinTasks}` };
  if (scorableTasks >= RULE.fullMinTasks && o.fullFrontierUsd <= o.frontierBudgetUsd) return { name: 'full', why: `${scorableTasks} scorable tasks, and the budget covers its $${o.fullFrontierUsd.toFixed(2)}` };
  if (o.reducedFrontierUsd <= o.frontierBudgetUsd) return { name: 'reduced', why: `the budget covers the reduced run's $${o.reducedFrontierUsd.toFixed(2)}` };
  return { name: 'no-budget', why: `the frontier budget, $${o.frontierBudgetUsd.toFixed(2)}, covers neither run` };
}
