import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway git repository with named commits: { files: {path: text} } per commit. */
export function makeRepo(commits: { message: string; files: Record<string, string | null>; symlinks?: Record<string, string> }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: dir } }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'bench@example.com');
  git('config', 'user.name', 'bench');
  const shas: string[] = [];
  for (const c of commits) {
    for (const [p, text] of Object.entries(c.files)) {
      const full = join(dir, p);
      if (text === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    for (const [p, target] of Object.entries(c.symlinks ?? {})) symlinkSync(target, join(dir, p));
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', c.message);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { dir, shas, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake Anthropic Messages endpoint or OpenAI chat endpoint, driven by a script of answers. It records every request. */
export function fakeProvider(shape: 'anthropic' | 'openai', script: (req: any, i: number) => { text?: string; tools?: { name: string; args: unknown }[]; status?: number; input?: number; output?: number }) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
    requests.push({ url: String(url), headers, body });
    const a = script(body, requests.length - 1);
    if (a.status && a.status >= 400) return new Response(JSON.stringify({ error: { message: 'secret echoed in an error body' } }), { status: a.status });
    const usage = { input: a.input ?? 100, output: a.output ?? 10 };
    if (shape === 'anthropic') {
      const content: unknown[] = [];
      if (a.text) content.push({ type: 'text', text: a.text });
      (a.tools ?? []).forEach((t, n) => content.push({ type: 'tool_use', id: `tu_${requests.length}_${n}`, name: t.name, input: t.args }));
      return Response.json({ id: `msg_${requests.length}`, model: body.model, content, stop_reason: a.tools?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: usage.input, output_tokens: usage.output } }, { headers: { 'x-call-ref': `call-${requests.length}` } });
    }
    return Response.json({
      id: `chat_${requests.length}`,
      model: body.model,
      choices: [{ finish_reason: a.tools?.length ? 'tool_calls' : 'stop', message: { content: a.text ?? null, tool_calls: a.tools?.map((t, n) => ({ id: `c_${requests.length}_${n}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, requests };
}
