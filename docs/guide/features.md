# Features

What Fleet Manager does, for the operator running it. How it works inside is
in [contributing.md](contributing.md).

There is no browser UI and no tier ladder. Every feature below is reached
through the `fleet` CLI, or through the platform's own management service.
That service runs this package in-process. "Node" is a machine the fleet
manages; a **claw** is a node whose only job is CI (a subset, not a
synonym); a **runner** is one registration of a node against one repo.

Two things it owns sit outside the six features below. It writes
machine-generated blocks into the platform's own docs — the CI alert watch
list (`fleet ci-watch`) and the workflow-to-runner blast-radius table
(`fleet inventory`) — each checked for staleness with `--check`. And it does
**not** own general cron dispatch, repo branch-protection policy, or anything
scoped to a single repo; those stay in the platform's management service.

## Runner-fleet health and dispatch

**What it does.** Watches every node's liveness and decides, job by job,
which node takes it. A node earns the label that lets GitHub schedule work
on it only while it is safe: not quarantined, not drained, not failed by
its last check-in. An unsafe node simply stops being offered work rather
than being specially excluded. Placement ranks candidates by how busy they
are and how long they have been idle, plus two safety rules. A node slow at
one kind of job keeps that kind off a faster node. A heavy job may double
up on a node already running one heavy job, but only after it has waited
long enough.

**How to use it.** `fleet queue-health --json` and `fleet decisions [--job
ID | --node X | --repo R]` read back what the dispatcher saw and why a job
went where it went. Every dispatch decision is written to a log with the
candidates it considered, in order, and why each skipped one was skipped.
`GET /fleet` (served by the platform's management service) is the same
report the command station renders.

**What it does not do.** It does not run the jobs themselves — GitHub's own
Actions runner does that, once this package has registered it and minted it
a credential. A job that waits past a long ceiling is reported as queued, not
silently retried.

**Containment.** Every job runs in a memory-capped unit that may lower its
CPU priority but never raise it. A unit still running ten minutes after
GitHub closed its job is stopped: a starved runner can lose touch with
GitHub and run on for an hour holding the memory it was starving for. On the
shared workstation node, CI is the first thing the kernel reclaims and the
first thing oomd kills under memory pressure, before the production services
beside it.

## Node onboarding

**What it does.** Carries a bare machine through six phases:

1. Image it.
2. Turn it into a server (no sleep, ssh, firewall, watchdog).
3. Enroll it as a declared node.
4. Provision it (install everything a runner needs).
5. Verify it against what was actually installed, not what the manifest
   claims.
6. Only then admit it to real scheduling.

A node **earns** a capability (a routing label) by having a probe actually
execute it, not by a manifest entry alone.

**How to use it.** `fleet enroll` writes a proposed manifest entry and exits
non-zero until an operator commits it — enrollment is the one place a node
describes itself; everywhere else the manifest declares and a probe observes.
`fleet provision`, then `fleet bootcamp` to prove the capabilities a node
should have, `fleet qualify` to run a one-node playlist of load tests
(network, disk, concurrency) before trusting its numbers. A qualification
judges each node against its own learned range, not one bar for every box.
A bar the hardware cannot meet is recorded as that node's weak point. A
reading outside the node's usual range is a drift finding, and the range
re-learns at the new reading. The nightly health check judges each node's
CPU temperature and clock under load the same way.

**What it does not do.** It will not admit a node to scheduling on the
manifest's say alone — a capability a probe cannot confirm is not offered,
even if the operator believes it should be there.

### Agent sessions on a node

**What it does.** Lets a node host the operator's interactive agent sessions
(a Claude session under herdr), so the builds and browsers a session starts
use that node's cores instead of the controller's. Each hosting node gets a
third user for it, the **dev** user, beside the one that manages the node and
the one that runs CI. It has no sudo and belongs to no shared group, and its
whole slice of the machine is weighted below CI's: a session gets an idle
machine to itself, and CI wins when both want it.

**How to use it.** `fleet node-users --dev <node>` is a dry run that lists
what would change; `--confirm` creates the user, copies the controller's own
`claude` binary to it, logs in as it to prove the path, and records the user
in the manifest. `fleet node-users --machine <node>` reads everything back
from the node and reports `sessions: ok` or what drifted. `--dev <node> --back
--confirm` undoes it, and deletes the user's keys from the home it keeps.

A session leases its Claude token from crossposter's account pool as the
node's own identity, `<node>-sessions`, through crossposter's `claude-lease`,
which the setup copies beside `claude`. So one node's sessions can be granted
or revoked on their own, and a rate limit a session hits benches the account
for everyone. The operator mints that identity once per node; the setup then
delivers its key and proves it by asking the edge who it is. A session pushes and
calls GitHub on a token of the node's own too, which the same setup logs the
user's `gh` in with and proves by asking GitHub who it is.

A live session counts as work in progress. The nightly refresh and the
reboot cycle skip a node while a session runs there, and come back to it once
it ends; a session more than a day old no longer counts, and the cycle says
so when it goes ahead.

**What it does not do.** It stores no credential on the node. It never
removes the home directory on undo (only the account), and it refuses to undo while anything
still runs as that user.

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
CI contracts, and reports every repo that drifted, by name:

- whether its workflow reads the fleet's own runner label instead of a
  hard-coded one;
- whether its tier vocabulary matches the shared rules;
- whether a micro-frontend's externals are declared correctly;
- whether its CI header follows the shared contract;
- whether a Rust cache step in its workflows, or in an action they call,
  would delete the cargo tools installed on the node that runs it.

**How to use it.** `fleet header-audit --json`, `fleet identity-model --fleet
--json`, `fleet tier-fleet --json` and `fleet mf-externals --json` each run
one auditor; `fleet reconcile --json` reports (and `--confirm` fixes) a
repo's runner coverage against the manifest, and carries the Rust cache
finding as `cargoBin`. That finding is advisory: it is reported and never
fails the run.

**What it does not do.** These auditors read each repo's current default
branch; they do not open a PR to fix what they find. The Rust cache check
follows actions this fleet's owner publishes, at the ref each workflow pins,
and the two third-party actions known to clean that directory; any other
third-party action is counted, not read. A repo with no
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
code. A caller that checks the exit code before reading stdout would
mistake a real finding for a crash.

## The GitHub API budget

**What it does.** Reads GitHub's own rate-limit headers after every call and
tracks what each caller inside the package spends. A cadence that is cheap
for one kind of read (a conditional request GitHub answers "nothing
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
dispatcher logic in virtual time, with no real node touched, and scores a
candidate placement policy against what really happened. A placement
change can be judged this way before it reaches a real queue.

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
