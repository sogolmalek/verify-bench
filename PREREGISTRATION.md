# Pre-registration

Fixed 2026-11-07, before any verifier was called on a sampled PR. A null result is a result.

## The question

Across coding agents, how many pull requests that look clean stay clean, and does a verifier from another vendor rank the ones with later-found problems above what size alone would?

**A PR can be all green and still be wrong.** CI green, no person's commit and no requested change is an upper bound on quality, not quality. So the claim tested is a risk ranking, not "safe to skim".

## Population

Public PRs by these agents: Copilot coding agent, Claude (GitHub app), Devin, Cursor (GitHub app), Codex (task link), Jules. Secondary, because a person's commits can't be told apart there: Claude Code and Cursor agent notes in the PR's body.

- At least 100 stars, not a fork or archived, CI known, at most 2,000 lines.
- Created from 2026-09-03, the day after the latest verifier's release, and merged at least 30 days before the read.
- **Primary: independently judged:** merged by someone other than the PR's own account (and not a bot), or closed by another person. Everything else is counted and reported apart.

## Sample

About 1,000 patches, at each agent's natural share of merged and closed, at most 170 an agent, at most 15% of an agent's from one repository. The 30 PRs in `tasks/probe.json` are held out. The sample may be smaller if the verifiers' capacity requires, set from the probe's seconds per vote, and the report says so. Codex and Jules are too concentrated to carry a row, and are reported as counts.

## The patch, and what a verifier sees

The agent's own patch, at its last commit before any person's.

A verifier sees the PR's title and description, with markers of who wrote it, links, and claims about tests or CI removed (`src/agentPrs.ts`), and the diff. It never sees the PR's state, comments, reviews, CI, later commits or author. The agent's own tests are in the diff, as a reviewer sees them.

The prompt and the answer are fixed in `src/rankVerifier.ts`: a `decide` tool with accept or reject, a confidence from 0 to 100 that the patch is correct, and a reason. No verifier sees another's answer.

## Verifiers

| Verifier | Vendor | Runs on |
|---|---|---|
| Qwen 3.8 27B | Alibaba | Nosana, a 3090 |
| GLM-4.7-Flash | Zhipu | Nosana, a 3090 |
| Devstral | Mistral | Nosana, a 3090 |
| Gemini 3.8 Flash | Google | Free tier: public code only |

**No verifier from the agent's vendor.** So Gemini isn't called on Jules. Copilot, Cursor and Devin don't say which model wrote a PR, so the rule can't be applied to what's behind them, and their rows are also reported leaving out each verifier in turn, from the same votes.

No frontier model is called as an author. These patches are already written.

## Arms

| Arm | Rule |
|---|---|
| A | The risk rules alone, with no verifier: risk paths first, then size |
| B | One open-weight verifier, the winner of the probe on `tasks/probe.json` |
| C | The quorum: 3 of 4 reject, or 2 of 3 when the vendor rule removes one. A split isn't an acceptance. Fewer than 3 votes isn't scored |

**Risk rules are mechanical:** each repository's CODEOWNERS plus one fixed list of paths (`src/agentPrs.ts`). **No decisions are used, so no conflict with a repository's decisions can be found, and every result says so.**

## Truth

**`quality@1`, an upper bound:** merged, CI green at merge, no person's commit, no requested change, not reverted or fixed forward within 7 days.

**`quality@2`,** read only on PRs old enough for the window to have passed:

| Part | Measure | Window |
|---|---|---|
| Line survival | The share of the agent's added lines unchanged | 30 days; 14 beside it |
| Later touch | Any later commit changing the agent's lines, whatever its message, by a person or another agent | 30 days |
| Later issues | Bug issues linked to the PR or referencing it later, and linked issues reopened | 30 days |
| Review intensity | Review comments, and rounds of requested changes | Before the merge |

**A later-found problem:**
- **Strict, the primary:** reverted, a later issue, or a later change to the agent's lines with a fix message or a test. A refactor isn't a bug.
- **Broad, beside it:** reverted, a later issue, or any later touch by anyone else.

`quality@2` is 1 when `quality@1` is 1 and there's no strict later-found problem. Line survival and review intensity stay numbers, with no threshold.

**Where this is noisy:** a closed PR may be superseded or stale. A merge isn't a review. A person's commit may be cosmetic. A later touch with a test can still be unrelated to a defect. A bug nobody has fixed or reported against the PR isn't seen. The model behind several agents isn't known, so a row is an agent, never a model. The task was chosen by whoever ran the agent, and the repositories chose to accept agents at all.

