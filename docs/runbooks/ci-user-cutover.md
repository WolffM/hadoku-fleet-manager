# R12 — move an existing claw's CI to a separate `ci` user

Scenario #12 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
The node-users concept and its cutover order are owned by a separate
workstream (d3, `docs/planning/node-users-2026-10-27.md`) — **this runbook
documents CURRENT behaviour only**, not that workstream's design intent.

Use this for a claw that is **already declared and provisioned** and still
runs CI as the `admin` user — the state every claw was in before
2026-10-27, and the state any claw stays in until this runbook (or R1 step 7,
for a brand-new node) runs against it. `machines.<node>.users.ci` absent in
the manifest is exactly that state (`docs/VOCABULARY.md`, "Node users").

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## What changes

Before: every CI job on the node runs as the `admin` user — the same login
that holds ssh access, NOPASSWD sudo and the journal. After: CI runs as a new,
unprivileged `ci` role user (named `<admin>-ci` by convention) that owns the
runner slots, the runner payload, its own toolchains and caches, and — only if
`--docker` is passed — its own rootless Docker. It has no sudo, no docker
GROUP membership (the rootful daemon stays admin's), and no adm. `admin` keeps
everything it already had; nothing is removed from it by this runbook.

## Preconditions

- The node is declared and provisioned (R1 already ran), and is not a guest —
  `fleet node-users --cutover` refuses a guest outright: "the fleet does not
  provision its users" for one.
- The node must be **drained and idle** before the cutover is allowed to
  write anything — the node script itself refuses to move a user out from
  under a running job.
- The controller's own ssh public key(s) are present under `~/.ssh/*.pub` on
  the control host; the cutover copies them, restricted, into the new ci
  user's `authorized_keys` so the SAME key that reaches `admin` also reaches
  `ci`.
- Decide up front whether this claw is one of the operator's rootless-docker
  claws — that is the one branch (`--docker`) you cannot add after the fact
  without re-running the toolchain step.

## Steps

1. **Check the current state.** Where: control host. As: `fleet node-users`
   connects as `admin` to read it.
   Command: `fleet node-users --machine <node>`
   Verify: reports CI still running as `admin` (no `users.ci`) — confirms
   there is something for this runbook to do.

2. **Dry run — inventory only, nothing written.** Where: control host. As:
   `admin`, read-only.
   Command: `fleet node-users --cutover <node>`
   This reads the node (who exists, what sshd currently allows, where the
   manifest would write) and prints each inventory step `✓`/`·`, then stops
   with `DRY RUN. Nothing was changed.` Nothing requires the node to be
   drained yet for this step alone.
   Verify: every inventory line reads `✓` or `·` (never `✗`); the summary
   says `DRY RUN. Nothing was changed. Drain the node, then re-run with
--confirm.`

3. **Drain it.** Where: control host. As: `fleet drain` connects as `admin`.
   Command: `fleet drain <node> --reason "node-users cutover"`
   Verify: `fleet drain --status` shows `<node>` drained; wait until it is
   actually idle (no running job) before the next step — the cutover will
   refuse a node that is not drained, but it does not wait for one that is
   drained-but-still-busy.

4. **Run the cutover.** Where: control host; it ssh's to the node as `admin`
   to move things, then logs back in as the NEW ci user to prove the login
   works, then runs several further `fleet` subcommands against the node
   under whichever role now owns each of them.
   Command:

   ```
   fleet node-users --cutover <node> --confirm
   fleet node-users --cutover <node> --confirm --docker   # rootless-docker claws
   ```

   In order: the node side (create the ci user, its restricted key, sshd's
   `AllowUsers`, stop CI running as admin, move and re-chown the runner trees,
   re-point links and text) → a login check (the controller logs in as the
   new ci user the way every future fleet command will) → the manifest write
   (`users.ci`, and `containers: "docker"` with `--docker`), committed and
   pushed to main → redeploy the slice, the throttle hook, the toolchain
   (installs rootless docker if `--docker` was given) and bootcamp against
   the node as the role that now owns each → re-read the node-users facet.
   Every node-side step is idempotent: a failed run picks back up where it
   stopped on a second `--confirm`.
   Verify: ends with `✓ <node>: CI runs as <ci-user>, every label re-proved,
the facet reads ok.`, and either `The deployed manifest agrees.` or a note
   to wait for the next redeploy before undraining.

5. **If step 4 said the deployed manifest does not agree yet**, wait for
   mgmt-api's next redeploy, then re-check. Where: control host. As:
   read-only.
   Command: `fleet node-users --machine <node>`
   Verify: reports the `ci` role present and not drifted.

6. **Undrain.** Where: control host. As: `fleet drain` connects as `admin`.
   Command: `fleet drain <node> --undo`
   Verify: `fleet traffic` once again considers `<node>` a candidate for the
   next job.

## Rollback

- Before step 4 (`--confirm`): nothing was written. The node, the manifest and
  GitHub are all untouched; undrain it and walk away, or just re-run the dry
  run later.
- After step 4 started but a node-side step failed: the node **stays
  drained**, and the run says so. Fix whatever failed and re-run
  `fleet node-users --cutover <node> --confirm` — every step is idempotent, so
  this finishes the run rather than repeating completed work.
- After step 4 finished (or partially landed) and you want CI back on
  `admin`: that is the same command with `--back`.

  ```
  fleet node-users --cutover <node> --back --confirm
  ```

  This moves CI back to `admin` on the node, flips the manifest's `users.ci`
  away, commits and pushes, and re-runs the same redeploy chain for the admin
  user. It refuses if the node was never cut over in the first place ("nothing
  to roll back"), and like the forward direction it requires the node to be
  drained.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command printed
  above exists in the door's table.
- `scripts/lib/node-users-guard.test.mjs` — fails the build on a user-name
  literal, a `runOn`/`runOnSync` call with no `as:`, or a hand-rolled ssh that
  skips `sshDestination` — the guard this runbook's whole premise depends on
  staying true.
- `fleet node-users` (the facet) — reads OBSERVED accounts on the node, not
  the manifest's own record of what it wrote, so a cutover that silently
  drifted (a chown that did not take, a stale `AllowUsers`) is caught on the
  next run rather than agreeing with itself forever.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.

## Memory lessons this runbook holds

- **Node users are a first-party concept, one door.** `nodeUser(machine,
role)` in `src/lib/node-users.ts` is the only place a role becomes a user
  name — never write a literal user name, a `/home/<name>` path, `user@1000`,
  or an `id -un` inference anywhere else.
- **Drained, one claw at a time.** The cutover refuses a node that is not
  drained, and the chown of the moved trees can take minutes on a full home
  directory — do not start it against a node you expect back in service in
  the next few minutes.
- **A probe reads its own role's pm2.** After the cutover, a `pm2-host` check
  on this claw will report nothing running in the ci user's pm2 even where
  `admin` still supervises some other service on the box — that is the facet
  working correctly, not a new finding.
- **This area has another owner.** If the behaviour documented here stops
  matching what `fleet node-users --cutover` actually does, that is a sign the
  node-users workstream moved the design — re-read
  `docs/planning/node-users-2026-10-27.md` before assuming this runbook is
  wrong.
