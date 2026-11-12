# `fleet simulate`: what it is, how far to trust it, and what it decided

`fleet simulate` replays the whole job history through the REAL dispatcher
(`planTick`, `choosePlacement`, `refusalFor`) in virtual time, without touching
a claw. Any change to how jobs are ordered, held or placed is scored here over
the full corpus before it reaches `src/runners/`. That rule exists because
traffic changes fail in ways a unit test cannot show: deadlock (a job waiting
beside a slot it may use), drain churn, and a fix that moves the wait from one
class of job to another.

The operator's three objectives, in order, are what every run reports beside
history over the same window:

1. **The oldest job in the queue**, sampled every tick: mean, p95 and peak.
2. **Real work over orchestration**: run time as a share of slot time
   (pickup, setup and cleanup are the overhead).
3. **Free claw capacity.**

## Running it

```sh
pnpm run build
node scripts/simulate.mjs --policy baseline --contention 0.3            # what ppe runs today
node scripts/simulate.mjs --policy legacy-hold                          # the validation run
node scripts/simulate.mjs --policy tuned --set narrowFirst=1            # one technique on
node scripts/simulate.mjs --tune heavyFree=2                            # a constant, fleet-wide
node scripts/simulate.mjs --tune-node claw-9:thirdHoldSec=600           # a constant, one node
node scripts/simulate.mjs --without claw-1,claw-3 --clone claw-9=claw-11 # fleet what-ifs
node scripts/simulate.mjs --drop event=schedule                          # workload what-ifs
```

A run over the whole history (about 29,000 jobs) takes 30-40 s alone.
`--json` prints the full report. `--contention` is how much two jobs on one
node slow each other (0.3 = 30% each); run a finding at 0.3, 0.6 and 1.0
before believing it, since the true figure differs by node and job kind.

Where things live:

- `src/runners/sim-engine.ts`: the virtual-time loop.
- `src/runners/sim-fleet.ts`: the fleet over time, rebuilt from the dispatch
  decision log (slots, health, drains, warm slots, memory) and the manifest.
- `src/runners/sim-policies.ts`, `sim-tuned.ts`: the policies. A new traffic
  rule is written here first.
- `NodeState.tuning` (`placement-node-state.ts`): placement constants the
  simulator may override. Live dispatch never sets it.

## How far to trust it

Validated by replaying the code that actually ran (`--policy legacy-hold`)
against what actually happened:

|                  | history    | simulated  |
| ---------------- | ---------- | ---------- |
| queue p50 / p95  | 20 / 326 s | 18 / 317 s |
| work / slot-time | 0.87       | 0.89       |
| claw utilisation | 19%        | 18%        |
| runner-hours     |            | within 3%  |

Known gaps, which the report prints every run:

- **General CI's worst waits are optimistic** (q95 127 s simulated, 202 s
  real), and **jdk21's are pessimistic** (3,033 s against 2,434 s). Part of
  the jdk21 gap is now explained: the simulator counts heavy jobs exactly,
  and until 2026-11-11 the live dispatcher did not (see the heavy count below).
- **No job fails.** Contention stretches a job; it never turns it red. CPU
  starvation, the reason for every heavy hold, is invisible here and has to
  be measured from job history.
- **Real incidents are not reproduced**: stuck runs, budget blackouts, a
  node that reboots.
- **A policy that reads the simulator's own duration estimate is an oracle.**
  `kindPlacement` scored general CI q95 112 s against 133 s for the live pace
  term only because the simulator runs each job at exactly that estimate.
  Score code the dispatcher can actually run.

## What it decided (2026-11-11)

Yardstick: whole history, contention 0.3 unless stated. Differences under
about 5% are noise.

### Built

| change                                                                          | measured effect                                                                         | commit      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| Second heavy job after 600 s instead of 3,600 s (`HEAVY_DOUBLE_HOLD_SEC`)       | oldest mean 500 -> 310 s, queue p99 2,198 -> 1,169 s                                    | 3295dbe     |
| Plan jobs needing a scarce label first (`placementOrder`)                       | jdk21 median 112 -> 78 s, general CI untouched, no churn                                | 9d3b661     |
| A claw with 3+ mint slots takes 2 heavy jobs with no hold (`heavyFreeOf`)       | oldest p95 1,784 -> 1,408 s (claw-9 alone: 1,495 s)                                     | 9d3b661     |
| Placement walk ranks speed for this job's kind ahead of load (pace, 30 s bands) | band sweep 0 / 15 / 30 / 60 / 120 s: oldest p95 1,778 / 1,731 / 1,710 / 1,689 / 1,810 s | 9d3b661     |
| Heavy count includes shards of fully placed runs (`heavy-units.ts`)             | makes the holds above mean what they say; see below                                     | this change |

Together (9d3b661 against the ppe before it): jdk21 median wait ~110 -> 28 s,
oldest mean -2 to -7%, oldest p95 flat or better, general CI q95 +5 to 16 s,
runner-hours -2%.

### Rejected

| idea                                                          | why                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Take claws out of general CI while jdk21 queues (reservation) | adds nothing over scarce-first; general CI's oldest peak 1,180 -> 1,637 s, ~120 reservations and 371 drains a day. jdk21 waits on other Forge jobs: capable claws held Forge in 84% of slots while jdk21 queued. |
| Shortest-expected-job first                                   | jdk21 q95 better, but objective 1 (oldest job) worse and 73 jobs starve                                                                                                                                          |
| Strict oldest-first ordering                                  | noise                                                                                                                                                                                                            |
| Tuning the slow-tier spill floor (claw-5)                     | noise anywhere from 0 to 300 s                                                                                                                                                                                   |
| Warm slots off                                                | pickup overhead 112 -> 144 h, oldest mean 304 -> 396 s: keep them                                                                                                                                                |
| Pairing heavy jobs on 2-slot claws (claw-4, claw-10)          | adds nothing (1,425 s against 1,408) and leaves no slot for light work                                                                                                                                           |

