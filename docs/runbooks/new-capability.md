# R6 — new capability or job label

Scenario #6 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Written against `src/lib/capability-registry.ts` (the one typed place a
capability's meaning lives, since wave 5j) and `nodeOffer`
(`src/lib/capability-offer.ts`), the one function that derives what a node
actually offers from it.

**One entry per capability, everything else derives.** Before this registry
existed, the label vocabulary was five string literals scattered across five
modules and nothing said so; `taskauto` and `av1-nvenc` were absent from one
of those five lists for months with no error, which cost a tenant 6h45m of
silent queueing on 2026-08-26. Adding a capability here is a code change, not
an ssh session — most of the steps below are "edit a file, run the build,
read what the test says."

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- Decide **`kind`**: `identity` (a fact about the node — almost every new
  capability is this) or `eligibility` (a routing lever the fast loop itself
  owns — there is exactly one, `hadoku-builder`; you are not adding a second
  one).
- Decide **`surface`**: `label` (a GitHub runner label, routable by a
  workflow's `runs-on`), `toolchain` (every managed node must have it — a
  floor, not a differentiator), or `implicit` (probed and recorded, routable
  by nothing — the GPU-family facts are the precedent: measured because the
  answer matters, not exposed because no workflow asks for it yet).
- Decide **`verify`**: `probe` (a script on the node EXECUTES it — the
  default, and the only one that satisfies "a probe that executes the
  capability, never one that reads its own writer's artifact"), `role`
  (nothing here can execute it — it needs a secret that lives only in a
  GitHub Actions store), or `mint` (proven only by
  minting — `jit-canary` is the one case; you are very unlikely to need a
  second).
- If this capability is going to differentiate SOME claws from others on a
  real workload (not just "can it build at all"), have the real job in hand
  — a `workflow_dispatch`-able job in a real repo, and the log line(s) that
  prove it actually ran the capability's work rather than merely concluding.
  "Earn the workload, not the tool": claw-3 cleared a RAM floor and a tool
  probe for `jdk21` and then failed five real Forge jobs, because neither
  check said anything about the WORK the label routes.

## Steps

1. **Add the `Capability` entry.** Where: this checkout, `src/lib/
capability-registry.ts`'s `CAPABILITIES` array. As: whoever is authoring
   the change (code review, not an operator action).
   Fields: `id`, `kind`, `surface`, `verify`, `label` (≤6 words — it renders
   in a UI), `description` (one line, operator-facing — it is rendered
   verbatim in every gate finding). Add `measure` only for a `probe`
   capability that differentiates claws by a measured number (see
   `cargo-bevy`'s entry for the shape and for how its bar is DERIVED from a
   real measurement, not guessed), and `requires.facts` when the capability
   may only ever be true of a node in some state (`jit-canary`'s `[MUST_BE_EPHEMERAL]`
   is the precedent for "only a JIT mint may ever answer this").
   Verify: `pnpm run build` (the registry is a TypeScript module; a malformed
   entry fails to compile before anything else runs), then `node --test
scripts/lib/job-registry-guard.test.mjs` is the WRONG test for this step —
   use `node --test` against `src/tests/capability-registry.test.ts`'s
   compiled output under `dist/tests/` (this repo's normal `pnpm test` runs
   the whole suite, which is the simplest verify here).

2. **Write the probe.** Where: this checkout, `scripts/capability-probe.sh`
   (and `scripts/lib/toolchain-floor.mjs` instead, if `surface: 'toolchain'`).
   As: code author; it runs ON the node as whichever role (`ci` by default)
   the capability belongs to.
   The probe must EXECUTE the capability — compile the thing, run the
   encode, start the JVM — never list a tool's presence or read a file an
   earlier writer already wrote. `av1-nvenc`'s own registry comment names
   the counterexample: Debian's ffmpeg reports the AV1 encoder on every box
   regardless of hardware, so only a real 256x256 encode tells hokon's RTX
   4090 apart from a claw's GTX 860M.
   Verify: `fleet capabilities --machine <node>` (reads
   `scripts/check-capabilities.mjs`) reports your new id as `EARNED` or a
   genuine failure for a node you ran the probe against by hand first — not
   `unreadable` or silently absent.

3. **Declare a `jobProof`, if this is a differentiator.** Where: the same
   `Capability` entry, `jobProof: { repo, workflow, job, evidence, budget? }`.
   As: code author.
   Pick the SMALLEST real spec pair that exercises the capability's actual
   work end to end — `jdk21`'s own entry picked two specs covering both
   match-start paths in the suite rather than the full 27-spec job, so the
   canary costs minutes rather than the ~15-18 min the full job takes.
   `evidence` is a regex over the job's OWN log lines that only prints when
   the capability was actually exercised; a job that goes green without
   printing it proves nothing. Add `budget: { factor, minProven }` only once
   you can point at measured durations on already-passing nodes — a bar
   invented before `minProven` nodes exist is a guess with a decimal point,
   and `judgeMeasurement` will say so.
   Verify: `fleet prove-job --node <node> --capability <id> --json` dispatches
   the real job on a throwaway runner and reports pass/fail against the
   evidence regex (and the budget, once one is set) — read the JSON document
   it returns, not just its exit code (`--out <file>` sidesteps the 8 KB pipe
   cliff if you also want the raw body).

4. **Bootcamp earns it.** Where: from the control host. As: `fleet bootcamp`
   connects as `ci` for the parts of its chain that run on the node.
   Command:

   ```
   fleet bootcamp --check-only --machine <node>   # probe only, installs nothing
   fleet bootcamp --write --machine <node>        # record the EARNED/UNEARNED/BLOCKED facet
   ```

   `earned` is the proof set this probe actually executed successfully — not
   `proven ∩ declared` — and it is what `nodeOffer` reads a node's label set
   from. `--write` records the facet and nothing else; it does not touch
   `machines[].labels`.
   Verify: `fleet bootcamp --check-only --machine <node>` a second time
   reports `EARNED` (or the genuine current state) for the new id, not
   `UNCLAIMED`.

5. **Routing — verify, do not configure.** Nothing in this step is a command
   you run to wire routing up: `nodeOffer` is "THE ONE ANSWER TO 'what labels
   does this node offer'", and both assignment paths — the JIT mint
   (`mintLabels()` in `src/runners/ephemeral-exec.ts`) and the warm listener
   (`warmLabels()`, same file) — derive from it. A registry entry therefore
   reaches both automatically, with ONE exception: if the capability must
   never be answered by a STANDING listener (because only a fresh mint
   actually proves it — `jit-canary`'s own reason), it needs
   `requires.facts: [MUST_BE_EPHEMERAL]` from step 1; `warmLabels()` reads
   that back through `ephemeralOnlyLabels()` and strips it from every warm
   listener. Skipping that flag on a mint-only capability is exactly the
   2026-09-08/09 incident: a warm listener on claw-3 answered `jit-canary`
   for five straight failures before anyone noticed.
   Verify: once a node has earned the capability, compare a JIT-minted
   runner's labels against a warm listener's for the SAME node and repo
   (`gh api repos/<owner>/<repo>/actions/runners`) — the new label should
   appear on both, UNLESS it is mint-only, in which case it must appear on
   neither... on the warm listener.

6. **Schema coherence.** Where: from the control host, offline (no network).
   As: read-only.
   Command: `fleet capability-schema`.
   This is the gate a pull request can answer before anything deploys: is
   every capability a manifest node claims actually registered, and can the
   node's declared spec carry it (`jit-canary` without `ephemeral: true` is
   the standing example it refuses).
   Verify: exit 0.

7. **Revocation is automatic — but know the footgun.** Nothing to configure:
   `src/capability-revocations.ts` already withholds a label the moment any
   probe that EXECUTES it judges the result FAIL, and clears it the moment
   one judges PASS. The footgun is `fleet bootcamp`: **revocations are
   written in every mode, with or without `--write`.** A `--check-only` run
   you believe is "just looking" still writes a revocation if the probe sees
   your new capability fail — this is deliberate (a dry run must not let a
   real failure hide behind the flag that normally means "nothing is
   written"), but it surprises anyone who has not read this far.
   Verify: after a probe you know will fail, `fleet bootcamp --check-only
--machine <node>` still changes `capability-revocations.json` in the state
   dir — read it back, or watch for the revocation in the run's own summary.

8. **Label drift on EXISTING standing registrations.** Where: from the
   control host (or wait for the nightly `ci:fleet-coverage` cron). As:
   `fleet reconcile` connects as `admin`.
   `nodeOffer` changes what a FRESH registration carries immediately, but an
   already-registered standing runner keeps its OLD label set until
   something relabels it. `fleet reconcile --confirm` is that something: it
   finds every runner whose node declares a capability the runner itself
   lacks and POSTs the missing labels to it.
   Command: `fleet reconcile --confirm`
   Verify: `gh api repos/<owner>/<repo>/actions/runners` shows the new label
   on a standing runner that existed BEFORE step 1, not only on runners
   minted after.

## Rollback

- Before step 1 lands (still editing the registry, nothing committed):
  nothing to undo.
- After step 1, before any `--write`/`--confirm`: delete the `Capability`
  entry. No manifest, no GitHub registration and no state-dir facet has been
  touched.
- After step 4 (`bootcamp --write`) but before step 8 (`reconcile --confirm`):
  the state-dir facet records EARNED/BLOCKED for an id that, once you delete
  the registry entry, nothing reads back into any offer — harmless to leave,
  or delete the facet file by hand if you want it clean. Any revocation
  written against the id is equally inert once the id no longer exists.
- After step 8: **`reconcile`'s label drift is additive-only — it has no
  path that REMOVES a label from a runner.** Deleting the registry entry at
  this point does not retract the label from any runner that already
  carries it; the stale label sits there until that runner is re-registered
  (see R3, retiring the node) or removed by hand:
  `gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>/labels/<label>`
  for each one.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.
- `fleet capability-schema` (nightly, part of `repo-sync`) — catches a
  manifest claim the registry no longer recognizes, or a node whose declared
  spec cannot carry what it claims.
- `fleet label-floor` (daily) — pages when a required label has no live
  runner to serve it, which is what a revoked-and-never-replaced capability
  eventually becomes.
- `fleet reconcile --confirm` (nightly `ci:fleet-coverage`) — applies label
  drift to existing registrations; see step 8's rollback caveat for what it
  does NOT do.

## Memory lessons this runbook holds

- **Earn the workload, not the tool** — step 3; a RAM floor and a tool probe
  are not proof of the real job, and the gap between them failed five real
  Forge jobs on claw-3 before the workload-proof budget existed.
- **Measured capabilities, idle only** — a `measure` bar taken beside a
  running job measures the job as much as the box (claw-4 scored 2281 idle,
  1169 under load); a new measured entry inherits "idle-only" unless its own
  `loadInvariant` says why load cannot touch it.
- **Dry bootcamp still revokes** — step 7; `--check-only` is not a true no-op
  once a probe has run.
- **Label revocation** — step 7's mechanism; a probe that EXECUTES and sees
  FAIL withholds the label fleet-wide on the next tick, everywhere a label is
  handed out, until a PASS clears it.
- **Opt-in gate is inert** — a capability wired behind a flag nothing ever
  passes routes to nobody; this is why step 5 ends in a verify command
  against BOTH assignment paths rather than trusting that adding the entry
  was enough.
- **Capability label drift** — step 8; standing runners get their labels
  only at registration, and `fleet reconcile --confirm` is what catches a
  standing runner up to a newly declared capability.
