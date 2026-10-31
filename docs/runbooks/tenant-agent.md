# R9 — new hosting tenant: agent kind

Scenario #9 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue. An
**agent** tenant is a binary the fleet supervises as a system unit, as the
app's own user, read back from the kernel — `docs/hosting.md`'s full contract,
`docs/VOCABULARY.md`'s "hosting node". Tenancy belongs to another owner
(fleet-manager#16, agreed with cardtable 2026-10-27); this runbook documents
CURRENT commands only, read from `scripts/hosting*.mjs` and
`scripts/lib/hosting-request.mjs`.

Use this when the tenant ships its own executable and the fleet starts,
restarts and tears it down. Cardtable's Forge-match supervisor
(`docs/requests/FLEET_MANAGER_FORGE_HOSTING.md` in that repo) is the only one
running today. For a tenant hadoku_site deploys into a pm2 daemon instead, see
R10 (`tenant-pm2-service.md`).

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- A `hosting.json` at the app repo's root, `"kind": "agent"`, valid against
  `scripts/lib/hosting-request.mjs`'s schema: a `slices.unit` (memory ≥ 256
  MiB, whole cores), `network.ingress` one of `controller` or `none` (an agent
  may not use `tunnel` — that is the app layer's), `disk.stateGb`, and
  `availability.noticeMin` ≥ 15 (the fleet's floor, `NOTICE_FLOOR_MIN`).
- The executable itself: under 64 MiB (`INSTALL_MAX_BYTES`) — ship a launcher,
  not the payload, if the real binary is bigger — and its sha256.
- A decision on `placement.auto`: on (the hosting-converge door declares and
  ends this tenant's slices to meet its own stated demand) or off (every
  slice is operator-declared by hand, below).

## Steps

1. **Validate the request.** Where: control host. As: read-only (reads the
   app repo's shipped file over the network, or a local draft by path).
   Command:

   ```
   fleet hosting-request WolffM/hadoku-cardtable
   fleet hosting-request ./hosting.json
   ```

   Prints the NORMALIZED request (defaults filled in) or every problem with
   its reason (`lib/hosting-request.mjs` owns every rule). EXIT 0 only when
   valid.
   Verify: exit 0, and the printed line reads `(agent)`.

2. **Register it.** Where: control host. As: whoever is `$SUDO_USER`/`$USER`
   on the controller — kept in the registry entry's `by`.
   Command:

   ```
   fleet hosting-request WolffM/hadoku-cardtable --register
   ```

   Writes the NORMALIZED request into the state dir's tenant registry
   (`hosting-tenants.json`). Every later reader — `fleet hosting`,
   `--check`, `node-status`, `hosting-demand` — reads THIS copy, never the
   repo again. **Re-run this exact command after the app changes its
   `hosting.json`; nothing re-syncs it automatically** (the gap below).
   Verify: `fleet hosting-request WolffM/hadoku-cardtable` (no `--register`)
   still reports valid; `fleet hosting-demand cardtable --json` no longer
   refuses with "is not a registered tenant".

3. **See where it could go.** Where: control host. As: read-only (one ssh per
   claw).
   Command:

   ```
   fleet hosting-offers
   fleet hosting-plan WolffM/hadoku-cardtable
   ```

   `hosting-offers` measures every claw (hostable memory and cores, disk,
   link, CI's own cost, pm2 neighbours); `hosting-plan` ranks them against
   this request's `placement.require`/`prefer` and its CI-may-read policy.
   Neither command changes anything.
   Verify: at least one node is ranked and not refused. If every node is
   refused, read why before step 4 — a fit problem ("the declaration does not
   fit X") and a placement refusal are different fixes.

4. **Declare the slice.** Where: control host. As: `fleet hosting` connects
   to the node as `admin`.
   Command:

   ```
   fleet hosting claw-9 --tenant cardtable --memory 4G --cores 4 --shared   # CI stays, ranks below the slice
   fleet hosting claw-8 --tenant cardtable --memory 12G --cores 6           # whole box, CI held off
   ```

   `--shared` keeps CI on the box at a lower `CPUWeight`; what the slice is
   not using goes back to CI. Without it, CI is held off by a `kind: hosting`
   drain, written FIRST so the agent never starts beside a CI job. The door
   re-checks fit and this tenant's own placement at the moment of declare — a
   node `hosting-plan` ranked a minute ago can still be refused here if
   something changed in between.
   Verify: the command's own `--json` reports `"state": "guaranteed"` with no
   `class: "blocking"` entry in `findings` — or, if the agent is not
   installed yet, `"not-guaranteed"` naming exactly that, which step 5 fixes.

5. **Install the executable.** Where: control host. As: `fleet hosting
--install` streams the bytes over ssh into a root-owned path; nothing
   passes through the CI user.
   Command:

   ```
   fleet hosting claw-9 --install ./run --sha256 <hex>
   ```

   The agent is started by a `.path` unit that waits for this file to exist.
   The hash is checked against the local file AND against what the node
   received before anything is swapped in.
   Verify: the command's own output ends `✓ <exec> on <node> is <sha>,
root-owned; the agent restarted.`; step 6 below reads the agent running.

6. **Verify the guarantee.** Where: control host. As: read-only.
   Command:

   ```
   fleet hosting --check
   fleet node-status --json
   ```

   `--check` re-observes every hosting node from the kernel (cgroup memory
   and cpu, the agent's own user, the firewall's controller-only reach) and
   judges declared vs observed. `node-status` carries the SAME judgement,
   filtered to what a tenant needs to read (`hosting.state`,
   `hosting.observed`) — both use the one word, `guaranteed` /
   `not-guaranteed`.
   Verify: the node's row reads `guaranteed`, with no `blocking` finding.

## Rollback

- Before step 4 (declare): nothing exists on any node. The registry entry
  from step 2 is harmless on its own — it only takes effect once something
  declares against it.
- After step 4, before step 5 (install): `fleet hosting <node> --end --in
15m` then, once that time has passed, `--remove` tears the slice down
  cleanly; the agent was never installed, so nothing was running.
- After step 5: this is now R11's job (`tenant-change-exit.md`) — end it with
  notice, then remove it, rather than deleting the registry entry out from
  under a live slice.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  tailnet name or other site fact; it never will, because it is public.
- `fleet hosting --check` / `fleet node-status --json` — either one catches a
  slice whose declared guarantee has lapsed, any time after step 4.

## Gaps (plan §5.4)

- **Registration is a manual, one-shot copy.** `registerTenant` has exactly
  one caller in this repo (`scripts/hosting-request.mjs`'s `--register`), and
  nothing re-reads the app's `hosting.json` on a schedule. A tenant that
  edits its request and forgets step 2 runs against a stale copy with no
  warning anywhere. The catalogue (§5.3) names this gap — "decide whether
  register is automatic" — but **§5.4's engineering table does not cost it**:
  unlike R3, R10 and R11's gaps, this one has no size or phase yet.
- There is no `fleet hosting-request --unregister`. See R11
  (`tenant-change-exit.md`) for what that means once a tenant's last slice is
  removed.

## Memory lessons this runbook holds

- **`--help` can execute** (fleet-wide lesson) — never run any step above
  with `--help` to "check" it first; read this runbook or `fleet hosting
--help` instead of guessing at a flag.
- **The agent's install never reaches the CI user.** `--install` streams
  straight to a root-owned path over an admin ssh; a CI job on the same node
  cannot reach it without becoming root itself, and the CI user keeps NOPASSWD
  sudo on the claws by a 2026-10-25 operator ruling — a separate fact from
  this install path, not a guarantee against it.
- **A re-run of step 4 on the SAME node, same mode and role, is a resize, not
  a new slice** — see R11 for what that means for a scheduled end already in
  force.
