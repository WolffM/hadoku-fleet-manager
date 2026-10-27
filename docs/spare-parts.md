# Spare parts — the shelf, and where it goes

Living inventory, started 2026-09-18. Two halves: what is on the shelf, and
what the fleet measurably needs. A part leaves the shelf when it is INSTALLED
and the node's `fleet benchmark --write` / `fleet bootcamp --write` has
re-measured it — not when someone decides where it goes.

## Shelf — lives in the private repo, not here

Every physical part, installed or loose, is one row in
`docs/planning/inventory/parts.json` in `WolffM/hadoku-fleet-manager-private`
(at the same path here once `scripts/attach-private.sh` has run). `location`
is `shelf` or a node name, `slot` is where in the node. The claws' rows were
read with dmidecode/lsblk/lspci on 2026-10-27; hokon is not read yet.

## Slots — read 2026-09-18 with dmidecode / lsblk / lspci

| node   | RAM slots (used/total, form, type) | installed | board max | root disk                             | used | GPU        |
| ------ | ---------------------------------- | --------- | --------- | ------------------------------------- | ---- | ---------- |
| claw-1 | 2/2 SODIMM DDR3-1600               | 4 + 8 GB  | 16 GB     | HGST HTS721010 1TB **HDD**            | 57G  | GTX 860M   |
| claw-2 | soldered LPDDR3                    | 8 GB      | —         | SSD                                   | —    | —          |
| claw-3 | soldered LPDDR3                    | 16 GB     | —         | SSD                                   | —    | —          |
| claw-4 | 2/4 DIMM DDR4-2133                 | 8 + 8 GB  | 64 GB     | WD Blue 1TB SSD (+ 1TB HDD, not root) | 28G  | GTX 745    |
| claw-5 | 4/4 DIMM DDR3 **@800**             | 4 x 4 GB  | 32 GB     | WD10EZEX 1TB **HDD**                  | 29G  | GTX 970    |
| claw-6 | 2/2 DIMM DDR4-2133                 | 4 + 4 GB  | 32 GB     | Samsung 750 EVO 250GB SSD             | 18G  | iGPU only  |
| claw-7 | 4/8 DIMM DDR4-2400                 | 4 x 8 GB  | 512 GB    | Crucial MX100 512GB SSD               | 21G  | GTX 980 Ti |
| claw-8 | not read — unreachable (drained)   |           |           |                                       |      |            |

claw-2/claw-3 rows are from the 2026-09-02 benchmark, not re-read today.

## Need — ranked by measured evidence

| node   | need               | evidence                                                            | shelf part                               |
| ------ | ------------------ | ------------------------------------------------------------------- | ---------------------------------------- |
| claw-8 | working CPU cooler | idles 72–78 °C, 100 °C in <5 s under stress; DRAINED (2026-09-09)   | none — needs an LGA1151 cooler           |
| claw-1 | SSD for root       | spinning disk, 89/122 MB/s W/R vs 344–679 on SSD claws (2026-09-02) | D1                                       |
| claw-5 | SSD for root       | spinning disk, 105/104 MB/s                                         | D1                                       |
| claw-6 | RAM                | 8 GB, both slots full; below the 16 GB heavy-job rule               | R2 (replace both → 16 GB)                |
| claw-1 | RAM                | 12 GB, both slots full, board max 16                                | none — needs one DDR3(L)-1600 SODIMM 8GB |
| claw-1 | thermal            | 98 °C loaded against a 105 °C trip                                  | paste / fan clean                        |
| claw-3 | thermal            | 94 °C loaded                                                        | paste / fan clean                        |
| claw-5 | RAM speed          | four DDR3 DIMMs running at 800 — check BIOS before buying anything  | none                                     |
| claw-5 | CPU                | FX-8350, 3.8x slower single-core; 2–8x slower on every heavy job    | no AM3+ part fixes this                  |
| claw-7 | wifi antenna       | BCM4360 ~30 dB down, wired-only                                     | none                                     |
| claw-7 | root SSD           | 91,489 power-on hours, zero reallocated; why it is tier2            | none at 240 GB worth the swap            |
| claw-2 | RAM                | 8 GB soldered                                                       | not fixable                              |

## Allocations

| part id | → node                  | installed | re-measured | result |
| ------- | ----------------------- | --------- | ----------- | ------ |
| D1 #1   | claw-1 root             |           |             |        |
| D1 #2   | claw-5 root             |           |             |        |
| R2 x2   | claw-6 (replaces 2x4GB) |           |             |        |

Unallocated on purpose:

- **R1, R3 (all four DDR5 sticks).** Every claw is DDR3, DDR4 or soldered.
  hokon is the only DDR5 box and it is a guest. They wait for an AM5 or
  LGA1700 node, or get sold.
- **D2.** An identical cold spare for claw-5's disk. Once claw-5 is on D1, it
  is spare CI scratch at best.
- **G1.** No CI job needs more GPU than the claws already have. If a Turing
  NVENC need turns up, claw-7 is where it goes (X99 x16, and its PSU already
  runs a 250 W 980 Ti; the 2080 draws 215 W). It still has no AV1 encode.

## Install checklist per node

1. `fleet drain` the node and wait for zero running jobs.
2. Disk swap is a REIMAGE: the root moves, so run the onboarding path
   (IMAGE → CONVERT → ENROLL → PROVISION → VERIFY) rather than cloning, and
   seed the JIT payload before flipping ephemeral.
3. After boot: `fleet benchmark --write` and `fleet bootcamp --write` for the
   node. Fill in the allocation row from THAT output.
4. RAM change: update `minFreeMb` / capacity in the manifest from the
   re-measured `MemTotal`, not the stick sizes.
