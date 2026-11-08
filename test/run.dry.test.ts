/**
 * The run against a fake Nosana and a fake Ollama on this machine, end to end: it starts one deployment per verifier, votes in order,
 * resumes, stops at the gate, stops every deployment, and never spends past the cap. Nothing leaves the machine.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
let server: Server;
let base = '';
const state = { settled: 0, reserved: 0, created: 0, started: 0, stopped: new Set<string>(), live: new Map<string, string>(), answer: 'tool' as 'tool' | 'none', calls: 0 };
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (j: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const u = req.url ?? '';
      if (u === '/api/credits/balance') return send({ assignedCredits: 10, reservedCredits: state.reserved, settledCredits: state.settled });
      if (u === '/api/markets/') return send([{ slug: 'nvidia-3090', name: '3090', type: 'PREMIUM', address: 'M' }]);
      if (u === '/api/deployments/create') { const id = `d${++state.created}`; state.live.set(id, JSON.parse(body).job_definition.global.variables.MODEL); state.reserved += 0.576; return send({ id, status: 'DRAFT' }); }
      const m = /^\/api\/deployments\/(d\d+)(\/start|\/stop)?$/.exec(u);
      if (m) {
        if (m[2] === '/start') { state.started++; return send({}); }
        if (m[2] === '/stop') { if (!state.stopped.has(m[1]!)) { state.stopped.add(m[1]!); state.reserved -= 0.576; state.settled += 0.01; } return send({}); }
        return send({ status: 'RUNNING', endpoints: [{ url: `${base}/ollama/${m[1]}` }] });
      }
      const o = /^\/ollama\/(d\d+)\/(api\/tags|v1\/chat\/completions)$/.exec(u);
      if (o) {
        const model = state.live.get(o[1]!)!;
        if (o[2] === 'api/tags') return send({ models: [{ name: model }] });
        state.calls++;
        const message = state.answer === 'tool' ? { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'decide', arguments: JSON.stringify({ decision: 'accept', confidence: 80, reason: 'fine' }) } }] } : { role: 'assistant', content: 'thinking…' };
        return send({ model, choices: [{ message, finish_reason: state.answer === 'tool' ? 'tool_calls' : 'length' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      }
      send({ message: 'not found' }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

function setup(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-run-'));
  const cache = join(dir, 'cache');
  mkdirSync(cache);
  const prs = Array.from({ length: n }, (_, i) => ({ id: `o/r#${i + 1}`, agent: 'Devin', repo: 'o/r', number: i + 1, state: 'merged', lines: 10 }));
  for (const p of prs) writeFileSync(join(cache, `${p.id.replace(/[/#]/g, '_')}.json`), JSON.stringify({ task: { title: 't', description: '' }, patch: 'diff', agentCommit: 'a', baseSha: 'b', commitsDropped: 0 }));
  writeFileSync(join(dir, 'sample.json'), JSON.stringify({ seed: 's', prs }));
  return { dir, env: { ...process.env, NOSANA_API_KEY: 'fake', GITHUB_TOKEN: '', RUN_NOSANA_API: base, RUN_SAMPLE: join(dir, 'sample.json'), RUN_CACHE: cache, RUN_OUT: join(dir, 'out'), RUN_POLL_MS: '10', RUN_RESERVE_WAIT_MS: '0' } };
}
const go = (env: NodeJS.ProcessEnv) => run(process.execPath, ['--import', 'tsx', 'scripts/run.mts'], { env, cwd: join(__dirname, '..'), timeout: 60_000 });
const report = (dir: string) => JSON.parse(readFileSync(join(dir, 'out', 'run-report.json'), 'utf8'));

describe('the run, against fakes', () => {
  it('votes every PR on every verifier, in order, and stops each deployment', async () => {
    const { dir, env } = setup(40);
    await go(env);
    const r = report(dir);
    expect(r).toMatchObject({ stopped: 'done', sample: 40, scoredOn: 40 });
    expect(Object.values(r.verifiers).map((v: any) => v.votes)).toEqual([40, 40, 40]);
    expect(state.stopped.size).toBe(state.created);
    expect(state.reserved).toBeCloseTo(0);
    const votes = readFileSync(join(dir, 'out', 'votes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(votes.filter((v) => v.verifier === 'devstral').map((v) => v.id)).toEqual(Array.from({ length: 40 }, (_, i) => `o/r#${i + 1}`));
    // The gate is decided once every verifier has 30 votes, and written then.
    const gate = JSON.parse(readFileSync(join(dir, 'out', 'gate.json'), 'utf8'));
    expect(gate).toMatchObject({ passed: true, failures: [] });
    expect(Object.values(gate.firstVotes).map((v: any) => v.votes)).toEqual([30, 30, 30]);
    // Resuming a finished run starts nothing.
    const before = state.created;
    await go(env);
    expect(state.created).toBe(before);
  }, 120_000);
  it('stops at the gate when answers run out of tokens, and says why', async () => {
    state.answer = 'none';
    const { dir, env } = setup(40);
    await go(env);
    state.answer = 'tool';
    const r = report(dir);
    expect(r.stopped).toMatch(/^the gate: .*missing \(ran out of tokens/);
    expect(JSON.parse(readFileSync(join(dir, 'out', 'gate.json'), 'utf8'))).toMatchObject({ passed: false });
    expect(state.stopped.size).toBe(state.created);
  }, 120_000);
  it('hands over at its time limit, and the next job resumes where it stopped', async () => {
    const { dir, env } = setup(10);
    await go({ ...env, RUN_MAX_MINUTES: '30' }); // under 40 minutes left: no deployment, hand over
    expect(report(dir)).toMatchObject({ stopped: 'time', scoredOn: 0 });
    await go(env);
    expect(report(dir)).toMatchObject({ stopped: 'done', scoredOn: 10 });
  }, 120_000);
  it('reads the frozen patches, the same in every job', async () => {
    const { gzipSync } = await import('node:zlib');
    const { dir, env } = setup(3);
    const patches = join(dir, 'patches.jsonl.gz');
    const frozen = [1, 2, 3].map((i) => JSON.stringify({ id: `o/r#${i}`, patch: i === 2 ? null : { task: { title: 'frozen', description: '' }, patch: 'diff', agentCommit: 'a', baseSha: 'b', commitsDropped: 0, coAuthored: i === 3 } })).join('\n');
    writeFileSync(patches, gzipSync(frozen));
    const cache = join(dir, 'cache2');
    mkdirSync(cache);
    await go({ ...env, RUN_CACHE: cache, RUN_PATCHES: patches });
    expect(report(dir)).toMatchObject({ stopped: 'done', unreadable: 1, scoredOn: 2 });
    // Each vote carries its PR's stratum (amendment 3).
    const votes = readFileSync(join(dir, 'out', 'votes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(new Set(votes.filter((v) => v.coAuthored).map((v) => v.id))).toEqual(new Set(['o/r#3']));
  }, 120_000);
  it("doesn't start a deployment the cap can't cover", async () => {
    const { dir, env } = setup(5);
    await go({ ...env, RUN_CAP_CREDITS: '0.5' });
    expect(report(dir).stopped).toMatch(/^the cap/);
    expect(Object.values(report(dir).verifiers).map((v: any) => v.votes)).toEqual([0, 0, 0]);
  }, 120_000);
});
