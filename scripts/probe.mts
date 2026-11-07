/**
 * The probe (PREREGISTRATION.md): 30 PRs held out of the sample, on the three open-weight models, one Nosana deployment after another. It
 * reports seconds per vote and the credits spent, then stops. Each deployment has a 60-minute timeout, which caps its bill, and stops as soon
 * as its votes are in. It stops everything if the credits spent reach the cap. No key is ever logged.
 *   NOSANA_API_KEY, GITHUB_TOKEN (optional), PROBE_CAP_CREDITS (default 2)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openaiClient } from '../src/clients.js';
import { AGENT_VERIFIERS } from '../src/agentPrs.js';
import { readAgentPatch, type AgentPatch } from '../src/agentPatch.js';
import { askRanker } from '../src/rankVerifier.js';

const API = 'https://api.nosana.com';
const KEY = process.env.NOSANA_API_KEY;
if (!KEY) throw new Error('NOSANA_API_KEY is not set');
const CAP = Number(process.env.PROBE_CAP_CREDITS ?? 2);
const TIMEOUT_MINUTES = 60;
const START_WAIT_MS = 25 * 60_000;
const VOTES_DEADLINE_MS = 50 * 60_000;
const OUT = process.env.PROBE_OUT ?? 'results';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string, o: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...o }));

async function nosana(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      const t = await r.text();
      if (r.ok) return t ? JSON.parse(t) : {};
      last = `${method} ${path}: HTTP ${r.status} ${t.slice(0, 200)}`;
      if (r.status < 500) break;
    } catch (err) {
      last = `${method} ${path}: ${(err as Error).message}`;
    }
    await pause(5_000 * (i + 1));
  }
  throw new Error(last);
}
const balance = async () => {
  const b = await nosana('GET', '/api/credits/balance');
  return { assigned: Number(b.assignedCredits ?? b.assigned ?? 0), reserved: Number(b.reservedCredits ?? b.reserved ?? 0), settled: Number(b.settledCredits ?? b.settled ?? 0), raw: b };
};

const jobDefinition = (model: string) => ({
  version: '0.1',
  type: 'container',
  global: { variables: { MODEL: model } },
  ops: [{ id: 'server', type: 'container/run', args: { gpu: true, image: 'docker.io/ollama/ollama:0.35.1', env: { OLLAMA_CONTEXT_LENGTH: '32768' }, expose: [{ port: 11434, health_checks: [{ type: 'http', path: '/api/tags', method: 'GET', expected_status: 200, continuous: false }] }], resources: [{ type: 'Ollama', model: '%%global.variables.MODEL%%' }] } }],
  meta: { trigger: 'api', system_requirements: { vram_total_mb: 22000 } },
});

const prs = (JSON.parse(readFileSync('tasks/probe.json', 'utf8')) as { prs: { agent: string; repo: string; number: number; heldOutAs: string; lines: number }[] }).prs;
mkdirSync(OUT, { recursive: true });
const before = await balance();
log('balance before', { assigned: before.assigned, reserved: before.reserved, settled: before.settled });
const spentNow = async () => {
  const b = await balance();
  return b.settled + b.reserved - (before.settled + before.reserved);
};

// The patches first, with no deployment running.
const patches = new Map<string, AgentPatch>();
for (const p of prs) {
  const a = await readAgentPatch(p.repo, p.number, { ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) });
  if (a) patches.set(`${p.repo}#${p.number}`, a);
  else log('no patch', { pr: `${p.repo}#${p.number}` });
}
log('patches read', { read: patches.size, of: prs.length });
if (!patches.size) throw new Error('no patches to vote on');

const market = process.env.PROBE_MARKET ?? ((await nosana('GET', '/api/markets/')) as { slug?: string; address: string; name: string; type: string }[]).find((m) => /3090/.test(`${m.slug} ${m.name}`) && m.type === 'PREMIUM')?.address;
if (!market) throw new Error('no 3090 market');
const created: string[] = [];
const stopAll = async () => {
  for (const id of created) await nosana('POST', `/api/deployments/${id}/stop`).catch((e: Error) => log('stop failed', { id, error: e.message }));
};
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => void stopAll().finally(() => process.exit(1)));

const models: { verifier: string; model: string; status: string; startupSeconds: number | null; votes: number; missing: number; secondsPerVote: number | null; medianSeconds: number | null; maxSeconds: number | null; inputTokens: number; outputTokens: number; deployedMinutes: number | null }[] = [];
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

try {
  for (const v of AGENT_VERIFIERS.filter((x) => x.group === 'open-weight')) {
    const spent = await spentNow();
    if (spent + (0.192 * TIMEOUT_MINUTES) / 60 > CAP) {
      log('stopping: the next deployment could pass the cap', { spent, cap: CAP });
      models.push({ verifier: v.id, model: v.model, status: 'not run: the cap', startupSeconds: null, votes: 0, missing: 0, secondsPerVote: null, medianSeconds: null, maxSeconds: null, inputTokens: 0, outputTokens: 0, deployedMinutes: null });
      continue;
    }
    const t0 = Date.now();
    const d = await nosana('POST', '/api/deployments/create', { name: `bench-probe-${v.id.replace(/[^a-z0-9]+/gi, '-')}`, market, replicas: 1, timeout: TIMEOUT_MINUTES, strategy: 'SIMPLE', job_definition: jobDefinition(v.model) });
    created.push(d.id);
    log('deployment created', { verifier: v.id, id: d.id, status: d.status });
    await nosana('POST', `/api/deployments/${d.id}/start`);
    let url: string | null = null;
    let status = 'STARTING';
    while (Date.now() - t0 < START_WAIT_MS) {
      await pause(20_000);
      const cur = await nosana('GET', `/api/deployments/${d.id}`).catch(() => null);
      if (!cur) continue;
      status = cur.status;
      const ep = (cur.endpoints ?? []).find((e: { url?: string }) => e.url)?.url as string | undefined;
      if (['ERROR', 'INSUFFICIENT_FUNDS', 'STOPPED', 'ARCHIVED'].includes(status)) break;
      if (status === 'RUNNING' && ep) {
        const tags = await fetch(`${ep.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { models?: { name: string }[] } | null;
        if (tags?.models?.some((m) => m.name === v.model || m.name.startsWith(v.model.split(':')[0]!))) {
          url = ep.replace(/\/+$/, '');
          break;
        }
      }
    }
    const startupSeconds = url ? (Date.now() - t0) / 1000 : null;
    log('deployment ready?', { verifier: v.id, ready: !!url, status, startupSeconds });
    const seconds: number[] = [];
    let missing = 0;
    let input = 0;
    let output = 0;
    if (url) {
      const client = openaiClient({ baseUrl: `${url}/v1`, model: v.model, apiKey: 'none', timeoutMs: 300_000 });
      const voteStart = Date.now();
      for (const p of prs) {
        const a = patches.get(`${p.repo}#${p.number}`);
        if (!a) continue;
        if (Date.now() - voteStart > VOTES_DEADLINE_MS) {
          log('out of time on this deployment', { verifier: v.id, votes: seconds.length });
          break;
        }
        const r = await askRanker(client, p.repo, a.task, a.patch);
        seconds.push(r.seconds);
        input += r.usage.input;
        output += r.usage.output;
        if (r.vote === null) missing++;
        appendFileSync(`${OUT}/probe-votes.jsonl`, `${JSON.stringify({ verifier: v.id, vendor: v.vendor, agent: p.agent, pr: `${p.repo}#${p.number}`, lines: p.lines, heldOutAs: p.heldOutAs, vote: r.vote, confidence: r.confidence, reason: r.reason, seconds: Math.round(r.seconds * 10) / 10, inputTokens: r.usage.input, outputTokens: r.usage.output, modelReported: r.model, ...(r.error ? { error: r.error } : {}) })}\n`);
        log('vote', { verifier: v.id, n: seconds.length, seconds: Math.round(r.seconds), vote: r.vote });
      }
    }
    await nosana('POST', `/api/deployments/${d.id}/stop`).catch((e: Error) => log('stop failed', { id: d.id, error: e.message }));
    models.push({ verifier: v.id, model: v.model, status: url ? 'ran' : `never ready: ${status}`, startupSeconds, votes: seconds.length, missing, secondsPerVote: seconds.length ? seconds.reduce((a, x) => a + x, 0) / seconds.length : null, medianSeconds: median(seconds), maxSeconds: seconds.length ? Math.max(...seconds) : null, inputTokens: input, outputTokens: output, deployedMinutes: (Date.now() - t0) / 60_000 });
    log('deployment stopped', { verifier: v.id, spentSoFar: await spentNow().catch(() => null) });
  }
} finally {
  await stopAll();
}
// Reservations settle after a stop.
await pause(120_000);
const after = await balance();
const report = { market, priceAssumedPerHour: 0.192, timeoutMinutes: TIMEOUT_MINUTES, before: { assigned: before.assigned, reserved: before.reserved, settled: before.settled }, after: { assigned: after.assigned, reserved: after.reserved, settled: after.settled }, creditsSpent: after.settled + after.reserved - before.settled - before.reserved, models };
writeFileSync(`${OUT}/probe-report.json`, JSON.stringify(report, null, 2));
log('done', report);
