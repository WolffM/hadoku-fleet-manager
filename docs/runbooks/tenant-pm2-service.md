# R10 — new hosting tenant: pm2 service kind

Scenario #10 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
A **service** tenant: hadoku_site deploys an app into a pm2 daemon that the
fleet runs as the tenant's own user (`runtime.manager: "pm2"` — the only
service manager defined today, `SERVICE_MANAGERS` in
`scripts/lib/hosting-runtimes.mjs`). The fleet owns the slice, the user, its
`.npmrc` and log rotation, and reads the guarantee back from the kernel;
hadoku_site owns the build, the push, and the app layer's own placement
record (`scripts/pm2-hosts.json`, `scripts/child-apps.json` there).

**This spans two repos.** Fleet-manager owns placement (plan §5.3), but
nothing in either repo keeps the two records in lockstep automatically today
— that is this runbook's main gap, below. Tenancy belongs to another owner
(fleet-manager#16); this runbook documents CURRENT commands only, read from
`scripts/hosting*.mjs`, `scripts/lib/hosting-runtimes.mjs` and
`scripts/lib/service-tunnels.mjs`.

Use this for a service moving onto (or starting fresh on) a fleet-managed
node. watchparty → claw-6 and archive-bot → claw-4, both 2026-10-29, are the
only two service tenants to have made this move so far; the exact recipe that
worked for both lives in agent memory (`watchparty-claw6-move`,
`hub-deploy-clones`) and is summarized in step 4.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- A `hosting.json` at the app repo's root: `"kind": "service"`,
  `runtime.manager: "pm2"`, `slices.max === 1` (the validator refuses more —
  a service is one deployed app, never a pool). `network.ingress` is usually
  `tunnel` with `network.hostname` set (a service, unlike an agent, may use
  the app layer's tunnel) or `none` for a loopback-only internal service.
- If the service keeps data, it declares its level under
  `docs/service-state.md`: `availability.stateful: true` with no fence for
  on-node (what watchparty and archive-bot both do today), or the full
  off-node fence contract if it wants a standby.
- The destination node runs pm2 for at least one other purpose already, or
  will once this tenant's unit exists — a brand-new node reads `-` in
  `fleet hosting-offers`'s pm2 column, which is fine; `UNBOUNDED` there is
  not (an existing pm2 on that box with no memory ceiling — fix it first, or
  `hosting-plan` weighs it against the node's free memory and refuses).
- On the hadoku_site side (not this repo): the node is declared a pm2 host
  with its own Cloudflare tunnel (`fleet converge-toolchain --refresh`
  converges it; see step 5) if the service takes inbound traffic at all.
- Know whether the tenant opts into `placement.auto: true`. A service the app
  layer already runs is ADOPTED by a move, never declared beside itself
  (`hosting-converge`'s own rule) — so `auto` blocks until the move in step 4
  happens, naming `hadoku_site#491`'s mover as the thing that should do it.

## Steps

1. **Validate, then register.** Where: control host. As: read-only, then
   whoever is `$SUDO_USER`/`$USER` on the controller.
   Command:

   ```
   fleet hosting-request WolffM/hadoku-watchparty
   fleet hosting-request WolffM/hadoku-watchparty --register
   ```

   Same two commands as R9 (`tenant-agent.md`) steps 1–2; the registered copy
   has the same staleness gap (see R9's Gaps section — this repo's registry
   is shared across both tenant kinds).
   Verify: the printed line reads `(service)`, and `runtime.manager` reads
   `pm2`; `fleet hosting-demand <app> --json` no longer refuses with "is not
   a registered tenant".

2. **See where it could go.** Where: control host. As: read-only.
   Command:

   ```
   fleet hosting-offers
   fleet hosting-plan WolffM/hadoku-watchparty
   ```

   Same two commands as R9 step 3. Read the pm2 column as described in
   Preconditions above — `bounded` or `-` are both fine for a new tenant;
   `UNBOUNDED` is a pre-existing problem on that node, not this tenant's.
   Verify: at least one node is ranked and not refused.

3. **Declare the slice.** Where: control host. As: `fleet hosting` connects
   to the node as `admin`.
   Command:

   ```
   fleet hosting claw-6 --tenant watchparty --memory 1536M --cores 2 --shared
   ```

   This writes the tenant's home (`<app>-svc`, 0700), its tokenless
   `.npmrc` (`//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` — without
   it, a `pnpm install` for an `@wolffm` package 401s; watchparty's first
   deploy hit exactly this on 2026-10-29), its
   `/etc/logrotate.d/hosting-<app>` (daily, 7 kept — pm2 never trims its own
   logs), and the `pm2-<app>-svc.service` unit. **It does not start the
   app**: the unit's `ExecStart=pm2 resurrect` resurrects whatever that pm2
   daemon last saved, which on a brand-new user is nothing — that is step 4.
   Verify: the command's own `--json` echoes the declared memory/cores in
   `declared`, and `observed.agent` names the `<app>-svc` user. Do not expect
   `"guaranteed"` yet; the unit legitimately has nothing to run until the
   deploy below.

4. **Deploy from hadoku_site** (another repo; not a `fleet` command). The
   app's placement there is set and the service is pushed into the pm2
   daemon this repo just created. For a MOVE off another host, the recipe
   that worked for both watchparty and archive-bot, in order: state
   inventory → stop the old host's copy → copy data across (`rsync`, with a
   sha diff) → push (the hub's deploy restarts the app into its new pm2) →
   pre-converge the destination's tunnel (step 5, done before cutover so the
   switch itself is just a DNS move) → the app layer's own move-preflight →
   `--confirm`. For a brand-new tenant with no prior placement, hadoku_site's
   deploy tooling places it there directly, with no move step.
   Verify (on the hadoku_site side, not this repo): `pm2 jlist` as the
   tenant's user on the node shows the app `online`; the deploy's own health
   check passes.

5. **Converge the node's tunnel**, if the service takes inbound traffic.
   Where: control host. As: `fleet converge-toolchain` connects as `admin`.
   Command:

   ```
   fleet converge-toolchain --refresh --plan --machine claw-6 --json   # check only
   fleet converge-toolchain --refresh --machine claw-6                # converges
   ```

   `--refresh --plan` is the read-only form: it reads this node's manifest
   entry AND hadoku_site's `pm2-hosts.json`/`child-apps.json`, renders the
   tunnel config every app placed on that host needs, and reads the live
   connector back from BOTH the node and Cloudflare — the one command in
   this repo that checks both sides of R10 at once. **There is no narrower
   door**: dropping `--plan` to actually write the tunnel also runs that
   node's WHOLE refresh cycle (drain, wait idle, update its version-managed
   toolchain, undrain) — the tunnel convergence rides inside it, not beside
   it. DNS is never touched here; hadoku_site's own mover points the
   hostname at this tunnel at cutover.
   Verify: in the `--json` output, this node's `tunnels[]` entry reads
   `"status": "ok"` with no finding carrying its name; `https://<hostname>
/health` answers under 500 from outside the tailnet.

6. **Verify the guarantee, both sides.** Where: control host. As: read-only.
   Command:

   ```
   fleet hosting --check
   fleet node-status --json
   fleet converge-toolchain --refresh --plan --machine claw-6 --json
   ```

   The first two are this repo's own guarantee (same as R9 step 6). The
   third is step 5's check again — it is the only command that reads back
   the hadoku_site half, and it does so as a side effect of a toolchain-floor
   command, not a hosting-specific one: its `findings` mix tunnel results in
   with unrelated package-floor results for the same node.
   Verify: `fleet hosting --check` reads `guaranteed` for the node; the
   `--refresh --plan` run's `findings` has no `tunnel-*` entry naming it.

## Rollback

- Before step 3 (declare): nothing exists on any node; the registry entry
  from step 1 is harmless until something declares against it.
- After step 3, before step 4 (deploy): `fleet hosting <node> --end --in
15m` then `--remove` tears the slice down — nothing was ever pushed to it.
- After step 4 (deployed): this is now a live service move. The mirror
  command is hadoku_site's own, not this repo's — `service-move.mjs <app>
--to <old-host> --confirm` there, following the same recipe in reverse.
- After step 5 (tunnel converged): re-running step 5's `--plan` form is
  always safe; nothing it does is destructive on its own.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  tailnet name or other site fact.
- `fleet hosting --check` / `fleet node-status --json` — either one catches a
  slice whose guarantee lapsed, any time after step 3.
- The nightly `ci:toolchain-refresh` cadence re-runs step 5 for every
  service host, so a tunnel drift raised by hand here does not wait for an
  operator to notice it again.

## Gaps (plan §5.4)

- **Registration is a manual, one-shot copy** — same as R9; not sized in
  §5.4 today.
- **hadoku_site's `child-apps.json` `host` field is hand-set, not derived
  from this repo's hosting records.** The fleet can declare, converge and
  verify a slice completely on its own, but the app layer's own placement
  record does not read any of it back (`hadoku_site#491` part 2; §5.4, sized
  M, phase P5a — **this is what "R10 blocks on it" means** in the plan's
  catalogue). Until it lands, a service's slice here and its placement there
  are two records an operator keeps in sync by hand, and step 4's deploy
  trusts whichever one is stale.
- **`hosting.slice` is not yet in the egress taxonomy**, and a service's tool
  floor is not yet derived from its declared `runtime.tools` (§5.4, sized S,
  phase P5a).
- **No single fleet command runs the cross-repo recipe end to end.** Step 4's
  sequence is prose knowledge carried in agent memory, not a script; a
  typo'd step order there is undetected until something breaks.
- **The tunnel converger has no narrower mode than the whole node's
  refresh.** Writing a tunnel fix always drains and updates the node's
  toolchain too (step 5). This is a footgun worth separating, not a design
  choice anyone has defended in writing.

## Memory lessons this runbook holds

- **pm2 installs 401 without the tenant's `.npmrc`** — fixed as a runtime
  `homeFiles` entry (fleet-manager 0.34.168), judged by sha; re-verify with
  `fleet hosting --check` after any runtime change to how that file renders.
- **A pushed clone has no git remote on a private repo** — a build step that
  fetches a branch fails on the destination host. This is a hadoku_site/app
  fix (`extraBranches`), not a fleet one, but re-check it per move.
- **A hub caller hardcoding the old host's loopback port breaks silently**
  once the app moves (cardtable → archivebot, fixed via env) — grep every
  repo for the loopback port before moving a service that others call
  directly.
- **pm2 keeps every app's logs forever with no rotation** unless the
  fleet's `systemFiles` logrotate entry (step 3) is actually in place —
  fixed fleet-manager 0.34.174.
- **Check CI on the placement commit in hadoku_site itself** — a service
  move's commit there has turned hadoku_site's own Tests red before (reading
  a live ecosystem file as a fixture).
