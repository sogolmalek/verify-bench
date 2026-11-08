/**
 * Draws the sample (PREREGISTRATION.md), read-only: GitHub's search, day by day, state by state, for each agent, then `drawSample`.
 * Writes tasks/candidates.jsonl (what search gave, with no PR bodies) and tasks/sample.json (the drawn PRs in run order, and the counts).
 *   GITHUB_TOKEN (read-only), SAMPLE_SEED (default verify-bench-40.10), SAMPLE_READ_AT (default now), SAMPLE_PER_DAY (default 150 for an
 *   app's account, 300 for a note in the body, where far fewer hold), SAMPLE_WORKERS (default 4)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { drawSample, SAMPLE_AGENTS, SAMPLE_RULES, type Candidate } from '../src/sample.js';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');
const SEED = process.env.SAMPLE_SEED ?? 'verify-bench-40.10';
const READ_AT = process.env.SAMPLE_READ_AT ?? new Date().toISOString();
const PER_DAY = (secondary: boolean) => Number(process.env.SAMPLE_PER_DAY ?? (secondary ? 300 : 150));
const WORKERS = Number(process.env.SAMPLE_WORKERS ?? 4);
const OUT = 'tasks/candidates.jsonl';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string, o: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...o }));

const QUERY = `query($q:String!,$after:String,$n:Int!){rateLimit{remaining resetAt} search(query:$q,type:ISSUE,first:$n,after:$after){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number createdAt mergedAt closedAt additions deletions body author{login __typename} mergedBy{login __typename} timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{actor{login __typename}}}} commits(last:1){nodes{commit{statusCheckRollup{state}}}} repository{nameWithOwner stargazerCount isFork isArchived}}}}}`;
async function search(q: string, after: string | null): Promise<any> {
  // GitHub answers 502 to 100 of these at once, and about 10 seconds to 50.
  for (const [i, n] of [50, 25, 10].entries()) {
    await pause(1_000 + 3_000 * i);
    try {
      const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'verify-bench' }, body: JSON.stringify({ query: QUERY, variables: { q, after, n } }), signal: AbortSignal.timeout(90_000) });
      if (r.status === 403 || r.status === 429) {
        log('rate limited, waiting', { status: r.status });
        await pause(90_000);
        continue;
      }
      const j = (await r.json()) as any;
      if (j.data?.search) {
        if (j.data.rateLimit?.remaining < 200) await pause(Math.max(0, Date.parse(j.data.rateLimit.resetAt) - Date.now()) + 5_000);
        return j.data.search;
      }
    } catch {
      // a smaller page, after a longer wait
    }
  }
  return null;
}

const heldOut = new Set((JSON.parse(readFileSync('tasks/probe.json', 'utf8')) as { prs: { repo: string; number: number }[] }).prs.map((p) => `${p.repo}#${p.number}`));
const lastDay = new Date(Date.parse(READ_AT) - SAMPLE_RULES.windowDays * 86_400_000).toISOString().slice(0, 10);
const days: string[] = [];
for (let t = Date.parse(`${SAMPLE_RULES.from}T00:00:00Z`); new Date(t).toISOString().slice(0, 10) <= lastDay; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
// Resumable: a day already read for an agent and state is skipped.
const done = new Set<string>();
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) { const j = JSON.parse(l); if (j.kind === 'day') done.add(`${j.agent}|${j.state}|${j.day}`); }
log('reading', { days: days.length, from: days[0], to: days.at(-1), agents: SAMPLE_AGENTS.length, perDay: { app: PER_DAY(false), note: PER_DAY(true) }, workers: WORKERS, readAt: READ_AT });
async function readAgent(a: (typeof SAMPLE_AGENTS)[number]) {
  for (const day of days) {
    for (const [state, sq] of [['merged', 'is:merged'], ['closed', 'is:closed is:unmerged']] as const) {
      if (done.has(`${a.name}|${state}|${day}`)) continue;
      let after: string | null = null;
      let read = 0;
      let pool = 0;
      while (read < PER_DAY(a.secondary)) {
        const r = await search(`is:pr is:public ${a.query} ${sq} created:${day} sort:created-desc`, after);
        if (!r) break;
        pool = r.issueCount;
        for (const n of r.nodes) {
          if (!n?.repository) continue;
          const c: Candidate & { kind: 'pr' } = { kind: 'pr', agent: a.name, repo: n.repository.nameWithOwner, number: n.number, state, createdAt: n.createdAt, mergedAt: n.mergedAt, closedAt: n.closedAt, lines: (n.additions ?? 0) + (n.deletions ?? 0), stars: n.repository.stargazerCount, fork: n.repository.isFork, archived: n.repository.isArchived, ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, body: '', author: n.author, mergedBy: n.mergedBy, closedBy: n.timelineItems?.nodes?.[0]?.actor ?? null };
          // The body is read only to check the marker, and isn't kept.
          if (a.marker) c.markerHolds = a.marker.test(n.body ?? '');
          appendFileSync(OUT, `${JSON.stringify(c)}\n`);
          read++;
        }
        if (!r.pageInfo.hasNextPage) break;
        after = r.pageInfo.endCursor;
      }
      appendFileSync(OUT, `${JSON.stringify({ kind: 'day', agent: a.name, state, day, pool, read })}\n`);
    }
  }
  log('agent read', { agent: a.name });
}
// A few agents at once: each worker takes the next agent.
const queue = [...SAMPLE_AGENTS];
await Promise.all(Array.from({ length: WORKERS }, async () => { for (let a = queue.shift(); a; a = queue.shift()) await readAgent(a); }));

const rows = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// The same number per day for every agent and state: a day read before the per-day number changed keeps only its first, the newest.
const perDayCount = new Map<string, number>();
const candidates = (rows.filter((r) => r.kind === 'pr') as Candidate[]).filter((c) => {
  const k = `${c.agent}|${c.state}|${c.createdAt.slice(0, 10)}`;
  const n = (perDayCount.get(k) ?? 0) + 1;
  perDayCount.set(k, n);
  return n <= PER_DAY(SAMPLE_AGENTS.find((a) => a.name === c.agent)?.secondary ?? false);
});
const pools: Record<string, { merged: number; closed: number }> = {};
for (const d of rows.filter((r) => r.kind === 'day')) (pools[d.agent] ??= { merged: 0, closed: 0 })[d.state as 'merged' | 'closed'] += d.pool;
const s = drawSample(candidates, { seed: SEED, readAt: READ_AT, heldOut });
writeFileSync('tasks/sample.json', `${JSON.stringify({ seed: SEED, readAt: READ_AT, rules: SAMPLE_RULES, days: [days[0], days.at(-1)], perDay: { app: PER_DAY(false), note: PER_DAY(true) }, pools, counts: s.counts, size: s.drawn.length, prs: s.drawn }, null, 1)}\n`);
log('drawn', { size: s.drawn.length, counts: Object.fromEntries(Object.entries(s.counts).map(([k, v]) => [k, `${v.merged}+${v.closed} of ${v.eligible} eligible, ${v.candidates} read`])) });
