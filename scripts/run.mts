/**
 * The run (the design, approved 2026-11-08): the sample in tasks/sample.json, on the three open-weight verifiers at once, one
 * Nosana deployment each, every one walking the same order. Deployments last 3 hours and are replaced, and the run resumes from the votes
 * already written. It stops at the credit cap, at the gate, or when every verifier is done, and stops every deployment it started.
 *   NOSANA_API_KEY, GITHUB_TOKEN (read-only), RUN_CAP_CREDITS (default 7.879), RUN_OUT (default results)
 * Gemini isn't here: arm C is 2 of 3 (amendment 2), and its daily side run is scripts/gemini-daily.mts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AGENT_VERIFIERS } from '../src/agentPrs.js';
import { readAgentPatch, type AgentPatch } from '../src/agentPatch.js';
import { openaiClient } from '../src/clients.js';
import { askRanker } from '../src/rankVerifier.js';
import { canDeploy, commonPrefix, DEPLOYMENT_MINUTES, gateFailure, remaining, RUN_CAP_CREDITS, type VoteRow } from '../src/run.js';

const API = process.env.RUN_NOSANA_API ?? 'https://api.nosana.com'; // another only for the dry-run test
const KEY = process.env.NOSANA_API_KEY;
if (!KEY) throw new Error('NOSANA_API_KEY is not set');
const CAP = Number(process.env.RUN_CAP_CREDITS ?? RUN_CAP_CREDITS);
const OUT = process.env.RUN_OUT ?? 'results';
const CACHE = process.env.RUN_CACHE ?? 'cache/patches';
const SAMPLE = process.env.RUN_SAMPLE ?? 'tasks/sample.json';
const POLL_MS = Number(process.env.RUN_POLL_MS ?? 20_000);
const START_WAIT_MS = 25 * 60_000;
const VOTE_UNTIL_MS = (DEPLOYMENT_MINUTES - 12) * 60_000; // stop voting with room before the timeout
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string, o: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), msg, ...o });
  console.log(line);
  appendFileSync(`${OUT}/run-log.jsonl`, `${line}\n`);
};
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

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
  return { settled: Number(b.settledCredits ?? 0), reserved: Number(b.reservedCredits ?? 0), assigned: Number(b.assignedCredits ?? 0) };
};
// The baseline is written once, at the first start, so a resumed run counts everything it spent.
const BASE = `${OUT}/run-baseline.json`;
if (!existsSync(BASE)) {
  const b = await balance();
  writeFileSync(BASE, `${JSON.stringify({ at: new Date().toISOString(), ...b })}\n`);
}
const base = JSON.parse(readFileSync(BASE, 'utf8')) as { settled: number; reserved: number };
/** Settled plus reserved since the start: a running deployment's whole timeout is reserved, so this is what it can still cost. */
const spent = async () => {
  const b = await balance();
  return b.settled + b.reserved - (base.settled + base.reserved);
};

const jobDefinition = (model: string) => ({
  version: '0.1',
  type: 'container',
  global: { variables: { MODEL: model } },
  ops: [{ id: 'server', type: 'container/run', args: { gpu: true, image: 'docker.io/ollama/ollama:0.35.1', env: { OLLAMA_CONTEXT_LENGTH: '32768' }, expose: [{ port: 11434, health_checks: [{ type: 'http', path: '/api/tags', method: 'GET', expected_status: 200, continuous: false }] }], resources: [{ type: 'Ollama', model: '%%global.variables.MODEL%%' }] } }],
  meta: { trigger: 'api', system_requirements: { vram_total_mb: 22000 } },
});

type SamplePr = { id: string; agent: string; repo: string; number: number; state: string; lines: number };
const sample = JSON.parse(readFileSync(SAMPLE, 'utf8')) as { prs: SamplePr[]; seed: string };
const VOTES = `${OUT}/votes.jsonl`;
const readVotes = (): VoteRow[] => (existsSync(VOTES) ? readFileSync(VOTES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as VoteRow) : []);

