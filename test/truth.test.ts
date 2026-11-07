import { afterAll, describe, expect, it } from 'vitest';
import { baselineOf, controlsHold, parseJunit, truthOf, type Suite } from '../src/truth.js';
import { makeRepo } from './fakes.js';

/** A real throwaway repository whose "suite" is a small shell script writing a JUnit report: no third-party code runs here. */
const RUN_TESTS = `#!/bin/sh
# Reads src/value and test/expected.* and reports each as a test.
{
  echo '<testsuites><testsuite>'
  for f in test/expected.*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ "$(cat src/value 2>/dev/null)" = "$(cat "$f")" ]; then
      echo "<testcase classname=\\"suite\\" name=\\"$name\\"/>"
    else
      echo "<testcase classname=\\"suite\\" name=\\"$name\\"><failure>no</failure></testcase>"
    fi
  done
  echo "<testcase classname=\\"suite\\" name=\\"always\\"/>"
  [ -f src/keep ] && echo "<testcase classname=\\"suite\\" name=\\"keeps\\"/>" || echo "<testcase classname=\\"suite\\" name=\\"keeps\\"><failure>gone</failure></testcase>"
  echo '</testsuite></testsuites>'
} > "$JUNIT_OUT"
`;
const suite: Suite = { test: 'sh run-tests.sh' };
const repo = makeRepo([
  { message: 'parent', files: { 'run-tests.sh': RUN_TESTS, 'src/value': '1\n', 'src/keep': 'k\n' } },
  { message: 'the PR', files: { 'src/value': '2\n', 'test/expected.value': '2\n' } },
]);
const [parentSha, mergedSha] = repo.shas as [string, string];
const task = { key: 'o/r#1', parentSha, mergedSha, testFiles: ['test/expected.value'] };
const fix = '--- a/src/value\n+++ b/src/value\n@@ -1 +1 @@\n-1\n+2\n';
const wrong = '--- a/src/value\n+++ b/src/value\n@@ -1 +1 @@\n-1\n+3\n';
const breaks = 'diff --git a/src/keep b/src/keep\ndeleted file mode 100644\n--- a/src/keep\n+++ /dev/null\n@@ -1 +0,0 @@\n-k\n--- a/src/value\n+++ b/src/value\n@@ -1 +1 @@\n-1\n+2\n';
const noApply = '--- a/src/value\n+++ b/src/value\n@@ -1 +1 @@\n-999\n+2\n';
afterAll(() => repo.cleanup());

describe('parseJunit', () => {
  it('reads pass, fail, skip and error, and a test seen twice fails if either failed', () => {
    const r = parseJunit('<testsuite><testcase classname="a" name="p"/><testcase classname="a" name="f"><failure/></testcase><testcase classname="a" name="e"><error/></testcase><testcase classname="a" name="s"><skipped/></testcase><testcase classname="a" name="t &amp; u"></testcase><testcase classname="a" name="p"><failure/></testcase></testsuite>');
    expect(r.get('a::f')).toBe('fail');
    expect(r.get('a::e')).toBe('fail');
    expect(r.get('a::s')).toBe('skip');
    expect(r.get('a::t & u')).toBe('pass');
    expect(r.get('a::p')).toBe('fail');
  });
});

describe('the truth: the PR\'s own tests, fail to pass, in a real git repository', () => {
  it('finds fail-to-pass and pass-to-pass from the parent with the PR\'s tests and the merge', async () => {
    const b = await baselineOf(repo.dir, task, suite);
    expect(b.failToPass).toEqual(['suite::expected.value']);
    expect(b.passToPass).toEqual(['suite::always', 'suite::keeps']);
    expect(b.flaky).toEqual([]);
  });
  it('the merged change comes out correct and the empty patch incorrect (the controls)', async () => {
    const b = await baselineOf(repo.dir, task, suite);
    const c = await controlsHold(repo.dir, task, fix, suite, b);
    expect(c.ok).toBe(true);
    expect(c.merged.correct).toBe(true);
    expect(c.empty.correct).toBe(false);
  });
  it('a wrong value, a broken passing test, and a patch that does not apply are each incorrect', async () => {
    const b = await baselineOf(repo.dir, task, suite);
    expect(await truthOf(repo.dir, task, wrong, suite, b)).toMatchObject({ applied: true, correct: false, failed: ['suite::expected.value'] });
    expect(await truthOf(repo.dir, task, breaks, suite, b)).toMatchObject({ applied: true, correct: false, failed: ['suite::keeps'] });
    expect(await truthOf(repo.dir, task, noApply, suite, b)).toMatchObject({ applied: false, correct: false });
  });
  it('an author can\'t pass by rewriting the PR\'s test: the PR\'s file replaces it', async () => {
    const b = await baselineOf(repo.dir, task, suite);
    const cheats = 'diff --git a/test/expected.value b/test/expected.value\nnew file mode 100644\n--- /dev/null\n+++ b/test/expected.value\n@@ -0,0 +1 @@\n+1\n';
    expect(await truthOf(repo.dir, task, cheats, suite, b)).toMatchObject({ applied: true, correct: false });
  });
  it('a task whose tests already pass at the parent has no fail-to-pass, and is excluded by the controls', async () => {
    const noSignal = makeRepo([
      { message: 'parent', files: { 'run-tests.sh': RUN_TESTS, 'src/value': '2\n', 'src/keep': 'k\n' } },
      { message: 'the PR', files: { 'test/expected.value': '2\n', 'src/other': 'x\n' } },
    ]);
    const t = { key: 'o/r#2', parentSha: noSignal.shas[0]!, mergedSha: noSignal.shas[1]!, testFiles: ['test/expected.value'] };
    const b = await baselineOf(noSignal.dir, t, suite);
    expect(b.failToPass).toEqual([]);
    expect((await controlsHold(noSignal.dir, t, '', suite, b)).ok).toBe(false);
    noSignal.cleanup();
  });
  it('a test whose result changes between two runs at the merge is flaky, and in neither set', async () => {
    const flakySuite: Suite = { test: `sh run-tests.sh && if [ -f /tmp/bench-flaky-$$ ]; then :; fi; n=$(cat "${repo.dir}/.git/flaky-count" 2>/dev/null || echo 0); echo $((n+1)) > "${repo.dir}/.git/flaky-count"; if [ $((n%3)) = 1 ]; then sed -i.bak 's/name="always"/name="always"><failure\\/><\\/testcase><testcase name="z"/' "$JUNIT_OUT"; fi` };
    const b = await baselineOf(repo.dir, task, flakySuite);
    expect(b.passToPass).not.toContain('suite::always');
    expect(b.flaky).toContain('suite::always');
  });
  it('gives the test command no key from this process', async () => {
    process.env.BENCH_SECRET_FOR_TEST = 'must-not-reach-the-suite';
    const leak: Suite = { test: 'printf "<testsuite><testcase classname=\\"env\\" name=\\"%s\\"/></testsuite>" "${BENCH_SECRET_FOR_TEST:-clean}" > "$JUNIT_OUT"' };
    const single = await truthOf(repo.dir, task, fix, leak, { failToPass: ['env::clean'], passToPass: [], flaky: [] });
    expect(single.correct).toBe(true);
    delete process.env.BENCH_SECRET_FOR_TEST;
  });
});
