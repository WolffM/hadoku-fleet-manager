# Features

What Fleet Manager does, for the operator running it. How it works inside is
in [contributing.md](contributing.md).

There is no browser UI and no tier ladder: every feature below is reached
through the `fleet` CLI or through the platform's own management service,
which runs this package in-process. "Node" is a machine the fleet manages; a
**claw** is a node whose only job is CI (a subset, not a synonym); a
**runner** is one registration of a node against one repo.

## Runner-fleet health and dispatch

**What it does.** Watches every node's liveness and decides, job by job,
which node takes it. A node earns the label that lets GitHub schedule work on
it only while it is safe — not quarantined, not drained, not failed by its
last check-in — so an unsafe node simply stops being offered work rather than
being specially excluded. Placement ranks candidates by how busy they are,
how long they have been idle, and a few safety rules (a node slow at one kind
of job keeps that kind off a faster node; a heavy job may double up on a node
already running one heavy job only after it has waited long enough).

**How to use it.** `fleet queue-health --json` and `fleet decisions [--job
ID | --node X | --repo R]` read back what the dispatcher saw and why a job
went where it went — every dispatch decision is written to a log with the
candidates it considered, in order, and why each one that was skipped was
skipped. `GET /fleet` (served by the platform's management service) is the
same report the command station renders.

**What it does not do.** It does not run the jobs themselves — GitHub's own
Actions runner does that, once this package has registered it and minted it
a credential. A job that waits past a long ceiling is reported as queued, not
silently retried.

## Node onboarding

**What it does.** Carries a bare machine through six phases — image it, turn
it into a server (no sleep, ssh, firewall, watchdog), enroll it as a declared
node, provision it (install everything a runner needs), verify it against
what was actually installed rather than what the manifest claims, and only
then admit it to real scheduling. A node **earns** a capability (a routing
label) by having a probe actually execute it, not by a manifest entry alone.

**How to use it.** `fleet enroll` writes a proposed manifest entry and exits
non-zero until an operator commits it — enrollment is the one place a node
describes itself; everywhere else the manifest declares and a probe observes.
`fleet provision`, then `fleet bootcamp` to prove the capabilities a node
should have, `fleet qualify` to run a one-node playlist of load tests
(network, disk, concurrency) before trusting its numbers.

**What it does not do.** It will not admit a node to scheduling on the
manifest's say alone — a capability a probe cannot confirm is not offered,
even if the operator believes it should be there.

## Drains, leases and the backstop

**What it does.** Takes a node out of CI for maintenance (a **drain**) or for
a fixed window (a **lease** — "lend this node to something else until this
time"), and can schedule either ahead of when it starts. One particular
node, the fleet's **backstop**, is held in reserve: it is minted for on
demand rather than kept standing with idle listeners, and is only brought in
when every other node is busy or down, never for an ordinary backlog.

**How to use it.** `fleet drain <node> --kind lease --for 48h --reason
"..."`, or `--in 30m` / `--at <iso>` to schedule one ahead of time; `--undo`
ends it early. `fleet drain --status` says who is out of service right now.
`fleet backstop --status` prints the backstop switch, the box's own load and
memory against the thresholds that would bring it in, and the last verdict;
`fleet backstop --force <node> [--for 60m]` overrides it by hand.

**What it does not do.** A drain never kills a job already running — it
waits for `fleet drain --status` to say the node is actually drained before
the operator starts anything that assumes it is empty. The backstop is never
a candidate for hosting another app's service.

## Hosting a tenant service

**What it does.** Lends a node's spare memory and CPU to another repo's own
long-running service (a **tenant**), beside CI or, on a smaller node,
instead of it. The fleet gets the node online and reports its status; the
tenant decides what runs inside the resources it was given and owns its own
failover. A tenant can ask for a **count** of capacity units instead of a
specific node, and the fleet's converger meets that count on enough separate
nodes to survive one of them going down.

**How to use it.** `fleet hosting <node> --tenant <name> --memory 4G --cores
4 --shared` declares a shared slice (CI keeps the node, ranked below the
slice); drop `--shared` to hand the tenant the whole node. `fleet
hosting-demand <tenant> --slices N` asks for a count; `fleet
hosting-converge --dry-run` shows what the converger would do about it.
`fleet hosting --check` verifies a declaration against what the kernel
actually enforces, not against the record that declared it.

**What it does not do.** It never guesses which node is best for a tenant
that has not opted into automatic placement (`placement.auto: true`) — for
everyone else it only reports what it would do. A singleton service never
gets a second primary copy by accident; moving one is a deliberate,
recorded move.

## Repo-fleet audits

**What it does.** Walks every repo this fleet covers for the same handful of
CI contracts — whether its workflow reads the fleet's own runner label
instead of a hard-coded one, whether its tier vocabulary matches the shared
rules, whether a micro-frontend's externals are declared correctly, whether
its CI header follows the shared contract — and reports every repo that
drifted, by name.

**How to use it.** `fleet header-audit --json`, `fleet identity-model --fleet
--json`, `fleet tier-fleet --json` and `fleet mf-externals --json` each run
one auditor; `fleet reconcile --json` reports (and `--confirm` fixes) a
repo's runner coverage against the manifest.

**What it does not do.** These auditors read each repo's current default
branch; they do not open a PR to fix what they find. A repo with no
`@wolffm/*` dependency and no micro-frontend genuinely has nothing for the
header or externals auditors to say, which is a fact about that repo, not a
gap in the auditor.

## The operator CLI

**What it does.** One `fleet <subcommand>` command is the whole operator
surface — about twenty scripts behind one door, so there is one place to
discover what exists and one thing for the tests to reason about. Every
subcommand prints, to stderr, which checkout and which installed version
answered — the same code can live in several trees that update on different
schedules, and this line is what tells them apart.

**How to use it.** `fleet --help` prints the live list, generated from the
command table rather than hand-copied. Every machine-scoped subcommand takes
`--machine <name>`; a bare positional machine name is refused rather than
silently guessed. `FLEET_NO_BANNER=1` silences the provenance line for a
caller that compares stderr byte for byte.

**What it does not do.** A subcommand under the `--json` contract always
answers on stdout as JSON, even on a finding that also sets a non-zero exit
code — a caller that checks the exit code before reading stdout would
mistake a real finding for a crash.

## The GitHub API budget

**What it does.** Reads GitHub's own rate-limit headers after every call and
tracks what each caller inside the package spends, so a cadence that is
cheap for one kind of read (a conditional request GitHub answers "nothing
changed" to, for free) is not assumed cheap for a kind that is not
conditional. Pages before the budget is close to spent, rather than after a
call starts failing.

**How to use it.** `GET /fleet` carries a `githubBudget` array: the token's
remaining budget from GitHub, next to this process's own calls by caller.
One log line per hour names every spender.

**What it does not do.** It does not slow a cadence down automatically when
the budget tightens — budget spent means further calls are suppressed until
the next reset, read back as "could not look," never silently treated as
"nothing changed."

## herdr and the simulator

**What it does.** Two small tools for the operator, not for the fleet
itself. A pair of [herdr](https://herdr.dev) plugins show the fleet, and a
search over past Claude sessions, inside a terminal multiplexer, read-only.
`fleet simulate` replays a whole day of real job history through the actual
dispatcher logic in virtual time — no real node touched — and scores a
candidate placement policy against what really happened, so a placement
change can be judged before it reaches a real queue.

**How to use it.** `herdr plugin link herdr/hadoku-fleet` then `herdr plugin
action invoke hadoku.fleet.open` opens a workspace of panes, one per node
plus the fleet-wide gates. `fleet simulate --tune` sweeps a policy's knobs
over the same replayed history.

**What it does not do.** Neither tool writes anything to a real node. The
simulator scores a policy against history that already happened; it does not
predict load the fleet has not yet seen.

## Trivia

The bulk repo-fleet auditors spend a dedicated GitHub App's own rate-limit
pool rather than the operator's personal one, so a big audit run never
competes with the operator's own GitHub use for budget (`e0feb22`).
