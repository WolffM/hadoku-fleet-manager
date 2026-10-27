# Vocabulary

The words this repo is allowed to use for the things it manages, and — where a
word is deliberately still wrong — why, and what it would cost to fix.

Settled 2026-08-30, when onboarding work needed a noun for "a box" and found
three already in use.

## The nouns

| word       | means                                                                  | not                                                  |
| ---------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| **node**   | A box the fleet manages. THE canonical noun.                           | not a runner, not a process                          |
| **claw**   | A node whose only job is CI. `loadClawNodes()` excludes the pm2-host.  | not a synonym for node — it is a proper SUBSET       |
| **runner** | One GitHub registration: a `(node, repo)` pair, with its own listener. | not a node — one node hosts up to `maxRegistrations` |
| **fleet**  | Every declared node, plus the coverage derived from them.              | not "the claws"                                      |

Two words for a node the fleet LENDS, both drains with a `kind` (`src/runners/drain.ts`):

- A **lease** lends a node for a window — a tenant's measurement, a calibration
  slot. CI is held off until its `until`, then returns by itself.
- A **hosting node** is lent to a tenant's RESIDENT service (`fleet hosting`):
  CI held off, declared memory and cores served from a slice and read back from
  the kernel, the tenant's agent supervised. It is still enrolled and probed,
  but it is not a claw while it hosts, because a claw's only job is CI. Say
  "hosting node", never bare "host" (below).

`claw` is load-bearing and stays. It is the answer to "which nodes may be
demoted without taking production with them", and `clawsOnline` /
`clawsPromotable` are read by the outage and saturation triggers. It is also the
local, hadoku-specific name for this fleet's CI boxes — a published tool would
say `node`, and `claw` would be what THIS deployment calls its nodes.

### `host` is three different things, and that is the one word to stop using bare

| what it means                               | say                                                     |
| ------------------------------------------- | ------------------------------------------------------- |
| the injected dependency container           | **`FleetHost`** (typed)                                 |
| the production box running mgmt-api and PM2 | **`pm2-host`** (the label) or **`the production host`** |
| the string `os.hostname()` returns          | **`hostname`**                                          |

`runner-health.ts` had a private `function host(): string { return os.hostname() }` —
the third meaning, spelled as the first. It is `selfHostname()` since
2026-08-30. Never write bare `host` in new code.

## The one question with one answer

> **Is this node the box I am running on?**

`src/lib/node-identity.ts` — `isLocalNode(node, self?)`. Nothing else may ask.

It was answered five ways until 2026-08-30 and only one of them survived an
FQDN. hokon refuses ssh to itself, so getting it wrong in the false direction
reads a node as permanently unreachable (this is how the fast loop treated hokon
as saturated for weeks); getting it wrong in the true direction runs another
node's script here, which is worse. `scripts/lib/node-identity-guard.test.mjs`
fails the build if a sixth appears, and it blanks comments before looking —
prose can neither trip that rule nor satisfy it.

## Node users: who a command runs as

> **Which user does this act as on that node?**

`src/lib/node-users.ts` — `nodeUser(machine, role)`. A first-party concept since
2026-10-27 (operator: "must be respected"). A node has users by **role**:

| role       | is                                                                        | never                           |
| ---------- | ------------------------------------------------------------------------- | ------------------------------- |
| **admin**  | the management identity: ssh, NOPASSWD sudo, the journal, pm2             | runs a CI job                   |
| **ci**     | runs every CI job; owns runner slots, toolchains, caches, `runners.slice` | sudo, the docker group, adm     |
| **tenant** | a hosting agent's system user (`cardtable-agent`), in `TENANTS`           | logs in, shares a group with ci |

Code names the ROLE, never a user. `runOn(node, script, { as: 'ci' })`,
`nodeShell(node, 'ci', cmd)`, `sshDestination(node, 'admin')` and
`nodeHome(machine, 'ci')` are the doors. The ssh LOGIN carries the role, so
`$HOME`, `id -u` and `systemctl --user` on the far side are that role's.
`machines.<node>.users.ci` names a node's ci user; absent means the node has
not been cut over and its CI still runs as admin.
`scripts/lib/node-users-guard.test.mjs` fails the build on a user literal, on a
`runOn` call with no `as:`, or on a hand-rolled ssh that skips `sshDestination`.
The plan and the cutover order are in `docs/planning/node-users-2026-10-27.md`.

