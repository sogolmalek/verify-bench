/**
 * The run's rules (the design, approved 2026-11-08): the three open-weight verifiers walk the sample's one order at once, each
 * on its own deployment. It stops at the credit cap, or at the gate, and is scored on the PRs every verifier finished.
 */
export const RUN_CAP_CREDITS = 7.879; // 8 in all, with the probe's 0.121
export const DEPLOYMENT_MINUTES = 180;
export const PRICE_PER_HOUR = 0.192; // the list price; the probe settled at about 0.18
export const GATE_VOTES = 30;
export const GATE_MAX_MISSING = 0.1;

export type VoteRow = { verifier: string; id: string; vote: 'accept' | 'reject' | null; error?: string; seconds: number };

/** A new deployment only when its whole timeout still fits under the cap, since that's what it can cost. */
export const canDeploy = (spent: number, cap = RUN_CAP_CREDITS, minutes = DEPLOYMENT_MINUTES, price = PRICE_PER_HOUR) => spent + (price * minutes) / 60 <= cap;

/** The gate: after its first 30 votes, a verifier missing more than 10% stops the run. Null while it passes or hasn't reached 30. */
export function gateFailure(rows: readonly VoteRow[], verifier: string): string | null {
  const mine = rows.filter((r) => r.verifier === verifier).slice(0, GATE_VOTES);
  if (mine.length < GATE_VOTES) return null;
  const missing = mine.filter((r) => r.vote === null);
  if (missing.length / mine.length <= GATE_MAX_MISSING) return null;
  const why: Record<string, number> = {};
  for (const r of missing) why[r.error ?? 'unknown'] = (why[r.error ?? 'unknown'] ?? 0) + 1;
  return `${verifier}: ${missing.length} of its first ${GATE_VOTES} votes missing (${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')})`;
}

/** How many PRs, from the start of the order, every verifier has an answer for, a vote or a missing one. The run is scored on these. */
export function commonPrefix(order: readonly string[], rows: readonly VoteRow[], verifiers: readonly string[]): number {
  const done = new Set(rows.map((r) => `${r.verifier}|${r.id}`));
  let n = 0;
  for (const id of order) {
    if (!verifiers.every((v) => done.has(`${v}|${id}`))) break;
    n++;
  }
  return n;
}

/** What a verifier still has to do, in order. */
export const remaining = (order: readonly string[], rows: readonly VoteRow[], verifier: string) => {
  const done = new Set(rows.filter((r) => r.verifier === verifier).map((r) => r.id));
  return order.filter((id) => !done.has(id));
};
