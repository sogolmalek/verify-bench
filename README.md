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
