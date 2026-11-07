/**
 * The truth of a patch: the PR's own tests, fail to pass, as SWE-bench (the design, 40.2.1).
 *
 * This runs a repository's code and a model's patch, so it runs only in the sandbox, with no keys. The PR's test files
 * are applied after the patch and replace whatever the patch did to them, so an author can't change the tests it is
 * judged by. The test command must write a JUnit XML report, which vitest and pytest both do.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type TestResults = Map<string, 'pass' | 'fail' | 'skip'>;

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Reads a JUnit XML report into test id (classname::name) and result. A test seen twice fails if either run failed. */
export function parseJunit(xml: string): TestResults {
  const out: TestResults = new Map();
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[1]!;
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const cls = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const body = m[3] ?? '';
    const r: 'pass' | 'fail' | 'skip' = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    const id = unescape(`${cls}::${name}`);
    out.set(id, out.get(id) === 'fail' ? 'fail' : r);
  }
  return out;
}

export type Suite = {
  /** Sets the checkout up: installs dependencies. Run once in each worktree, before the tests. */
  setup?: string;
  /** Runs the tests and writes a JUnit report to the path in $JUNIT_OUT. */
  test: string;
  timeoutMs?: number;
};

export type TruthTask = { key: string; parentSha: string; mergedSha: string; testFiles: readonly string[] };

/** The sets a task's truth rests on, from the parent with the PR's tests and from the merged commit. */
export type Baseline = {
  /** Tests that fail or don't exist at the parent with the PR's tests, and pass at the merge, stably. */
  failToPass: string[];
  /** Tests that pass at both. */
  passToPass: string[];
  /** Tests whose result changed between two runs at the merge: they are in neither set. */
  flaky: string[];
};

const quietEnv = () => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });

async function inWorktree<T>(repoDir: string, sha: string, f: (wt: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-truth-'));
  const wt = join(dir, 'wt');
  try {
    await run('git', ['-C', repoDir, 'worktree', 'add', '--detach', wt, sha], { env: quietEnv() });
    return await f(wt);
  } finally {
    await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', wt], { env: quietEnv() }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

async function runSuite(wt: string, suite: Suite): Promise<TestResults> {
  const junit = join(wt, '.bench-junit.xml');
  const env = { ...quietEnv(), JUNIT_OUT: junit };
  if (suite.setup) await run('sh', ['-c', suite.setup], { cwd: wt, env, timeout: suite.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 });
  await run('sh', ['-c', suite.test], { cwd: wt, env, timeout: suite.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
  try {
    return parseJunit(await readFile(junit, 'utf8'));
  } catch {
    return new Map();
  }
}

async function applyPrTests(wt: string, task: TruthTask): Promise<void> {
  if (task.testFiles.length) await run('git', ['-C', wt, 'checkout', task.mergedSha, '--', ...task.testFiles], { env: quietEnv() });
}

const passing = (r: TestResults) => [...r].filter(([, v]) => v === 'pass').map(([k]) => k);

/** A task's sets. Empty failToPass means the PR's tests can't tell a right patch from a wrong one: the task is excluded. */
export async function baselineOf(repoDir: string, task: TruthTask, suite: Suite): Promise<Baseline> {
  const atParent = await inWorktree(repoDir, task.parentSha, async (wt) => {
    await applyPrTests(wt, task);
    return runSuite(wt, suite);
  });
  const runMerged = () => inWorktree(repoDir, task.mergedSha, (wt) => runSuite(wt, suite));
  const first = await runMerged();
  const second = await runMerged();
  const stable = new Set(passing(first).filter((t) => second.get(t) === 'pass'));
  const flaky = passing(first).filter((t) => second.get(t) !== 'pass').concat(passing(second).filter((t) => first.get(t) !== 'pass'));
  const parentPass = new Set(passing(atParent));
  return { failToPass: [...stable].filter((t) => !parentPass.has(t)).sort(), passToPass: [...stable].filter((t) => parentPass.has(t)).sort(), flaky: [...new Set(flaky)].sort() };
}

export type Truth = { applied: boolean; correct: boolean; detail: string; failed: string[] };

/** A patch's truth. It doesn't apply, or any fail-to-pass or pass-to-pass test doesn't pass: incorrect. */
export async function truthOf(repoDir: string, task: TruthTask, patch: string, suite: Suite, base: Baseline): Promise<Truth> {
  return inWorktree(repoDir, task.parentSha, async (wt) => {
    if (patch.trim()) {
      const file = join(wt, '.bench-patch.diff');
      await writeFile(file, patch);
      try {
        await run('git', ['-C', wt, 'apply', '--whitespace=nowarn', file], { env: quietEnv() });
      } catch {
        return { applied: false, correct: false, detail: 'the patch did not apply', failed: [] };
      } finally {
        await rm(file, { force: true });
      }
    }
    await applyPrTests(wt, task);
    const r = await runSuite(wt, suite);
    const failed = [...base.failToPass, ...base.passToPass].filter((t) => r.get(t) !== 'pass');
    return { applied: true, correct: failed.length === 0, detail: failed.length ? `${failed.length} tests did not pass` : 'every fail-to-pass and pass-to-pass test passed', failed: failed.slice(0, 20) };
  });
}

/**
 * The controls of 40.2.1, run on every task: the empty patch must come out incorrect, and the merged change correct.
 * A task where either fails is excluded, and the count reported.
 */
export async function controlsHold(repoDir: string, task: TruthTask, mergedChange: string, suite: Suite, base: Baseline): Promise<{ ok: boolean; empty: Truth; merged: Truth }> {
  const empty = await truthOf(repoDir, task, '', suite, base);
  const merged = await truthOf(repoDir, task, mergedChange, suite, base);
  return { ok: base.failToPass.length > 0 && !empty.correct && merged.correct, empty, merged };
}
