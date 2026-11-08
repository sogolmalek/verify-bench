/**
 * What happened to a sampled PR after its merge (PREREGISTRATION.md, "the two truths"), from GitHub, read-only: later touches of the
 * agent's lines, reverts, later bug issues and reopened linked issues, line survival at 14 and 30 days, and review intensity. Pure
 * helpers here; scripts/facts.mts reads GitHub.
 */
import type { LaterTouch } from './agentPrs.js';

export const FIX = /^(fix|bug|hotfix)\b|\b(fix(es|ed)?|bug|regression|broken|crash)\b/i;
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)|[_.-](test|tests|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+$/i;
const NOT_CODE = /\.(md|rst|txt|lock|json|ya?ml|toml|csv|svg|png|jpe?g|gif)$/i;
export const FACT_WINDOW_DAYS = 30;
export const MAX_CODE_FILES = 5;

/** The agent's added lines per code file, the five with most, as a later commit would have to remove them. Lines under 8 characters are too common to follow. */
export function addedByFile(files: readonly { filename: string; patch?: string | undefined }[]): { name: string; added: Set<string> }[] {
  return files
    .filter((f) => f.patch && !TEST_FILE.test(f.filename) && !NOT_CODE.test(f.filename))
    .map((f) => ({ name: f.filename, added: new Set(f.patch!.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l.length >= 8)) }))
    .filter((f) => f.added.size)
    .sort((a, b) => b.added.size - a.added.size || a.name.localeCompare(b.name))
    .slice(0, MAX_CODE_FILES);
}

export type LaterCommit = { sha: string; author: string | null; message: string; date: string; files: { filename: string; patch?: string | undefined; additions: number }[] };

/** The agent's lines a later commit removed, in one file. */
export function removedOf(c: LaterCommit, file: string, added: ReadonlySet<string>): string[] {
  const patch = c.files.find((x) => x.filename === file)?.patch ?? '';
  return patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim()).filter((l) => added.has(l));
}

export const isRevertOf = (message: string, pr: { number: number; title: string; mergeSha: string | null }) =>
  /^revert\b/i.test(message) && (message.includes(`#${pr.number}`) || (!!pr.mergeSha && message.includes(pr.mergeSha)) || message.includes(pr.title));

/** One later commit that changed the agent's lines: by someone else than the PR's account, with a fix message, adding to a test. */
export function touchOf(c: LaterCommit, prAuthor: string, mergedAt: string): LaterTouch & { days: number } {
  return {
    byOther: (c.author ?? '').toLowerCase() !== prAuthor.toLowerCase(),
    fixMessage: FIX.test(c.message.split('\n')[0] ?? ''),
    test: c.files.some((f) => TEST_FILE.test(f.filename) && f.additions > 0),
    days: Math.round(((Date.parse(c.date) - Date.parse(mergedAt)) / 86_400_000) * 10) / 10,
  };
}

/** The share of the agent's added lines no later commit removed within the days given. Null with none to follow. */
export function survival(addedTotal: number, removed: readonly { line: string; days: number }[], days: number): number | null {
  if (!addedTotal) return null;
  return 1 - new Set(removed.filter((r) => r.days <= days).map((r) => r.line)).size / addedTotal;
}

/** Issues a PR says it closes: "fixes #41", "closes owner/repo#7". */
export function closedIssues(body: string | null, repo: string): { repo: string; number: number }[] {
  const out = new Map<string, { repo: string; number: number }>();
  for (const m of (body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi)) out.set(`${m[1] ?? repo}#${m[2]}`, { repo: m[1] ?? repo, number: Number(m[2]) });
  return [...out.values()].slice(0, 3);
}

export const BUG_ISSUE = /\b(bug|regression|broken|crash(es)?)\b/i;
type TimelineEvent = { event: string; created_at?: string; source?: { issue?: { pull_request?: unknown; title?: string; labels?: { name: string }[] } } };
/** Bug issues that referenced the PR within the window after its merge. */
export function laterBugIssues(events: readonly TimelineEvent[], mergedAt: string, days = FACT_WINDOW_DAYS): number {
  const from = Date.parse(mergedAt);
  return events.filter((e) => {
    const at = Date.parse(e.created_at ?? '');
    const issue = e.source?.issue;
    return e.event === 'cross-referenced' && !!issue && !issue.pull_request && at >= from && at <= from + days * 86_400_000 && (BUG_ISSUE.test(issue.title ?? '') || (issue.labels ?? []).some((l) => /bug/i.test(l.name)));
  }).length;
}
/** A linked issue reopened within the window after the merge. */
export const reopenedAfter = (events: readonly TimelineEvent[], mergedAt: string, days = FACT_WINDOW_DAYS) =>
  events.some((e) => e.event === 'reopened' && Date.parse(e.created_at ?? '') >= Date.parse(mergedAt) && Date.parse(e.created_at ?? '') <= Date.parse(mergedAt) + days * 86_400_000);

/** Review intensity: rounds of requested changes, and review comments. */
export function reviewIntensity(reviews: readonly { state: string }[], pr: { comments?: number; review_comments?: number }) {
  return { changeRequestRounds: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length, reviewComments: pr.review_comments ?? 0, comments: pr.comments ?? 0 };
}
