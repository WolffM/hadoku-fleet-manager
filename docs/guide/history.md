# History

Fleet Manager's public history begins on 2026-10-22. What came before lived
in a private companion repo and is told here only in outline, with no detail
and no commit of its own cited from it.

## Before this repo was public

The package began life inside the platform's own management service and was
split out into its own library and CLI there, then developed privately for
roughly two months. When it went public, that entire prior history — around
760 commits — was folded into one starting commit rather than carried over
commit by commit: `50a64a9`, "published from a fresh public repository,"
whose own message is the citation for everything in this paragraph. The
private companion repo keeps that history, the maintainer's planning notes,
and the repo's issue tracker up to that date; this repo numbers its own
issues from #1.

## Going public (2026-10-22 to 2026-10-23)

The first commits after the cut were the guards that keep the split real:
a check that refuses to attach the private companion's history onto a
checkout that should not have it (`174db27`), and a pre-push hook that
refuses any commit whose history still reaches into the private side
(`b25d752`). Both still run today, and both exist because a `git merge` (as
opposed to a rebase) of a branch begun before the cut would otherwise upload
every one of those private commits silently.

## The backstop stops standing, and CI changes who it runs as (late October)

Two changes landed days apart. CI jobs on every node moved off the
shared administrative account and onto a dedicated, unprivileged account
created for exactly that purpose, with Docker becoming something a node
earns rather than something every node gets (`1a1bb8a`). And the fleet's one
reserved node, previously kept online around the clock with listeners for
dozens of repos, became something the fleet mints a runner on only when it
is actually needed — the same way every other node already worked — rather
than a standing exception (`1b26d97`).

## The shrink (late October to early November)

A two-week pass gave every source file an enforced line ceiling — 800 for
source, 1,000 for tests — with a debt list that is only allowed to shrink
(`134bae2`). The biggest single-day moves split the largest remaining test
files into dozens of smaller ones with no change to what each test actually
checked (`909901f`, `e5edae9`), a later wave (named "gates2") retired or
merged nine of the CLI's oldest prose-only audit gates and consolidated
several toolchain probes into fewer subcommands (`a57f3c3`), and two cleanup
passes removed hundreds of exports nothing in the codebase or its one
consumer actually imported (`b9aa3b0`, `29c45b9`).

## Pushing through a staging branch (2026-11-01)

Direct pushes to `main` stopped; `ppe` became the only branch an operator
pushes to, with its own CI and a scheduled promotion to `main` once it has
been green for a while (`a56eba3`). A hand-maintained version number in a
commit stopped too — the published version is now computed at publish time.

## Hosting other apps' services (ongoing since the cut)

Lending a node's spare capacity to another repo's own long-running service
— rather than only running that repo's CI on it — grew through the whole
post-cut window: a placement record with a fencing token so a service is
never accidentally placed twice (`b70f190`), a check that a service tenant
is judged only on what its own deploy actually needs rather than a guess
(`f6c4875`), and a rule that a service is only placed on a node the fleet
has actually watched stay up for a while (`00f93a7`).

## Simulating the dispatcher (2026-11-11)

`fleet simulate` can now replay a whole day of real job history through the
real dispatch logic in virtual time, with no node touched, and score a
candidate placement policy against what actually happened that day
(`6f26c21`) — a way to judge a placement change before it ever reaches a
real queue.

## Trivia

The guard that refuses to attach the private companion's history onto the
wrong checkout landed 72 minutes after the public repo's very first commit
(`50a64a9`, `174db27`). The rest of the best facts, each with its source,
are in [trivia.md](trivia.md).
