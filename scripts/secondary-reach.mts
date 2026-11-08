/**
 * The secondary analysis (PREREGISTRATION.md, "cross-file reach"): does reach rank the strict later-found problems above size alone,
 * and above random? Reads results/facts.jsonl and results/reach.jsonl, writes results/secondary-reach.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AgentPatch } from '../src/agentPatch.js';
import { broadProblem, strictProblem, type PrFacts } from '../src/agentPrs.js';
import { recallAt, recallResult, SIZE, RANDOM, type RankRow } from '../src/ranking.js';

const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const facts = new Map<string, PrFacts & { id: string; unreadable?: boolean }>(lines('results/facts.jsonl').map((r) => [r.id, r]));
const reach = new Map<string, { id: string; sites?: number; functions: string[]; error?: string }>(lines('results/reach.jsonl').map((r) => [r.id, r]));
const patches = new Map<string, AgentPatch | null>(gunzipSync(readFileSync('tasks/patches.jsonl.gz')).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((j) => [j.id, j.patch]));
const sample = JSON.parse(readFileSync('tasks/sample.json', 'utf8')) as { prs: { id: string; repo: string; state: string; lines: number }[] };

const merged = sample.prs.filter((p) => p.state === 'merged' && patches.get(p.id));
const counted = { mergedWithPatch: merged.length, noFacts: 0, noReach: 0 };
const rows: (RankRow & { broad: boolean; coAuthored: boolean; functions: number })[] = [];
for (const p of merged) {
  const f = facts.get(p.id);
  const r = reach.get(p.id);
  if (!f || f.unreadable) { counted.noFacts++; continue; }
  if (!r || r.error || typeof r.sites !== 'number') { counted.noReach++; continue; }
  rows.push({ id: p.id, repo: p.repo, problem: strictProblem(f), broad: broadProblem(f), lines: p.lines, coAuthored: !!patches.get(p.id)?.coAuthored, functions: r.functions.length, scores: { reach: r.sites, reachThenSize: r.sites * 1e6 + p.lines, functions: r.functions.length } });
}
const KS = [0.1, 0.2, 0.3];
const ARMS = ['reach', 'reachThenSize', 'functions'] as const;
const analyse = (rs: RankRow[]) => ({
  prs: rs.length,
  problems: rs.filter((r) => r.problem).length,
  repos: new Set(rs.map((r) => r.repo)).size,
  withReach: rs.filter((r) => (r.scores.reach ?? 0) > 0).length,
  size: Object.fromEntries(KS.map((k) => [k, recallAt(rs, SIZE, k)])),
  random: Object.fromEntries(KS.map((k) => [k, recallAt(rs, RANDOM, k)])),
  arms: Object.fromEntries(ARMS.map((a) => [a, KS.map((k) => recallResult(rs, a, k))])),
});
const strictAll = analyse(rows);
const strictNoCo = analyse(rows.filter((r) => !r.coAuthored));
const broadAll = analyse(rows.map((r) => ({ ...r, problem: r.broad })));
const holds = (a: ReturnType<typeof analyse>, arm: (typeof ARMS)[number]) => {
  const r = a.arms[arm].find((x) => x.k === 0.2)!;
  return !!r.againstSize && r.againstSize.low > 0;
};
const report = {
  question: 'Does cross-file reach rank strict later-found problems above size alone, and above random? (secondary; not 40.10\'s claim)',
  counted,
  strict: strictAll,
  strictWithoutCoAuthored: strictNoCo,
  broad: broadAll,
  reachAddsSomething: { strict: holds(strictAll, 'reach'), strictWithoutCoAuthored: holds(strictNoCo, 'reach'), reachThenSize: holds(strictAll, 'reachThenSize') },
};
writeFileSync('results/secondary-reach.json', `${JSON.stringify(report, null, 1)}\n`);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const iv = (d: { point: number; low: number; high: number } | null) => (d ? `${d.point >= 0 ? '+' : ''}${Math.round(d.point * 100)} [${Math.round(d.low * 100)}, ${Math.round(d.high * 100)}]` : '-');
for (const [name, a] of [['strict', strictAll], ['strict, without co-authored', strictNoCo], ['broad', broadAll]] as const) {
  console.log(`\n${name}: ${a.prs} PRs, ${a.problems} problems, ${a.repos} repositories, ${a.withReach} with reach above 0`);
  for (const [i, k] of KS.entries()) console.log(`  k=${k}: size ${pct(a.size[k])}, random ${pct(a.random[k])}; ${ARMS.map((arm) => `${arm} ${pct(a.arms[arm][i]!.recall)} vs size ${iv(a.arms[arm][i]!.againstSize)} vs random ${iv(a.arms[arm][i]!.againstRandom)}`).join('; ')}`);
}
console.log('\n', JSON.stringify(report.reachAddsSomething), JSON.stringify(counted));
