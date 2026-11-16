---
title: Fleet Manager
summary: >-
  A library and operator CLI that runs the hadoku CI fleet, the self-hosted
  machines that build and test every repo on the account, deciding which
  machine takes each CI job, onboarding new machines, and lending a
  machine's spare capacity to another app's own service for a while.
features:
  - name: Runner-fleet health and dispatch
    summary: Decides which machine takes each CI job, and keeps one runner listening per decision.
    anchor: runner-fleet-health-and-dispatch
  - name: Node onboarding
    summary: Six verbs turn a bare machine into one the fleet will schedule real work on.
    anchor: node-onboarding
  - name: Drains, leases and the backstop
    summary: Take a machine out of CI for a while, or bring in the one machine held in reserve for an outage.
    anchor: drains-leases-and-the-backstop
  - name: Hosting a tenant service
    summary: Lend a machine's spare memory and cores to another app's own long-running service.
    anchor: hosting-a-tenant-service
  - name: Repo-fleet audits
    summary: Walks every repo's CI setup for the same handful of contracts and reports who drifted.
    anchor: repo-fleet-audits
  - name: The operator CLI
    summary: One `fleet` command covers roughly twenty subcommands, every one scriptable with `--json`.
    anchor: the-operator-cli
  - name: The GitHub API budget
    summary: Tracks what every caller spends against GitHub's rate limit, and pages before it runs out.
    anchor: the-github-api-budget
  - name: herdr and the simulator
    summary: Watch the fleet from a terminal multiplexer, or replay a day of real jobs through the dispatcher without touching a machine.
    anchor: herdr-and-the-simulator
trivia:
  - "The whole private history before this repo went public — about 760 commits over roughly two months — became this repo's first commit (`50a64a9`)."
  - "A test's fake node is named `claw-fixture`, a name no real machine carries, so the suite can never accidentally match one (`321d08b`)."
  - 'One commit removed 371 forwarding exports that nothing imported (`b9aa3b0`).'
  - 'Every source file earned a line ceiling — 800 lines for source, 1,000 for tests — the same week dozens of files were split to fit under it (`134bae2`).'
---

# Fleet Manager

Fleet Manager runs the hadoku CI fleet: a set of self-hosted machines
("nodes," one kind of which is a "claw" — a node whose only job is CI) that
build and test every repo on the account instead of billed, shared runners.
It decides which node takes a CI job, mints the runner that serves it and
retires it afterward, walks every covered repo for the same handful of CI
contracts, and can lend a node's spare capacity to another app's own
long-running service for a while.

It is **not a service you open**. It ships as a published library
(`@wolffm/fleet-manager`) that the platform's own management service runs
in-process, plus one CLI, `fleet`, for the operator. There is no sign-in and
no tier ladder here — the whole tool is operator-only, reached by `ssh` and a
terminal, not a browser.

**This repo is public; a private companion repo is not.** The public history
starts on 2026-10-22, when roughly two months of prior private development
were folded into one starting commit (`50a64a9`) and the public repo began
numbering its own issues from #1. The private companion keeps the maintainer's
planning notes and the issue history before that date; nothing here links to
either.

## Where to read next

| You want to                   | Read                               |
| ----------------------------- | ---------------------------------- |
| what it does, as an operator  | [features.md](features.md)         |
| run it, change it, or ship it | [contributing.md](contributing.md) |
| how it got here               | [history.md](history.md)           |
| the odd facts                 | [trivia.md](trivia.md)             |

The deep rules — the ones that fail silently when broken, each with the
incident that taught it — live in [`AGENTS.md`](../../AGENTS.md) at the repo
root. This guide is the map; that file is the territory.

## Trivia

The full list, each with its source, is in [trivia.md](trivia.md).
