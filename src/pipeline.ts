/**
 * The run, one whole task at a time (the design, 40.5): every author, the truth of each patch, every eligible verifier,
 * triage's inputs, and one row per patch for the scoring. The steps take their dependencies as arguments, so the same code
 * runs against fake providers at $0. In the bench's workflow the truth step runs in a job of its own, with no keys.
 */
import { DEFAULT_CAPS, worstCaseInputTokens, writePatch, type AuthorCaps, type AuthorResult, type AuthorTask } from './author.js';
import type { ModelClient, Usage } from './clients.js';
import { GitTree } from './gitTree.js';
import { costUsd, type Model } from './models.js';
import { analyses, eligibleVerifiers, loneOpenWeightVote, type Verifier, type Vote } from './quorum.js';
import type { Row } from './score.js';
import { changedFiles, riskPaths } from './triage.js';
import { askVerifier, VERIFIER_MAX_TOKENS, type VerifierResult } from './verifier.js';
import { Budgets, BudgetRefused } from './budget.js';

export type BenchTask = AuthorTask & { key: string; number: number; repoDir: string };

export type RunCase = {
  /** Who writes patches: nine in the full run, four in the reduced run (V-26). */
  authors: readonly Model[];
  /** Who votes: the same five in both cases. */
  verifiers: readonly (Model & { group: Verifier['group'] })[];
  /** The probe's ranking of the open-weight verifiers: its winner is arm B's verifier. */
  ranking: readonly Verifier[];
  riskPatterns: (repo: string) => readonly string[];
  caps?: AuthorCaps;
};

export type Deps = {
  client: (m: Model) => ModelClient;
  /** Applies the patch and runs the PR's tests, in the sandbox. Null: it didn't apply. */
  truth: (task: BenchTask, patch: string) => Promise<{ applied: boolean; correct: boolean }>;
  /** The deterministic check against the repository's decisions: how many conflicts. It makes no model call. */
  decisionConflicts: (task: BenchTask, patch: string) => Promise<number>;
  budgets: Budgets;
};

export type PatchRecord = {
  row: Row;
  author: Omit<AuthorResult, 'patch' | 'trace'> & { hasPatch: boolean };
  patch: string | null;
  votes: Vote[];
  loneOpenWeight: Vote | null;
  costs: { authorUsd: number; verifierUsd: number };
  /** Votes refused because a budget had too little left: the run stops after this task. */
  budgetRefused: boolean;
};

/** At worst, every input token is charged as a cache write, the dearest kind. */
const worstCaseAuthor = (m: Model, caps: AuthorCaps) => costUsd(m, { input: worstCaseInputTokens(caps), output: caps.maxOutputTokens, cachedInput: 0, cacheWrite: worstCaseInputTokens(caps) });
const worstCaseVerifier = (m: Model, inputTokens: number) => costUsd(m, { input: inputTokens, output: VERIFIER_MAX_TOKENS, cachedInput: 0, cacheWrite: 0 });
/** Tokens in a prompt, roughly, for a reservation: on the safe side for code. */
const roughTokens = (s: string) => Math.ceil(s.length / 2.5);

/** What the next whole task can cost at worst, per budget. The run doesn't start a task it can't finish. */
export function worstCaseOfTask(c: RunCase): { frontier: number; nosana: number } {
  const caps = c.caps ?? DEFAULT_CAPS;
  const sum = { frontier: 0, nosana: 0 };
  for (const a of c.authors) {
    sum[a.budget] += worstCaseAuthor(a, caps);
    for (const v of eligibleVerifiers(c.verifiers.map((x) => ({ id: x.id, vendor: x.vendor, group: x.group })), a.vendor)) {
      const m = c.verifiers.find((x) => x.id === v.id)!;
      sum[m.budget] += worstCaseVerifier(m, caps.maxOutputTokens + 8_000);
    }
  }
  return sum;
}

