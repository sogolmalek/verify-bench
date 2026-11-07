/**
 * Which merged PRs are tasks (the design, 40.2.1, 40.2.2). Reads public GitHub data through an injected reader, so the same
 * code runs against fixtures. It decides everything it can without running anything; the fail-to-pass rule and the
 * controls come after, in the sandbox.
 */
export type PullSummary = {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user?: { login?: string; type?: string } | null;
};
export type PullFile = { filename: string; changes: number; status?: string };
export type Reader = (path: string) => Promise<any>;

export type Exclusion = 'before-window' | 'bot' | 'no-tests' | 'no-code' | 'too-large' | 'thin-description' | 'not-one-commit' | 'unreadable';

export type PlannedTask = {
  key: string;
  repo: string;
  number: number;
  title: string;
  /** The PR's description, with its HTML comments removed, and the text of the issue it closes, if any. */
  description: string;
  linkedIssue: number | null;
  parentSha: string;
  mergedSha: string;
  testFiles: string[];
  codeFiles: string[];
  codeLines: number;
  testLines: number;
  mergedAt: string;
};

export type RepoPlan = { repo: string; tasks: PlannedTask[]; excluded: Partial<Record<Exclusion, number>>; read: number };

/** 39.12's class rule reads a size from labels these repositories don't use, so size M is set in lines. */
export const SIZE_LIMIT_CODE_LINES = 200;
/** A task whose text is shorter than this isn't one a person could do from what it says. */
export const MIN_TASK_WORDS = 15;

const TEST_PATH = /(^|\/)(tests?|__tests__|testing|spec|specs)(\/|$)|\.(test|spec|test-d)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|(^|\/)conftest\.py$/i;
const DOC_PATH = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
const CHORE_PATH = /(^|\/)(\.github|\.changeset|changelog\.d|changes)\//i;
const CHORE_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|changelog[^/]*)$/i;

export const isTestFile = (f: string) => TEST_PATH.test(f);
export const isCodeFile = (f: string) => !isTestFile(f) && !DOC_PATH.test(f) && !CHORE_PATH.test(f) && !CHORE_FILE.test(f);

const isBot = (p: PullSummary) => p.user?.type === 'Bot' || /\[bot\]$|^(dependabot|renovate|pre-commit-ci)/i.test(p.user?.login ?? '');
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').trim();
/** The issue a PR closes, from its description: `fixes #12`, `closes #12`, `resolves #12`. */
export const closedIssue = (body: string | null): number | null => {
  const m = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b:?\s+#(\d+)/i.exec(body ?? '');
  return m ? Number(m[1]) : null;
};
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** One merged PR, as a task or a reason it isn't one. */
export async function planPull(repo: string, p: PullSummary, windowStart: string, read: Reader): Promise<{ task: PlannedTask } | { excluded: Exclusion }> {
  if (!p.merged_at || !p.merge_commit_sha || p.merged_at.slice(0, 10) < windowStart) return { excluded: 'before-window' };
  if (isBot(p)) return { excluded: 'bot' };
  const files: PullFile[] | null = await read(`repos/${repo}/pulls/${p.number}/files?per_page=100`);
  if (!files) return { excluded: 'unreadable' };
  const testFiles = files.filter((f) => isTestFile(f.filename));
  const codeFiles = files.filter((f) => isCodeFile(f.filename));
  if (!testFiles.length) return { excluded: 'no-tests' };
  if (!codeFiles.length) return { excluded: 'no-code' };
  const codeLines = codeFiles.reduce((s, f) => s + f.changes, 0);
  if (codeLines > SIZE_LIMIT_CODE_LINES) return { excluded: 'too-large' };
  const commit = await read(`repos/${repo}/commits/${p.merge_commit_sha}`);
  const parentSha = commit?.parents?.[0]?.sha as string | undefined;
  if (!parentSha) return { excluded: 'unreadable' };
  // A rebase merge's last commit isn't the whole PR: its parent wouldn't be where the PR started.
  const inCommit = new Set<string>((commit.files ?? []).map((f: PullFile) => f.filename));
  if (files.some((f) => !inCommit.has(f.filename))) return { excluded: 'not-one-commit' };
  const body = stripComments(p.body ?? '');
  const issue = closedIssue(body);
  let issueText = '';
  if (issue !== null) {
    const i = await read(`repos/${repo}/issues/${issue}`);
    if (i?.title) issueText = `\n\nThe issue it closes, #${issue}: ${i.title}\n\n${stripComments(i.body ?? '')}`;
  }
  const description = `${body}${issueText}`.trim();
  if (words(`${p.title} ${description}`) < MIN_TASK_WORDS) return { excluded: 'thin-description' };
  return {
    task: {
      key: `${repo}#${p.number}`,
      repo,
      number: p.number,
      title: p.title,
      description,
      linkedIssue: issue,
      parentSha,
      mergedSha: p.merge_commit_sha,
      testFiles: testFiles.map((f) => f.filename),
      codeFiles: codeFiles.map((f) => f.filename),
      codeLines,
      testLines: testFiles.reduce((s, f) => s + f.changes, 0),
      mergedAt: p.merged_at,
    },
  };
}

/** The merged PRs since the window's start, each planned, most recent first. */
export async function planRepo(repo: string, windowStart: string, read: Reader, o: { maxPages?: number } = {}): Promise<RepoPlan> {
  const out: RepoPlan = { repo, tasks: [], excluded: {}, read: 0 };
  for (let page = 1; page <= (o.maxPages ?? 5); page++) {
    const rows: (PullSummary & { updated_at?: string })[] | null = await read(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!rows?.length) break;
    for (const p of rows) {
      if (!p.merged_at || p.merged_at.slice(0, 10) < windowStart) continue;
      out.read++;
      const r = await planPull(repo, p, windowStart, read);
      if ('task' in r) out.tasks.push(r.task);
      else out.excluded[r.excluded] = (out.excluded[r.excluded] ?? 0) + 1;
    }
    if (rows.length < 100 || rows.every((p) => (p.updated_at ?? '').slice(0, 10) < windowStart)) break;
  }
  out.tasks.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
  return out;
}
