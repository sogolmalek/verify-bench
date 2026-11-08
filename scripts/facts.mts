/**
 * Reads what happened to each sampled PR after its merge, from GitHub, read-only, into results/facts.jsonl (src/facts.ts). Resumable:
 * a PR already written is skipped. It waits out GitHub's rate limit.
 *   GITHUB_TOKEN (read-only)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AgentPatch } from '../src/agentPatch.js';
import { addedByFile, closedIssues, FACT_WINDOW_DAYS, isRevertOf, laterBugIssues, removedOf, reopenedAfter, reviewIntensity, survival, touchOf, type LaterCommit } from '../src/facts.js';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');
const OUT = process.env.FACTS_OUT ?? 'results/facts.jsonl';
mkdirSync('results', { recursive: true });
const sample = JSON.parse(readFileSync('tasks/sample.json', 'utf8')) as { prs: { id: string; repo: string; number: number; agent: string; state: 'merged' | 'closed'; lines: number; ci: string | null; mergedAt: string | null }[] };
const patches = new Map<string, AgentPatch | null>(gunzipSync(readFileSync('tasks/patches.jsonl.gz')).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((j) => [j.id, j.patch]));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id) : []);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gh<T>(path: string): Promise<T | null> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'verify-bench' }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!r) { await pause(5_000); continue; }
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      const wait = r.headers.get('x-ratelimit-remaining') === '0' && reset ? Math.max(5_000, reset - Date.now() + 2_000) : 60_000;
      console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'rate limited, waiting', seconds: Math.round(wait / 1000) }));
      await pause(wait);
      continue;
    }
    if (r.status >= 500) { await pause(5_000); continue; }
    return r.status === 200 ? ((await r.json()) as T) : null;
  }
  return null;
}

const commitCache = new Map<string, LaterCommit | null>();
async function commitOf(repo: string, sha: string): Promise<LaterCommit | null> {
  const k = `${repo}@${sha}`;
  if (!commitCache.has(k)) {
    const d = await gh<{ sha: string; author: { login: string } | null; commit: { message: string; committer: { date: string } }; files?: { filename: string; patch?: string; additions: number }[] }>(`/repos/${repo}/commits/${sha}`);
    commitCache.set(k, d ? { sha: d.sha, author: d.author?.login ?? null, message: d.commit.message, date: d.commit.committer.date, files: d.files ?? [] } : null);
    if (commitCache.size > 4_000) commitCache.clear();
  }
  return commitCache.get(k)!;
}

let n = 0;
for (const p of sample.prs) {
  if (done.has(p.id)) continue;
  const base = { id: p.id, agent: p.agent, repo: p.repo, state: p.state, linesChanged: p.lines, independent: true, ciGreenAtMerge: p.ci === 'SUCCESS', readAt: new Date().toISOString() };
  const patch = patches.get(p.id) ?? null;
  const pr = await gh<{ user: { login: string } | null; title: string; body: string | null; merged_at: string | null; merge_commit_sha: string | null; base: { ref: string }; comments?: number; review_comments?: number }>(`/repos/${p.repo}/pulls/${p.number}`);
  if (!pr) {
    appendFileSync(OUT, `${JSON.stringify({ ...base, unreadable: true })}\n`);
    continue;
  }
  const reviews = (await gh<{ state: string }[]>(`/repos/${p.repo}/pulls/${p.number}/reviews?per_page=100`)) ?? [];
  const intensity = reviewIntensity(reviews, pr);
  const person = { personCommits: patch ? patch.commitsDropped : null, coAuthored: patch?.coAuthored ?? false, changesRequested: intensity.changeRequestRounds > 0 };
  if (p.state !== 'merged' || !pr.merged_at) {
    appendFileSync(OUT, `${JSON.stringify({ ...base, ...person, ...intensity, reverted: false, fixedForward: false, laterIssues: 0, reopened: false, touches: [] })}\n`);
    continue;
  }
  const mergedAt = pr.merged_at;
  const until = new Date(Date.parse(mergedAt) + FACT_WINDOW_DAYS * 86_400_000).toISOString();
  const files = addedByFile((await gh<{ filename: string; patch?: string }[]>(`/repos/${p.repo}/pulls/${p.number}/files?per_page=100`)) ?? []);
  const touches: ReturnType<typeof touchOf>[] = [];
  const removed: { line: string; days: number }[] = [];
  let reverted = false;
  for (const f of files) {
    const list = (await gh<{ sha: string; parents?: unknown[] }[]>(`/repos/${p.repo}/commits?sha=${encodeURIComponent(pr.base.ref)}&path=${encodeURIComponent(f.name)}&since=${encodeURIComponent(mergedAt)}&until=${encodeURIComponent(until)}&per_page=30`)) ?? [];
    for (const c of list) {
      if (c.sha === pr.merge_commit_sha || (c.parents?.length ?? 1) > 1) continue;
      const d = await commitOf(p.repo, c.sha);
      if (!d) continue;
      if (isRevertOf(d.message, { number: p.number, title: pr.title, mergeSha: pr.merge_commit_sha })) reverted = true;
      const hit = removedOf(d, f.name, f.added);
      if (!hit.length) continue;
      const t = touchOf(d, pr.user?.login ?? '', mergedAt);
      touches.push(t);
      hit.forEach((line) => removed.push({ line: `${f.name}\0${line}`, days: t.days }));
    }
  }
  const timeline = (await gh<Parameters<typeof laterBugIssues>[0][number][]>(`/repos/${p.repo}/issues/${p.number}/timeline?per_page=100`)) ?? [];
  let reopened = false;
  for (const i of closedIssues(pr.body, p.repo)) {
    const ev = await gh<Parameters<typeof reopenedAfter>[0][number][]>(`/repos/${i.repo}/issues/${i.number}/timeline?per_page=100`);
    if (ev && reopenedAfter(ev, mergedAt)) reopened = true;
  }
  const addedTotal = files.reduce((a, f) => a + f.added.size, 0);
  appendFileSync(OUT, `${JSON.stringify({
    ...base,
    ...person,
    ...intensity,
    mergedAt,
    reverted,
    fixedForward: touches.some((t) => t.byOther && t.fixMessage && t.days <= 7),
    laterIssues: laterBugIssues(timeline, mergedAt) + (reopened ? 1 : 0),
    reopened,
    touches,
    addedFollowed: addedTotal,
    survived30: survival(addedTotal, removed, 30),
    survived14: survival(addedTotal, removed, 14),
  })}\n`);
  if (++n % 25 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), read: done.size + n, of: sample.prs.length }));
}
console.log(JSON.stringify({ done: true, of: sample.prs.length }));
