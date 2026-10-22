# `fleet throttle`

Script: `scripts/ci-throttle.sh` (the hook), `scripts/deploy-ci-throttle.mjs`
(the deployer), installed via `scripts/ci-throttle-install.sh`.

Source: `hadoku_site/scripts/AGENTS.md`, `### ci-throttle.sh +
deploy-ci-throttle.mjs (2026-08-24)`, lines 600–657 at commit `da0653c5`
(2026-10-05). Moved here per #97; hadoku_site replaces that section with a
pointer to this file. Usage details that are properties of the hadoku_site
checkout stay there.

**Verification note:** lanes B and C in this same wave are editing
`scripts/ci-throttle.sh`, `scripts/deploy-ci-throttle.mjs` and
`scripts/ci-throttle-install.sh` concurrently. Every claim below was checked
against `git show HEAD:<path>` at this worktree's base commit `273a2eb`
(2026-10-07), **not** the live working tree — so a lane-in-flight edit is not
described here as settled, and this file may need a follow-up pass once B/C
land.

## Why this exists

The fleet's only real concurrency limit. On 2026-08-24 the 13:00 UTC fan-out
dispatched 14 repos in 4 seconds; **eleven** landed on claw-2 — the box with
the _least_ RAM in the fleet (7G against claw-1's 11G and claw-3's 15G) — and
the kernel OOM-killer reaped two while ~20GB sat free on the other two claws.

Every existing lever is the wrong shape for this:

| lever              | what it actually is                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| registrations      | per-repo, so N repos = N listeners = up to N simultaneous jobs (claw-2: 26) |
| `maxRegistrations` | bounds that N — at 26, where ~3 is safe                                     |
| `runs-on`          | GitHub assigns arbitrarily among eligible runners, no "full" signal         |

The runner itself is the only place left that can say no, and
`ACTIONS_RUNNER_HOOK_JOB_STARTED` is its only synchronous point. Per
actions/runner ADR 1751, the hook blocks the job, has **no timeout of its
own**, and _any_ non-zero exit fails the job with an annotation.

```
pnpm run fleet:throttle                                # dry run (hadoku_site side)
fleet throttle --confirm                                # install fleet-wide
fleet throttle --machine claw-2 --confirm               # one box
fleet throttle --machine hokon --include-guests --check
```

## It is a smoother, and — changed since 2026-08-24 — no longer _only_ a smoother

The source section describes it as delaying a job's start on the machine
GitHub already picked, and says: "After `MAX_WAIT_S` (90s...) it starts
anyway and annotates the job, because holding a build past its own timeout
turns a slow build into a failed one," and "the script bounds its own wait and
exits 0 on literally every path."

**That is no longer accurate.** The current hook (`scripts/ci-throttle.sh:89-98`,
confirmed at `git show HEAD`) documents a deliberate reversal:

