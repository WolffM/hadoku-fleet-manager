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
declares `maxMb: 16384` explicitly because CI is a guest on the production
host there. `slice.name` defaults to `runners.slice`; hokon overrides it to
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

`IOWeight` is set alongside but is **inert**: the `io` controller is not
delegated to the user manager (`cgroup.subtree_control` is `cpu memory pids`).
Enabling it needs a root `user@.service` drop-in with `Delegate=`. Memory is
deliberately uncapped per pane for now; the swap pressure seen in the same
incident is not addressed by this.

## Converged by the controller since 2026-10-24 (fleet-manager#1)

`fleet converge-provisioning` runs every 30 minutes inside mgmt-api
(`src/provisioning-converge.ts`). It reads both `--check`s, repairs only the
nodes that drifted (throttle env, standing-unit slice placement and cap), and
reads those nodes again. Idle units only; a node drifting on both facets
restarts each unit once. It logs what it changed and pages only on a repair
the re-check still disagrees with, or a deferral behind a live job that has
lasted 6 hours. `check:slice` in hadoku_site is now the backstop and should
find nothing.
