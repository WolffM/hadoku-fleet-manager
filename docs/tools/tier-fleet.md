# `fleet tier-fleet`

Script: `scripts/check-tier-fleet.mjs` + `scripts/lib/tier-detectors.mjs`.

Source: `hadoku_site/scripts/AGENTS.md`, `### check-tier-fleet.mjs (2026-08-04)`,
lines 198–230 at commit `da0653c5` (2026-10-05). Moved here per #97; hadoku_site
replaces that section with a pointer to this file. Usage details that are
properties of the hadoku_site checkout (`REPOS_DIR`, running from the repo
root) stay there — this file keeps only the design rationale.

## Why this exists

`check-tier-gating.mjs` runs in hadoku_site's own CI and pre-commit hook, and
reaches **nothing else**. The 12 child repos holding most of the ecosystem's
actual auth gates had no tier check at all — which is how eight of them
silently fell behind the tier vocabulary before the 2026-08-04 `wife` rollout,
and two carried exact-match allowlists that were already wrong before `wife`
ever existed.

This is the same shape as `check-key-sync.mjs`: hadoku_site is the only place
that knows what the whole ecosystem is supposed to agree on, so it is the one
that audits the siblings.

## What it reads

`origin/main` of each repo (fetched first unless `--no-fetch`), not the working
copy — what is **shipped**, not what happens to be on disk. A local checkout
may be behind origin (reporting drift already fixed) or dirty (reporting drift
nobody pushed). `--worktree` scans working copies instead, for the case where
you're actively fixing things.

It is an **audit, not a gate**: it cannot block a child repo's own CI, only
report. `--warn` makes that explicit by always exiting 0.

## The two rules

Both live in `lib/tier-detectors.mjs`, shared with the in-repo gate so there is
only **one** implementation of each rule — a second copy of a tier rule would
be exactly the class of bug these rules exist to catch.

- **Incomplete tier vocabulary** (`findStaleVocabularies`) — a local list naming
  3+ tiers that omits one. This fails **closed and silently**: the unlisted
  tier gets rewritten to `public` or ranked `-1`, so the caller authenticates
  at the edge and then receives public data — no 401, no 403, no log line.
  Three, not two, is the minimum run length that counts as a vocabulary: a
  two-tier run is overwhelmingly a _comparison_, not a declaration — e.g.
  `tierAtLeast({ userType: 'admin' }, 'friend')` is separated by pure glue and
  syntactically indistinguishable from a two-element list
  (`scripts/lib/tier-detectors.mjs:43-55`).
- **Equality against a non-top tier** (`findNonTopTierEquality`) —
  `userType === 'service'` silently excludes every tier _above_ service.
  `=== 'admin'` is exempt (nothing outranks the top, so it cannot lock anyone
  out — about a dozen such sites exist and flagging them would be noise that
  gets the whole check ignored). This is the two-tier-allowlist shape the
  vocabulary rule cannot see by construction — it caught watchparty's
  browser-side `isPrivileged` (`=== 'service' || === 'admin'`) after the
  server-side twin had already been fixed.

Tests are scanned for stale vocabularies but _not_ for equality comparisons: a
test asserting `userType === 'service'` behaves correctly is the point of the
test, not drift (`scripts/check-tier-fleet.mjs:114-126,195`).

### Comments are not evidence

`blankComments` strips whole-line comments (and, under `{ python: true }`,
docstrings) before scanning, specifically because `hadoku-pygmalion`'s
`tiers.py` opens with a docstring whose entire purpose is to record a tier bug
that was _already fixed_ — and an early version of this audit reported that
sentence as a live violation. A gate that reports its own documentation is a
gate people learn to wave through, which is worse than one that misses
(`scripts/lib/tier-detectors.mjs:57-79`).

## The roster

`FLEET` is derived from `allRepos()` (the one coverage roster — see
`docs/tools/reconcile.md`), never hand-listed. The array this replaced held 15
repos and disagreed with the header checker's 14 on seven names in both
directions. `check-tier-fleet` deliberately takes the **whole** roster rather
than a facet-filtered subset: tier vocabulary can appear anywhere auth is
enforced, and the detectors are pattern-based, so a repo with no JS/TS/Python
auth code simply yields nothing (`scripts/check-tier-fleet.mjs:85-95`).

Exemptions live in `tier-fleet-allowlist.json` (`repo:path`, `why` required); a
stale entry — one that no longer matches a scanned file — is itself reported as
a finding, because an exemption must not outlive its reason.

## Usage

```
fleet tier-fleet             # audit origin/main, exit 1 on drift
fleet tier-fleet --worktree  # audit working copies
fleet tier-fleet --warn      # report, always exit 0
fleet tier-fleet --no-fetch  # skip the fetch (offline)
```

## Verified against this worktree (2026-10-07)

Checked `scripts/check-tier-fleet.mjs` and `scripts/lib/tier-detectors.mjs`
against the source section's claims:

- Both rules, their rationale, the watchparty incident, the pygmalion
  docstring incident, the 3-tier minimum, and the `--worktree`/`--warn`/
  `--no-fetch` flags are **unchanged**.
- One correction: the source section's usage block also listed
  `pnpm run check:tier-fleet` (the hadoku_site npm script that invokes this).
  That's a hadoku_site-side entry point, out of scope here.

**5 of 5 substantive design claims verified unchanged, 0 changed.**