// Patches first, with nothing running. A PR whose patch can't be read is left out for every verifier alike, and counted.
const patches = new Map<string, AgentPatch>();
const unreadable: string[] = [];
for (const [i, p] of sample.prs.entries()) {
  const file = `${CACHE}/${p.id.replace(/[/#]/g, '_')}.json`;
  let a: AgentPatch | null = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AgentPatch | null) : null;
  if (!existsSync(file)) {
    a = await readAgentPatch(p.repo, p.number, { ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) }).catch(() => null);
    writeFileSync(file, JSON.stringify(a));
    await pause(300);
  }
  if (a) patches.set(p.id, a);
  else unreadable.push(p.id);
  if ((i + 1) % 100 === 0) log('patches', { read: i + 1, of: sample.prs.length, unreadable: unreadable.length });
}
const order = sample.prs.map((p) => p.id).filter((id) => patches.has(id));
const byId = new Map(sample.prs.map((p) => [p.id, p]));
log('patches read', { sample: sample.prs.length, readable: order.length, unreadable: unreadable.length });

const verifiers = AGENT_VERIFIERS.filter((v) => v.group === 'open-weight');
const running = new Map<string, string>(); // verifier -> deployment id
let stopReason: string | null = null;
const stopAll = async () => {
  for (const [v, id] of running) {
    await nosana('POST', `/api/deployments/${id}/stop`).catch((e: Error) => log('stop failed', { verifier: v, id, error: e.message }));
    running.delete(v);
  }
};
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { stopReason = `signal ${s}`; void stopAll().finally(() => process.exit(1)); });

