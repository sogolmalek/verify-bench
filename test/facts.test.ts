import { describe, expect, it } from 'vitest';
import { addedByFile, closedIssues, isRevertOf, laterBugIssues, removedOf, reopenedAfter, reviewIntensity, survival, touchOf, type LaterCommit } from '../src/facts.js';

const merged = '2026-09-10T00:00:00Z';
const commit = (o: Partial<LaterCommit> = {}): LaterCommit => ({ sha: 's', author: 'ana', message: 'Tidy', date: '2026-09-12T00:00:00Z', files: [], ...o });

describe('what happened after the merge', () => {
  it('follows the agent’s added code lines, five files at most, not tests or docs', () => {
    const files = [
      { filename: 'src/fee.ts', patch: '@@\n+export const fee = (x) => x * 100;\n+a\n-gone' },
      { filename: 'src/fee.test.ts', patch: '+expect(fee(1)).toBe(100);' },
      { filename: 'README.md', patch: '+Fees are in cents now.' },
    ];
    const got = addedByFile(files);
    expect(got.map((f) => f.name)).toEqual(['src/fee.ts']);
    expect([...got[0]!.added]).toEqual(['export const fee = (x) => x * 100;']);
  });
  it('a later commit by someone else that removes the agent’s line, with a fix message and a test, is a strict touch', () => {
    const c = commit({ message: 'fix: fee was in dollars', files: [{ filename: 'src/fee.ts', patch: '-export const fee = (x) => x * 100;\n+export const fee = (x) => x;', additions: 1 }, { filename: 'test/fee.test.ts', additions: 3 }] });
    expect(removedOf(c, 'src/fee.ts', new Set(['export const fee = (x) => x * 100;']))).toHaveLength(1);
    expect(touchOf(c, 'devin-ai-integration[bot]', merged)).toEqual({ byOther: true, fixMessage: true, test: true, days: 2 });
    expect(touchOf(commit({ author: 'Devin-AI-Integration[bot]' }), 'devin-ai-integration[bot]', merged).byOther).toBe(false);
  });
  it('survival counts each removed line once, within its days', () => {
    expect(survival(4, [{ line: 'a', days: 2 }, { line: 'a', days: 3 }, { line: 'b', days: 20 }], 14)).toBe(0.75);
    expect(survival(4, [{ line: 'a', days: 2 }, { line: 'b', days: 20 }], 30)).toBe(0.5);
    expect(survival(0, [], 30)).toBeNull();
  });
  it('reads a revert, closed issues, later bug issues and a reopening in the window', () => {
    expect(isRevertOf('Revert "Add fees" (#12)', { number: 12, title: 'Add fees', mergeSha: null })).toBe(true);
    expect(isRevertOf('Revert unrelated', { number: 12, title: 'Add fees', mergeSha: null })).toBe(false);
    expect(closedIssues('Fixes #41, closes o/r#7 and mentions #9', 'a/b')).toEqual([{ repo: 'a/b', number: 41 }, { repo: 'o/r', number: 7 }]);
    const ev = [
      { event: 'cross-referenced', created_at: '2026-09-15T00:00:00Z', source: { issue: { title: 'Crash on checkout' } } },
      { event: 'cross-referenced', created_at: '2026-09-15T00:00:00Z', source: { issue: { title: 'Docs', labels: [{ name: 'bug' }] } } },
      { event: 'cross-referenced', created_at: '2026-09-15T00:00:00Z', source: { issue: { title: 'Crash', pull_request: {} } } },
      { event: 'cross-referenced', created_at: '2026-11-15T00:00:00Z', source: { issue: { title: 'Crash, later' } } },
    ];
    expect(laterBugIssues(ev, merged)).toBe(2);
    expect(reopenedAfter([{ event: 'reopened', created_at: '2026-09-20T00:00:00Z' }], merged)).toBe(true);
    expect(reopenedAfter([{ event: 'reopened', created_at: '2026-09-01T00:00:00Z' }], merged)).toBe(false);
  });
  it('review intensity is rounds of requested changes and comments', () => {
    expect(reviewIntensity([{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }], { comments: 3, review_comments: 5 })).toEqual({ changeRequestRounds: 2, reviewComments: 5, comments: 3 });
  });
});
