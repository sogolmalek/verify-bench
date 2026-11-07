import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Budgets, BudgetRefused } from '../src/budget.js';
import { anthropicClient, openaiClient } from '../src/clients.js';
import { FRONTIER_CHEAPER, FRONTIER_TOP, type Model } from '../src/models.js';
import { runBench, runTask, worstCaseOfTask, type BenchTask, type RunCase } from '../src/pipeline.js';
import type { Verifier } from '../src/quorum.js';
import { armRates, tierScore, triageScore } from '../src/score.js';
import { fakeProvider, makeRepo } from './fakes.js';

const repo = makeRepo([
  { message: 'parent', files: { 'src/a.ts': 'export const a = 1;\n', 'src/auth/token.ts': 'export const t = 1;\n' } },
  { message: 'next', files: { 'src/a.ts': 'export const a = 2;\n' } },
]);
afterAll(() => repo.cleanup());

const OW: Model[] = [
  { id: 'ow-qwen', vendor: 'alibaba', tier: 'open-weight', budget: 'nosana', shape: 'openai', baseUrl: 'https://ow.test/v1' },
  { id: 'ow-deepseek', vendor: 'deepseek', tier: 'open-weight', budget: 'nosana', shape: 'openai', baseUrl: 'https://ow.test/v1' },
  { id: 'ow-codestral', vendor: 'mistral', tier: 'open-weight', budget: 'nosana', shape: 'openai', baseUrl: 'https://ow.test/v1' },
];
const VERIFIERS = [...FRONTIER_TOP.map((m) => ({ ...m, group: 'frontier' as const })), { ...OW[0]!, group: 'open-weight' as const }, { ...OW[1]!, group: 'open-weight' as const }];
const RANKING: Verifier[] = [{ id: 'ow-qwen', vendor: 'alibaba', group: 'open-weight' }, { id: 'ow-deepseek', vendor: 'deepseek', group: 'open-weight' }];
const FULL: RunCase = { authors: [...FRONTIER_TOP, ...FRONTIER_CHEAPER, ...OW], verifiers: VERIFIERS, ranking: RANKING, riskPatterns: () => ['src/auth/**'] };
const REDUCED: RunCase = { ...FULL, authors: [...FRONTIER_TOP, ...FRONTIER_CHEAPER].filter((m) => m.vendor !== 'google') };

