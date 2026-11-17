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