export async function runTask(task: BenchTask, c: RunCase, d: Deps): Promise<PatchRecord[]> {
  const caps = c.caps ?? DEFAULT_CAPS;
  const tree = new GitTree(task.repoDir, task.parentSha);
  const records: PatchRecord[] = [];
  const patterns = c.riskPatterns(task.repo);
  for (const a of c.authors) {
    const hold = a.budget === 'frontier' ? d.budgets.reserve('frontier', worstCaseAuthor(a, caps), `author ${a.id} ${task.key}`) : null;
    const result = await writePatch(d.client(a), tree, task, caps);
    const authorUsd = costUsd(a, result.usage);
    if (hold) d.budgets.settle(hold, authorUsd);
    const truth = result.patch ? await d.truth(task, result.patch) : { applied: false, correct: false };
    const votes: Vote[] = [];
    let verifierUsd = 0;
    let budgetRefused = false;
    if (truth.applied && result.patch) {
      for (const v of eligibleVerifiers(c.verifiers.map((x) => ({ id: x.id, vendor: x.vendor, group: x.group })), a.vendor)) {
        const m = c.verifiers.find((x) => x.id === v.id)!;
        let r: VerifierResult | null = null;
        let id: string | null = null;
        try {
          if (m.budget === 'frontier') id = d.budgets.reserve('frontier', worstCaseVerifier(m, roughTokens(result.patch) + roughTokens(task.description) + 2_000), `verifier ${m.id} ${task.key}`);
          r = await askVerifier(d.client(m), task, result.patch);
          if (id) d.budgets.settle(id, costUsd(m, r.usage));
          if (m.budget === 'frontier') verifierUsd += costUsd(m, r.usage);
        } catch (err) {
          if (!(err instanceof BudgetRefused)) throw err;
          budgetRefused = true;
        }
        votes.push({ verifier: m.id, vendor: m.vendor, group: m.group, vote: r?.vote ?? null, ...(r?.reason ? { reason: r.reason } : {}) });
      }
    }
    const a2 = truth.applied ? analyses(votes, c.ranking, a.vendor) : null;
    const files = result.patch ? changedFiles(result.patch) : [];
    const conflicts = truth.applied && result.patch ? await d.decisionConflicts(task, result.patch) : 0;
    records.push({
      row: {
        task: task.key,
        repo: task.repo,
        author: a.id,
        vendor: a.vendor,
        tier: a.tier,
        applied: truth.applied,
        correct: truth.correct,
        armB: a2?.armB.outcome ?? null,
        armC: a2?.armC.outcome ?? null,
        frontier: a2?.frontier.outcome ?? null,
        openWeight: a2?.openWeight.outcome ?? null,
        riskPaths: riskPaths(patterns, files).length,
        decisionConflicts: conflicts,
      },
      author: { hasPatch: !!result.patch, status: result.status, ...(result.error ? { error: result.error } : {}), capHit: result.capHit, toolCalls: result.toolCalls, turns: result.turns, usage: result.usage, models: result.models, callRefs: result.callRefs },
      patch: result.patch,
      votes,
      loneOpenWeight: loneOpenWeightVote(votes),
      costs: { authorUsd: a.budget === 'frontier' ? authorUsd : 0, verifierUsd },
      budgetRefused,
    });
  }
  return records;
}

export type RunResult = { records: PatchRecord[]; tasksDone: number; cutShort: boolean; reason?: string };

/** One whole task at a time; the run stops before a task its budgets can't finish (40.5). */
export async function runBench(tasks: readonly BenchTask[], c: RunCase, d: Deps): Promise<RunResult> {
  const records: PatchRecord[] = [];
  let tasksDone = 0;
  const need = worstCaseOfTask(c);
  for (const t of tasks) {
    if (!d.budgets.affords({ frontier: need.frontier })) return { records, tasksDone, cutShort: true, reason: `the frontier budget can't finish another task (worst case $${need.frontier.toFixed(2)})` };
    records.push(...(await runTask(t, c, d)));
    tasksDone++;
  }
  return { records, tasksDone, cutShort: false };
}

export type { Usage };
