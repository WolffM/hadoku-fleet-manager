# docs

## Here now

- [`VOCABULARY.md`](VOCABULARY.md) — the nouns, the axes, the onboarding verbs,
  and where the `machine` → `node` rename deliberately stops. Read before
  naming anything.
- [`control-plane.md`](control-plane.md) — the controller assumption and which
  subcommands are host-bound.
- [`tools/`](tools/) — the design rationale and known incidents behind
  `tier-fleet`, `header-audit`, `mf-externals`, `reconcile`, `throttle` and
  `slice`, moved in from hadoku_site's `scripts/AGENTS.md` (#97).
- [`hosting.md`](hosting.md) — lending a node to a tenant: leases vs hosting
  nodes, the slice contract, and who owns what once a tenant is placed.
- [`service-state.md`](service-state.md) — the contract a hosted service's
  state must meet before the fleet may move it, give it a standby, or fail it
  over.
- [`herdr.md`](herdr.md) — the `hadoku.fleet` and `hadoku.sessions` herdr
  plugins.
- [`spare-parts.md`](spare-parts.md) — the hardware shelf and what the fleet
  measurably needs; the shelf half lives in the private repo.

## Arriving in Phase 4

These are still **authoritative in `hadoku_site`** and are edited there while the
extraction is pending. Copying them early would create two drifting copies of
documents this migration depends on being correct.

Line counts below are as of 2026-10-29; re-check with `wc -l` before citing one,
the way this table itself drifted (three of eight were stale, three more had
never been measured).

| doc                                         | lines | current location               |
| ------------------------------------------- | ----- | ------------------------------ |
| `SELF_HOSTED_RUNNERS.md`                    | 1,378 | `hadoku_site/docs/operations/` |
| `fleet-rearchitecture-2026-08-25.md`        | 2,785 | `hadoku_site/docs/planning/`   |
| `fleet-consolidation-handoff-2026-08-28.md` | 381   | `hadoku_site/docs/planning/`   |
| `fleet-runner-reconciler.md`                | 155   | `hadoku_site/docs/planning/`   |
| `hokon-ephemeral-runners-2026-08-25.md`     | 184   | `hadoku_site/docs/planning/`   |
| `CLAW_ADMIN_RECOVERY.md`                    | 246   | `hadoku_site/docs/operations/` |
| `claw-fleet-migration.md`                   | 265   | `hadoku_site/docs/archive/`    |
| `cktest-runner-migration.md`                | 350   | `hadoku_site/docs/archive/`    |

`hadoku_site` runs `check:doc-paths`, which validates that every path a doc cites
exists. Moving a doc that cites `scripts/admin/…` before the scripts move would
turn that gate red — which is why the docs go LAST, with the code they describe.

## Private

`planning/` — the live workstream board (`planning/workstreams.md`, start there),
the migration plan (`planning/fleet-manager-extraction-2026-08-29.md`: §3 before
adding an export, §8 before touching the fleet) and every dated design note. It
lives at the same path in `WolffM/hadoku-fleet-manager-private` and is not
published: it records the operator's network and machines in detail.
