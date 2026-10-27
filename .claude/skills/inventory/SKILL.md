---
name: inventory
description: Find the fleet's hardware inventory — every physical part (RAM sticks, disks, GPUs, coolers) on the shelf or installed in a node, plus each node's slots and board limits. Use when the user asks what parts they have, whether a part fits a node or a new build, what's on the shelf, what RAM/disk a claw has, or before recommending any hardware purchase.
---

# Fleet hardware inventory

It lives in the private repo, `WolffM/hadoku-fleet-manager-private`:

    ~/repos/hadoku-fleet-manager-private/docs/planning/inventory/parts.json   one row per part
    ~/repos/hadoku-fleet-manager-private/docs/planning/inventory/README.md    nodes, slots, board max

In a checkout of this repo that has run `bash scripts/attach-private.sh`, the
same files are at `docs/planning/inventory/`. Pull the private checkout
first; a stale copy is how a part gets "found" that was installed weeks ago.

    jq '.parts[] | select(.location == "shelf")' ~/repos/hadoku-fleet-manager-private/docs/planning/inventory/parts.json

Every answer says which it came from: the file, or the box itself.

## The box is the authority

The file is only as current as its last read. Before telling the operator a
part fits or is free, read the node:

    ssh <node> 'sudo -n dmidecode -t memory; lsblk -dno NAME,MODEL,SERIAL,SIZE,ROTA,TRAN; lspci | grep -iE "vga|3d"'

The claws have passwordless sudo; hokon does not, so the operator runs
`dmidecode` there by hand. Compare installed RAM, not MemTotal: a 16 GB box
reports ~15.5 GB.

## Fit

`spec` decides fit. DDR3, DDR4 and DDR5 are keyed differently; UDIMM
(desktop), SODIMM (laptop) and RDIMM (server, Xeon W) do not interchange.
claw-2 and claw-3 have soldered RAM.

## When a part moves

Edit its row in `parts.json` in the private repo (location, slot, condition,
plus a `history` entry), commit it there, then run `fleet benchmark --write`
and `fleet bootcamp --write` on the node, so the fleet's records come from
the new measurement.
