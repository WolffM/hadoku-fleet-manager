# `fleet header-audit`

Script: `scripts/check-header-fleet.mjs`.

Source: `hadoku_site/scripts/AGENTS.md`, `### check-header-fleet.mjs
(2026-08-05)`, lines 231–305 at commit `da0653c5` (2026-10-05). Moved here per
#97; hadoku_site replaces that section with a pointer to this file. Usage
details that are properties of the hadoku_site checkout (`REPOS_DIR`, worktree
caveats) stay there.

## Why this exists

Two ecosystem rules are enforced at **compile time** inside
`@wolffm/task-ui-components` 3.x: `AppHeader` renders the theme picker and the
settings gear itself, and the raw pickers (`ThemePicker` /
`ConnectedThemePicker`) are no longer exported — so on 3.x a child app
physically cannot substitute either. That enforcement only bites once a repo
is **on** 3.x; a repo pinned to 2.x keeps its private picker and compiles
forever.

So the thing that actually needs auditing isn't "does this app pass a
themePicker" (the type system already answers that) but "is this app still on
a version where it could" — which makes **staleness the primary check**, and
the always-latest policy is what closes the loop. Same shape as
`check-tier-fleet.mjs` and `check-key-sync.mjs`.

It reads `origin/main` (fetched first; `--worktree` for working copies), and it
is an audit, not a gate — it reports, a human or cron acts.

## The rules

The source section (2026-08-05) listed: `stale-package`, `stale-peer`,
`no-update-flow`, `no-landing-path`, `private-picker`, `no-app-header`,
`no-provider`, `no-checkout`, `not-in-fleet`, `not-in-fanout`, `npm-auth-form`.

**Changed since** — the script's own header comment (`scripts/check-header-fleet.mjs:36-123`)
now documents these rules instead, and the set has grown:

- `stale-package`, `stale-peer`, `no-update-flow`, `no-landing-path`,
  `private-picker`, `no-app-header`, `npm-auth-form` — **unchanged**, same
  rationale as below.
- `release-age-cooldown` — **new**, not in the source section at all. pnpm
  11.5 defaults `minimum-release-age` to 24h and verifies the whole lockfile
  against it on every install, which collides head-on with always-latest (the
  auto-update commit installs a version minutes old). The exemption must be
  the scope glob `@wolffm/*` — a pinned `name@version` entry silently never
  matches, which is how `hadoku-tenhands` failed verification twice on
  2026-08-05 trying to pin `@wolffm/themes@4.0.0` as its own exclusion.
  Found live 2026-08-26 on `hadoku-filetransfer`, which had neither
  (`scripts/check-header-fleet.mjs:1071-1095`).
- `header-name-hardcoded` / `header-name-unverified` — **new**. Whether the
  `<AppHeader>` title hardcodes the app's name rather than reading it from
  `@wolffm/catalogue`'s `spec/categories.json` at runtime. `no-app-header`
  cannot see this at all — it only asks whether the header is _present_ — which
  is why a hardcoded "Craft" tab over a catalogue entry of "Hadoku Craft"
  reported as "no drift" across fifteen repos the whole time
  (`scripts/check-header-fleet.mjs:65-82`).
- `no-favicon` — **new**. An index.html entry shell with no `<link
rel="icon">`; nothing inherits one, so the tab renders the generic globe.
- **`not-in-fanout` is RETIRED** (2026-08-26). It asked whether a repo was a
  `child-apps.json` consumer and said "publishes never reach it" — which
  stopped being true on 2026-08-23 when the fan-out's derivation moved to the
  `wolffmConsumer` coverage facet. Repointing the rule at that facet would only
  ever agree with `not-in-fleet`, which already compares against the same
  facet — so it was deleted rather than repaired: "a rule that cannot be wrong
  in a way its neighbour is not already wrong is not coverage"
  (`scripts/check-header-fleet.mjs:87-100`). Treat the source section's mention
  of `not-in-fanout` as **stale**.
- `no-provider` and `no-checkout` are still active (confirmed at
  `scripts/check-header-fleet.mjs:1000-1005` and `:1199-1201`) — just not named
  in the new header's rule list, which only documents the ones with inline
  prose blocks. `not-in-fleet` is likewise still active
  (`scripts/check-header-fleet.mjs:1159`).

## `npm-auth-form` (unchanged)

Every repo authenticates `npm.pkg.github.com` installs the same way, with the
install-only token. Before 2026-08-19 three different forms were in use — an
inline `${{ secrets.… }}`, a shell `${VAR}` fed by vault-fetch, and an env
export consumed by a committed `.npmrc` — and nothing described a canonical
shape, so migrating the credential took three passes and a per-repo reading of
every workflow. The rule is deliberately narrow: it does not dictate _where_
the `.npmrc` comes from (a monorepo with several packages legitimately
differs), only that whatever authenticates presents `HADOKU_NPM_READ_TOKEN`,
never `HADOKU_SITE_TOKEN` (which carries repo + workflow scope, so a leak from
an install step is an account compromise). It skips `#`-prefixed lines after
`blankComments`, because `tenhands`' `taskauto.yml` explains the tokenless
scheme in a comment and reported as a violation on the first run
(`scripts/check-header-fleet.mjs:328-369`).

