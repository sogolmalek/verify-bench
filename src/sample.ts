/**
 * The sample (PREREGISTRATION.md): about 1,000 independently judged PRs, at most 170 an agent, at each agent's natural share of merged
 * and closed, at most 15% of an agent's from one repository, drawn in one seeded order. The probe's 30 are left out. Everything not
 * drawn is counted, with why.
 */
import { createHash } from 'node:crypto';

export type SampleAgent = { name: string; query: string; vendor: string; secondary: boolean; marker?: RegExp; mergedShare: number };

/**
 * The agents, how GitHub finds them, and the natural share of merged PRs estimated in the design's counts (pool times usable share).
 * Gemini CLI's note held on 4% of rows, so it isn't an agent signal, and isn't here.
 */
export const SAMPLE_AGENTS: readonly SampleAgent[] = [
  { name: 'Copilot coding agent', query: 'author:app/copilot-swe-agent', vendor: 'github', secondary: false, mergedShare: 0.83 },
  { name: 'Claude (GitHub app)', query: 'author:app/claude', vendor: 'anthropic', secondary: false, mergedShare: 0.93 },
  { name: 'Devin', query: 'author:app/devin-ai-integration', vendor: 'cognition', secondary: false, mergedShare: 0.79 },
  { name: 'Cursor (GitHub app)', query: 'author:app/cursor', vendor: 'cursor', secondary: false, mergedShare: 0.81 },
  { name: 'Codex (task link)', query: '"chatgpt.com/codex/tasks" in:body', vendor: 'openai', secondary: false, marker: /chatgpt\.com\/codex\/tasks/i, mergedShare: 0.64 },
  { name: 'Jules', query: 'author:app/google-labs-jules', vendor: 'google', secondary: false, mergedShare: 0.24 },
  { name: 'Claude Code (body note)', query: '"Generated with Claude Code" in:body', vendor: 'anthropic', secondary: true, marker: /claude\.(?:com|ai)\/(?:claude-)?code|Generated with \[?Claude Code/i, mergedShare: 0.93 },
  { name: 'Cursor (agent note)', query: '"cursor.com/agents" in:body', vendor: 'cursor', secondary: true, marker: /cursor\.com\/(?:agents|background-agent)/i, mergedShare: 0.86 },
];

export const SAMPLE_RULES = { from: '2026-09-03', minStars: 100, maxLines: 2_000, windowDays: 30, perAgent: 170, repoShare: 0.15 } as const;

type Actor = { login: string; __typename?: string } | null;
/** One PR as GitHub's search gives it. */
export type Candidate = {
  agent: string;
  repo: string;
  number: number;
  state: 'merged' | 'closed';
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  lines: number;
  stars: number;
  fork: boolean;
  archived: boolean;
  ci: string | null;
  body: string;
  /** Set when the body was checked at the read and not kept. */
  markerHolds?: boolean;
  author: Actor;
  mergedBy: Actor;
  closedBy: Actor;
};
export type Drawn = Omit<Candidate, 'body' | 'markerHolds' | 'author' | 'mergedBy' | 'closedBy'> & { id: string; author: string | null; judgedBy: string | null };

const isBot = (a: Actor) => !a || a.__typename === 'Bot' || /\[bot\]$/i.test(a.login);
export const idOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
/** A number in [0, 1) from the seed and the PR, the same on every machine. */
export const draw = (seed: string, id: string) => createHash('sha256').update(`${seed}|${id}`).digest().readUInt32BE(0) / 2 ** 32;

/** Merged by someone other than the PR's own account, and not a bot; or closed by another person. */
export function independent(c: Pick<Candidate, 'state' | 'author' | 'mergedBy' | 'closedBy'>): boolean {
  const by = c.state === 'merged' ? c.mergedBy : c.closedBy;
  if (!by || isBot(by)) return false;
  return by.login.toLowerCase() !== (c.author?.login ?? '').toLowerCase();
}

/** Why a PR isn't in the population, or null when it is. The read date sets "merged at least 30 days before the read". */
export function exclusion(c: Candidate, agent: SampleAgent, readAt: string, heldOut: ReadonlySet<string>): string | null {
  if (heldOut.has(idOf(c))) return 'held out for the probe';
  if (agent.marker && !(c.markerHolds ?? agent.marker.test(c.body))) return "the marker isn't in the body";
  if (c.fork || c.archived) return 'a fork or archived';
  if (c.stars < SAMPLE_RULES.minStars) return 'under 100 stars';
  if (c.createdAt < SAMPLE_RULES.from) return 'created before 2026-09-03';
  const ended = c.state === 'merged' ? c.mergedAt : c.closedAt;
  if (!ended || Date.parse(ended) > Date.parse(readAt) - SAMPLE_RULES.windowDays * 86_400_000) return 'not 30 days old';
  if (!c.ci) return 'CI not known';
  if (c.lines > SAMPLE_RULES.maxLines) return 'over 2,000 lines';
  if (!independent(c)) return 'not independently judged';
  return null;
}

export type SampleResult = { drawn: Drawn[]; counts: Record<string, { candidates: number; eligible: number; merged: number; closed: number; target: { merged: number; closed: number }; short: { merged: number; closed: number }; repos: number; excluded: Record<string, number> }> };

/**
 * Per agent: the eligible PRs in seeded order, taken while the state's quota and the repository's cap allow. A state short of its quota
 * stays short, rather than being filled from the other, so the natural share holds. Then all of it in one seeded order, which the run walks.
 */
export function drawSample(candidates: readonly Candidate[], o: { seed: string; readAt: string; heldOut: ReadonlySet<string>; agents?: readonly SampleAgent[]; perAgent?: number; repoShare?: number }): SampleResult {
  const agents = o.agents ?? SAMPLE_AGENTS;
  const per = o.perAgent ?? SAMPLE_RULES.perAgent;
  const repoCap = Math.max(1, Math.floor(per * (o.repoShare ?? SAMPLE_RULES.repoShare)));
  const seen = new Set<string>();
  const drawn: Drawn[] = [];
  const taken = new Set<string>();
  const counts: SampleResult['counts'] = {};
  for (const a of agents) {
    const mine = candidates.filter((c) => c.agent === a.name && !seen.has(`${a.name}|${idOf(c)}`) && seen.add(`${a.name}|${idOf(c)}`));
    const excluded: Record<string, number> = {};
    const ok: Candidate[] = [];
    for (const c of mine) {
      const why = exclusion(c, a, o.readAt, o.heldOut);
      if (why) excluded[why] = (excluded[why] ?? 0) + 1;
      else ok.push(c);
    }
    const target = { merged: Math.round(per * a.mergedShare), closed: per - Math.round(per * a.mergedShare) };
    const got = { merged: 0, closed: 0 };
    const byRepo = new Map<string, number>();
    for (const c of [...ok].sort((x, y) => draw(o.seed, idOf(x)) - draw(o.seed, idOf(y)))) {
      // A PR found under two agents (an app's PR whose body also has a note) is drawn once, for the first.
      if (taken.has(idOf(c)) || got[c.state] >= target[c.state] || (byRepo.get(c.repo) ?? 0) >= repoCap) continue;
      taken.add(idOf(c));
      got[c.state]++;
      byRepo.set(c.repo, (byRepo.get(c.repo) ?? 0) + 1);
      const { body: _b, markerHolds: _m, author, mergedBy, closedBy, ...rest } = c;
      drawn.push({ ...rest, id: idOf(c), author: author?.login ?? null, judgedBy: (c.state === 'merged' ? mergedBy : closedBy)?.login ?? null });
    }
    counts[a.name] = { candidates: mine.length, eligible: ok.length, merged: got.merged, closed: got.closed, target, short: { merged: target.merged - got.merged, closed: target.closed - got.closed }, repos: byRepo.size, excluded };
  }
  return { drawn: drawn.sort((x, y) => draw(`${o.seed}|order`, x.id) - draw(`${o.seed}|order`, y.id)), counts };
}
