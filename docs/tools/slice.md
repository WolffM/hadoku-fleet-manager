# `fleet slice`

Script: `scripts/runners-slice-install.sh` (the installer),
`scripts/deploy-runners-slice.mjs` (the deployer).

Source: `hadoku_site/scripts/AGENTS.md`, `### runners-slice-install.sh +
deploy-runners-slice.mjs (2026-08-28)`, lines 658–722 at commit `da0653c5`
(2026-10-05). Moved here per #97; hadoku_site replaces that section with a
pointer to this file. Usage details that are properties of the hadoku_site
checkout stay there.

**Verification note:** this pair was not among the files lanes B/C are
editing in this wave, but `scripts/ci-throttle.sh` and
`scripts/deploy-ci-throttle.mjs` are, and the two tools share the fleet
manifest's `machines[]` shape — so the same caution applies if those lanes'
edits touch shared manifest-reading helpers. Checked against `git show
HEAD:<path>` at this worktree's base commit `273a2eb` (2026-10-07).

## Why this exists

The memory half of the same idea as `fleet throttle`: throttle bounds how many
jobs **start**; this bounds how much they may **hold**.

```
pnpm run fleet:slice                              # dry run (hadoku_site side)
fleet slice --machine hokon --confirm             # one box
fleet slice --confirm --restart                   # also converge Slice= placement
fleet slice --check                               # audit, exit 1 on drift
```

It existed as a shell script invoked by hand for four days, and every failure
that produced was invisible. Three, all real:

- Values drifted from the manifest with nothing watching — claws sat at a
  hand-passed `UNIT_MB=4608` while the repo said 4096.
- A fleet-wide run reported `changed=27` and changed **nothing live**: a
  drop-in is inert until a `daemon-reload`, and with `RESTART=0` nothing
  issued one.
- hokon's 24 user-manager runner units were **uncontained** (`app.slice`,
  `MemoryMax=infinity`) while the 16 GiB cap on its 2 system units made the
  machine look covered — 24 of 26 runners with no ceiling, on the box that
  also runs mgmt-api, the tunnel and the other production services.

## What is derived and what is declared (unchanged)

`slice.maxMb` is normally **absent** and derived on the node as `measured
MemTotal - minFreeMb` (confirmed: `scripts/deploy-runners-slice.mjs:26-29,
202-227`). The manifest's `ramGb` is rounded — claw-1 says 11G and measures
11,885 MiB — so a ceiling computed from the declared figure would reserve the
wrong amount; the probe reads `/proc/meminfo` on the box itself. hokon
declares `maxMb: 16384` explicitly because CI there runs beside the
production host's own services. `slice.name` defaults to `runners.slice`; hokon overrides it to
`ci-runner.slice`, which already holds its system units — defaulting there
would migrate them out of a capped slice, a containment change wearing a cap's
clothes (confirmed: `scripts/deploy-runners-slice.mjs:32`,
`scripts/runners-slice-install.sh:16-17`).

**Restarts are off by default and that is safe for the part that matters.**
`MemoryMax` applies to a running unit on `daemon-reload`; only `Slice=`
placement waits for the next start. So the ceiling lands immediately and
placement converges as runners cycle naturally.

## New since the source section: `unitMemoryMaxMb()` — one shared per-unit cap