let deployLock: Promise<unknown> = Promise.resolve();
const deployments: { verifier: string; id: string; startupSeconds: number | null; votes: number; minutes: number }[] = [];
async function worker(v: (typeof verifiers)[number]) {
  let failures = 0;
  while (!stopReason) {
    const todo = remaining(order, readVotes(), v.id);
    if (!todo.length) return log('verifier done', { verifier: v.id });
    // One deployment is started at a time, so each check sees the reservations of those before it.
    const next = deployLock.catch(() => undefined).then(async (): Promise<{ id: string } | null> => {
      const s = await spent();
      if (!canDeploy(s, CAP)) {
        stopReason ??= `the cap: ${s.toFixed(3)} spent, ${CAP} allowed`;
        return null;
      }
      const d = await nosana('POST', '/api/deployments/create', { name: `bench-run-${v.id.replace(/[^a-z0-9]+/gi, '-')}`, market: MARKET, replicas: 1, timeout: DEPLOYMENT_MINUTES, strategy: 'SIMPLE', job_definition: jobDefinition(v.model) });
      running.set(v.id, d.id);
      await nosana('POST', `/api/deployments/${d.id}/start`);
      log('deployment started', { verifier: v.id, id: d.id, spent: s });
      await pause(Number(process.env.RUN_RESERVE_WAIT_MS ?? 15_000)); // for the reservation to show in the balance
      return d as { id: string };
    });
    deployLock = next;
    const started = await next;
    if (!started) return;
    const d = started;
    const t0 = Date.now();
    let url: string | null = null;
    while (!stopReason && Date.now() - t0 < START_WAIT_MS) {
      await pause(POLL_MS);
      const cur = await nosana('GET', `/api/deployments/${d.id}`).catch(() => null);
      if (!cur) continue;
      if (['ERROR', 'INSUFFICIENT_FUNDS', 'STOPPED', 'ARCHIVED'].includes(cur.status)) break;
      const ep = (cur.endpoints ?? []).find((e: { url?: string }) => e.url)?.url as string | undefined;
      if (cur.status === 'RUNNING' && ep) {
        const tags = (await fetch(`${ep.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { models?: { name: string }[] } | null;
        if (tags?.models?.some((m) => m.name === v.model || m.name.startsWith(v.model.split(':')[0]!))) url = ep.replace(/\/+$/, '');
        if (url) break;
      }
    }
    const startupSeconds = url ? (Date.now() - t0) / 1000 : null;
    let votes = 0;
    if (url) {
      failures = 0;
      log('deployment ready', { verifier: v.id, startupSeconds });
      const client = openaiClient({ baseUrl: `${url}/v1`, model: v.model, apiKey: 'none', timeoutMs: 600_000 });
      for (const id of todo) {
        if (stopReason || Date.now() - t0 > VOTE_UNTIL_MS) break;
        const p = byId.get(id)!;
        const a = patches.get(id)!;
        const r = await askRanker(client, p.repo, a.task, a.patch);
        appendFileSync(VOTES, `${JSON.stringify({ verifier: v.id, vendor: v.vendor, id, agent: p.agent, state: p.state, lines: p.lines, vote: r.vote, confidence: r.confidence, reason: r.reason, seconds: Math.round(r.seconds * 10) / 10, inputTokens: r.usage.input, outputTokens: r.usage.output, modelReported: r.model, stop: r.stop ?? null, ...(r.error ? { error: r.error } : {}), ...(r.excerpt !== undefined ? { excerpt: r.excerpt } : {}) })}\n`);
        votes++;
        const gate = gateFailure(readVotes(), v.id);
        if (gate) stopReason ??= `the gate: ${gate}`;
        if (votes % 10 === 0) {
          const now = await spent().catch(() => null);
          if (now !== null && now > CAP) stopReason ??= `the cap: ${now.toFixed(3)} spent`;
        }
      }
    } else {
      failures++;
      log('deployment never ready', { verifier: v.id, id: d.id });
    }
    await nosana('POST', `/api/deployments/${d.id}/stop`).catch((e: Error) => log('stop failed', { verifier: v.id, id: d.id, error: e.message }));
    running.delete(v.id);
    deployments.push({ verifier: v.id, id: d.id, startupSeconds, votes, minutes: (Date.now() - t0) / 60_000 });
    log('deployment stopped', { verifier: v.id, id: d.id, votes, minutes: Math.round((Date.now() - t0) / 60_000) });
    if (failures >= 3) {
      stopReason ??= `${v.id}: three deployments in a row never got ready`;
      return;
    }
  }
}

const MARKET = process.env.RUN_MARKET ?? ((await nosana('GET', '/api/markets/')) as { slug?: string; address: string; name: string; type: string }[]).find((m) => /3090/.test(`${m.slug} ${m.name}`) && m.type === 'PREMIUM')?.address;
if (!MARKET) throw new Error('no 3090 market');
log('run starting', { sample: sample.prs.length, readable: order.length, cap: CAP, spentAtStart: await spent(), verifiers: verifiers.map((v) => v.id) });
try {
  await Promise.all(verifiers.map((v) => worker(v).catch((e: Error) => { stopReason ??= `${v.id}: ${e.message}`; })));
} finally {
  await stopAll();
}
const rows = readVotes();
const per = Object.fromEntries(verifiers.map((v) => {
  const mine = rows.filter((r) => r.verifier === v.id);
  const missing: Record<string, number> = {};
  for (const r of mine.filter((x) => x.vote === null)) missing[r.error ?? 'unknown'] = (missing[r.error ?? 'unknown'] ?? 0) + 1;
  const secs = mine.map((r) => r.seconds).sort((a, b) => a - b);
  return [v.id, { votes: mine.length, missing, secondsPerVote: secs.length ? secs.reduce((a, x) => a + x, 0) / secs.length : null, medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : null, deployments: deployments.filter((d) => d.verifier === v.id).length }];
}));
const report = { stopped: stopReason ?? 'done', sample: sample.prs.length, unreadable: unreadable.length, scoredOn: commonPrefix(order, rows, verifiers.map((v) => v.id)), creditsSpent: await spent().catch(() => null), verifiers: per, deployments };
writeFileSync(`${OUT}/run-report.json`, `${JSON.stringify(report, null, 1)}\n`);
log('run ended', report);
