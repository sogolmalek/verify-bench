/**
 * Cross-file reach for one shard of the sample (src/reach.ts), in Actions with no secrets and no token: each repository is fetched at
 * the patch's base commit, one commit deep, and searched with `git grep`. Nothing in it runs.
 *   REACH_SHARD, REACH_SHARDS (default 0 of 1), REACH_OUT (default results/reach)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AgentPatch } from '../src/agentPatch.js';
import { callSites, changedExported, filesOf, GLOBS, type Family } from '../src/reach.js';

const SHARD = Number(process.env.REACH_SHARD ?? 0);
const SHARDS = Number(process.env.REACH_SHARDS ?? 1);
const OUT = process.env.REACH_OUT ?? 'results/reach';
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `reach-${SHARD}.jsonl`);
const done = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id) : []);
const sample = JSON.parse(readFileSync('tasks/sample.json', 'utf8')) as { prs: { id: string; repo: string; state: string }[] };
const patches = new Map<string, AgentPatch | null>(gunzipSync(readFileSync('tasks/patches.jsonl.gz')).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((j) => [j.id, j.patch]));
// Merged, with a patch; whole repositories per shard, so each is fetched by one job.
const repos = [...new Set(sample.prs.filter((p) => p.state === 'merged' && patches.get(p.id)).map((p) => p.repo))].sort();
const mine = new Set(repos.filter((_, i) => i % SHARDS === SHARD));
const todo = sample.prs.filter((p) => mine.has(p.repo) && p.state === 'merged' && patches.get(p.id) && !done.has(p.id)).sort((a, b) => a.repo.localeCompare(b.repo));
const git = (cwd: string, args: string[], timeout = 600_000) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0' } });
console.log(JSON.stringify({ shard: SHARD, of: SHARDS, repos: mine.size, prs: todo.length }));

let dir: string | null = null;
let dirRepo = '';
for (const p of todo) {
  const a = patches.get(p.id)!;
  const started = Date.now();
  const fns = changedExported(a.patch);
  const row: Record<string, unknown> = { id: p.id, repo: p.repo, baseSha: a.baseSha, functions: fns.map((f) => `${f.file}:${f.name}`) };
  if (!fns.length) {
    appendFileSync(file, `${JSON.stringify({ ...row, sites: 0, files: 0, perName: {} })}\n`);
    continue;
  }
  if (dirRepo !== p.repo) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'reach-'));
    dirRepo = p.repo;
    git(dir, ['init', '-q']);
    git(dir, ['remote', 'add', 'origin', `https://github.com/${p.repo}.git`]);
  }
  const f = git(dir!, ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', a.baseSha]);
  if (f.status !== 0) {
    appendFileSync(file, `${JSON.stringify({ ...row, error: `fetch: ${(f.stderr || f.error?.message || '').slice(0, 200)}` })}\n`);
    continue;
  }
  const names = [...new Map(fns.map((x) => [`${x.family}\0${x.name}`, { name: x.name, family: x.family as Family }])).values()];
  const globs = [...new Set(names.flatMap((n) => GLOBS[n.family]))];
  const g = git(dir!, ['grep', '-n', '-I', '-w', ...names.flatMap((n) => ['-e', n.name]), a.baseSha, '--', ...globs], 300_000);
  // git grep exits 1 when nothing matches.
  if (g.status !== 0 && g.status !== 1) {
    appendFileSync(file, `${JSON.stringify({ ...row, error: `grep: ${(g.stderr || g.error?.message || '').slice(0, 200)}` })}\n`);
    continue;
  }
  appendFileSync(file, `${JSON.stringify({ ...row, ...callSites(g.stdout ?? '', names, filesOf(a.patch)), seconds: Math.round((Date.now() - started) / 1000) })}\n`);
}
if (dir) rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ shard: SHARD, done: true }));
