/**
 * A token profile counted on a real task, with no model (the design, 40.4): a scripted reader walks the parent commit with the
 * same tools an author gets, and the real tool results are counted. How much a real model reads is unknown until it runs, so
 * this gives a stated, repeatable reading habit to price, beside the caps' worst case. It reads only; it never calls a model.
 */
import { AUTHOR_SYSTEM, authorPrompt, taskText, type AuthorTask } from './author.js';
import type { PatchProfile, VoteProfile } from './estimate.js';
import { AUTHOR_TOOLS, GitTree, runTool } from './gitTree.js';
import { DECIDE_TOOL, VERIFIER_SYSTEM } from './verifier.js';

export type CountTokens = (text: string) => number;

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'when', 'should', 'into', 'not', 'are', 'was', 'fix', 'add', 'feat', 'chore', 'support', 'use', 'update', 'remove', 'make', 'allow']);

/** The words a reader would search for first: the title's longer words, code-like ones first. */
export function searchTerms(title: string, n: number): string[] {
  const words = title.replace(/[`'"(),:;[\]{}]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()) && /^[\w.\-/]+$/.test(w));
  const codeLike = (w: string) => (/[A-Z_.\-/]/.test(w.slice(1)) ? 0 : 1);
  return [...new Set(words)].sort((a, b) => codeLike(a) - codeLike(b)).slice(0, n);
}

export type ReadingHabit = { name: string; searches: number; reads: number; outputPerTurn: number };

export const HABITS: readonly ReadingHabit[] = [
  { name: 'light', searches: 1, reads: 4, outputPerTurn: 100 },
  { name: 'heavy', searches: 3, reads: 10, outputPerTurn: 600 },
];

/**
 * Walks the tree: the file list, some searches, then reads of the files the searches found most often. Each call's input is
 * the whole context so far. The patch's output is the merged change's size, as a stand-in for the size of what the model writes.
 */
export async function profileOf(tree: GitTree, task: AuthorTask, mergedDiff: string, habit: ReadingHabit, count: CountTokens): Promise<PatchProfile> {
  let context = count(AUTHOR_SYSTEM) + count(JSON.stringify(AUTHOR_TOOLS)) + count(authorPrompt(task));
  const contexts = [context];
  const add = (result: string, turnOutput = 60) => {
    context += count(result) + turnOutput;
    contexts.push(context);
  };
  add(await runTool(tree, 'list_files', {}));
  const hits = new Map<string, number>();
  for (const pattern of searchTerms(task.title, habit.searches)) {
    const out = await runTool(tree, 'search', { pattern });
    add(out);
    for (const line of out.split('\n')) {
      const f = line.split(':')[0]!;
      if (f && !f.startsWith('[') && f !== 'no matches') hits.set(f, (hits.get(f) ?? 0) + 1);
    }
  }
  const files = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, habit.reads);
  for (const path of files) add(await runTool(tree, 'read_file', { path }));
  return { contexts, output: count(mergedDiff) + contexts.length * habit.outputPerTurn };
}

/** A vote's input: the verifier's system prompt, its tool, the task and the patch; the output is its decision and reason. */
export function voteProfileOf(task: AuthorTask, patch: string, count: CountTokens, output = 400): VoteProfile {
  return { input: count(VERIFIER_SYSTEM) + count(JSON.stringify(DECIDE_TOOL)) + count(taskText(task)) + count(patch) + 40, output };
}
