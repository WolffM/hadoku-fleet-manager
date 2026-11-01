/**
 * The `CI_RUNNER` variable's fleet value — moved out of `ci-runner-fallback.ts`
 * (wave clean-1 lane C/D, cut (iii)). `ci-runner-fallback.ts` (ci-scheduling)
 * is still the one WRITER of the variable; `scripts/check-label-floor.mjs`
 * (observation) reads this same literal to judge a repo's form, and config is
 * the one layer both can legally reach. `ci-runner-fallback.ts` re-exports it
 * under its original path, so no existing importer changes.
 */

/**
 * The fleet target. Written on every covered repo whenever the fleet is up.
 *
 * It used to be that "the fleet" meant CI_RUNNER ABSENT, and each of 107
 * workflows across 27 repos carried the fallback itself:
 *
 *   runs-on: ${{ fromJSON(vars.CI_RUNNER || '["self-hosted","hadoku-builder"]') }}
 *
 * That put three pieces of fleet internals in every repo — the label, this
 * variable's name, and the semantics of unset — so the fleet could not change
 * how it is addressed without a 107-file edit. Setting the value explicitly
 * lets a workflow say `fromJSON(vars.CI_RUNNER)` and nothing else.
 *
 * Safe because a GitHub variable is PERSISTENT state, not a lease: if this
 * process dies the last value stays and CI keeps scheduling.
 *
 * THE REMAINING HOLE, STATED HONESTLY. The failure is a repo where the variable
 * was NEVER WRITTEN: with the bare `fromJSON(vars.CI_RUNNER)` form and no value,
 * `runs-on` resolves to nothing and every workflow in that repo fails to start.
 *
 * For a year this comment said that case "is what the seeding pass and `fleet
 * check-runner-var` exist to catch" while neither existed — a comment standing
 * in for a guard, the failure this codebase has now been bitten by four times
 * (handoff §2 counts three). Half of it is now true: `check-runner-var` was
 * built on 2026-09-01 and DETECTS the case, wired as the `ci:runner-var` cron.
 *
 * THE SEEDING PASS STILL DOES NOT EXIST. `syncHostedFallback` (ci-runner-fallback.ts)
 * is the only writer of this variable anywhere in either repo, and it iterates
 * `coveredRepos()`, so it structurally cannot reach a repo that is not in the
 * roster YET — exactly and only the population the original sentence claimed was
 * covered. A new repo has no CI_RUNNER until the nightly reconcile admits it.
 *
 * Consequence for anyone tempted to tidy the last `||` fallbacks away:
 * `hadoku_site/templates/*` MUST keep a fallback. Since 2026-09-01 it points at
 * `'"ubuntu-latest"'` rather than the claw labels — a scaffolded repo has no
 * runners either, so falling back to labels nothing carries aims its jobs at
 * nothing and QUEUES them silently (854 minutes, hadoku-games-host, 2026-08-23).
 * Hosted builds it, and the repo joins the fleet on its own once this module
 * writes the variable. The bare form is correct for a COVERED repo and fatal for
 * a template: its output is by definition not covered yet.
 * hadoku_site/scripts/test/template-runner-form.test.mjs enforces both halves.
 */
export const FLEET_VALUE = '["self-hosted","hadoku-builder"]';