## The axes

These are already how the codebase argues; they were just never written down in
one place.

- **declared vs observed.** The manifest DECLARES; a probe OBSERVES. _The reader
  for a facet may not read what the writer wrote._ An idempotency check must
  read observed state too, or a gate and a repair share a blind spot.
- **identity vs eligibility.** A FACT about the node (it has an NVENC-capable
  GPU; it is the production host) versus a ROUTING LEVER the fast loop (the
  backstop, on a guest) rewrites as a node becomes safe or unsafe. `hadoku-builder` is the only eligibility label.
  Collapsing them made a healthy demoted claw vanish from `clawsOnline`.
- **port vs probe.** A **port** is injected by the host and is present or the
  process does not start. A **probe** crosses a network and may come back empty.
  Config fails LOUD; the network fails SOFT. Never the other way round.
- **three-valued.** `null` = never looked. `false` = looked, it is down. A
  number = looked, here it is. Never `?? 0` — a fleet with no capacity and a
  fleet nobody has looked at must not render identically.
- **result, not exception.** An unreachable node is a RESULT. A sweep that
  throws on the first dead box reports nothing about the other three. Silence is
  still never a pass.

## The onboarding verbs

Six phases. This package owns the last three; the first three are the
2026-08-30 onboarding workstream.

| phase         | from → to                                            | owner                       |
| ------------- | ---------------------------------------------------- | --------------------------- |
| **IMAGE**     | bare metal → an OS that boots                        | `fleet usb-prep`            |
| **CONVERT**   | an OS → a server (no sleep, ssh, firewall, watchdog) | `node-bootstrap.sh`         |
| **ENROLL**    | a running box → a DECLARED node                      | `fleet enroll`              |
| **PROVISION** | declared → converged                                 | `fleet provision`           |
| **VERIFY**    | converged → proven against observed state            | each deployer's `--check`   |
| **ADMIT**     | proven → the fleet may schedule real work here       | `fleet-loop` (`nodeIsSafe`) |

**ENROLL is the only inversion in the system.** Everywhere else a node is
described by the manifest and observed by a probe; a node never speaks. At
enrollment there is no manifest entry yet, so the box has to describe itself
once. Keeping that to ONE command, ONE direction and ONE moment is what stops it
becoming a heartbeat protocol. `fleet enroll` therefore writes a PROPOSED entry
and exits non-zero until an operator commits it: measurement is automated,
declaration stays a human act.

## The network

### `wifi manager` — which stack owns a node's radio

Not "does the node have NetworkManager". Every claw with a radio has
NetworkManager **installed and running**; claw-2 and claw-3 are on ifupdown
anyway, because the radio is `unmanaged` and `wpa_supplicant` is driven by
ifupdown's own hook. `systemctl is-active NetworkManager` and
`systemctl is-active wpa_supplicant` both score them as converged, and both are
wrong — NM's wifi backend IS wpa_supplicant, so that unit runs under every
owner. The question has one asker, `parseWifiManager()` in
`scripts/lib/node-interfaces.mjs`, which reads the two files the two stacks
write about themselves: the radio's device state from `nmcli device status`,
and `/run/network/ifstate`, which ifupdown writes for every interface it has
brought up. Six answers; every one but `unmanaged` was observed on a real claw
on 2026-09-09:

| answer           | means                                                 | seen on             |
| ---------------- | ----------------------------------------------------- | ------------------- |
| `networkmanager` | NM holds the radio and nothing else holds anything    | claw-1              |
| `ifupdown`       | ifstate names the radio; NM calls it `unmanaged`      | claw-2, claw-3      |
| `split`          | two managers on one box — a race, not a merge         | claw-7              |
| `unmanaged`      | a radio present and configured by nobody              | —                   |
| `none`           | no radio. A fact about the box, NOT a fault           | claw-4/5/6          |
| `unknown`        | the probe said nothing. Never collapse this to `none` | an unreachable node |

**`split` is the dangerous one and it does not announce itself.** A converted
node whose `/run/network/ifstate` still names an interface keeps that
interface's dhclient lease and its default route, at a better metric than the
radio's, until somebody reboots it — and a stale default route outlives the
carrier it was learned on, so the box blackholes itself the moment the cable
comes out while both links still look configured. claw-7 sat in exactly that
state for a day after `node-bootstrap.sh` converted it. /run is tmpfs: a reboot
clears it, and `ifdown --force` clears it now. A bare `ifdown` does not — the
2026-09-07 claw-3 outage was a failed `ifdown` leaving a stale ifstate entry
that made the following `ifup` a silent no-op, and it cost a garage trip.

