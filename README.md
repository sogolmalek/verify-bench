# verify-bench

A public measurement: across coding agents, how many pull requests that look clean stay clean, and does a verifier from another vendor rank the ones with later-found problems above what size alone would?

- **[PREREGISTRATION.md](PREREGISTRATION.md)** is the plan, fixed before the run.
- `src/` holds the bench: truths, ranking, the verifier's prompt, the vendor rule, triage, scoring. `test/` tests it against fakes.
- `tasks/` holds public PR references. `results/` holds what came back, every vote and its reason.

**It only reads public repositories.** It opens nothing upstream: no PR, comment or CI run against any repository it reads.

The job that holds keys never runs a repository's code. Running a repository's code, when that's built, is a separate job with no secrets and no token.

```bash
npm ci
npm test
```

An earlier design is also here (`src/author.ts`, `src/truth.ts`, `src/plan.ts`, `src/budget.ts`): nine model authors on the same tasks, scored by each PR's own tests. It's kept for later, with no run planned.

## Result: cross-file reach (the secondary analysis, 2026-11-08)

**Reach doesn't rank later-found problems above size, by the pre-registered test.** On 631 merged PRs with a readable patch, in 234 repositories, 99 had a strict later-found problem. 185 had a call site of a changed exported function in a file the patch didn't change.

| At k = 20% | Recall | Against size, paired, 95% | Against random, paired, 95% |
|---|---|---|---|
| Size alone | 35% | | |
| Reach | 39% | +4 [-9, 17] | +29 [6, 31] |
| Reach, then size | 39% | +4 [-9, 18] | +29 [7, 31] |
| Changed functions | 40% | +5 [-5, 16] | +30 [8, 32] |

- **The test:** the lower bound against size must be above zero at k = 20%. It's -9 for reach, so the claim doesn't hold. Without the co-authored stratum, also not: +4 [-9, 20]. On the broad definition, also not: +6 [-6, 16].
- **Every score, size included, beats random.**
- **One cell clears zero:** changed functions at k = 10%, +9 [0, 16], and +11 [1, 18] without co-authored. That isn't the pre-registered test, and it's one cell of many, so it's a lead to test again, not a finding.
- **The random ranking's one draw** finds 10% at k = 20%, below the 20% a random ranking finds on average. So the margins against random are wider than they'd usually be.

Every number is in `results/secondary-reach.json`, from `results/facts.jsonl`, `results/reach.jsonl` and `scripts/secondary-reach.mts`.