The source section describes only the slice-level derivation above. The
per-**unit** cap (`UNIT_MB`, each runner's individual `MemoryMax`) is now
computed by a single shared function, `unitMemoryMaxMb()` in
`src/runners/ephemeral.ts`, imported by both this deployer and the JIT/warm
runner provisioning path (`scripts/deploy-runners-slice.mjs:60-69`,
`scripts/runners-slice-install.sh:58-71`). The installer's own comment records
why this consolidation happened: a standing runner's unit
(`actions-runner-hadoku-fleet-manager.service`) and a warm-provisioned one
(`warm-claw-4-hadoku-fleet-manager.service`) had been computing their
`MemoryMax` from two different code paths and disagreed — confirmed in the
installer's header (`scripts/runners-slice-install.sh:58-71`). This is a
genuine design change since 2026-08-28, not just more code: the per-unit
ceiling is no longer something this tool computes alone.

## Three traps this hit (unchanged, confirmed present)

- **`LoadState` is the only honest discriminator.** `systemctl show` answers
  for units it has never heard of — asked about a USER unit, the SYSTEM
  manager returns `MemoryMax=infinity`, not an error, not an empty string. An
  emptiness check never fires, so all 24 of hokon's freshly capped units read
  back as uncapped. Confirmed: `scripts/runners-slice-install.sh:240-262`,
  `:286` (`LoadState --value` checked for `"loaded"` before trusting any
  other property of a unit).
- **Reads need no root; only writes do.** Reads routed through `sudo -n` on a
  box without passwordless sudo (hokon) return **empty**, not an error — the
  run reports on 24 units while believing it covered 26. Confirmed:
  `scripts/runners-slice-install.sh:231-233` and the read helpers at `:751,
:786` reading via plain `systemctl show`/`--user show`, not `sudo -n`.
- **`/sys/fs/cgroup/$SLICE_NAME/memory.max` only resolves for a top-level
  system slice.** hokon's `ci-runner.slice` is nested, so a direct path read
  returns `-` and the machine looks like it has no slice at all — ask
  `systemctl`, don't guess the path. Confirmed:
  `scripts/runners-slice-install.sh:786-792` (`sysshow` wraps
  `systemctl show ... -p MemoryMax`, no raw cgroupfs path read for the
  slice-level value).

## Known, deliberately reported, not failed on (unchanged)

The ceiling is enforced in **both** managers and they do not share a budget:
user units live under `user@<uid>.service`, outside the system slice, so
`maxMb` is a per-manager ceiling and a machine's CI total is bounded at up to
**twice** it. Every run prints this; it is not treated as drift because it's
what the manifest currently declares. Fixing it means either splitting the
budget or capping `user@1000.service` itself — the latter would cap
production PM2 too. Open decision, confirmed still open: no manifest field or
code path in `scripts/deploy-runners-slice.mjs` or
`scripts/runners-slice-install.sh` splits this budget today.

`check:slice` (`fleet slice --check`) needs ssh — same reasoning as
`fleet throttle --check`. When a machine has system-side drift _and_ no
passwordless sudo, the audit says so and prints the `sudo -v && …` form,
rather than telling an operator to re-run `--confirm` on a box that just
failed for lack of sudo.

## Verified against this worktree (2026-10-07, base `273a2eb`)

**6 claims verified unchanged**: the three real incidents motivating the
tool, the derived-vs-declared `maxMb`/`slice.name` model, restarts-off-by-
default being safe for `MemoryMax`, all three systemd traps (`LoadState`,
`sudo -n` read blindness, nested cgroup path), and the known dual-manager
budget gap.
**1 claim changed (addition, not contradiction)**: per-unit `MemoryMax`
computation moved out of this tool alone and into a shared
`unitMemoryMaxMb()` (`src/runners/ephemeral.ts`), after a standing-vs-warm
unit disagreement bug was found
(`scripts/runners-slice-install.sh:58-71`).

## Desktop priority (hokon, 2026-10-16)

Not part of `fleet slice` — hand-installed with
`deploy/systemd/user-priority/install.sh`, no root. It exists because
concurrent agent test runs (three `vitest` runs, one with 11 forks, plus a
Playwright e2e job with its Java bridges) drove hokon to load 40 on 12 cores
and the Plasma desktop went sluggish.

Two findings:

- **The CI weight never applied.** `ci-runner.slice` is a child of `ci.slice`
  (systemd's dash hierarchy), so its `CPUWeight=50` ranked it only within
  `ci.slice`. `ci.slice` was at the default 100 — level with `session.slice`.
  The system twin has the same shape; its `ci.slice` was inactive when this
  was found and was left alone.
- **Agent panes ranked with interactive apps.** tmux 3.5 puts every pane in a
  transient `tmux-spawn-<uuid>.scope` under `app.slice`, beside Firefox and
  Konsole, all at weight 100.

Weights under `user@1000.service` after the fix:

| cgroup                         | CPUWeight | drop-in                             |
| ------------------------------ | --------- | ----------------------------------- |
| `session.slice` (kwin, plasma) | 1000      | `session.slice.d/priority.conf`     |
| `app.slice` children (apps)    | 100       | default                             |
| `ci.slice`                     | 25        | `ci.slice.d/priority.conf`          |
| each `tmux-spawn-*.scope`      | 20        | `tmux-spawn-.scope.d/priority.conf` |

The tmux drop-in is a unit-name prefix drop-in, so it applies to every new
pane's transient scope with no tmux change (verified with a
`systemd-run --scope --unit=tmux-spawn-…` probe). Weights only act under
contention; idle tests still get every core. `daemon-reload` does not
re-weight existing cgroups, hence the `--runtime` pass in the installer.

`IOWeight` is set alongside. The `io` controller is now delegated to the user
manager (`cgroup.subtree_control` is `cpu io memory pids`), but a weight still
does nothing on hokon's root disk while io.cost sees no contention (below).
Memory is deliberately uncapped per pane for now.

### Agent panes cannot starve PM2 (2026-11-27)

`app.slice.d/io-cap.conf` caps `app.slice`, every agent pane included, at
120 MB/s written and 250 MB/s read on the root LV (`io.max`, on the dm-crypt
device 254:0). Weights could not do it: io.cost's auto model rates the NVMe at
1.7 GB/s, so at the ~400 MB/s parallel Rust builds wrote it saw no contention,
while btrfs over dm-crypt stalled every writer. mgmt-api blocked its event
loop 4-22 s at a time (CPU profile: `writeFileSync`, directory prunes, file
refaults), and the command station's grant read and a friend-key mint ran past
the edge's 30 s. Measured the same hour, after the cap: `pm2-hadoku.service`
io pressure avg60 43% → 1.6%, mgmt-api's worst stall 22 s → 52 ms. Agent panes
pay for it: `app.slice` io pressure rose to ~47%.

### Sized to the device, plus a memory ceiling (2026-11-28)

120/250 MB/s held but was not enough. In the two all-claw heartbeat losses after
it (2026-11-27 05:32Z, 06:39Z) `app.slice`'s charged writes stayed at 26-94
MB/s while the root LV sat 97-98% busy: btrfs metadata and dm-crypt writeback
are charged to no cgroup. The cap is now **60 MB/s write, 150 MB/s read**, on
`app.slice` and on hokon's minted CI (`ci.slice.d/io-cap.conf`). Measured
under an 8-writer small-file storm in `app.slice`: claws' tailnet connect p99
under 100 ms, mgmt-api ready p99 under 15 ms. Prod's own io pressure still
peaked at 16-23% avg10, and an `IOWriteIOPSMax=600` A/B did not lower it
(device busy fell 40% → 15%, prod pressure did not), so what remains is btrfs
commit contention that no per-cgroup cap reaches. No IOPS cap ships.

`app.slice.d/memory-cap.conf`: `MemoryHigh=24G`, `MemoryMax=28G`,
`MemorySwapMax=20G`. A runaway pane test is throttled and then OOM-killed in
its own slice, and total swap stays under swap-black's 32 GB, so nothing
spills onto `/swapfile-invoke` on the root btrfs (1-9 GB did on 2026-11-27).

The root half (pm2's `MemoryHigh` 20G → 26G, tailscaled's logs on tmpfs) is
`deploy/systemd/hokon-prod-guard/install.sh`, run by the operator.

## Dev slices: the shadow week (hokon, 2026-11-24)

**Why.** On 2026-11-24 the Forge coordinator (pm2 `cardtable`) lost its claws
15 times in a day. Each time, both ends of the link went silent for 10 s
together. The claws were healthy. hokon was frozen: load 70 to 314 on 12
cores, swap 25 GB on the dm-crypt root, I/O pressure 40 to 76% at the alert
minutes. The coordinator's CPU weight (1000) and memory floor held. Its I/O
weight is inert (#158). Since boot (11-18), agent sessions had used 256
CPU-hours, 219 of them tsunami-surfer's, against 283 for all CI.

The pane drop-in above is **per pane**: 50 panes at weight 20 outweigh Firefox
ten to one, and nothing caps their memory. The plan:

```
app.slice/
  app-dev.slice               every agent session: one ceiling (CPUQuota, MemoryHigh)
    app-dev-<repo>.slice      one per repo, by weight: fair between repos
```

A pane's children (headless Chrome, vite, cargo, Gradle) inherit its cgroup,
so placing the pane places everything it starts. Docker containers, `systemd-run`
units and pm2 apps escape. That is fine for pm2, which is meant to be protected.

**Shadow first. Nothing is moved yet.** `fleet dev-usage --sample` runs every
minute from `dev-usage.timer` (installed by `user-priority/install.sh`). It
attributes each `tmux-spawn-*.scope`, and any other `app.slice` cgroup holding
a `claude` process, to a repo by the session's working directory. It does the
same for each CI unit under `ci-runner.slice`, by unit name. Rows go to
`~/.hadoku-mgmt/dev-usage/<day>.jsonl` (30 days). `fleet dev-usage [--hours N]`
reports per-repo use. It also reports how often the proposed ceilings
(`PROPOSED` in `scripts/lib/dev-usage.mjs`: 8 cores, 24 GiB for all dev
sessions together) would have bitten, and whose work they would have slowed.

**Why measure in place rather than move panes for the week.** Three things
read the `app.slice/tmux-spawn-*.scope` layout, and moving a pane breaks each
of them silently:

| reader                     | what it does with the layout                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `~/.local/bin/game-mode`   | freezes `app.slice/tmux-spawn-*.scope`; a moved pane keeps running  |
| `~/.local/bin/memtriage`   | reclaims only `*tmux-spawn-*` cgroups; a moved pane is never parked |
| `user-priority/install.sh` | re-weights live `tmux-spawn-*.scope` units                          |

Enforcing moves panes and changes all three in the same change.

**Enforcing** waits for a week of rows read with the operator, from 2026-12-01.
The I/O weight only means something once #158 lands.

## PM2 survives a memory incident (hokon, 2026-11-21)

On 2026-11-21 07:57–09:07Z hokon's memory pressure sat at ~60% for an hour,
cardtable's prod server stalled up to 32 s at a time, and six matches
restarted. Three things let it happen, each read from the kernel's own files:

- **PM2's protection was inert.** cgroup2 is mounted `memory_recursiveprot`, so
  a child's `memory.min`/`memory.low` cannot exceed its ancestors'.
  `system.slice` was at 0/0, so `pm2-hadoku.service`'s `MemoryLow=8G` (and the
  journald/oomd/tailscaled Mins) protected nothing. The user tree held a
  hand-set Min 8G / Low 12G, so the kernel spared CI and reclaimed PM2.
- **CI was throttled, never killed.** Three units filled `ci-runner.slice` to
  its 12G `MemoryHigh` (`memory.events` `high` = 7.7M) and refaulted 1.2–2 T
  off the NVMe that PM2 swaps to. The only oomd kill rule on CI was on the
  system `ci.slice`, which has no cgroup on hokon.
- **The units outlived their jobs.** GitHub logged "the self-hosted runner
  lost communication" and closed the jobs at ~08:09Z. The units ran until
  09:06Z, one `Post Run actions/checkout` taking 33 minutes, and GitHub had
  already removed the registrations the reap walks.

What changed:

| where                | what                                                                                                                        | installed by                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `system.slice`       | `MemoryMin=13G`, `MemoryLow=17G`                                                                                            | `deploy/systemd/pm2-protection/install.sh` (root) |
| `pm2-hadoku.service` | `MemoryMin=12G`, `MemoryLow=16G` (working set 12.6G, peak 21.5G)                                                            | same                                              |
| user tree            | its hand-set floor, unchanged, moved out of `system.control/` into named drop-ins                                           | same                                              |
| `app.slice` (user)   | `MemoryMin=8G`, `MemoryLow=8G`: claims the user floor so none of it shields CI                                              | `deploy/systemd/user-priority/install.sh`         |
| `app.slice` (user)   | `IOWriteBandwidthMax=60M`, `IOReadBandwidthMax=150M` on the root LV; `MemoryHigh=24G`, `MemoryMax=28G`, `MemorySwapMax=20G` | `deploy/systemd/user-priority/install.sh`         |
| `ci.slice` (user)    | `IOWriteBandwidthMax=60M`, `IOReadBandwidthMax=150M` on the root LV                                                         | same                                              |
| `ci.slice` (user)    | oomd `kill` at 50% memory pressure for 30 s                                                                                 | same                                              |
| every minted unit    | `LimitNICE=+0`: a browser in a job cannot raise itself above the node                                                       | `ciUnitProperties`                                |
| the reap             | stops a live JIT unit 10 min after GitHub's `workflow_job` `completed` names its runner                                     | `stopFinishedUnits`                               |

Both installers take `--dry-run`. The perf row's `ciMemory` (ci.slice
pressure plus its `high` count) is the data for tightening the oomd limit.
Agent sessions' Chrome still self-raises: a scope cannot carry an rlimit, and
the user manager's `DefaultLimitNICE` is left alone because pipewire, kwin,
the game and Discord rely on it.

## Converged by the controller since 2026-10-24 (fleet-manager#1)

`fleet converge-provisioning` runs every 30 minutes inside mgmt-api
(`src/provisioning-converge.ts`). It reads both `--check`s, repairs only the
nodes that drifted (throttle env, standing-unit slice placement and cap), and
reads those nodes again. Idle units only; a node drifting on both facets
restarts each unit once. It logs what it changed and pages only on a repair
the re-check still disagrees with, or a deferral behind a live job that has
lasted 6 hours. `check:slice` in hadoku_site is now the backstop and should
find nothing.