**NetworkManager everywhere, decided by the operator 2026-09-09**, on the one
measurement that separates them: during the 2026-09-07 SSID rename claw-1 (NM)
reassociated unaided and claw-3 (ifupdown) did not, because ifupdown never
retries. `scripts/fixes/nm-convert.sh` converts a node; `node-bootstrap.sh` §11b
does it for a new one.

### Changing the SSID — the whole procedure

Every claw with a radio carries **both** SSIDs (5 GHz at `autoconnect-priority`
10, 2.4 GHz at 1) so that renaming one band cannot strand a node: it falls to
the other band, and the fleet has time to notice. So change one band at a time
on the gateway, wait for every claw to reassociate on the band you did NOT
touch (`fleet drain --status` will not tell you this; `nmcli -t -f NAME,DEVICE
con show --active` on each node will), then write the new SSID into each node's
profile with `nmcli con modify fleet-wifi-primary 802-11-wireless.ssid <new>` —
reading the PSK from the node's own config and never passing one in — and only
then change the second band. A node that ends the procedure holding one SSID is
one rename away from a garage trip, and `nm-convert.sh` warns when it finds one.

### ssh targets are NAMES, and `sshTarget()` is the only place that decides

An address is a DHCP lease: it moves without telling anybody, and six scripts
that each let `~/.ssh/config`'s pinned IP stand in for a node will all read a
live node as unreachable at once, with no single place to correct it.
`sshTarget(node)` in `scripts/lib/node-interfaces.mjs` is that place. It refuses
an IP literal and appends `$FLEET_SSH_SUFFIX` when one is declared. It does
**not** answer "is this node me" — that is `isLocalNode()` and nowhere else.

The tailnet is the intended answer and is **not** switched on. MagicDNS resolves
every claw from hokon, but **Tailscale SSH is enabled on the claws with an ACL
action of `check`**, so a connection over the tailnet is intercepted by
tailscaled and answered with a browser login URL, then hangs — verified
2026-09-09 against claw-1 (by tailnet IP) and claw-4 (by MagicDNS name), both
timing out at 20s under `BatchMode=yes`. That is an operator change in the
Tailscale admin console (an `ssh` rule for `tag:claw` with `action: "accept"`),
not a code change. Once it lands, `FLEET_SSH_SUFFIX=<tailnet>.ts.net` moves
every ssh path in this repo at once.

## The on-demand guest

A **guest** (`role: "guest"`) is a node the fleet borrows; hokon is the only
one. An **on-demand guest** also declares `"mint": "on-demand"`: the
dispatcher mints JIT runners on it like a claw, but it is NOT `ephemeral` —
never in the census, never given a warm listener, always placed after every
claw — and it offers `hadoku-builder` only while the backstop holds it. Its
`standingRepos` are the registrations it keeps standing anyway (hadoku_site's
deploy runner). Different from a **resident repo** below, which is a claw's
standing `hadoku-builder` registration. See `docs/control-plane.md` §6.

## The resident backstop

