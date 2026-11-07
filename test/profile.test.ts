import { afterAll, describe, expect, it } from 'vitest';
import { GitTree } from '../src/gitTree.js';
import { HABITS, profileOf, searchTerms, voteProfileOf } from '../src/profile.js';
import { makeRepo } from './fakes.js';

const repo = makeRepo([{ message: 'parent', files: { 'src/money.ts': 'export function roundMoney(x) { return x; }\n'.repeat(50), 'src/other.ts': 'roundMoney used here\n', 'README.md': 'hello\n' } }]);
const task = { repo: 'o/r', parentSha: repo.shas[0]!, title: 'Fix roundMoney for negative amounts', description: 'It rounds the wrong way.' };
const count = (s: string) => Math.ceil(s.length / 4);
afterAll(() => repo.cleanup());

describe('the token profile, counted on real tool results', () => {
  it('picks code-like words from the title first, and skips filler', () => {
    expect(searchTerms('Fix roundMoney for negative amounts', 2)).toEqual(['roundMoney', 'negative']);
    expect(searchTerms('fix: handle `foo.bar` when the value is empty', 1)).toEqual(['foo.bar']);
    expect(searchTerms('a b c', 3)).toEqual([]);
  });
  it('grows the context call by call, reading what the searches found', async () => {
    const p = await profileOf(new GitTree(repo.dir, repo.shas[0]!), task, 'diff --git a/x b/x\n', HABITS[0]!, count);
    for (let i = 1; i < p.contexts.length; i++) expect(p.contexts[i]!).toBeGreaterThan(p.contexts[i - 1]!);
    // The prompt, the file list, one search, and the two files it found.
    expect(p.contexts.length).toBe(5);
    expect(p.contexts.at(-1)!).toBeGreaterThan(count('export function roundMoney(x) { return x; }\n'.repeat(50)));
    expect(p.output).toBeGreaterThan(p.contexts.length * HABITS[0]!.outputPerTurn - 1);
  });
  it('a heavier reader costs more on the same task', async () => {
    const tree = new GitTree(repo.dir, repo.shas[0]!);
    const [light, heavy] = [await profileOf(tree, task, 'x', HABITS[0]!, count), await profileOf(tree, task, 'x', HABITS[1]!, count)];
    expect(heavy.contexts.length).toBeGreaterThanOrEqual(light.contexts.length);
    expect(heavy.output).toBeGreaterThan(light.output);
  });
  it('counts a vote from the task and the patch', () => {
    const small = voteProfileOf(task, 'x', count);
    const big = voteProfileOf(task, 'x'.repeat(4000), count);
    expect(big.input - small.input).toBeGreaterThanOrEqual(999);
    expect(small.output).toBe(400);
  });
});
