/**
 * job-metrics — the pure half of `fleet job-metrics`.
 *
 * Joins what the node measured (peak RSS per job, from the kernel) to what
 * job-history recorded (which repo, which job, how long). Separated so the join
 * and the summaries can be asserted without a fleet or an ssh connection.
 *
 * THE JOIN, AND WHY IT IS EXACT
 * -----------------------------
 * A JIT mint's transient unit is named
 * `jit-<node>-<repo>-j<jobId>-r<runId>-<epoch>.service`, so the hook reads the
 * numeric job id straight off its own cgroup. `jobId` is job-history's own
 * primary key, so the join is an identity match rather than a guess.
 *
 * A STANDING runner's cgroup carries no job id — one long-lived unit serves many
 * jobs. There the key is `(repo, runId, runner)`, which is unique because a
 * runner executes one job at a time. It is a weaker key and the code says so:
 * anything it cannot place is reported as unjoined rather than dropped, because
 * a silently discarded measurement is the same lie as a missing one.
 *
 * EVERY FACET CARRIES ITS OWN SAMPLE COUNT
 * ----------------------------------------
 * `job-metrics.sh` has emitted `cpuUsageUsec`, `cpuUserUsec`, `cpuSystemUsec`,
 * `ioReadBytes` and `ioWriteBytes` per job for weeks; the summaries here read
 * peak memory only, which is why "nothing records CPU or I/O" was still being
 * written down in 2026-09 planning docs. The gap was never harvesting — it was
 * summarisation, and this file is where it was missing.
 *
 * Those fields are NOT uniformly present. `io.stat` is absent on some cgroup
 * layouts (a hokon standing-runner row from 2026-09-16 carries all three CPU
 * counters and `ioReadBytes: null`), and `shmemPeakBytes`/`shmemBytes` only
 * exist on rows written after the hook learned to read `memory.stat`. A p95
 * computed over 4 of 500 rows is not the group's p95; it is four samples
 * wearing the group's name — the same class of mistake the 2026-09-07 join doc
 * caught when one run per node read as a node effect. So every facet reports
 * `<facet>Samples` beside its percentiles, ALWAYS, and the percentiles are
 * `null` rather than 0 when nothing carried the field. A reader can then tell
 * "measured, and it is low" from "nobody measured it", which is the whole of
 * "'I could not look' must never render as 'nothing is wrong'" applied to a
 * column instead of a node.
 */

/**
 * THIS FILE IS NOW A BARREL (wave shrink-1 lane D). The join, cost,
 * grouping, variance and node-read logic each moved to their own
 * job-metrics-*.mjs module, named for the one job it does — see each
 * file's own header. Every name below is re-exported unchanged so every
 * existing importer (this file's own tests, collect-job-metrics.mjs,
 * demand-derive.mjs, join-workload-benchmark.mjs,
 * reconcile-job-reserves.mjs) compiles and behaves exactly as before.
 */
