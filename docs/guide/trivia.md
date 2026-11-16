# Trivia

The best facts about Fleet Manager, each with its source. SHAs are this
repo's own, from its public history, which begins 2026-10-22.

## Going public

- Roughly 760 commits and two months of private development became this
  repo's first public commit in one squash, rather than being replayed one
  by one (`50a64a9`).
- The guard that refuses to attach the private companion repo's history onto
  the wrong checkout landed 72 minutes after that first public commit
  (`174db27`). The matching pre-push guard, which refuses any commit whose
  history still reaches into the private side, landed the next day
  (`b25d752`).
- The commit that made this repo public says plainly that every issue cited
  as a bare `#N` in a comment up to that point stays with the private
  companion repo, along with the commits and planning notes before it
  (`50a64a9`).

## Naming things so nothing leaks by accident

- A test's fixture node is named `claw-fixture`, deliberately a name no real
  machine in the fleet carries, so the suite could never accidentally match
  a live one (`321d08b`).
- A separate active-hardware test suite only ever runs against whichever
  node called it, and names no node in its own fixtures, so the same suite
  passes unchanged on every claw in the fleet (`fe04453`).

## Housekeeping at scale

- One commit removed 371 forwarding exports that nothing in the codebase, or
  its one real consumer, actually imported (`b9aa3b0`); a follow-up the same
  day removed 24 more exports from the package's public entry point
  (`29c45b9`).
- Every source file in the repo earned an enforced line ceiling — 800 lines
  for source, 1,000 for tests — in a single commit, and the debt list it
  created is only ever allowed to shrink (`134bae2`).
- The CLI's own command table became declarative data specifically so that
  no consumer would be tempted to parse the built CLI file itself to
  discover what subcommands exist (`23f3c04`).

## Spending someone else's budget carefully

- The repo-fleet auditors that walk every covered repo spend a dedicated
  GitHub App's own rate-limit pool, kept apart from the operator's personal
  one, so a big audit run never competes with the operator's own GitHub use
  for budget (`e0feb22`).

## The backstop

- The fleet's one reserved node used to carry standing runner registrations
  for roughly two dozen repos around the clock; it now mints a runner only
  when a job actually needs it, the same as every other node (`1b26d97`).
- CI on every node moved off the shared administrative account onto a
  dedicated, unprivileged one made for exactly that purpose, with container
  access becoming something a node earns rather than something every node
  starts with (`1a1bb8a`).
