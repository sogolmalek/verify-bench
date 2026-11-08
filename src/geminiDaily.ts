/**
 * Gemini's daily side run (PREREGISTRATION.md, amendment 2): 20 requests a day from the bench's own Google project, on the sample's
 * order, reported apart and never counted in arm C. Its key is BENCH_GEMINI_API_KEY only: the other Gemini key belongs to a product
 * and has its own quota, and the bench must never spend it.
 */
import type { ModelClient } from './clients.js';

export const GEMINI_DAILY_REQUESTS = 20;
export const GEMINI_SECONDS_BETWEEN = 13; // 5 a minute, with room

export function benchGeminiKey(env: Record<string, string | undefined>): string {
  const k = env.BENCH_GEMINI_API_KEY;
  if (!k) throw new Error(env.GEMINI_API_KEY ? 'BENCH_GEMINI_API_KEY is not set. GEMINI_API_KEY is never used here: it is another quota.' : 'BENCH_GEMINI_API_KEY is not set');
  return k;
}

/** The next PRs for Gemini: in the sample's order, not yet voted, and not by an agent on Google's own models. */
export function nextForGemini<T extends { id: string; agent: string }>(order: readonly T[], voted: ReadonlySet<string>, vendorOf: (agent: string) => string, n: number): T[] {
  return order.filter((p) => !voted.has(p.id) && vendorOf(p.agent) !== 'google').slice(0, n);
}

export class DailyLimitReached extends Error {}
/** Counts every request, retries included, and refuses past the day's limit, so the quota can't be overrun by a retry. */
export function countedClient(inner: ModelClient, limit: number): ModelClient & { used: () => number } {
  let used = 0;
  return {
    used: () => used,
    async call(r) {
      if (used >= limit) throw new DailyLimitReached(`the day's ${limit} requests are used`);
      used++;
      return inner.call(r);
    },
  };
}
