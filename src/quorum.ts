/**
 * Who votes on a patch and what the votes decide: the vendor rule (the design, 40.2.3) and its removal rule (40.2.4),
 * written before any run. Pure functions; nothing here calls a model.
 */
export type Group = 'frontier' | 'open-weight';
export type Verifier = { id: string; vendor: string; group: Group };
export type Vote = { verifier: string; vendor: string; group: Group; vote: 'accept' | 'reject' | null; reason?: string };
export type Outcome = 'reject' | 'accept' | 'split' | 'below-floor';
export type Decision = { outcome: Outcome; cast: number; rejects: number; accepts: number };

/** A verifier of the author's vendor isn't called on that patch at all (rule 2), so no same-vendor vote can exist. */
export function eligibleVerifiers(verifiers: readonly Verifier[], authorVendor: string): Verifier[] {
  return verifiers.filter((v) => v.vendor !== authorVendor);
}

/** A strict majority of the votes cast decides (rule 3); an even split decides nothing; below the floor, no score (rule 5). */
export function decide(votes: readonly Pick<Vote, 'vote'>[], floor: number): Decision {
  const rejects = votes.filter((v) => v.vote === 'reject').length;
  const accepts = votes.filter((v) => v.vote === 'accept').length;
  const cast = rejects + accepts;
  if (cast < floor) return { outcome: 'below-floor', cast, rejects, accepts };
  if (rejects * 2 > cast) return { outcome: 'reject', cast, rejects, accepts };
  if (accepts * 2 > cast) return { outcome: 'accept', cast, rejects, accepts };
  return { outcome: 'split', cast, rejects, accepts };
}

/** The floors of 40.2.4's table: arm C 4; frontier only 2; open-weight only 2. */
export const FLOORS = { armC: 4, frontier: 2, openWeight: 2 } as const;

export type Analyses = { armC: Decision; frontier: Decision; openWeight: Decision; armB: { verifier: string | null; outcome: Outcome } };

/**
 * Every analysis of one patch, from one set of votes. Arm B's vote is the same call as that verifier's vote in arm C:
 * the probe's winner, or, when the winner is the author's vendor, the next on the probe's ranking from another vendor.
 */
export function analyses(votes: readonly Vote[], ranking: readonly Verifier[], authorVendor: string): Analyses {
  const armBVerifier = ranking.find((v) => v.vendor !== authorVendor) ?? null;
  const armBVote = armBVerifier ? votes.find((v) => v.verifier === armBVerifier.id)?.vote ?? null : null;
  return {
    armC: decide(votes, FLOORS.armC),
    frontier: decide(votes.filter((v) => v.group === 'frontier'), FLOORS.frontier),
    openWeight: decide(votes.filter((v) => v.group === 'open-weight'), FLOORS.openWeight),
    armB: { verifier: armBVerifier?.id ?? null, outcome: armBVote === 'accept' ? 'accept' : armBVote === 'reject' ? 'reject' : 'below-floor' },
  };
}

/** Rule 5: a patch left with one open-weight vote has no quorum; that vote is reported apart as a one-model result, never pooled. */
export function loneOpenWeightVote(votes: readonly Vote[]): Vote | null {
  const cast = votes.filter((v) => v.group === 'open-weight' && v.vote);
  return cast.length === 1 ? cast[0]! : null;
}