### Left for the operator

| idea                            | simulated effect                                        | why it is not built                                                                               |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| hokon pairs heavy jobs too      | oldest p95 1,165 s, the best score                      | hokon is the emergency backstop, not a claw                                                       |
| One more claw like claw-9       | oldest p95 1,830 -> 1,086 s, jdk21 q95 2,143 -> 1,128 s | hardware; the largest single lever                                                                |
| Fewer scheduled Forge full sets | oldest p95 1,830 -> 1,452 s                             | a cardtable decision; 81% of jdk21 runner-hours are dispatched or scheduled full sets, 10% pushes |
| Decommission claw-1 and claw-3  | general CI q95 109 -> 273 s, 168 jobs starve            | replace their slots first                                                                         |

## The third heavy job, and the count that was not counting

The simulator's largest remaining lever was letting a THIRD heavy job onto a
node after 600 s (oldest p95 ~1,700 -> ~1,300 s with every node allowed). It
was held back because the only evidence about three Forge shards on one node
was claw-4 on 2026-10-08 (4 cores, 15 GB): both extra shards starved and 8
specs failed.

Looking for claw-9's baseline before a trial showed the trial had already
run, by accident. Job history, 2026-10-29 to 11-12, claw-9 (6 cores,
12 threads, 31 GB, 4 slots), full-set forge-e2e shards by the most heavy
jobs on the node during the shard:

| heavy jobs at once | shards | p50     | failed |
| ------------------ | ------ | ------- | ------ |
| 1                  | 41     | 2,493 s | 14.6%  |
| 2                  | 50     | 2,995 s | 24.0%  |
| 3                  | 70     | 3,618 s | 20.0%  |
| 4                  | 43     | 4,112 s | 9.3%   |

forge-jvm full sets: 1,288 / 1,590 / 1,948 / 2,653 s, failing 10.0 / 9.7 /
7.4 / 29.4% (the last n = 17). CPU pressure (`psi300` cpu some) by workers
on claw-9: 1 -> 4.5% median, 2 -> 11.9%, 3 -> 26.1%, 4 -> 43.5% (p95 64.5%).

**Why the hold let it happen.** The heavy count came from the job listings of
runs with something still queued, plus units whose own job was still queued.
A shard whose run was fully placed was in neither. Comparing every heavy
placement in the dispatch log (11-05..11-12) with job history: on claw-9, 273
of 413 saw fewer heavy jobs than were running, 117 of them read 0 while 2 or
3 ran; behind those reading 0, 269 of 281 running shards belonged to a run
with nothing queued. hokon undercounted 44%, claw-8 14%, claw-4 20%.
`heavy-units.ts` now records each heavy mint by runner name, on disk, and the
pass counts a live unit no listing explains as the heavy job it was minted
for.

**Conclusions.**

- Three heavy jobs on claw-9 cost each shard about 1.45x its solo time and
  showed no failure rate above two at once; three shards finish in ~3,600 s
  where back to back they take ~7,500 s. That is the evidence the claw-4
  incident lacked, on the node that matters.
- Four is where it turns: CPU pressure past 40%, the cpu-oversubscribed
  advisory's threshold is 20%, and forge-jvm failures rose (small n).
- Fixing the count alone would HOLD claw-9 at two for an hour, which is
  stricter than what it has actually been running. So the count fix ships
  with a per-node setting, `heavyThirdHoldSec` in the manifest, and claw-9
  carries 600: a third after 10 minutes, a fourth still waits an hour.
- Re-read the trial as described below after a week. Promote the setting to more nodes
  only on that readout; remove it from claw-9 if three-at-once failures move
  above the two-at-once rate.

**Simulated** (whole history, 29,678 jobs, contention 0.3, with the count
fixed; the live dispatcher before this change sits somewhere past the last
row on claw-9, since it was not holding there at all):

| claw-9's third heavy job        | oldest p95 | oldest mean | queue p99 | jdk21 q95 | general CI q95 | run h |
| ------------------------------- | ---------- | ----------- | --------- | --------- | -------------- | ----- |
| waits 3,600 s (count fix alone) | 2,068 s    | 349 s       | 1,388 s   | 2,348 s   | 141 s          | 1,526 |
| after 600 s (the trial)         | 1,782 s    | 304 s       | 1,185 s   | 1,961 s   | 155 s          | 1,546 |
| after 0 s                       | 1,763 s    | 295 s       | 1,194 s   | 1,951 s   | 161 s          | 1,586 |

600 s keeps nearly all of the gain of no hold at a third of its extra
runner-hours. Contention 0.3 charges a shard 1.6x with two others beside it;
claw-9 measured 1.45x, so the simulated cost is if anything high.

**How to read the trial back.** For each heavy shard on the node in job
history, take the most heavy jobs running on the node at any moment of the
shard (itself included), split by job (forge-e2e, forge-jvm) and by set
(a run whose median heavy shard is 1,500 s or more is a full set), and
compare p50 duration and failure rate at 1, 2, 3 and 4. Join `fleet perf`'s
`psi300.cpuSome` by `workers` for CPU pressure. The dispatch decision log's
`capacity[].heavyJobs` against job history shows whether the count is now
right: before the fix, 66% of claw-9's heavy placements undercounted.