> The one path that does NOT fail open: a job that waited the full
> `MAX_WAIT_S` and the node is STILL over its declared limit when the wait
> ends. `MAX_WAIT_S=90` used to admit there too ("spreads a burst, cannot cap
> one" — true only for a burst that clears in time), and that is exactly what
> let four concurrent jobs pile onto claw-1's `maxConcurrent: 3` on
> 2026-09-01 and thrash vitest's worker fork into a 3m21s stall... the same
> shape that OOM-killed two jobs on claw-2 on 2026-08-24. A cap that always
> eventually admits is not a cap. So that exit is deliberately non-zero.

So: a job that gets a slot inside the wait is admitted immediately (spreads a
burst). A job that does **not** get a slot by `MAX_WAIT_S`, and whose node is
_confirmed_ still over its declared limit, is now **refused** (non-zero exit,
annotated) — see `scripts/ci-throttle.sh:760-811`. Every other failure mode
(no config, unreadable `/proc`, bad arithmetic, an exempt workflow) still
fails open and starts the job, per the file's own stated principle: "FAILS
OPEN ON UNCERTAINTY, REFUSES ON A CONFIRMED BREACH."

## Load counting — changed since 2026-08-24

The source section says busy is read "from the PROCESS TREE (a
`Runner.Worker` whose parent is that dir's listener), not the GitHub API."
That's still the _substrate_, but the counting rule on top of it changed. A
naive `pgrep -x Runner.Worker` minus the current job's own worker double-counts
**waiters**: every job blocked inside this same hook also has a
`Runner.Worker`, so a burst counts itself. This recurred concretely on hokon
2026-09-17/18/19 (pygmalion, resume-bot, study, task): four jobs arriving
together each saw the other three plus real load, `4 < 4` was false for all
four, nobody was ever admitted, and all four were refused at the 90s ceiling
with 26GB free and a real load of one.

The fix (`scripts/ci-throttle.sh:42-83`): a job counts as load only once
**admitted**, and says so itself by writing
`$HOME/.hadoku/throttle/admitted/<pid>.<starttime>` on admission (pid = its
own `Runner.Worker`, starttime = field 22 of `/proc/<pid>/stat`, so a reused
pid with a different start time reads as a different, stale marker). The
marker is never deleted by a completion hook — the one
`ACTIONS_RUNNER_HOOK_JOB_COMPLETED` slot is already taken by `job-metrics.sh`
— so it's **self-reaping**: the pid it names _is_ the job, so the marker stops
counting the instant the job ends, and the next run unlinks it on sight. The
count-and-claim is one atomic step under `flock`, without which the four
waiters above would all read "under the limit" in the same instant and all
admit — the pile-up this file exists to prevent, arrived at from the other
side. JIT slots are deliberately not hook-throttled (their concurrency is the
dispatcher's, and `systemd-run` gives them `MemoryMax` directly), so they hold
no marker; `MIN_FREE_MB` is what still sees them, since it reads the kernel
directly.

## Mutation-testing finding (unchanged)

Still present and confirmed verbatim in intent at `scripts/ci-throttle.sh:748-767`:
feeding the script a deliberately malformed config made every `[ x -lt y ]`
evaluate false, so the script waited the **full** 90s ceiling on a completely
idle machine — failing _closed_, throttling harder than any intentional
setting, the exact opposite of its stated contract. `MAX_CONCURRENT`,
`MIN_FREE_MB` and `MAX_WAIT_S` are now validated after sourcing; anything
unparseable is discarded for the permissive default, loudly.

## Exemptions, restart model, deployment (unchanged)

- `runner-smoke`/`runner-diag` are exempt outright: they carry the fleet's
  only 2- and 3-minute job budgets and are diagnostics _about_ the runner, so
  delaying them is both risky and self-defeating
  (`scripts/ci-throttle.sh:462-470`).
- Limits are rendered from `machines[].maxConcurrent`/`.minFreeMb`, never
  hand-written on a box (`scripts/deploy-ci-throttle.mjs:22,180-181`). claw-2
  gets a lower `maxConcurrent` than claw-1 at a comparable core count because
  memory binds first there.
- A restart is required and deliberately **partial**: `.env` is read once at
  listener start, so restarting mid-job kills that job. Only **idle** runners
  are restarted; busy ones are reported and picked up by the next run, which
  makes the command idempotent (`scripts/deploy-ci-throttle.mjs:29-37`).
- `check:throttle` (this repo's `fleet throttle --check`) needs ssh — a
  machine whose runners are unwired has no limit at all, so the manifest
  values are inert until this has run there, and the audit is what stops that
  being invisible.

**New since the source section**, not contradicting it but worth flagging for
anyone reading the old prose expecting a simpler tool: `deploy-ci-throttle.mjs`
now also guards `--check`/`--confirm` mutual exclusion explicitly ("a verifier
that reads its own writer's artifact cannot fail" —
`scripts/deploy-ci-throttle.mjs:144-154`), supports `--include-guests` for
hokon with an explicit refusal path if a bare `--confirm` would otherwise ssh
the production host, and renders a `~/.hadoku/standing.env` file alongside the
runner `.env`s so a warm listener minted _between_ deploys can still build its
own throttle env.

## Verified against this worktree (2026-10-07, base `273a2eb`)

**4 claims verified unchanged**: why nothing else could do this (the lever
table), the exemption of runner-smoke/runner-diag, the rendered
maxConcurrent/minFreeMb limits, the partial-restart model, and the
mutation-testing finding.
**2 claims changed**: (1) the refusal path is no longer "starts anyway and
annotates" — a confirmed breach at the end of `MAX_WAIT_S` now exits non-zero
and fails the job, reversed deliberately after a 2026-09-01 incident
(`scripts/ci-throttle.sh:89-98`); (2) load counting moved from raw
`Runner.Worker` process-tree counting to an admitted-marker model with
`flock`, after a waiters-count-as-load bug recurred three nights running on
hokon (`scripts/ci-throttle.sh:42-83`).
