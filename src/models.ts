/**
 * The authors and verifiers (the design, 40.1; V-17, V-19), each with its vendor and tier. Prices are list prices per
 * million tokens read on 2026-11-07: Claude's and Gemini 3.8 Flash's from their vendors' pages (it doubles on 2027-01-01), GPT's
 * and Argon's from OpenRouter's public listing. The dry run reads them again. A model's status
 * says what can't run yet.
 */
import type { Usage } from './clients.js';

export type Tier = 'top' | 'cheaper' | 'open-weight';
export type Budget = 'frontier' | 'nosana';

export type Model = {
  id: string;
  vendor: string;
  tier: Tier;
  budget: Budget;
  shape: 'anthropic' | 'openai';
  /** Where the provider is. An open-weight model's address comes from its Nosana deployment. */
  baseUrl?: string;
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  inPerMTok?: number;
  outPerMTok?: number;
  cachedInPerMTok?: number;
  cacheWritePerMTok?: number;
  status?: 'pending: location';
};

const ANTHROPIC = 'https://api.anthropic.com/v1';
const OPENAI = 'https://api.openai.com/v1';
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/openai';

export const FRONTIER_TOP: readonly Model[] = [
  { id: 'claude-opus-5-5', vendor: 'anthropic', tier: 'top', budget: 'frontier', shape: 'anthropic', baseUrl: ANTHROPIC, inPerMTok: 4, outPerMTok: 20, cachedInPerMTok: 0.2, cacheWritePerMTok: 5 },
  { id: 'gpt-6.1-sol', vendor: 'openai', tier: 'top', budget: 'frontier', shape: 'openai', baseUrl: OPENAI, tokenParam: 'max_completion_tokens', inPerMTok: 2, outPerMTok: 10, cachedInPerMTok: 0.1 },
  { id: 'gemini-4-argon', vendor: 'google', tier: 'top', budget: 'frontier', shape: 'openai', baseUrl: GOOGLE, inPerMTok: 2, outPerMTok: 10, cachedInPerMTok: 0.1, status: 'pending: location' },
];

export const FRONTIER_CHEAPER: readonly Model[] = [
  { id: 'claude-sonnet-5-5', vendor: 'anthropic', tier: 'cheaper', budget: 'frontier', shape: 'anthropic', baseUrl: ANTHROPIC, inPerMTok: 2, outPerMTok: 10, cachedInPerMTok: 0.1, cacheWritePerMTok: 2.5 },
  { id: 'gpt-6.1-terra', vendor: 'openai', tier: 'cheaper', budget: 'frontier', shape: 'openai', baseUrl: OPENAI, tokenParam: 'max_completion_tokens', inPerMTok: 1, outPerMTok: 5, cachedInPerMTok: 0.05 },
  { id: 'gemini-3.8-flash', vendor: 'google', tier: 'cheaper', budget: 'frontier', shape: 'openai', baseUrl: GOOGLE, inPerMTok: 0.75, outPerMTok: 3.75, cachedInPerMTok: 0.075, status: 'pending: location' },
];

/** The frontier verifiers run at top tier (V-19). */
export const FRONTIER_VERIFIERS = FRONTIER_TOP;

/** What a call costs: cache reads and writes at their own prices, or the input price when a model has none. */
export function costUsd(m: Pick<Model, 'inPerMTok' | 'outPerMTok' | 'cachedInPerMTok' | 'cacheWritePerMTok'>, u: Usage): number {
  const inPrice = m.inPerMTok ?? 0;
  const plain = Math.max(0, u.input - u.cachedInput - u.cacheWrite);
  return (plain * inPrice + u.cachedInput * (m.cachedInPerMTok ?? inPrice) + u.cacheWrite * (m.cacheWritePerMTok ?? inPrice) + u.output * (m.outPerMTok ?? 0)) / 1_000_000;
}