A **resident repo** is a repo an ephemeral (JIT-minting) node keeps a STANDING
runner registration for, declared in that node's `residentRepos` array in
`fleet-runner-manifest.json`. It exists for exactly one reason and exactly one
repo: **`WolffM/hadoku-fleet-manager` must be able to run its own CI even when
the dispatcher is broken**, because this is the repo where a broken dispatcher
gets fixed. On 2026-09-02 minting itself was broken (a 69-character runner
name over GitHub's 64-char ceiling — `jit-name-length-ceiling` in this
package's memory) and both `check` and `publish` queued forever: the fix could
not publish because CI could not run, and CI could not run because the fix was
not published. mgmt-api consumes the PUBLISHED package, so nothing in the
checkout could break that loop from the inside. One standing registration
makes the deadlock structurally impossible.

**No other repo is ever resident, and nothing is ever seeded for traffic.**
This is a disaster backstop, not a performance feature — see
`docs/planning/workstreams.md` C0. Widening it dilutes the one property that
makes it trustworthy: that it is small enough to reason about completely.

**The rule, settled 2026-09-07: at least two holders, never the weakest claw,
never a drained one.** It lived on claw-1 alone from 2026-09-02, applied BY
HAND, because `runner-tiers.ts`'s `if (ephemeral.has(node)) continue` skipped
every ephemeral node's registrations unconditionally and nothing could
promote, demote, or strip it — see `docs/planning/handoff-2026-09-02.md` §3.1.
That made claw-1 (the fleet's weakest non-drained claw, and a single point of
failure) a permanent, unaudited exception. It now lives on **claw-4 and
claw-6** — two holders, so one going down does not take the guarantee with it
— and the fast loop processes an ephemeral node's resident registrations
through NORMAL promotion/demotion (not `demotable: false`, which was rejected
because it bypasses thermal/sick demotion, a safety control). The label is
therefore owned by the same mechanism that owns every other node's, and is
stripped automatically if the entry is ever emptied.

**How to move it:**

1. Edit the `residentRepos` array on the CURRENT holder(s) (remove) and the
   NEW holder(s) (add) in `hadoku_site/scripts/admin/fleet-runner-manifest.json`
   — never in `~/srv`, which mgmt-api reads and nothing commits to. Give the
   new holder a `$why-residentRepos` naming the reason and the rule above.
2. `fleet reconcile --confirm` to create the new registrations and remove the
   old.
3. Verify against the **GitHub API**, not the manifest: two ONLINE
   registrations for the repo, both carrying `hadoku-builder`, on the new
   holders — `gh api repos/WolffM/hadoku-fleet-manager/actions/runners`.
   The manifest states an intention; only GitHub confirms it converged.
4. `fleet label-floor` gates this continuously: it fails when fewer than two
   declared holders are online and labelled, or when any declared holder is
   drained.

Never pick the fleet's weakest non-drained claw or a currently-drained one —
see `fleet-hardware-baseline` in this package's memory for the measured
ranking, and `fleet drain --status` for who is out of service.

## Where the rename stops, and why

`node` is canonical in code — tiers 1 and 2 landed on 2026-08-30. It is **not**
canonical on the wire, and the boundary is deliberate rather than unfinished.

Two places in the code now name a wire key that differs from the identifier
holding it, and each carries a comment saying so: `NodeJobStats.machine` and
`JobHistorySummary.byMachine` (job-history.ts), and `buildFleetReport`'s
`machines: nodes` (routes/fleet.ts). In
`scripts/`, `selectMachines` and `machineArg` keep their spelling for the same
reason — the first is a published subpath export hadoku_site imports, the second
is named for the `--machine` FLAG.

| tier                                                                  | status                   |
| --------------------------------------------------------------------- | ------------------------ |
| 1. internal identifiers (`nodeOf`, `NodeState`, locals)               | **done 2026-08-30**      |
| 2. new surfaces (`node-profiles.json`, `fleet enroll`, `NodeProfile`) | born as `node`           |
| 3. wire keys                                                          | **deferred, on purpose** |

Tier 3 is every key an out-of-repo consumer already parses:

- the `GET /fleet` payload — `machines`, `machine`, `byMachine`, `clawsOnline`,
  `clawsFree`, `clawsPromotable`, `clawState`
- the persisted health snapshot — `claws_free`, `claws_online`,
  `claws_registered`, `claw_state`, `runner_state`
- `fleet-runner-manifest.json`'s top-level `machines:` key
- the type NAMES in `fleet-report-types.ts`, which the command station imports

Consumers, measured 2026-08-30: `services/mgmt-api/src/fleet.ts`,
`src/components/ContactAdmin/System/{types.ts,FleetView.tsx,FleetCharts.tsx}`
and `services/mgmt-api/src/routes/jobs/claw-cleanup.ts` — six files in
hadoku_site.

Renaming those buys nothing that renaming the identifiers does not already buy,
and it costs a lockstep change in a production repo plus an mgmt-api redeploy
(which restarts it and wipes the in-memory agent-token store). Worse, the site
checkout is fast-forwarded nightly and **installs nothing**, so a stale
`@wolffm/fleet-manager` there would meet a renamed payload and fail deep in a
loader — the exact 24-hour red that `check:site-install` was written for.

So: a wire format is versioned separately from the code that emits it. That is
not drift, and it must not be "tidied up" opportunistically. Do tier 3 as one
atomic commit pair across both repos, or not at all.
