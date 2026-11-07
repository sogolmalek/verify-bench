/**
 * Read-only access to a repository at one commit, through git's objects and never the working tree (the design, 40.2.1).
 *
 * This is what an author's tools can see. Reading objects, not files, is the safety:
 * - a path can only name something in that commit's tree, so `..`, an absolute path or a symlink can't reach the host;
 * - nothing after the parent commit can be addressed, so the PR's tests and diff stay hidden;
 * - no code of the repository ever runs here: this step holds the provider keys, the sandbox doesn't.
 * Subprocesses get a minimal environment, so a key in this process's environment can't reach them.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What one tool call may return, so one read can't fill a model's context. */
export const TREE_LIMITS = { listEntries: 500, readLines: 400, readBytes: 32_000, searchLines: 100, searchLineChars: 300, gitTimeoutMs: 20_000 };

export class RefusedPath extends Error {}

/** A path inside the tree, or a refusal. Pathspec magic and `..` are refused rather than interpreted. */
export function safePath(p: string | undefined): string {
  const s = (p ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (s === '' || s === '.') return '';
  if (s.startsWith('/') || s.startsWith(':') || s.includes('\0') || s.split('/').some((x) => x === '..' || x === '.git')) throw new RefusedPath(`refused path: ${s.slice(0, 120)}`);
  return s;
}

export class GitTree {
  constructor(
    private readonly repoDir: string,
    readonly sha: string,
  ) {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error('GitTree needs a commit id');
  }

  private async git(args: string[], ok: number[] = [0]): Promise<string> {
    const env = { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    try {
      const { stdout } = await run('git', ['-C', this.repoDir, '--literal-pathspecs', ...args], { env, timeout: TREE_LIMITS.gitTimeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { code?: number; stdout?: string; killed?: boolean };
      if (typeof e.code === 'number' && ok.includes(e.code)) return e.stdout ?? '';
      throw new Error(e.killed ? 'git timed out' : 'git refused that request');
    }
  }

  /** The files under a path, one per line, capped. */
  async list(path?: string): Promise<string> {
    const p = safePath(path);
    const names = (await this.git(['ls-tree', '-r', '--name-only', this.sha, ...(p ? ['--', p] : [])])).split('\n').filter(Boolean);
    if (!names.length) return p ? `no files under ${p}` : 'the tree is empty';
    const shown = names.slice(0, TREE_LIMITS.listEntries);
    return shown.join('\n') + (names.length > shown.length ? `\n[${names.length - shown.length} more files not shown; list a narrower path]` : '');
  }

  /** A file's lines, numbered, capped. Binary files are refused. */
  async read(path: string, start = 1, end?: number): Promise<string> {
    const p = safePath(path);
    if (!p) throw new RefusedPath('read_file needs a path');
    const body = await this.git(['cat-file', 'blob', `${this.sha}:${p}`]);
    if (body.includes('\0')) return `${p} is a binary file`;
    const lines = body.split('\n');
    const from = Math.max(1, Math.floor(start));
    const to = Math.min(lines.length, end ? Math.floor(end) : lines.length, from + TREE_LIMITS.readLines - 1);
    let out = '';
    for (let i = from; i <= to; i++) {
      const next = `${i}: ${lines[i - 1]}\n`;
      if (out.length + next.length > TREE_LIMITS.readBytes) return `${out}[cut at ${TREE_LIMITS.readBytes} bytes; ask for lines from ${i}]`;
      out += next;
    }
    return out + (to < lines.length ? `[${lines.length - to} more lines; ask for lines from ${to + 1}]` : '');
  }

  /** Lines matching a regular expression, capped. No match isn't an error. */
  async search(pattern: string, path?: string): Promise<string> {
    const p = safePath(path);
    if (!pattern.trim()) throw new RefusedPath('search needs a pattern');
    const found = (await this.git(['grep', '-n', '-I', '-E', '-e', pattern, this.sha, ...(p ? ['--', p] : [])], [0, 1])).split('\n').filter(Boolean);
    if (!found.length) return 'no matches';
    const prefix = `${this.sha}:`;
    const shown = found.slice(0, TREE_LIMITS.searchLines).map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l).slice(0, TREE_LIMITS.searchLineChars));
    return shown.join('\n') + (found.length > shown.length ? `\n[${found.length - shown.length} more matches not shown; narrow the pattern or the path]` : '');
  }
}

/** The tools an author gets, in a neutral shape each client turns into its provider's. */
export const AUTHOR_TOOLS = [
  {
    name: 'list_files',
    description: 'List the files in the repository at this commit, optionally under one directory.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'A directory, relative to the repository root. Omit for the whole repository.' } } },
  },
  {
    name: 'search',
    description: 'Search the files at this commit with an extended regular expression. Returns path:line:text.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Limit the search to this file or directory.' } }, required: ['pattern'] },
  },
  {
    name: 'read_file',
    description: 'Read a file at this commit, with line numbers.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] },
  },
] as const;

/** Runs one tool call. A refusal or error goes back to the model as text, and never stops the run. */
export async function runTool(tree: GitTree, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'list_files') return await tree.list(typeof args.path === 'string' ? args.path : undefined);
    if (name === 'search') return await tree.search(String(args.pattern ?? ''), typeof args.path === 'string' ? args.path : undefined);
    if (name === 'read_file') return await tree.read(String(args.path ?? ''), Number(args.start_line ?? 1) || 1, args.end_line === undefined ? undefined : Number(args.end_line) || undefined);
    return `unknown tool: ${String(name).slice(0, 60)}`;
  } catch (err) {
    return err instanceof RefusedPath ? err.message : `tool error: ${(err as Error).message}`;
  }
}
