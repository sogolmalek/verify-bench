import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AUTHOR_SYSTEM, authorPrompt, DEFAULT_CAPS, extractPatch, LAST_CALL, MAX_DESCRIPTION_CHARS, worstCaseInputTokens, writePatch } from '../src/author.js';
import { anthropicClient, openaiClient } from '../src/clients.js';
import { GitTree, runTool, safePath, TREE_LIMITS } from '../src/gitTree.js';
import { fakeProvider, makeRepo } from './fakes.js';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';
const repo = makeRepo([
  { message: 'old', files: { 'src/a.ts': 'export const a = 1;\n', 'docs/readme.md': 'hello\nworld\n', 'bin.dat': 'a\0b' }, symlinks: { 'escape.txt': '/etc/hosts' } },
  { message: 'the PR', files: { 'src/a.ts': 'export const a = 2;\n', 'test/hidden.test.ts': 'the PR test, must stay hidden\n' } },
]);
const [parent, merged] = repo.shas as [string, string];
const task = { repo: 'o/r', parentSha: parent, title: 'Make a two', description: 'a should be 2' };
afterAll(() => repo.cleanup());

describe('the read-only tools read the parent commit and nothing else', () => {
  const tree = new GitTree(repo.dir, parent);
  it('lists, reads with line numbers, and searches at that commit', async () => {
    expect(await tree.list()).toContain('src/a.ts');
    expect(await tree.read('src/a.ts')).toContain('1: export const a = 1;');
    expect(await tree.search('const a')).toContain('src/a.ts:1:export const a = 1;');
    expect(await tree.search('nothing-like-this')).toBe('no matches');
  });
  it('hides what the PR added or changed, even though the clone has the later commit', async () => {
    expect(await tree.list()).not.toContain('hidden.test');
    expect(await runTool(tree, 'read_file', { path: 'test/hidden.test.ts' })).toMatch(/tool error/);
    expect(await tree.search('must stay hidden')).toBe('no matches');
    expect(await tree.read('src/a.ts')).not.toContain('= 2');
    expect(await new GitTree(repo.dir, merged).read('src/a.ts')).toContain('= 2');
  });
  it('refuses a path that leaves the tree, and pathspec magic, before git sees it', () => {
    for (const p of ['../secret', '/etc/passwd', 'src/../../x', ':(glob)**', '.git/config', 'a/.git/x', 'x\0y']) expect(() => safePath(p)).toThrow(/refused/);
    expect(safePath('./src/')).toBe('src');
    expect(safePath(undefined)).toBe('');
  });
  it('gives a symlink as its text, and never follows it to the host', async () => {
    const out = await tree.read('escape.txt');
    expect(out).toContain('/etc/hosts');
    expect(out).not.toContain('localhost');
  });
  it('sends a refusal back to the model as text, and never throws', async () => {
    expect(await runTool(tree, 'read_file', { path: '../../.env' })).toMatch(/^refused path/);
    expect(await runTool(tree, 'run_tests', {})).toMatch(/unknown tool/);
    expect(await runTool(tree, 'search', { pattern: '' })).toMatch(/needs a pattern/);
    expect(await runTool(tree, 'search', { pattern: '(' })).toMatch(/tool error/);
  });
  it('refuses a binary file and caps what a read returns', async () => {
    expect(await tree.read('bin.dat')).toMatch(/binary/);
    const big = makeRepo([{ message: 'big', files: { 'big.txt': Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') } }]);
    const out = await new GitTree(big.dir, big.shas[0]!).read('big.txt');
    expect(out.split('\n').length).toBeLessThan(TREE_LIMITS.readLines + 3);
    expect(out).toMatch(/more lines; ask for lines from 401/);
    big.cleanup();
  });
  it('passes no key to git: the subprocess environment is minimal', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'must-not-reach-a-subprocess';
    const source = readFileSync(fileURLToPath(new URL('../src/gitTree.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/const env = \{ PATH:/);
    expect(source).not.toMatch(/\.\.\.process\.env/);
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  });
});

describe('the prompt carries the task and nothing from the PR', () => {
  it('has the title, description and commit, and no diff or test', () => {
    const p = authorPrompt(task);
    expect(p).toContain('Make a two');
    expect(p).toContain(parent);
    expect(p).not.toMatch(/diff --git|hidden\.test/);
    expect(AUTHOR_SYSTEM).toMatch(/one unified diff/);
  });
  it('cuts a very long description, and says so', () => {
    const p = authorPrompt({ ...task, description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 500) });
    expect(p.length).toBeLessThan(MAX_DESCRIPTION_CHARS + 200);
    expect(p).toContain('[description cut]');
  });
});

describe('the harness, against a fake provider in each shape', () => {
  const tree = new GitTree(repo.dir, parent);
  const clients = {
    anthropic: (f: typeof fetch) => anthropicClient({ baseUrl: 'https://fake.test/v1', model: 'm', apiKey: 'sk-test-key', fetch: f }),
    openai: (f: typeof fetch) => openaiClient({ baseUrl: 'https://fake.test/v1', model: 'm', apiKey: 'sk-test-key', fetch: f }),
  };
  for (const shape of ['anthropic', 'openai'] as const) {
    it(`${shape}: reads with tools over turns, then returns the diff, with the usage summed`, async () => {
      const p = fakeProvider(shape, (_b, i) => (i === 0 ? { tools: [{ name: 'list_files', args: {} }, { name: 'read_file', args: { path: 'src/a.ts' } }] } : { text: `\`\`\`diff\n${DIFF}\`\`\``, input: 200, output: 50 }));
      const r = await writePatch(clients[shape](p.fetch), tree, task);
      expect(r.status).toBe('patch');
      expect(r.patch).toContain('+export const a = 2;');
      expect(r.toolCalls).toBe(2);
      expect(r.turns).toBe(2);
      expect(r.usage).toMatchObject({ input: 300, output: 60 });
      expect(r.trace.map((t) => t.name)).toEqual(['list_files', 'read_file']);
      // The second request carries the tools' real results back to the model.
      const second = JSON.stringify(p.requests[1]!.body.messages);
      expect(second).toContain('src/a.ts');
      expect(second).toContain('export const a = 1;');
    });
  }
  it('sends a key only in a header, never in the body or the address', async () => {
    const p = fakeProvider('anthropic', () => ({ text: DIFF }));
    await writePatch(clients.anthropic(p.fetch), tree, task);
    expect(JSON.stringify(p.requests[0]!.body)).not.toContain('sk-test-key');
    expect(p.requests[0]!.url).not.toContain('sk-test-key');
    expect(p.requests[0]!.headers['x-api-key']).toBe('sk-test-key');
  });
  it('stops reading at the tool-call cap, then asks for the diff once with no tools', async () => {
    const p = fakeProvider('openai', (b) => (b.tools ? { tools: [{ name: 'list_files', args: {} }] } : { text: DIFF }));
    const r = await writePatch(clients.openai(p.fetch), tree, task, { ...DEFAULT_CAPS, maxToolCalls: 3 });
    expect(r.toolCalls).toBe(3);
    expect(r.capHit).toBe('tool-calls');
    expect(r.status).toBe('patch');
    expect(p.requests.at(-1)!.body.tools).toBeUndefined();
    expect(JSON.stringify(p.requests.at(-1)!.body.messages)).toContain(LAST_CALL);
    expect(p.requests.length).toBe(4);
  });
  it('runs no tool past the cap when a model asks for many in one turn, and still answers each', async () => {
    const many = Array.from({ length: 10 }, () => ({ name: 'list_files', args: {} }));
    const p = fakeProvider('anthropic', (b) => (b.tools ? { tools: many } : { text: DIFF }));
    const r = await writePatch(clients.anthropic(p.fetch), tree, task, { ...DEFAULT_CAPS, maxToolCalls: 3 });
    expect(r.toolCalls).toBe(3);
    expect(r.trace.length).toBe(3);
    const results = JSON.stringify(p.requests[1]!.body.messages);
    expect(results.match(/refused: the budget/g)?.length).toBe(7);
    expect(results.match(/tool_result/g)?.length).toBe(10);
  });
  it('the reservation is a true upper bound: a model reading the largest files in one turn stays under it', async () => {
    const huge = makeRepo([{ message: 'huge', files: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, 'x'.repeat(40_000)])) }]);
    const t2 = new GitTree(huge.dir, huge.shas[0]!);
    const reads = Array.from({ length: 15 }, (_, i) => ({ name: 'read_file', args: { path: `f${i}.txt` } }));
    // A provider that counts every character of the context as 0.4 tokens, as dense as the bound assumes.
    const p = fakeProvider('openai', (b) => {
      const input = Math.ceil(JSON.stringify(b.messages).length / 2.5);
      return b.tools ? { tools: reads, input, output: 100 } : { text: DIFF, input, output: 100 };
    });
    const r = await writePatch(clients.openai(p.fetch), t2, task);
    expect(r.usage.input).toBeLessThan(worstCaseInputTokens(DEFAULT_CAPS));
    huge.cleanup();
  });
  it('asks for caching in the tool loop, and counts cache reads and writes from the provider', async () => {
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(JSON.stringify(body.messages)).toContain('cache_control');
      return Response.json({ id: 'm', model: 'm', content: [{ type: 'text', text: DIFF }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } });
    }) as unknown as typeof fetch;
    const r = await writePatch(anthropicClient({ baseUrl: 'https://fake.test/v1', model: 'm', apiKey: 'k', fetch: f }), tree, task);
    expect(r.usage).toEqual({ input: 130, output: 5, cachedInput: 100, cacheWrite: 20 });
  });
  it('stops at the input-token cap, as the provider reports tokens', async () => {
    const p = fakeProvider('anthropic', (b) => (b.tools ? { tools: [{ name: 'list_files', args: {} }], input: 60_000 } : { text: DIFF, input: 60_000 }));
    const r = await writePatch(clients.anthropic(p.fetch), tree, task, { ...DEFAULT_CAPS, maxInputTokens: 100_000 });
    expect(r.capHit).toBe('input-tokens');
    expect(r.usage.input).toBeLessThanOrEqual(180_000);
  });
  it('never asks for more output than the cap leaves', async () => {
    const p = fakeProvider('openai', (b) => (b.tools ? { tools: [{ name: 'list_files', args: {} }], output: 900 } : { text: DIFF }));
    await writePatch(clients.openai(p.fetch), tree, task, { ...DEFAULT_CAPS, maxOutputTokens: 1_000, maxTokensPerCall: 800 });
    expect(p.requests[0]!.body.max_tokens).toBe(800);
    expect(p.requests[1]!.body.max_tokens).toBe(100);
  });
  it('an answer with no diff is no patch, not a retry', async () => {
    const p = fakeProvider('anthropic', () => ({ text: 'I could not do this.' }));
    const r = await writePatch(clients.anthropic(p.fetch), tree, task);
    expect(r).toMatchObject({ status: 'no-diff', patch: null });
    expect(p.requests.length).toBe(1);
  });
  it('retries a failed call once, then records the error by its status alone', async () => {
    const p = fakeProvider('openai', () => ({ status: 503 }));
    const r = await writePatch(clients.openai(p.fetch), tree, task);
    expect(r).toMatchObject({ status: 'error', error: 'HTTP 503', patch: null });
    expect(p.requests.length).toBe(2);
    const once = fakeProvider('openai', (_b, i) => (i === 0 ? { status: 500 } : { text: DIFF }));
    expect((await writePatch(clients.openai(once.fetch), tree, task)).status).toBe('patch');
  });
  it('a model trying to leave the tree gets a refusal and carries on', async () => {
    const p = fakeProvider('openai', (_b, i) => (i === 0 ? { tools: [{ name: 'read_file', args: { path: '../../../.env' } }] } : { text: DIFF }));
    const r = await writePatch(clients.openai(p.fetch), tree, task);
    expect(r.status).toBe('patch');
    expect(JSON.stringify(p.requests[1]!.body.messages)).toContain('refused path');
  });
});

describe('extractPatch', () => {
  it('finds a fenced diff, a bare diff, or none', () => {
    expect(extractPatch('Here:\n```diff\n--- a/x\n+++ b/x\n```\nDone')).toBe('--- a/x\n+++ b/x\n');
    expect(extractPatch('text\ndiff --git a/x b/x\n--- a/x\n')).toBe('diff --git a/x b/x\n--- a/x\n');
    expect(extractPatch('no diff here')).toBeNull();
  });
});

describe('the bench stands alone, so it can move to its own repository', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  it('imports nothing from the closed engine, and no third-party package', () => {
    for (const f of readdirSync(src)) {
      const full = join(src, f);
      if (!statSync(full).isFile()) continue;
      const imports = [...readFileSync(full, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).toMatch(/^(\.\/|node:)/);
    }
  });
});
