/**
 * The agent's patch and its stripped task, read-only from GitHub (PREREGISTRATION.md): the diff at the agent's last commit before any
 * person's. Null when a commit's author can't be told, or the diff can't be read.
 */
import { stripTask } from './agentPrs.js';

const isBot = (u: { login?: string; type?: string } | null | undefined) => !!u && (u.type === 'Bot' || /\[bot\]$/i.test(u.login ?? ''));

export type AgentPatch = { task: { title: string; description: string }; patch: string; agentCommit: string; baseSha: string; commitsDropped: number };

export async function readAgentPatch(repo: string, number: number, o: { fetch?: typeof fetch; token?: string; maxChars?: number }): Promise<AgentPatch | null> {
  const f = o.fetch ?? fetch;
  const headers = { 'user-agent': 'verify-bench', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) };
  const json = async (path: string) => {
    const r = await f(`https://api.github.com/repos/${repo}${path}`, { headers: { ...headers, accept: 'application/vnd.github+json' } });
    return r.status === 200 ? ((await r.json()) as any) : null;
  };
  const pr = await json(`/pulls/${number}`);
  if (!pr) return null;
  const commits = (await json(`/pulls/${number}/commits?per_page=100`)) as { sha: string; author: { login: string; type?: string } | null; commit: { author?: { name?: string } } }[] | null;
  if (!commits?.length) return null;
  const opener = String(pr.user?.login ?? '').toLowerCase();
  const byAgent = (c: (typeof commits)[number]) => isBot(c.author) || c.author?.login?.toLowerCase() === opener || /copilot|claude|devin|cursor|jules|codex/i.test(c.commit.author?.name ?? '');
  const firstPerson = commits.findIndex((c) => !byAgent(c));
  const upTo = firstPerson === -1 ? commits.length : firstPerson;
  if (upTo === 0) return null;
  const agentCommit = commits[upTo - 1]!.sha;
  const r = await f(`https://api.github.com/repos/${repo}/compare/${pr.base.sha}...${agentCommit}`, { headers: { ...headers, accept: 'application/vnd.github.v3.diff' } });
  if (r.status !== 200) return null;
  const patch = await r.text();
  if (!patch.trim() || patch.length > (o.maxChars ?? 60_000)) return null;
  return { task: stripTask(pr.title ?? '', pr.body ?? null), patch, agentCommit, baseSha: pr.base.sha, commitsDropped: commits.length - upTo };
}
