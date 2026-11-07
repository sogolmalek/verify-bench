import { describe, expect, it } from 'vitest';
import { conflictsOf, patchFacts } from '../src/decisions.js';
import { REPOS } from '../src/repos.js';
import { globMatch } from '../src/triage.js';

const of = (repo: string) => REPOS.find((r) => r.repo === repo)!;
const change = (file: string, removed: string[], added: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((l) => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${added.map((l) => `+${l}`).join('\n')}\n`;
const fresh = (file: string, added: string[]) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join('\n')}\n`;
const ids = (repo: string, patch: string) => conflictsOf(of(repo).decisions, patch).map((d) => d.id);

describe('patchFacts reads a diff, file by file', () => {
  it('separates added and removed lines from context and from headers', () => {
    const f = patchFacts(['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ' keep', 'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ b/y.ts', '@@ -5 +5 @@', '-a', '+b'].join('\n'));
    expect(f.map((x) => x.path)).toEqual(['x.ts', 'y.ts']);
    expect(f[0]).toMatchObject({ added: ['new'], removed: ['old'], isNew: false, isDeleted: false });
    expect(f[1]).toMatchObject({ added: ['b'], removed: ['a'] });
  });
  it('does not read a +++ or --- inside a hunk as a header', () => {
    const f = patchFacts(['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '---- old rule', '-keep', '+++++ new heading', '+keep'].join('\n'));
    expect(f.length).toBe(1);
    expect(f[0]!.removed).toEqual(['--- old rule', 'keep']);
    expect(f[0]!.added).toEqual(['++++ new heading', 'keep']);
  });
  it('reads a new file, a deleted file and a bare diff', () => {
    expect(patchFacts(fresh('n.ts', ['a']))[0]).toMatchObject({ path: 'n.ts', isNew: true, added: ['a'] });
    expect(patchFacts('--- /dev/null\n+++ b/n.py\n@@ -0,0 +1 @@\n+x\n')[0]).toMatchObject({ path: 'n.py', isNew: true });
    const d = patchFacts('diff --git a/o.ts b/o.ts\ndeleted file mode 100644\n--- a/o.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
    expect(d[0]).toMatchObject({ path: 'o.ts', isDeleted: true, removed: ['x'] });
  });
});

describe('each decision fires on what it says, and not on a neighbour', () => {
  it('zod: no version bump in any package.json', () => {
    expect(ids('colinhacks/zod', change('packages/zod/package.json', ['  "version": "4.1.0",'], ['  "version": "4.1.1",']))).toEqual(['zod-no-version-bump']);
    expect(ids('colinhacks/zod', change('package.json', ['  "name": "a",'], ['  "name": "b",']))).toEqual([]);
    expect(ids('colinhacks/zod', change('packages/zod/src/x.ts', [], ['const version = 1']))).toEqual([]);
  });
  it('zod: a new test file is TypeScript', () => {
    expect(ids('colinhacks/zod', fresh('packages/zod/src/v4/tests/x.test.js', ['x']))).toEqual(['zod-tests-in-typescript']);
    expect(ids('colinhacks/zod', fresh('packages/zod/src/v4/tests/x.test.ts', ['x']))).toEqual([]);
    expect(ids('colinhacks/zod', change('packages/zod/src/v4/tests/x.test.js', ['a'], ['b']))).toEqual([]);
  });
  it('zod: no shared code branching on a schema type', () => {
    expect(ids('colinhacks/zod', change('packages/zod/src/v4/core/util.ts', [], ['if (def.type === "optional") return;']))).toEqual(['zod-no-type-branching']);
    expect(ids('colinhacks/zod', change('packages/zod/src/v4/core/util.ts', ['if (def.type === "optional") return;'], []))).toEqual([]);
    expect(ids('colinhacks/zod', change('packages/other/x.ts', [], ['if (def.type === "x") return;']))).toEqual([]);
  });
  it('pydantic: deprecated functionality stays, by the marks its code uses', () => {
    expect(ids('pydantic/pydantic', change('pydantic/main.py', ["@deprecated('use x', category=PydanticDeprecatedSince20)"], []))).toEqual(['pydantic-keep-deprecated']);
    expect(ids('pydantic/pydantic', change('pydantic/main.py', [], ["@deprecated('use x', category=PydanticDeprecatedSince220)"]))).toEqual([]);
    expect(ids('pydantic/pydantic', change('tests/test_x.py', ['@deprecated("x")'], []))).toEqual([]);
  });
  it('click: no new dependency, no ternary in its source', () => {
    expect(ids('pallets/click', change('pyproject.toml', [], ['    "rich>=13",']))).toEqual(['click-no-new-dependency']);
    expect(ids('pallets/click', change('pyproject.toml', [], ['requires-python = ">=3.10"']))).toEqual([]);
    expect(ids('pallets/click', change('src/click/core.py', [], ['    x = a if cond else b']))).toEqual(['click-no-ternary']);
    expect(ids('pallets/click', change('src/click/core.py', [], ['    if cond:', '        x = a', '    else:', '        x = b']))).toEqual([]);
    expect(ids('pallets/click', change('tests/test_core.py', [], ['    x = a if cond else b']))).toEqual([]);
  });
  it('pytest: a source change needs a changelog entry; a test change does not', () => {
    const src = change('src/_pytest/main.py', ['a'], ['b']);
    expect(ids('pytest-dev/pytest', src)).toEqual(['pytest-changelog-entry']);
    expect(ids('pytest-dev/pytest', `${src}${fresh('changelog/1234.bugfix.rst', ['Fixed it.'])}`)).toEqual([]);
    expect(ids('pytest-dev/pytest', change('testing/test_main.py', ['a'], ['b']))).toEqual([]);
  });
  it('pytest: deprecated functionality stays', () => {
    const out = ids('pytest-dev/pytest', `${change('src/_pytest/deprecated.py', ['X = PytestRemovedIn9Warning("gone")'], [])}${fresh('changelog/1.misc.rst', ['x'])}`);
    expect(out).toEqual(['pytest-keep-deprecated']);
  });
  it('hono has no decisions, and says so', () => {
    expect(of('honojs/hono').decisions).toEqual([]);
    expect(of('honojs/hono').gaps.join()).toMatch(/rule 3 is not tested/);
  });
});

describe('every pattern and decision has a pinned public source', () => {
  it('each source is a GitHub address in that repository, with what it says', () => {
    for (const r of REPOS) {
      for (const s of [...r.riskPatterns.map((x) => x.source), ...r.decisions.map((x) => x.source)]) {
        for (const url of s.url.split(' ')) expect(url.startsWith(`https://github.com/${r.repo}/`), url).toBe(true);
        expect(s.what.length).toBeGreaterThan(5);
      }
    }
  });
  it('a document source is pinned to the commit it was read at, with its line', () => {
    for (const r of REPOS) for (const d of r.decisions) expect(d.source.url).toMatch(new RegExp(`/blob/${r.sourcesAt}/.+#L\\d+$`));
  });
  it('risk patterns match the paths they mean', () => {
    const hono = of('honojs/hono').riskPatterns.map((p) => p.glob);
    const hit = (f: string) => hono.some((g) => globMatch(g, f));
    for (const f of ['src/middleware/jwt/index.ts', 'src/utils/jwt/jws.ts', 'src/adapter/deno/serve-static.ts', 'adapters/bun/src/serve-static.ts', 'src/jsx/components.ts', 'src/hono-base.ts']) expect(hit(f), f).toBe(true);
    for (const f of ['src/middleware/logger/index.ts', 'src/helper/factory/index.ts', 'src/context.ts']) expect(hit(f), f).toBe(false);
    expect(of('pallets/click').riskPatterns).toEqual([]);
    expect(of('pallets/click').gaps.join()).toMatch(/rule 2 does not fire/);
  });
  it('states what is not covered, for every repository lacking a source', () => {
    for (const r of REPOS) if (!r.riskPatterns.length || !r.decisions.length) expect(r.gaps.length, r.repo).toBeGreaterThan(0);
  });
});
