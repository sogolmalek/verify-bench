/**
 * "Skim" or "careful review" (the design, 40.2.6). A patch is skim when all three hold: the verifier or quorum accepts,
 * none of the files it changes matches a risk pattern, and the deterministic check finds no decision conflict.
 * A split or a patch below the floor is careful review: it wasn't rejected, but it wasn't accepted either.
 */
import type { Outcome } from './quorum.js';

/** The files a unified diff changes: the new path, or the old one for a deletion. */
export function changedFiles(patch: string): string[] {
  const files = new Set<string>();
  let oldPath: string | null = null;
  for (const line of patch.split('\n')) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      oldPath = git[1]!;
      files.add(git[2]!);
      continue;
    }
    const minus = /^--- (?:a\/)?(.+)$/.exec(line);
    if (minus && minus[1] !== '/dev/null') oldPath = minus[1]!;
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plus) {
      if (plus[1] !== '/dev/null') files.add(plus[1]!);
      else if (oldPath) files.add(oldPath);
    }
  }
  return [...files];
}

/** Matches one path against a glob: `**` crosses directories, `*` and `?` don't. */
export function globMatch(glob: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

export const riskPaths = (patterns: readonly string[], files: readonly string[]) => files.filter((f) => patterns.some((p) => globMatch(p, f)));

export type TriageInput = {
  /** The verifier's or quorum's outcome. Null for arm A's baseline, which has no verifier. */
  outcome: Outcome | null;
  riskPaths: readonly string[];
  decisionConflicts: number;
};

export function triage(t: TriageInput): 'skim' | 'careful' {
  const accepted = t.outcome === null || t.outcome === 'accept';
  return accepted && t.riskPaths.length === 0 && t.decisionConflicts === 0 ? 'skim' : 'careful';
}
