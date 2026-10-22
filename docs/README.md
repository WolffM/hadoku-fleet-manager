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

## Arriving in Phase 4

These are still **authoritative in `hadoku_site`** and are edited there while the
extraction is pending. Copying them early would create two drifting copies of
documents this migration depends on being correct.

| doc                                         | lines | current location               |
| ------------------------------------------- | ----- | ------------------------------ |
| `SELF_HOSTED_RUNNERS.md`                    | 1,248 | `hadoku_site/docs/operations/` |
| `fleet-rearchitecture-2026-08-25.md`        | 2,538 | `hadoku_site/docs/planning/`   |
| `fleet-consolidation-handoff-2026-08-28.md` | 344   | `hadoku_site/docs/planning/`   |
| `fleet-runner-reconciler.md`                | 155   | `hadoku_site/docs/planning/`   |
| `hokon-ephemeral-runners-2026-08-25.md`     | 184   | `hadoku_site/docs/planning/`   |
| `CLAW_ADMIN_RECOVERY.md`                    | —     | `hadoku_site/docs/operations/` |
| `claw-fleet-migration.md`                   | —     | `hadoku_site/docs/archive/`    |
| `cktest-runner-migration.md`                | —     | `hadoku_site/docs/archive/`    |

`hadoku_site` runs `check:doc-paths`, which validates that every path a doc cites
exists. Moving a doc that cites `scripts/admin/…` before the scripts move would
turn that gate red — which is why the docs go LAST, with the code they describe.

## Private

`planning/` — the live workstream board (`planning/workstreams.md`, start there),
the migration plan (`planning/fleet-manager-extraction-2026-08-29.md`: §3 before
adding an export, §8 before touching the fleet) and every dated design note. It
lives at the same path in `WolffM/hadoku-fleet-manager-private` and is not
published: it records the operator's network and machines in detail.
