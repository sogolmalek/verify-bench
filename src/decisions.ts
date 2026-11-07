/**
 * Rule 3 of triage (the design, 40.2.6): does a patch conflict with what a repository has written down? Deterministic, over
 * the diff's text, with no model. Published with the bench, so anyone can re-score a patch without the closed engine.
 */
import { globMatch } from './triage.js';

export type Source = { url: string; what: string };

export type DecisionRule =
  /** A line the patch adds, in a file matching `path`, matches `pattern`. */
  | { kind: 'added-line'; path: string; pattern: string }
  /** A line the patch removes, in a file matching `path`, matches `pattern`. */
  | { kind: 'removed-line'; path: string; pattern: string }
  /** The patch adds a new file matching `path`. */
  | { kind: 'file-added'; path: string }
  /** The patch changes a file matching `when` and adds or changes no file matching `requires`. */
  | { kind: 'requires-file'; when: string; requires: string };

export type RepoDecision = { id: string; statement: string; source: Source; rule: DecisionRule };

export type FileChange = { path: string; added: string[]; removed: string[]; isNew: boolean; isDeleted: boolean };

/** What a unified diff does, file by file. Lines of a hunk only: headers aren't lines of the file. */
export function patchFacts(patch: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  let oldPath: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (path: string) => {
    cur = { path, added: [], removed: [], isNew: false, isDeleted: false };
    files.push(cur);
    return cur;
  };
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        cur!.added.push(line.slice(1));
        newLeft--;
      } else if (line.startsWith('-')) {
        cur!.removed.push(line.slice(1));
        oldLeft--;
      } else if (!line.startsWith('\\')) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk && cur) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      start(git[2]!);
      oldPath = git[1]!;
      continue;
    }
    if (line.startsWith('new file mode') && cur) (cur as FileChange).isNew = true;
    if (line.startsWith('deleted file mode') && cur) (cur as FileChange).isDeleted = true;
    const minus = /^--- (?:a\/)?(.+)$/.exec(line);
    if (minus) {
      oldPath = minus[1] === '/dev/null' ? null : minus[1]!;
      continue;
    }
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plus) {
      const path = plus[1] === '/dev/null' ? oldPath : plus[1]!;
      // A bare diff has no `diff --git` line, so its file starts here.
      if (!cur || (cur as FileChange).path !== path) start(path ?? '');
      if (plus[1] === '/dev/null') (cur as unknown as FileChange).isDeleted = true;
      if (oldPath === null) (cur as unknown as FileChange).isNew = true;
    }
  }
  return files;
}

function fires(rule: DecisionRule, files: readonly FileChange[]): boolean {
  switch (rule.kind) {
    case 'added-line':
    case 'removed-line': {
      const re = new RegExp(rule.pattern);
      const lines = (f: FileChange) => (rule.kind === 'added-line' ? f.added : f.removed);
      return files.some((f) => globMatch(rule.path, f.path) && lines(f).some((l) => re.test(l)));
    }
    case 'file-added':
      return files.some((f) => f.isNew && globMatch(rule.path, f.path));
    case 'requires-file':
      return files.some((f) => globMatch(rule.when, f.path)) && !files.some((f) => globMatch(rule.requires, f.path));
  }
}

/** The repository's decisions this patch conflicts with. */
export function conflictsOf(decisions: readonly RepoDecision[], patch: string): RepoDecision[] {
  const files = patchFacts(patch);
  return decisions.filter((d) => fires(d.rule, files));
}

export type RiskPattern = { glob: string; source: Source };

export type RepoConfig = {
  repo: string;
  /** The commit the policy sources were read at. */
  sourcesAt: string;
  language: 'TypeScript' | 'Python';
  riskPatterns: RiskPattern[];
  decisions: RepoDecision[];
  /** Where a repository has no source for a rule, this says so, and the report repeats it. */
  gaps: string[];
};
