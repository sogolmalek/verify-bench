/**
 * Cross-file reach, read statically (PREREGISTRATION.md, "a secondary analysis"): the exported functions a patch changes, and their
 * call sites in files the patch didn't change, from `git grep` at the patch's base commit. Text only: no repository's code runs.
 */
export type Family = 'ts' | 'py' | 'go' | 'rs' | 'jvm' | 'cs' | 'php' | 'rb';
const EXT: Record<string, Family> = { ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts', py: 'py', go: 'go', rs: 'rs', java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm', cs: 'cs', php: 'php', rb: 'rb' };
export const familyOf = (file: string): Family | null => EXT[/\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? ''] ?? null;
export const GLOBS: Record<Family, string[]> = { ts: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts'], py: ['*.py'], go: ['*.go'], rs: ['*.rs'], jvm: ['*.java', '*.kt', '*.kts', '*.scala'], cs: ['*.cs'], php: ['*.php'], rb: ['*.rb'] };

/** A definition on this line: its name, and whether it's exported by its language's convention. */
type Def = { name: string; exported: boolean };
const DEFS: Record<Family, ((line: string) => Def | null)[]> = {
  ts: [
    (l) => ((m) => (m ? { name: m[1]!, exported: true } : null))(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l)),
    (l) => ((m) => (m ? { name: m[1]!, exported: true } : null))(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.exec(l)),
    (l) => ((m) => (m ? { name: m[1]!, exported: true } : null))(/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l)),
    (l) => ((m) => (m ? { name: m[1]!, exported: false } : null))(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l)),
  ],
  py: [(l) => ((m) => (m ? { name: (m[1] ?? m[2])!, exported: !(m[1] ?? m[2])!.startsWith('_') } : null))(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(|^class\s+([A-Za-z_]\w*)/.exec(l))],
  go: [(l) => ((m) => (m ? { name: m[1]!, exported: /^[A-Z]/.test(m[1]!) } : null))(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/.exec(l))],
  rs: [(l) => ((m) => (m ? { name: m[2]!, exported: !!m[1] } : null))(/^\s*(pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/.exec(l))],
  // Only a line with a visibility or Kotlin's `fun` is a definition: a statement such as `return foo(` isn't.
  jvm: [(l) => {
    const m = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(public|private|protected|internal)?\s*(?:(?:static|final|abstract|synchronized|override|suspend|open|inline|default)\s+)*(fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?|(?:<[^>]+>\s*)?[\w<>[\],.?]+\s+)([A-Za-z_]\w*)\s*\(/.exec(l);
    if (!m || (!m[1] && !m[2]!.startsWith('fun'))) return null;
    return { name: m[3]!, exported: m[1] === 'public' || (!m[1] && m[2]!.startsWith('fun')) };
  }],
  cs: [(l) => ((m) => (m ? { name: m[1]!, exported: true } : null))(/^\s*public\s+(?:(?:static|virtual|override|async|sealed|abstract)\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/.exec(l))],
  php: [(l) => ((m) => (m ? { name: m[2]!, exported: m[1] !== 'private' && m[1] !== 'protected' } : null))(/^\s*(?:(public|private|protected)\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/.exec(l))],
  rb: [(l) => ((m) => (m ? { name: m[1]!, exported: true } : null))(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/.exec(l))],
};
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'function', 'else', 'elif', 'with', 'match']);
/** Too common to follow by name: they'd match other functions everywhere. */
export const COMMON_NAMES = new Set(['main', 'init', 'setup', 'teardown', 'render', 'handle', 'handler', 'update', 'create', 'delete', 'build', 'start', 'stop', 'close', 'open', 'read', 'write', 'load', 'save', 'parse', 'format', 'print', 'reset', 'clear', 'call', 'apply', 'bind', 'test', 'tests', 'index', 'value', 'values', 'items', 'keys', 'length', 'size', 'name', 'type', 'data', 'config', 'options', 'props', 'state', 'error', 'toString', 'equals', 'hashCode', 'constructor', 'default', 'execute', 'process', 'validate', 'serialize', 'deserialize', 'String', 'Error', 'Close', 'Read', 'Write', 'Run', 'Start', 'Stop', 'Get', 'Set', 'New', 'Init', 'Handle', 'ServeHTTP', 'forward', '__init__', 'get_queryset']);

export function definitionOn(line: string, family: Family): Def | null {
  for (const d of DEFS[family]) {
    const got = d(line);
    if (got && !KEYWORDS.has(got.name)) return got;
  }
  return null;
}

/** The exported functions a unified diff changes: their definition is on a changed line, or encloses one by the hunk's header or an earlier line of the hunk. */
export function changedExported(diff: string): { file: string; family: Family; name: string }[] {
  const out = new Map<string, { file: string; family: Family; name: string }>();
  let file = '';
  let family: Family | null = null;
  let current: { name: string; exported: boolean } | null = null;
  const mark = () => {
    if (family && current?.exported && current.name.length >= 4 && !COMMON_NAMES.has(current.name)) out.set(`${file}\0${current.name}`, { file, family, name: current.name });
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = / b\/(.+)$/.exec(raw)?.[1] ?? '';
      family = familyOf(file);
      current = null;
      continue;
    }
    if (!family || raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('@@')) {
      current = definitionOn(/^@@[^@]*@@ ?(.*)$/.exec(raw)?.[1] ?? '', family);
      continue;
    }
    const body = raw.slice(1);
    const def = definitionOn(body, family);
    if (def) current = def;
    if (raw.startsWith('+') || raw.startsWith('-')) mark();
  }
  return [...out.values()];
}

export const filesOf = (diff: string) => new Set([...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].flatMap((m) => [m[1]!, m[2]!]));
export const MAX_SITES_PER_NAME = 500;
const esc = (s: string) => s.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');

/** Call sites from `git grep -n` output at a commit (`<sha>:<path>:<line>:<text>`), in files the patch didn't change. */
export function callSites(grep: string, names: readonly { name: string; family: Family }[], changed: ReadonlySet<string>): { sites: number; files: number; perName: Record<string, number> } {
  const perName: Record<string, number> = Object.fromEntries(names.map((n) => [n.name, 0]));
  const files = new Set<string>();
  // A call is the name and `(`; in TypeScript and JavaScript a component's use, `<Name`, is one too.
  const res = names.map((n) => ({ ...n, call: new RegExp(`(^|[^\\w$])${esc(n.name)}\\s*\\(${n.family === 'ts' ? `|<${esc(n.name)}[\\s/>]` : ''}`) }));
  for (const line of grep.split('\n')) {
    const m = /^[0-9a-f]{7,40}:(.+?):(\d+):(.*)$/.exec(line);
    if (!m || changed.has(m[1]!)) continue;
    const fam = familyOf(m[1]!);
    for (const n of res) {
      if (fam !== n.family || perName[n.name]! >= MAX_SITES_PER_NAME || !n.call.test(m[3]!)) continue;
      const def = definitionOn(m[3]!, n.family);
      if (def?.name === n.name) continue;
      perName[n.name]!++;
      files.add(m[1]!);
    }
  }
  return { sites: Object.values(perName).reduce((a, x) => a + x, 0), files: files.size, perName };
}