## Primary results

1. **Recall at k:** of the strict later-found problems, the share in the top 10%, 20% and 30% of each arm's ranking, with a bootstrap over repositories, over merged PRs, **against a random ranking and against size alone,** paired. **The claim holds for an arm only if, at k = 20%, its difference from size has a lower bound above zero. Arm C is the primary arm.** Broad is reported beside it.
2. **The base rate:** the share of independently judged PRs that were clean, per agent, by `quality@1` and `quality@2`, with Wilson and bootstrap intervals, merged only and with closed PRs.

## Secondary results

- **Skim:** precision and coverage, per arm, under both truths. A patch is skim when its verifier or quorum accepts and no risk path changed.
- **The full precision-coverage curve, per arm.** Descriptive.
- **Two operating points: precision's lower bound at or above 0.95 at coverage at or above 0.40, and at coverage at or above 0.15.** Each threshold is cross-fitted, five folds by repository. Both the Wilson and the bootstrap lower bound must clear.
- **Verifier recall:** the share of wrong patches rejected, by how they were wrong, and the share of right ones wrongly rejected.
- The note rows, and each leave-one-verifier-out.
- Fail to pass, as its own column, where the sandbox can run it. It shows only that an agent's tests match its patch.

## Predictions

| Prediction | Basis, before the run |
|---|---|
| `quality@1` clean: at most about 40% of independently judged PRs | About 45% of independent merges, before reverts and fix-forwards, on a read-only sample of 88 to 198 PRs |
| `quality@2` clean: about 30% of independent merges (strict), 20% to 25% (broad), and below `quality@1` for every agent with at least 50 PRs | 26 of 88 and 21 of 88 |
| Most lines survive: about 88% at 30 days, 91% at 14, with wide gaps between agents that may be their repositories | The same 88 |
| Size alone beats random: recall at 20% of 25% to 35% | 28% on the same 88. A larger PR has more lines to touch |
| Arm C beats random. Whether it beats size isn't predicted | |
| Arm B doesn't beat size | One model, with no second reader |
| Skim clears neither operating point | At a 40% base rate, catching 40% of wrong patches and wrongly rejecting 15% of right ones gives precision about 0.49. Reaching 0.95 takes catching about 97% |

## Hidden defects (designed, not built)

For PRs that looked clean, in this order:

1. **Later-test oracle.** A later commit changes the agent's lines and adds a test. Run that test at the agent's commit, and at the later commit as the control. Failing at the first and passing at the second, when the later commit is a fix, is a confirmed hidden defect. A floor, never a rate.
2. **Static checks,** new findings on the changed files, as one more ranking.
3. **Behavioral diff,** property-based inputs on the changed functions, before against after. Python and TypeScript first. A change in behavior, not a bug.
4. **Cross-vendor intent tests.** A verifier from another vendor reads the task and the parent commit, never the patch, and writes tests. Failures are possible intent misses, never confirmed bugs, and agreement with the oracle is measured.

## The stop rule

The probe first. It reports seconds per vote and the credits spent, then stops. The sample is set from it. Every count, exclusion, interval and the spend is reported in any case.

## Amendment 1 (2026-11-08, approved by the owner, after the probe, before any sampled PR is voted on)

The probe's 11 missing votes were all answers without a valid decision. 9 stopped at the 4,000-token limit, which a thinking model's reasoning counts toward. The server ignores `tool_choice`, so a model can answer in text. In `src/rankVerifier.ts`:
- The answer's limit is 16,000 tokens, or less where the 32,768-token context requires. A PR leaving under 4,000 is counted as too long, for every verifier.
- An answer in the text counts when it holds a decision, in any of the forms the tests list. Prose without one is still a missing vote.
- A missing vote records why.

The prompt, the tool, the models, thinking at each model's default, and the rule that a missing vote is missing are unchanged.

## Amendment 2 (2026-11-08, approved by the owner, before any sampled PR is voted on)

Gemini's free tier allows 20 requests a day, so 1,000 votes would take 50 days. **The run goes without Gemini, and arm C is 2 of 3**, as the arms allow when a verifier is removed. Gemini votes 20 PRs a day from the same order, in its own job, with its own Google project's key. Those votes are reported apart and never counted in arm C.

**The sample:** 1,000 PRs at most 170 an agent, independently judged, drawn by `scripts/sample.mts` from GitHub's search day by day, with seed `verify-bench-40.10`. The run walks its order on the three verifiers at once. It is scored on the PRs every verifier answered, and stops at 7.879 Nosana credits (8 in all, with the probe).