const task = (i: number): BenchTask => ({ key: `o/r#${i}`, number: i, repo: 'o/r', parentSha: repo.shas[0]!, title: `Task ${i}`, description: 'Make a two.', repoDir: repo.dir });
const diff = (file = 'src/a.ts') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`;

/** Fake providers: each model reads once, then answers; a verifier rejects per `rejects`. Records who was called. */
function deps(o: { rejects?: (verifier: string, author: string) => boolean; total?: number; patchFile?: (m: string) => string; correct?: (author: string, t: string) => boolean; applied?: (author: string) => boolean; failVerifier?: string } = {}) {
  const calls: { model: string; kind: 'author' | 'verifier' }[] = [];
  const budgets = new Budgets();
  budgets.state('frontier', o.total ?? 1_000, 'test');
  budgets.state('nosana', 10, 'test');
  const client = (m: Model) => {
    const script = (b: any) => {
      const verifying = !!(b.tool_choice);
      calls.push({ model: m.id, kind: verifying ? 'verifier' : 'author' });
      if (verifying) {
        if (o.failVerifier === m.id) return { status: 500 };
        const text = JSON.stringify(b.messages);
        const author = /AUTHOR=([\w.-]+)/.exec(text)?.[1] ?? '';
        return { tools: [{ name: 'decide', args: { decision: o.rejects?.(m.id, author) ? 'reject' : 'accept', reason: 'because' } }], input: 1_000, output: 100 };
      }
      const asked = JSON.stringify(b.messages).length;
      if (asked < 400) return { tools: [{ name: 'list_files', args: {} }], input: 2_000, output: 20 };
      return { text: `${diff(o.patchFile?.(m.id))}+AUTHOR=${m.id}\n`, input: 3_000, output: 200 };
    };
    const p = fakeProvider(m.shape, script as never);
    return m.shape === 'anthropic' ? anthropicClient({ baseUrl: 'https://fake.test/v1', model: m.id, apiKey: 'k', fetch: p.fetch }) : openaiClient({ baseUrl: 'https://fake.test/v1', model: m.id, apiKey: 'k', fetch: p.fetch });
  };
  return {
    calls,
    budgets,
    d: {
      client,
      budgets,
      truth: async (t: BenchTask, patch: string) => {
        const author = /AUTHOR=([\w.-]+)/.exec(patch)?.[1] ?? '';
        const applied = o.applied?.(author) ?? true;
        return { applied, correct: applied && (o.correct?.(author, t.key) ?? true) };
      },
      decisionConflicts: async () => 0,
    },
  };
}

describe('the whole pipeline against fake providers, at $0', () => {
  it('the full run: nine patches, the vendor rule on every vote, a row for each', async () => {
    const { d, calls } = deps();
    const r = await runTask(task(1), FULL, d);
    expect(r.map((x) => x.row.author)).toEqual(FULL.authors.map((a) => a.id));
    // No model ever judged its own vendor's patch.
    for (const rec of r) expect(rec.votes.map((v) => v.vendor)).not.toContain(rec.row.vendor);
    const votesOf = (author: string) => r.find((x) => x.row.author === author)!.votes.length;
    expect(votesOf('claude-opus-5-5')).toBe(4);
    expect(votesOf('claude-sonnet-5-5')).toBe(4);
    expect(votesOf('gpt-6.1-terra')).toBe(4);
    expect(votesOf('ow-qwen')).toBe(4);
    expect(votesOf('ow-codestral')).toBe(5);
    // Six frontier patches at 4 votes, two open-weight at 4, one at 5.
    expect(calls.filter((c) => c.kind === 'verifier').length).toBe(37);
    expect(r.find((x) => x.row.author === 'ow-qwen')!.row.openWeight).toBe('below-floor');
    expect(r.find((x) => x.row.author === 'ow-qwen')!.loneOpenWeight?.verifier).toBe('ow-deepseek');
    expect(r.every((x) => x.row.armC === 'accept')).toBe(true);
  });
  it('the reduced run: four authors, five verifiers, 4 votes on every patch (V-26)', async () => {
    const { d, calls } = deps();
    const r = await runTask(task(1), REDUCED, d);
    expect(r.map((x) => x.row.author)).toEqual(['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'gpt-6.1-terra']);
    expect(r.every((x) => x.votes.length === 4)).toBe(true);
    expect(calls.filter((c) => c.kind === 'verifier').length).toBe(16);
    expect(r.every((x) => x.loneOpenWeight === null)).toBe(true);
    // Gemini still votes, so the reduced run still needs a host Gemini accepts.
    expect(calls.some((c) => c.model === 'gemini-4-argon' && c.kind === 'verifier')).toBe(true);
    expect(calls.some((c) => c.model === 'gemini-4-argon' && c.kind === 'author')).toBe(false);
  });
  it('a patch that does not apply gets no verifier call, and counts as incorrect for its author', async () => {
    const { d, calls } = deps({ applied: (a) => a !== 'claude-sonnet-5-5' });
    const r = await runTask(task(1), REDUCED, d);
    const s = r.find((x) => x.row.author === 'claude-sonnet-5-5')!;
    expect(s.row).toMatchObject({ applied: false, correct: false, armC: null });
    expect(s.votes).toEqual([]);
    expect(calls.filter((c) => c.kind === 'verifier').length).toBe(12);
  });
  it('a verifier that errors after its retry is a missing vote, and the patch still scores on the rest', async () => {
    const { d, calls } = deps({ failVerifier: 'ow-deepseek' });
    const r = await runTask(task(1), FULL, d);
    const c = r.find((x) => x.row.author === 'ow-codestral')!;
    expect(c.votes.find((v) => v.verifier === 'ow-deepseek')?.vote).toBeNull();
    expect(c.row.armC).toBe('accept');
    expect(calls.filter((x) => x.model === 'ow-deepseek').length).toBeGreaterThan(8);
    // An open-weight author that already lost one vote drops under arm C's floor when a second is missing.
    expect(r.find((x) => x.row.author === 'ow-qwen')!.row.armC).toBe('below-floor');
  });
  it('scores what the sandbox and the votes left, end to end, on known figures', async () => {
    const { d } = deps({
      correct: (author, key) => !(author === 'gpt-6.1-terra' && key === 'o/r#2'),
      rejects: (v, author) => author === 'gpt-6.1-terra' && v !== 'ow-deepseek',
      patchFile: (m) => (m === 'claude-sonnet-5-5' ? 'src/auth/token.ts' : 'src/a.ts'),
    });
    const r = await runBench([task(1), task(2)], REDUCED, d);
    expect(r).toMatchObject({ tasksDone: 2, cutShort: false });
    const rows = r.records.map((x) => x.row);
    expect(rows.length).toBe(8);
    // Terra was rejected on both tasks and wrong on one; Sonnet's patch touches a risk path.
    const rates = armRates(rows, 'armC');
    expect(rates.caught).toMatchObject({ k: 1, n: 1 });
    expect(rates.wronglyRejected).toMatchObject({ k: 1, n: 7 });
    const t = triageScore(rows, 'armC');
    expect(t).toMatchObject({ patches: 8, skim: 4 });
    expect(t.precision).toMatchObject({ k: 4, n: 4 });
    expect(t.coverage).toBe(0.5);
    expect(t.holds).toBe(false);
    expect(triageScore(rows, 'armA').skim).toBe(6);
    expect(tierScore(rows, 'openai')).toMatchObject({ tasks: 2, bothRight: 1, topOnly: 1 });
    expect(tierScore(rows, 'anthropic')).toMatchObject({ tasks: 2, bothRight: 2 });
  });
  it('records each patch\'s vendor and tier', async () => {
    const { d } = deps();
    const r = await runTask(task(1), FULL, d);
    expect(r.find((x) => x.row.author === 'gemini-3.8-flash')!.row).toMatchObject({ vendor: 'google', tier: 'cheaper' });
    expect(r.find((x) => x.row.author === 'ow-codestral')!.row).toMatchObject({ vendor: 'mistral', tier: 'open-weight' });
  });
  it('counts only frontier spend against the frontier budget', async () => {
    const { d, budgets } = deps();
    const r = await runTask(task(1), FULL, d);
    const sum = r.reduce((s, x) => s + x.costs.authorUsd + x.costs.verifierUsd, 0);
    expect(budgets.spent('frontier')).toBeCloseTo(sum, 6);
    expect(budgets.spent('frontier')).toBeGreaterThan(0);
    expect(r.find((x) => x.row.author === 'ow-qwen')!.costs.authorUsd).toBe(0);
    expect(budgets.spent('nosana')).toBe(0);
  });
});

describe('the stop rule: a budget can\'t be crossed (40.5)', () => {
  it('stops before a whole task it can\'t finish, and says so', async () => {
    const worst = worstCaseOfTask(REDUCED).frontier;
    const { d } = deps({ total: worst * 1.000001 });
    const r = await runBench([task(1), task(2), task(3)], REDUCED, d);
    expect(r.cutShort).toBe(true);
    expect(r.tasksDone).toBe(1);
    expect(r.reason).toMatch(/frontier budget/);
    expect(r.records.length % 4).toBe(0);
    expect(d.budgets.remaining('frontier')).toBeGreaterThanOrEqual(0);
  });
  it('spends nothing with no stated budget: the first reservation is refused', async () => {
    const budgets = new Budgets();
    expect(() => budgets.reserve('frontier', 0.01)).toThrow(BudgetRefused);
    const { d } = deps();
    const none = await runBench([task(1)], REDUCED, { ...d, budgets });
    expect(none).toMatchObject({ tasksDone: 0, cutShort: true });
  });
  it('holds a reservation while a call runs, and settles it to what the call cost', () => {
    const b = new Budgets();
    b.state('frontier', 1, 'test');
    const id = b.reserve('frontier', 0.6);
    expect(b.remaining('frontier')).toBeCloseTo(0.4);
    expect(() => b.reserve('frontier', 0.5)).toThrow(BudgetRefused);
    b.settle(id, 0.1);
    expect(b.remaining('frontier')).toBeCloseTo(0.9);
    const other = b.reserve('frontier', 0.5);
    b.release(other);
    expect(b.remaining('frontier')).toBeCloseTo(0.9);
  });
  it('keeps the two budgets apart, and reads a ledger back from its file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const b = new Budgets(path);
    b.state('frontier', 5, 'the owner');
    b.state('nosana', 10, 'the owner');
    b.settle(b.reserve('frontier', 2), 1.5);
    expect(b.remaining('nosana')).toBe(10);
    const again = new Budgets(path);
    expect(again.remaining('frontier')).toBeCloseTo(3.5);
    expect(again.spent('frontier')).toBeCloseTo(1.5);
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean).length).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });
});
