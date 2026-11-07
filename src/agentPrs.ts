/**
 * Patches real agents already wrote (PREREGISTRATION.md): who may vote, what a verifier may read, the mechanical risk patterns, and
 * the two truths. Pure functions; nothing here calls a model or GitHub.
 */
import type { Verifier } from './quorum.js';

export type AgentVerifier = Verifier & { model: string };
export const AGENT_VERIFIERS: readonly AgentVerifier[] = [
  { id: 'qwen3.8:27b', model: 'qwen3.8:27b', vendor: 'alibaba', group: 'open-weight' },
  { id: 'glm-4.7-flash', model: 'glm-4.7-flash:latest', vendor: 'zhipu', group: 'open-weight' },
  { id: 'devstral', model: 'devstral:latest', vendor: 'mistral', group: 'open-weight' },
  { id: 'gemini-3.8-flash', model: 'gemini-3.8-flash', vendor: 'google', group: 'frontier' },
];

/** The agents, with the vendor the rule removes. An agent whose models aren't known removes only its own vendor, and is also reported leaving out each verifier in turn. */
export const AGENT_VENDOR: Record<string, string> = { 'Copilot coding agent': 'github', 'Claude (GitHub app)': 'anthropic', 'Claude Code (body note)': 'anthropic', 'Codex (task link)': 'openai', Devin: 'cognition', 'Cursor (GitHub app)': 'cursor', 'Cursor (agent note)': 'cursor', Jules: 'google' };
export const MODELS_NOT_KNOWN = new Set(['Copilot coding agent', 'Devin', 'Cursor (GitHub app)', 'Cursor (agent note)']);

const MARKERS = /generated with|co-authored-by|cursor\.com|claude\.(ai|com)|chatgpt\.com|devin\.ai|copilot|jules\.google|session link|requested by|tag @/i;
const TEST_CLAIMS = /\b(tests?|ci|checks?|lint|build|coverage)\b[^.\n]*\b(pass(es|ed|ing)?|green|succeed(s|ed)?|ok)\b|\b(pass(es|ed|ing)?|green)\b[^.\n]*\b(tests?|ci|checks?)\b|✅|✓/i;

/** What a verifier may read of a PR's text: no marker of who wrote it, no link, and no claim about tests or CI. */
export function stripTask(title: string, body: string | null, maxChars = 4_000): { title: string; description: string } {
  const lines = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .split('\n')
    .filter((l) => !MARKERS.test(l) && !TEST_CLAIMS.test(l));
  return { title: title.replace(/^\[?(copilot|claude|cursor|devin|jules|codex)\]?:?\s*/i, ''), description: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars) };
}

/** The fixed list beside CODEOWNERS (no decisions: every result says so). */
export const FIXED_RISK_PATHS = ['.github/workflows/**', 'infra/**', 'infrastructure/**', 'terraform/**', 'deploy/**', '**/migrations/**', '**/*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'Cargo.lock', 'poetry.lock', '**/auth/**', '**/security/**'];

/** A CODEOWNERS file's paths, as globs. */
export function codeownersPatterns(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0]!)
    .filter((p) => p !== '*' && p !== '**')
    .map((p) => {
      const g = p.replace(/^\//, '');
      return g.endsWith('/') ? `${g}**` : g;
    });
}
export const riskPatternsOf = (codeowners: string | null) => [...FIXED_RISK_PATHS, ...(codeowners ? codeownersPatterns(codeowners) : [])];

export type LaterTouch = { byOther: boolean; fixMessage: boolean; test: boolean };
export type PrFacts = {
  agent: string;
  repo: string;
  state: 'merged' | 'closed';
  /** Merged by someone other than the PR's own account (and not a bot), or closed by another person. */
  independent: boolean;
  ciGreenAtMerge: boolean;
  personCommits: number;
  changesRequested: boolean;
  reverted: boolean;
  fixedForward: boolean;
  laterIssues: number;
  touches: readonly LaterTouch[];
  linesChanged: number;
};

/** quality@1: an upper bound. Merged, CI green, no person's change, not reverted or fixed forward. */
export const quality1 = (p: PrFacts) => p.state === 'merged' && p.ciGreenAtMerge && !p.personCommits && !p.changesRequested && !p.reverted && !p.fixedForward;
/** Strict is primary: a refactor isn't a bug. */
export const strictProblem = (p: PrFacts) => p.state === 'merged' && (p.reverted || p.laterIssues > 0 || p.touches.some((t) => t.byOther && (t.fixMessage || t.test)));
export const broadProblem = (p: PrFacts) => p.state === 'merged' && (p.reverted || p.laterIssues > 0 || p.touches.some((t) => t.byOther));
export const quality2 = (p: PrFacts) => quality1(p) && !strictProblem(p);