## `stale-peer` (unchanged)

`@wolffm/*` peerDependencies must be floors (`>=x.y.z`), never caret/tilde/
exact — `pnpm update --latest` bumps deps/devDeps but never peers, so a caret
peer rots the moment the fleet crosses a major (six repos sat on `^3.0.0` while
installing tuic 4.x). Covers `templates/` too, so a scaffolded app doesn't
start pre-drifted.

## `not-in-fleet` and the roster itself (unchanged in spirit, facet-scoped since)

The rule that checks the **list itself**, not just what's in it: every other
rule only inspects repos named in the roster, so a repo nobody remembered to
add is invisible to all of them (conjure absent from the fan-out until
2026-08-04; pygmalion with no update path at all from creation until
2026-08-05 — both found by hand). It scans `REPOS_DIR` for any repo declaring
an `@wolffm/*` dependency and asserts it appears in the `wolffmConsumer`
coverage facet (`KNOWN_CONSUMERS`), comparing against the **publish-safe**
dependency fields only — matching the raw text would also catch a manifest's
own `"name": "@wolffm/…"` for a repo that _publishes_ an `@wolffm` package
without consuming any, which is exactly what tripped `hadoku-fleet-manager`
itself on its first nightly run (`scripts/check-header-fleet.mjs:1082-1157`).

**New since the source section: `new-repo-grace` (#95).** hadoku_site's
`reconcile-fleet-coverage.yml` is what actually admits a repo into the roster,
scheduled `30 12` / `0 14` UTC but observed to fire hours late — so a repo
created minutes before a `header-audit` run is reliably `not-in-fleet` through
no fault of its own. Found 2026-10-05 when `hadoku-housemodel`, created
21:04Z, paged `@here` at 06:11Z — hours before the regen could possibly have
run. A 24-hour grace window (`NEW_REPO_GRACE_HOURS`) reports the same finding
as **advisory** instead of failing, measured from the repo's first commit
reachable from `origin/main` (never GitHub's `created_at`, which would need an
extra API call the checkout already makes unnecessary) — and refuses to trust
that age on a shallow clone, because a depth-1 clone's only visible commit is
the newest one, which would read a months-old repo as brand new
(`scripts/check-header-fleet.mjs:1007-1065`).

## `no-provider` / `no-checkout` (unchanged)

Two rules describing one general trap: an "answer that looks real."
`no-provider` — `<HadokuThemePicker />` / `<AppHeader>` throw at runtime
without a `<HadokuThemeRoot>` above them, which typecheck and build both miss
because a missing React context is a runtime fact, not a compile one.
`no-checkout` — a missing sibling checkout used to be a silent `continue`,
which combined with a misresolved repos dir to print "OK — no drift" while
auditing nothing: "an audit that asserts cleanliness without looking is worse
than no audit."

**Not a rule:** a file merely named `*Settings*` — craft's `SettingsPanel` is
print-job settings, not user settings, and keying on the word would
false-positive every run.

## Usage

```
fleet header-audit                # audit origin/main, exit 1 on drift
fleet header-audit --worktree     # audit working copies
fleet header-audit --warn         # report, always exit 0
fleet header-audit --no-registry  # skip npm view (offline)
fleet header-audit --json         # machine-readable, for ci:header-fleet
```

`--json` reports registry blindness as a first-class field: `latestVersion`
swallows every npm failure into `null`, so an unauthenticated run would
otherwise report "no drift" while `stale-package`/`stale-peer` silently
checked nothing — "I could not look" must never render as "nothing is wrong"
(`scripts/check-header-fleet.mjs:114-122`).

## Verified against this worktree (2026-10-07)

Checked the full rule list, the `npm-auth-form`, `stale-peer`, `not-in-fleet`
and `no-provider`/`no-checkout` sections, and the roster-derivation claim
against `scripts/check-header-fleet.mjs` in full.

**7 claims verified unchanged** (`stale-package`, `stale-peer`,
`no-update-flow`, `no-landing-path`, `private-picker`, `no-app-header`,
`npm-auth-form`, `no-provider`, `no-checkout`, `not-in-fleet` — core mechanics
all intact).
**3 claims changed/retired**: `not-in-fanout` retired 2026-08-26 (source
section still lists it as active); the rule list itself grew by four
(`release-age-cooldown`, `header-name-hardcoded`, `header-name-unverified`,
`no-favicon`) since the section's 2026-08-05 date; `new-repo-grace` (#95) added
an advisory window around `not-in-fleet` that did not exist in the source.
