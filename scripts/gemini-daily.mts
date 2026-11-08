/**
 * Gemini's daily side run (amendment 2): up to 20 requests, retries included, on the next PRs in the sample's order, 5 a minute. Reported
 * apart and never counted in arm C. Its key is BENCH_GEMINI_API_KEY, from the bench's own Google project: never GEMINI_API_KEY.
 *   BENCH_GEMINI_API_KEY, GITHUB_TOKEN (read-only)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { AGENT_VENDOR, AGENT_VERIFIERS } from '../src/agentPrs.js';
import { readAgentPatch } from '../src/agentPatch.js';
import { openaiClient } from '../src/clients.js';
import { benchGeminiKey, countedClient, DailyLimitReached, GEMINI_DAILY_REQUESTS, GEMINI_SECONDS_BETWEEN, nextForGemini } from '../src/geminiDaily.js';
import { askRanker } from '../src/rankVerifier.js';

const key = benchGeminiKey(process.env);
const gemini = AGENT_VERIFIERS.find((v) => v.id === 'gemini-3.8-flash')!;
const OUT = 'results/gemini-votes.jsonl';
mkdirSync('results', { recursive: true });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sample = JSON.parse(readFileSync('tasks/sample.json', 'utf8')) as { prs: { id: string; agent: string; repo: string; number: number; state: string; lines: number }[] };
const voted = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id) : []);
const client = countedClient(openaiClient({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: gemini.model, apiKey: key, timeoutMs: 600_000 }), GEMINI_DAILY_REQUESTS);
let cast = 0;
for (const p of nextForGemini(sample.prs, voted, (a) => AGENT_VENDOR[a] ?? 'unknown', GEMINI_DAILY_REQUESTS)) {
  if (client.used() >= GEMINI_DAILY_REQUESTS) break;
  const a = await readAgentPatch(p.repo, p.number, { ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) });
  if (!a) {
    appendFileSync(OUT, `${JSON.stringify({ id: p.id, agent: p.agent, day: new Date().toISOString().slice(0, 10), vote: null, error: 'patch not readable' })}\n`);
    continue;
  }
  const r = await askRanker(client, p.repo, a.task, a.patch);
  // The day's limit, from our count or from Google's 429: this PR isn't recorded, and is tried again tomorrow.
  if (r.error && (/the day's/.test(r.error) || /429/.test(r.error))) break;
  appendFileSync(OUT, `${JSON.stringify({ id: p.id, agent: p.agent, state: p.state, lines: p.lines, day: new Date().toISOString().slice(0, 10), vote: r.vote, confidence: r.confidence, reason: r.reason, seconds: Math.round(r.seconds * 10) / 10, inputTokens: r.usage.input, outputTokens: r.usage.output, modelReported: r.model, stop: r.stop ?? null, ...(r.error ? { error: r.error } : {}), ...(r.excerpt !== undefined ? { excerpt: r.excerpt } : {}) })}\n`);
  cast++;
  await pause(GEMINI_SECONDS_BETWEEN * 1000);
}
void DailyLimitReached;
console.log(JSON.stringify({ day: new Date().toISOString().slice(0, 10), cast, requests: client.used(), total: voted.size + cast }));
