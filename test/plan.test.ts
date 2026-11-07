import { describe, expect, it } from 'vitest';
import { closedIssue, isCodeFile, isTestFile, MIN_TASK_WORDS, planPull, planRepo, SIZE_LIMIT_CODE_LINES, type PullSummary } from '../src/plan.js';

const LONG = 'Handle the empty string when parsing a header value, so the parser returns null rather than throwing an error at runtime.';
const pull = (o: Partial<PullSummary> = {}): PullSummary => ({ number: 7, title: 'Fix the parser', body: LONG, merged_at: '2026-10-30T10:00:00Z', merge_commit_sha: 'abc123', user: { login: 'someone', type: 'User' }, ...o });
const files = [{ filename: 'src/a.ts', changes: 20 }, { filename: 'test/a.test.ts', changes: 10 }, { filename: 'docs/a.md', changes: 3 }];
const commit = (fs = files) => ({ parents: [{ sha: 'parent1' }], files: fs });
const reader = (over: Record<string, unknown> = {}) => async (path: string) => {
  if (path in over) return over[path];
  if (/\/pulls\/\d+\/files/.test(path)) return files;
  if (/\/commits\//.test(path)) return commit();
  if (/\/issues\//.test(path)) return { title: 'Parser throws', body: 'It throws on an empty header. <!-- hidden --> Steps below.' };
  return null;
};

describe('which files are tests and code', () => {
  it('reads both languages\' test layouts', () => {
    for (const f of ['test/a.ts', 'tests/test_a.py', 'src/a.test.ts', 'src/__tests__/a.tsx', 'testing/test_b.py', 'pkg/a_test.py', 'conftest.py', 'src/x.spec.js', 'src/types.test-d.ts']) expect(isTestFile(f), f).toBe(true);
    for (const f of ['src/a.ts', 'src/contest.py', 'src/latest.ts', 'attestation.py']) expect(isTestFile(f), f).toBe(false);
  });
  it('doesn\'t count docs, CI, changelogs or lockfiles as code', () => {
    for (const f of ['README.md', 'docs/x.ts', '.github/workflows/a.yml', 'changelog.d/1.md', 'pnpm-lock.yaml', 'uv.lock', 'CHANGELOG.rst', 'test/a.ts']) expect(isCodeFile(f), f).toBe(false);
    for (const f of ['src/a.ts', 'pyproject.toml', 'package.json']) expect(isCodeFile(f), f).toBe(true);
  });
});

describe('planPull: a task, or the reason it isn\'t one', () => {
  it('keeps a PR with code and tests, from its true parent, without its docs', async () => {
    const r = await planPull('o/r', pull(), '2026-10-27', reader());
    expect(r).toMatchObject({ task: { key: 'o/r#7', parentSha: 'parent1', mergedSha: 'abc123', testFiles: ['test/a.test.ts'], codeFiles: ['src/a.ts'], codeLines: 20, testLines: 10 } });
  });
  it('excludes each case, by name', async () => {
    const expectOut = async (p: Partial<PullSummary>, over: Record<string, unknown>, why: string) => expect(await planPull('o/r', pull(p), '2026-10-27', reader(over))).toEqual({ excluded: why });
    const f = 'repos/o/r/pulls/7/files?per_page=100';
    await expectOut({ merged_at: '2026-10-26T23:00:00Z' }, {}, 'before-window');
    await expectOut({ merged_at: null }, {}, 'before-window');
    await expectOut({ user: { login: 'renovate[bot]', type: 'Bot' } }, {}, 'bot');
    await expectOut({ user: { login: 'dependabot-preview', type: 'User' } }, {}, 'bot');
    await expectOut({}, { [f]: [{ filename: 'src/a.ts', changes: 5 }] }, 'no-tests');
    await expectOut({}, { [f]: [{ filename: 'test/a.ts', changes: 5 }, { filename: 'README.md', changes: 2 }] }, 'no-code');
    await expectOut({}, { [f]: [{ filename: 'src/a.ts', changes: SIZE_LIMIT_CODE_LINES + 1 }, { filename: 'test/a.ts', changes: 5 }] }, 'too-large');
    await expectOut({}, { [f]: null }, 'unreadable');
    await expectOut({ title: 'Fix', body: 'small fix' }, {}, 'thin-description');
    await expectOut({}, { 'repos/o/r/commits/abc123': commit([{ filename: 'src/a.ts', changes: 20 }]) }, 'not-one-commit');
  });
  it('the size limit counts code lines, not test lines', async () => {
    const f = 'repos/o/r/pulls/7/files?per_page=100';
    const big = [{ filename: 'src/a.ts', changes: SIZE_LIMIT_CODE_LINES }, { filename: 'test/a.ts', changes: 5_000 }];
    expect(await planPull('o/r', pull(), '2026-10-27', reader({ [f]: big, 'repos/o/r/commits/abc123': commit(big) }))).toHaveProperty('task');
  });
  it('adds the issue it closes, drops HTML comments, and a thin PR with a full issue passes', async () => {
    const r: any = await planPull('o/r', pull({ title: 'Fix', body: '<!-- template --> Fixes #12' }), '2026-10-27', reader({ 'repos/o/r/issues/12': { title: 'Parser throws on an empty header value', body: LONG } }));
    expect(r.task.linkedIssue).toBe(12);
    expect(r.task.description).toContain('The issue it closes, #12: Parser throws');
    expect(r.task.description).not.toContain('template');
    expect(MIN_TASK_WORDS).toBeGreaterThan(5);
  });
  it('gives no task any test content or diff, only file names', async () => {
    const r: any = await planPull('o/r', pull(), '2026-10-27', reader());
    expect(JSON.stringify(r.task)).not.toMatch(/@@|expect\(/);
  });
  it('reads a closing reference, and not a passing mention', () => {
    expect(closedIssue('Fixes #12')).toBe(12);
    expect(closedIssue('closes: #9')).toBe(9);
    expect(closedIssue('resolved #3')).toBe(3);
    expect(closedIssue('see #12 for context')).toBeNull();
    expect(closedIssue(null)).toBeNull();
  });
});

describe('planRepo', () => {
  it('walks the merged PRs in the window, counts every exclusion, most recent first', async () => {
    const rows = [
      { ...pull({ number: 1, merged_at: '2026-10-28T00:00:00Z' }), updated_at: '2026-11-01' },
      { ...pull({ number: 2, merged_at: '2026-11-02T00:00:00Z', merge_commit_sha: 'def' }), updated_at: '2026-11-02' },
      { ...pull({ number: 3, user: { type: 'Bot', login: 'x' } }), updated_at: '2026-11-03' },
      { ...pull({ number: 4, merged_at: null }), updated_at: '2026-11-03' },
      { ...pull({ number: 5, merged_at: '2026-10-01T00:00:00Z' }), updated_at: '2026-11-03' },
    ];
    const p = await planRepo('o/r', '2026-10-27', async (path) => {
      if (path.includes('/pulls?')) return rows;
      if (/\/pulls\/\d+\/files/.test(path)) return files;
      if (/\/commits\//.test(path)) return commit();
      return null;
    });
    expect(p.tasks.map((t) => t.number)).toEqual([2, 1]);
    expect(p.excluded).toEqual({ bot: 1 });
    expect(p.read).toBe(3);
  });
});
