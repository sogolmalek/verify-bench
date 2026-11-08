/**
 * Freezes what the verifiers see: each sampled PR's stripped task and the agent's patch, read once from GitHub, into
 * tasks/patches.jsonl.gz. Public code from public repositories. A PR whose patch can't be read is written as null, and left out for
 * every verifier alike.
 *   GITHUB_TOKEN (read-only)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readAgentPatch, type AgentPatch } from '../src/agentPatch.js';

const OUT = 'tasks/patches.jsonl.gz';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sample = JSON.parse(readFileSync('tasks/sample.json', 'utf8')) as { prs: { id: string; repo: string; number: number }[] };
const have = new Map<string, AgentPatch | null>();
if (existsSync(OUT)) for (const l of gunzipSync(readFileSync(OUT)).toString('utf8').split('\n').filter(Boolean)) { const j = JSON.parse(l); have.set(j.id, j.patch); }
const save = () => writeFileSync(OUT, gzipSync(sample.prs.filter((p) => have.has(p.id)).map((p) => JSON.stringify({ id: p.id, patch: have.get(p.id) })).join('\n') + '\n'));
let n = 0;
for (const p of sample.prs) {
  if (have.has(p.id)) continue;
  let a: AgentPatch | null = null;
  for (let i = 0; i < 3 && a === null; i++) {
    a = await readAgentPatch(p.repo, p.number, { ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) }).catch(() => null);
    if (a === null && i < 2) await pause(3_000 * (i + 1));
  }
  have.set(p.id, a);
  await pause(400);
  if (++n % 50 === 0) {
    save();
    console.log(JSON.stringify({ read: have.size, of: sample.prs.length, unreadable: [...have.values()].filter((x) => x === null).length }));
  }
}
save();
console.log(JSON.stringify({ done: have.size, of: sample.prs.length, unreadable: [...have.values()].filter((x) => x === null).length }));
