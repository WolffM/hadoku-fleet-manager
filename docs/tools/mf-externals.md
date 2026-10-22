# `fleet mf-externals`

Script: `scripts/check-mf-externals.mjs`.

Source: `hadoku_site/scripts/AGENTS.md`, `### check-mf-externals.mjs
(2026-08-05)`, lines 306–341 at commit `da0653c5` (2026-10-05). Moved here per
#97; hadoku_site replaces that section with a pointer to this file. Usage
details that are properties of the hadoku_site checkout stay there.

## Why this exists

Every micro-frontend mounts into a parent page whose import map already
supplies React, `@wolffm/themes`, `@wolffm/task-ui-components`,
`@wolffm/logger/client` and `@wolffm/prefs-client`. These are **singletons**:
React context matches on module identity, the theme context is owned by one
copy, and the logger and prefs client each hold their own instance cache. A
bundle that **inlines** one gives the page a second copy the first never talks
to.

Not hypothetical: on 2026-08-05, `hadoku-aggregator` and `hadoku-craft` both
inlined `@wolffm/task-ui-components` while the theme provider arrived from the
parent's copy — two React contexts, and every user hit "No
`<HadokuThemeRoot>` above this component" with the provider plainly mounted.
`craft` stayed broken for days after `aggregator` was fixed, because nothing
tied the two repos together — this gate is what ties them.

**This gate exists because nothing else can see the failure.** It typechecks,
lints, builds, and passes tests. It appears only in a browser, for everyone at
once.

## The rule

If the parent's import map (`src/layouts/Base.astro`'s `<script
type="importmap">`) provides a specifier **and** a child imports it, the
child's lib build must list it in `rollupOptions.external`. The import map is
read at runtime rather than hardcoded, so mapping a new module automatically
extends the rule to every child (`scripts/check-mf-externals.mjs:117-121`).

Apps that serve their own HTML (conjure, pygmalion, games-host) have no parent
import map and must inline everything; they carry no entry in
`scripts/child-apps.json` and are skipped.

## Singletons vs. notes

`SINGLETONS` (react family, `@wolffm/themes`, `@wolffm/task-ui-components`,
`@wolffm/logger/client`, `@wolffm/prefs-client[/react]`) — inlining one of
these **fails** the audit, because it forks live state, not just bytes.

Everything else the import map carries (`zod`, `recharts`) is reported as a
**note**, not a failure — inlining costs bundle size and a duplicate download,
not correctness.

**Changed since the source section (2026-08-18):** the source section called
the zod/recharts trade "a judgement call per app... inlining costs bytes,
externalizing trades those bytes for a runtime fetch." That's no longer true
for **zod** specifically, and the current script documents why it measured the
claim rather than assumed it: `@wolffm/themes` imports zod _bare_ from
`themePrefs.js`, and every micro-frontend imports themes — so the page fetches
`esm.sh/zod` whether or not the child bundle _also_ contains a copy. Confirmed
against the live site 2026-08-18: `/task` (bundle inlines zod) and `/study`
(bundle externalizes it) both issued the same 16 `esm.sh/zod` requests. So
there is no trade to weigh for zod — inlining it buys nothing and costs ~100 kB
(`hadoku-study` measured 131 kB → 33 kB). Left as a note rather than promoted
to a failure anyway, because turning it red would fail four repos' audits over
a change their owners haven't made yet. `recharts` remains a genuine
per-app judgement call (`scripts/check-mf-externals.mjs:87-104`).

## The roster

`FLEET` is `reposWith('microFrontend')` off the one coverage roster (see
`docs/tools/reconcile.md`), never hand-listed. The array this replaced held 9
entries with hand-written build paths (`frontend/vite.config.ts` for
tenhands, `apps/ui/vite.config.ts` for watchparty); the derived set reproduces
all nine exactly and adds six that had simply never been added
(`scripts/check-mf-externals.mjs:60-74`).

## Usage

```
fleet mf-externals             # audit origin/main
fleet mf-externals --worktree  # audit working copies
fleet mf-externals --warn      # report, exit 0
fleet mf-externals --no-fetch
```

## Verified against this worktree (2026-10-07)

Checked `scripts/check-mf-externals.mjs` in full against the source section.

**3 claims verified unchanged**: the rule itself (import map → external),
the 2026-08-05 aggregator/craft incident, the roster derivation and its nine
reproduced entries.
**1 claim changed**: the zod/recharts "judgement call" framing is stale for
zod — the 2026-08-18 measurement on the live site showed externalizing buys
nothing to weigh against, because `@wolffm/themes` already fetches it
unconditionally. The source section (written 2026-08-05, before that
measurement) still frames it as an open trade for both modules; the current
script frames it as settled for zod and open only for recharts.
