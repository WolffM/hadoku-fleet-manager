#!/usr/bin/env python3
"""runner-mem-report — turn the harvest into the numbers step 6 needs.

Reads the JSONL that runner-mem-harvest.py appends on each node and answers
three questions the fleet could not answer before:

  1. What does a job on THIS REPO actually cost in unreclaimable memory?
  2. How badly does memory.current overstate that? (the §1 retraction, per repo)
  3. Does `maxConcurrent` x the tail actually fit in the node's RAM?

A window the harvest marked CLIPPED — one whose cgroup recorded an OOM kill —
answers none of those. Its peak is bounded by the cap that killed it, so it is a
FLOOR and never a requirement: clipped windows are excluded from every
percentile, counted separately, and a repo whose windows are ALL clipped reports
"no usable measurement" rather than a number. A window with no `clipped` key at
all (written by a harvester old enough to predate the field) is UNMARKED — it
still sizes, because throwing it away would be the opposite error, but every
number drawn from a population that contains one is a LOWER BOUND rather than a
plain measurement (`lowerBound`/`unmarkedInStat` in `--json`, a `≥` prefix in
text): brave-quartet's only two windows on the live fleet are both unmarked
(its original 2026-09-19 OOM kills) and must read `≥3739`, never a bare 3739.
`--json`'s top-level `findings` additionally names every explicitly CLIPPED
window's repo, job (unit), cap and kill — additive, never a bare count.

(3) is the one that matters most. A count cap cannot express "three cheap jobs
are fine, three hadoku_site jobs are not", so a node can be inside its
declared concurrency limit and still be over its memory budget — which is what
`maxConcurrent: 3` on claw-2's 7.7 GB turned out to be at the tail.

Usage:
  fleet mem-report                 # whole fleet over ssh
  fleet mem-report --min-dur 15    # ignore trivial windows
  fleet mem-report --json
  fleet mem-report --check         # gate: is the harvest ALIVE and CURRENT on
                                   # every node? Reads the OUTPUT files, never
                                   # `systemctl is-active` — a unit that is up
                                   # with a stale output file is broken, and
                                   # is-active is exactly the reader that
                                   # cannot see it (#47).

SPLIT (wave 5q lane D) into `mem_report_env.py` (node identity / ssh roles)
and `mem_report_check.py` (the `--check` gate), loaded LAZILY by `_sibling()`
below — never at module scope. That matters for two things this package does
NOT control:

  - `scripts/lib/slice-placement-guard.test.mjs` copies, and separately
    MUTATES, only THIS file into a scratch directory with no siblings beside
    it, then runs `main()` against it with `collect` replaced and no
    `--check` — a path that reaches `repo_of`/`split_windows`/`main` but
    never node-identity or the --check gate. Eager imports at module scope
    would fail loading that copy at all, for code it never calls; the lazy
    form only pays for a sibling the call it is actually for needs — same
    shape `hub_repo()` below already uses for a BUILT-package dependency it
    cannot assume either.
  - `runner_mem_report_test.py` monkeypatches `local_node`/`subprocess`/
    `getpass` as ATTRIBUTES of this already-loaded module and then calls
    `collect()`'s real body — which only works if `collect()` keeps
    resolving those names through ITS OWN globals, i.e. this module's dict.
    That is why `collect()`, `local_node`, `assert_can_act_locally` and
    `ssh_destination` stay defined (or re-exported) here rather than being
    plain `from mem_report_env import ...` re-bindings done once at import
    time: a patch applied to `runner-mem-report`'s own attribute must be
    what every later bare-name call inside this file actually sees.
"""

import argparse
import getpass  # noqa: F401 — kept importable as `mem_report.getpass` for
# `runner_mem_report_test.py`'s `mock.patch.object(mem_report.getpass, ...)`,
# which patches the shared stdlib module every caller (including
# mem_report_env.py's own `import getpass`) sees — not this file's own code.
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _sibling(name):
    """Load `scripts/<name>.py` by its own absolute path — the mechanism
    `harvest_interval()` already used (now in `mem_report_env.py`) for
    `runner-mem-harvest.py` before this file was split. Never a plain
    `import`: this file is loaded three different ways (`python3
    runner-mem-report.py`, where CPython puts THIS file's directory on
    `sys.path[0]`; spawned by the CLI the same way; and
    `importlib.util.spec_from_file_location`, used by every test in this
    tree, which puts nothing on `sys.path` at all), and only an absolute,
    `__file__`-relative path behaves the same under all three.

    CACHED IN `sys.modules`, NOT A LOCAL DICT — `mem_report_check.py` loads
    `mem_report_env.py` too (its own `_env()`, same reasoning), and a role or
    manifest resolution WARMED through one loader must be visible to the
    other: `runner_mem_report_test.py` warms `node_role_user`'s cache via
    this file's wrapper, then calls `_probe_node` (which asks the same
    question through `mem_report_check.py`), and expects the second ask to
    be the cached answer rather than a fresh `node` subprocess call. Two
    independent `importlib` loads of the same file produce two independent
    module objects with two independent caches; `sys.modules`, keyed by the
    same name every loader here agrees on, makes the first load everyone's
    load — the ordinary meaning of "already imported".

    LAZY ON PURPOSE — called from inside the functions below, never at
    module scope. See the module docstring for why a copy of only this one
    file, with no siblings beside it, must still load successfully for the
    code paths that never call into one.
    """
    if name in sys.modules:
        return sys.modules[name]
    import importlib.util

    path = (HERE / f"{name}.py").resolve()
    if not path.is_file():
        raise SystemExit(
            f"fleet mem-report: {path} does not exist — this copy of "
            f"runner-mem-report.py is missing its sibling module {name}.py"
        )
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ── thin re-exports of mem_report_env.py — see the module docstring for why
# these stay defined HERE (bare-name calls inside `collect()`, and the
# attributes `runner_mem_report_test.py` calls/patches directly) rather than
# being bound once at import time.


def ask_library(machines=()):
    """`{manifestDir, stateDir, local?}` — see `mem_report_env.ask_library`."""
    return _sibling("mem_report_env").ask_library(machines)


def node_role_user(machine, role):
    """The user that plays `role` on `machine` — see
    `mem_report_env.node_role_user`."""
    return _sibling("mem_report_env").node_role_user(machine, role)


def ssh_destination(node, role, machine):
    """`<user>@<node>` for ROLE — see `mem_report_env.ssh_destination`."""
    return _sibling("mem_report_env").ssh_destination(node, role, machine)


def assert_can_act_locally(node, role, machine):
    """See `mem_report_env.assert_can_act_locally`."""
    return _sibling("mem_report_env").assert_can_act_locally(node, role, machine)


def local_node(nodes):
    """Which of `nodes` is this box, or None — see `mem_report_env.local_node`.
    Deliberately a bare top-level name here, not inlined into `collect()`:
    `runner_mem_report_test.py` monkeypatches `mem_report.local_node` and
    relies on `collect()`'s own bare-name lookup resolving through THIS
    module's globals."""
    return _sibling("mem_report_env").local_node(nodes)


def run_checks(nodes, as_json=False):
    """The `--check` gate — see `mem_report_check.run_checks`."""
    return _sibling("mem_report_check").run_checks(nodes, as_json)


def _probe_node(name, local, machine):
    """Run PROBE on one node — see `mem_report_check._probe_node`."""
    return _sibling("mem_report_check")._probe_node(name, local, machine)


def manifest_path():
    """The node topology — the same tree the CLI's banner resolved.

    (#46) The fallback this used to have, `HERE.parent / "manifests"`, read the
    4-machine fixture PACKAGED with the repo and presented it as the fleet:
    measured 2026-09-22 from a source checkout, `fleet mem-report --json`
    printed `manifests=<site>/scripts/admin` on stderr, then reported
    `machinesDeclared: 4, unreachable: [], exit 0` over the fixture — five
    claws silently absent while 5,107 real windows were attributed to the
    wrong topology. A comment above the old read said it had been fixed; the
    code was still reading the fixture. So there is NO local fallback at all:

      FLEET_MANIFEST_DIR set      that directory, or a refusal naming it
      otherwise                   whatever dist/lib/fleet-paths.js resolves —
                                  the same call the CLI banner printed — or its
                                  refusal, verbatim
    """
    env = os.environ.get("FLEET_MANIFEST_DIR", "").strip()
    # SET WINS OUTRIGHT. A set-but-wrong FLEET_MANIFEST_DIR must fail, never
    # fall through to the library: falling through answers a question about
    # ANOTHER operator's fleet with this one's topology, and nothing in the
    # output says so.
    if env:
        p = Path(env) / "fleet-runner-manifest.json"
        if p.is_file():
            return p
        raise SystemExit(
            f"fleet: no fleet-runner-manifest.json at {p}\n"
            "  FLEET_MANIFEST_DIR names that directory; point it at the fleet manifests."
        )
    d = Path(ask_library()["manifestDir"])
    p = d / "fleet-runner-manifest.json"
    if p.is_file():
        return p
    raise SystemExit(
        f"fleet: no fleet-runner-manifest.json at {p}\n"
        f"  The package's library resolved the manifest directory to {d} —\n"
        "  a manifest that resolves to nothing reports a healthy fleet of zero\n"
        "  machines, so this refuses rather than reading any other copy."
    )


# ── a killed run is not a measurement ───────────────────────────────────────
#
# A cgroup kill at `memory.max` TRUNCATES the window it ends: the sampled peak
# can never exceed the cap that killed it. So a clipped window's anon figure is
# a FLOOR — "this job wanted at least this much" — and feeding it to a
# percentile makes the sizing input bounded by the limit it exists to set.
#
# brave-quartet is the case that named it. Its only two windows ARE its two
# killed runs (2026-09-19 10:55 and 11:26, `oom-kill:constraint=CONSTRAINT_MEMCG`,
# anon-rss 3830164kB), and it reported p95/max 3,739 MiB — one hair under the
# 4 GiB unit cap, which is what a clipped distribution always looks like. Read
# as a measurement, that number says "3.7 GB is enough" about the one repo on
# this fleet known for a fact that it is not.
#
# THREE STATES, NOT TWO. `clipped: true` is excluded from sizing and counted.
# `clipped: false` is usable. A record with NO `clipped` key at all came from a
# harvest that predates the field — it is neither, it is UNMARKED, and it is
# counted and named rather than assumed either way. Assuming clean would be the
# silent version of the bug; assuming clipped would throw away the 674-window
# baseline every existing number rests on. So UNMARKED STILL SIZES — `usable`
# below is "not explicitly clipped", same as it always was — but every stat
# drawn from a population that contains an unmarked row is a LOWER BOUND, not
# a plain number: an unmarked row could have been clipped and the field simply
# predates saying so, so the true tail could sit higher than what is reported,
# never lower. `lowerBound` / `unmarkedInStat` (additive JSON fields, a `≥`
# prefix in text) carry that caveat forward instead of discarding the data or
# passing it off as confirmed-clean.
#
# brave-quartet is the live case: its only two windows on the fleet today are
# its original 2026-09-19 kills (`actions-runner-brave-quartet.service`, host
# hokon, peak_unreclaimable_mb 3739.3 / 3444.4), written by a harvester old
# enough to carry no `clipped` key at all. They still size — dropping them
# would be the opposite error — but they must read `≥3739`, never a bare 3739.


def split_windows(rows):
    """`(usable, clipped, unmarked)` — sizing rows, floors, and the unknowable."""
    clipped = [r for r in rows if r.get("clipped") is True]
    unmarked = [r for r in rows if "clipped" not in r]
    usable = [r for r in rows if r.get("clipped") is not True]
    return usable, clipped, unmarked


def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * len(s)))]


# A stat is a LOWER BOUND exactly when an unmarked row could be sitting in its
# population — it might have been clipped and simply predates the field that
# would say so, so the true value can only be AT LEAST what is reported.
def is_lower_bound(unmarked):
    return len(unmarked) > 0


# "the shape a clipped distribution always looks like" (see above): a max
# sitting at-or-just-under a known cap is the same signature whether or not
# any window in this population happens to carry `clipped: true` itself. 0.98
# matches "one hair under the cap" without flagging an unrelated lower figure.
NEAR_CAP_FRACTION = 0.98


def cap_reference(rs, usable):
    """The cap to compare a measured max against, from whichever row in this
    repo/node's history happens to carry `cap_mb` — preferring the usable row
    with the largest peak, since that is the one the comparison is about."""
    for x in sorted(usable, key=lambda r: -(r.get("peak_unreclaimable_mb") or 0)):
        if x.get("cap_mb"):
            return x["cap_mb"]
    for x in rs:
        if x.get("cap_mb"):
            return x["cap_mb"]
    return None


def at_cap(max_mb, cap_mb):
    """True when `max_mb` sits at or within `NEAR_CAP_FRACTION` of a known
    cap — the shape #44 is named for, flagged even when nothing in the
    population is itself marked `clipped`."""
    return cap_mb is not None and max_mb >= cap_mb * NEAR_CAP_FRACTION


def clipped_finding(r, repo):
    """One finding per clipped window: the repo AND the job, the cap AND the
    kill — never a bare floor number with no way to act on it. `unit` carries
    the job identity: the all-JIT shape embeds the run
    (`jit-<node>-<repo>-j<jobId>-r<runId>-<mintTs>`), which is more specific
    than anything this report could invent."""
    return {
        "repo": repo,
        "unit": r.get("unit"),
        "host": r.get("host"),
        "end": r.get("end"),
        "capMb": r.get("cap_mb"),
        "oomKills": r.get("oom_kills"),
        "cgroupReset": r.get("cgroup_reset"),
        "peakUnreclaimableMb": r.get("peak_unreclaimable_mb"),
    }


def collect(nodes):
    """Pull every node's JSONL. A node that cannot be read is NAMED, never
    silently dropped — 'I could not look' must not read as 'there was nothing'.

    `nodes` is the manifest's `machines` MAPPING, not a bare list of names:
    the harvester's output is `ci`'s own file (deployed `as: 'ci'` by
    `deploy-ci-throttle.mjs`), and naming that role on a remote call needs
    each node's own `users.ci` override from its manifest entry."""
    remote = _sibling("mem_report_env").REMOTE
    rows, unreachable = [], []
    local = local_node(nodes)
    for m, cfg in nodes.items():
        if m == local:
            assert_can_act_locally(m, "ci", cfg)
            cmd = ["cat", os.path.expanduser(remote)]
        else:
            cmd = [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                ssh_destination(m, "ci", cfg),
                f"cat {remote}",
            ]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            unreachable.append(f"{m}: timeout")
            continue
        if out.returncode != 0:
            unreachable.append(f"{m}: {out.stderr.strip()[:80] or 'no samples yet'}")
            continue
        for line in out.stdout.splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows, unreachable


# hokon's two original units predate the `actions-runner-<repo>` convention and
# their names say nothing about which repo they serve. Left unmapped they
# aggregate as their OWN repos, which splits hadoku_site's distribution in two
# and would size its MemoryMax from a subset of its jobs — the one thing this
# report exists to get right.
#
# Each mapping was verified, and neither was verifiable the obvious way:
#   github-runner          -> the unit's own Description and its
#                             RUNNER_PATH=~/repos/hadoku_site/actions-runner.
#                             There is no ~/actions-runner/.runner on hokon; this
#                             install lives INSIDE the working checkout.
#   github-runner-tenhands -> .runner says WolffM/tenhands, which is a stale name.
#                             The API redirects it to WolffM/hadoku-tenhands.
#
# `hub_repo()` and `legacy_units()`/`repo_of()` stay defined IN THIS FILE
# (not moved to a sibling) because `slice-placement-guard.test.mjs`'s fixture
# and mutation tests load (or mutate) only a standalone copy of this one file
# and still call `repo_of()` through it — so it, and everything it needs,
# must work with nothing else beside it on disk. `hub_repo()` already
# tolerates that: see "NOT FATAL, AND NOT SILENT" below, the same shape
# `_sibling()` above uses for a missing PYTHON sibling rather than a missing
# BUILT one.
_HUB_ASK = """const { hubRepo } = await import(process.argv[1]);
process.stdout.write(hubRepo());"""

_HUB_CACHE = []


def hub_repo():
    """The hub repo's name, from `src/lib/fleet-config.ts` — never spelled here.

    That module is the one answer to "who does this fleet belong to" and the
    names below are the only place this report needed it. Kept independent of
    `ask_library()`'s resolution on purpose: `repo_of` must keep working where
    no manifest resolves (CI has no sibling checkout), and folding the two
    would make a unit-name lookup depend on operator config it does not read.
    """
    if _HUB_CACHE:
        return _HUB_CACHE[0]
    mod = (HERE.parent / "dist" / "lib" / "fleet-config.js").resolve()
    import shutil

    exe = shutil.which("node")
    why = None
    if not exe:
        why = "`node` is not on PATH"
    elif not mod.is_file():
        why = f"{mod} does not exist — this copy of the script is not inside a built package"
    else:
        r = subprocess.run(
            [exe, "--input-type=module", "-e", _HUB_ASK, mod.as_uri()],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if r.returncode == 0 and r.stdout.strip():
            _HUB_CACHE.append(r.stdout.strip())
            return _HUB_CACHE[0]
        why = f"{mod} did not name it: {r.stderr.strip()[:160]}"
    # NOT FATAL, AND NOT SILENT. This name is needed only to fold two legacy
    # unit names onto the hub repo; every other unit is read from its own name.
    # Killing the whole report over it would make a memory distribution
    # unobtainable from any copy of this script that is not inside a built
    # package — but saying nothing would let those two units quietly aggregate
    # as a repo of their own, which is the split the mapping exists to prevent.
    # So: the mapping is dropped, the reason is printed, and the caller sees it.
    print(
        f"fleet mem-report: could not read the hub repo's name ({why}).\n"
        "  The two legacy unit names that fold onto it will aggregate under "
        "their own names in this run.",
        file=sys.stderr,
    )
    _HUB_CACHE.append(None)
    return None


def legacy_units():
    """Unit name -> repo, for the units whose names say nothing about what they
    serve. The hub repo's name is read from `fleet-config`, never spelled here.

    The third entry is DERIVED, not written out: the production host's standing
    backstop unit spells the hub repo with a DASH while the repo itself (and
    every claw's warm unit) spells it with an underscore. Verified from that
    unit's own Description on 2026-09-23. Unmapped, its windows aggregate under
    a second repo name and the hub's distribution splits in two — the exact
    failure the first two entries exist to prevent.
    """
    units = {"github-runner-tenhands": "hadoku-tenhands"}
    hub = hub_repo()
    if hub:
        units["github-runner"] = hub
        units["actions-runner-" + hub.replace("_", "-")] = hub
    return units


# `actions.runner.<owner>-<repo>` — GitHub's own unit-name shape. Matched as a
# SHAPE rather than as this account's name: the owner is whoever installed the
# package, and spelling one here means a second operator's units fall through to
# the `actions-runner-` branch and aggregate under a repo called
# `<owner>-<repo>`, which reads as a real repo with real numbers.
#
# LAZY, and that is the whole correctness of it: `[^.]+-` is greedy and backtracks
# to the LAST hyphen, so `actions.runner.WolffM-hadoku-craft.claw-4` stripped
# `WolffM-hadoku-` and reported the repo as `craft`. `+?` stops at the first one.
# The shape is genuinely ambiguous when an OWNER contains a hyphen; erring toward
# keeping a segment is the safe side, because a kept segment shows up as an
# unfamiliar repo name a reader questions, and an eaten one silently merges two
# repos' distributions.
GH_UNIT_PREFIX = re.compile(r"^actions\.runner\.[^.]+?-")

# THE all-JIT UNIT SHAPES — where every job on this fleet has run since the
# 2026-09-07 conversion: `jit-<node>-<repo>-j<jobId>-r<runId>-<mintTs>` (a
# per-mint transient) and `warm-<node>-<repo>` (a standing listener). Until
# 2026-09-22 neither shape was stripped here, so every window from one
# aggregated under a "repo" called `jit-claw-1-hadoku-scraper-j101139…` — which
# reads as a real repo with real numbers and is neither.
#
# The repo segment is kept VERBATIM. GitHub truncates a long repo name to fit
# the 64-char unit-name ceiling (hadoku-promptsmith mints as `hadoku-promptsm`),
# and that truncation is a fact about the unit name; completing it here would
# invent a join the source cannot support. A truncated spelling shows up as its
# own repo row, which a reader questions — the safe direction.
JIT_UNIT = re.compile(r"^jit-(.+?)-j\d+-r\d+-\d+$")


def repo_of(unit, nodes=()):
    """Unit name -> repo. Four naming conventions are live across this fleet.

    `nodes` is the manifest's node list. The trailing `.<node>` field used to be
    stripped against a hard-coded list of four names — the fleet as it stood when
    this was written. It has been eight nodes since, so a later claw's unit kept
    its suffix and aggregated as its own repo, splitting that repo's distribution
    and sizing MemoryMax from a subset of its jobs. That is the one thing this
    report exists to get right, so the list comes from the manifest that already
    says which nodes exist — and naming them here would have put the same four
    facts about one garage back into a published package.
    """
    u = unit.removesuffix(".service")
    legacy = legacy_units()
    if u in legacy:
        return legacy[u]
    # The all-JIT shapes carry the node as a LEADING field (`jit-claw-1-<repo>`,
    # `warm-claw-1-<repo>`) rather than the trailing one the loop at the foot
    # strips, so they are handled here, against the same manifest node list.
    m = JIT_UNIT.match(u)
    if m:
        body = m.group(1)
    elif u.startswith("warm-"):
        body = u[len("warm-") :]
    else:
        body = None
    if body is not None:
        for pre in sorted(nodes, key=len, reverse=True):
            if body.startswith(pre + "-"):
                return body[len(pre) + 1 :] or unit
        return body or unit
    stripped = GH_UNIT_PREFIX.sub("", u, count=1)
    if stripped != u:
        u = stripped
    elif u.startswith("actions-runner-"):
        u = u[len("actions-runner-") :]
    # `actions.runner.<repo>.<node>` carries the node as a trailing field.
    for suf in sorted((f".{n}" for n in nodes), key=len, reverse=True):
        if u.endswith(suf):
            u = u[: -len(suf)]
            break
    return u or unit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-dur", type=float, default=15.0)
    ap.add_argument("--percentile", type=float, default=0.95)
    ap.add_argument("--headroom", type=float, default=1.25, help="safety factor on a suggested cap")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--check",
        action="store_true",
        help="gate the harvester's OUTPUT on every node (exit 1 on stale or silent)",
    )
    a = ap.parse_args()

    mpath = manifest_path()
    manifest = json.loads(mpath.read_text())
    nodes = manifest.get("machines", {})
    # SAY WHICH TREE ANSWERED (issue #4). `manifest_path()` now resolves through
    # the package's own library, so this line and the CLI banner above it name
    # the SAME tree — until 2026-09-22 (#46) they did not: the banner said
    # `<site>/scripts/admin` while this report read the 4-machine fixture
    # packaged with the repo and called it the fleet, `unreachable: []`, exit 0.
    print(f"manifest: {mpath} ({len(nodes)} machine(s))", file=sys.stderr)
    if a.check:
        return run_checks(nodes, a.json)
    rows, unreachable = collect(nodes)
    rows = [r for r in rows if r.get("dur_s", 0) >= a.min_dur]
    if not rows:
        print("no job windows harvested yet", file=sys.stderr)
        for u in unreachable:
            print(f"  unread {u}", file=sys.stderr)
        return 1

    by_repo, by_node = {}, {}
    for r in rows:
        by_repo.setdefault(repo_of(r["unit"], nodes), []).append(r)
        by_node.setdefault(r["host"], []).append(r)

    all_usable, all_clipped, all_unmarked = split_windows(rows)
    # NAMED, NOT COUNTED. A clipped job is a finding — the repo, the job, the
    # cap and the kill — never just a tally folded into `clipped: N`. Built
    # even when empty (today's live fleet: 0) so the shape is proven before
    # the first real one lands, rather than wired the day it is needed.
    findings = [
        clipped_finding(r, repo_of(r["unit"], nodes))
        for r in sorted(all_clipped, key=lambda r: r.get("end") or 0, reverse=True)
    ]
    out = {
        "manifest": str(mpath),
        "machinesDeclared": len(nodes),
        "windows": len(rows),
        "usable": len(all_usable),
        "clipped": len(all_clipped),
        "unmarked": len(all_unmarked),
        "unreachable": unreachable,
        "findings": findings,
        "repos": {},
        "machines": {},
    }
    if not a.json:
        print(
            f"{len(rows)} job windows >= {a.min_dur:.0f}s"
            f" — {len(all_usable)} usable, {len(all_clipped)} clipped by a cgroup OOM kill"
            + (
                f", {len(all_unmarked)} from a harvest too old to say"
                if all_unmarked
                else ""
            )
        )
        for u in unreachable:
            print(f"  ! unread {u}")
        for f in findings:
            print(
                f"  ! clipped: {f['repo']} ({f['unit']} on {f['host']}) — "
                f"floor >= {f['peakUnreclaimableMb']} MB"
                + (f", cap {f['capMb']} MB" if f["capMb"] is not None else "")
                + (f", {f['oomKills']} oom kill(s)" if f["oomKills"] else "")
                + (", cgroup reset under it" if f["cgroupReset"] else "")
            )
        print(
            f"\n{'repo':32} {'n':>4} {'clip':>5} {'p50':>8} {'p95':>8} {'max':>8} {'cache×':>7}"
        )

    # SORTED ON THE USABLE TAIL. A repo whose every window was clipped has no
    # tail to sort on and goes to the bottom with -1, rather than being ranked
    # by a floor it would then be read as a requirement.
    def sort_key(kv):
        usable, _, _ = split_windows(kv[1])
        if not usable:
            return 1.0
        return -pct([x["peak_unreclaimable_mb"] for x in usable], a.percentile)

    for repo, rs in sorted(by_repo.items(), key=sort_key):
        usable, clipped, unmarked = split_windows(rs)
        floor = max((x["peak_unreclaimable_mb"] for x in clipped), default=None)
        if not usable:
            # NEVER A NUMBER HERE. Every window this repo has was truncated by
            # the cap, so nothing in the data says what the job needs — only
            # that it needs more than the cap that stopped it. A p95 printed
            # from floors would size the next cap from the last one.
            out["repos"][repo] = {
                "n": len(rs),
                "usable": 0,
                "clipped": len(clipped),
                "unmarked": len(unmarked),
                "p50": None,
                "p95": None,
                "max": None,
                "overstatement": None,
                "suggestedMemoryMaxMb": None,
                "floorMb": floor,
                "capMb": next((x.get("cap_mb") for x in clipped if x.get("cap_mb")), None),
                "why": (
                    f"no usable measurement: all {len(clipped)} window(s) were truncated by a "
                    f"cgroup OOM kill, so the peak is a FLOOR (>= {floor} MB), not a requirement. "
                    "Sizing needs one uncapped run on a node with headroom."
                ),
            }
            if not a.json:
                print(
                    f"{repo[:32]:32} {len(rs):4} {len(clipped):5} "
                    f"{'—':>8} {'—':>8} {'—':>8} {'—':>7}"
                    f"   no usable measurement; floor >= {floor:.0f} MB"
                )
            continue
        un = [x["peak_unreclaimable_mb"] for x in usable]
        cur = [x["peak_current_mb"] for x in usable]
        ratio = (pct(cur, a.percentile) / pct(un, a.percentile)) if pct(un, a.percentile) else 0
        lower_bound = is_lower_bound(unmarked)
        cap_ref = cap_reference(rs, usable)
        repo_max = max(un)
        out["repos"][repo] = {
            "n": len(rs),
            "usable": len(usable),
            "clipped": len(clipped),
            "unmarked": len(unmarked),
            "p50": pct(un, 0.5),
            "p95": pct(un, a.percentile),
            "max": repo_max,
            "overstatement": round(ratio, 2),
            "suggestedMemoryMaxMb": int(repo_max * a.headroom),
            # A repo with SOME clipped windows still has a floor its usable
            # numbers may sit below — that is a live contradiction, not a
            # rounding error, and it is carried rather than averaged away.
            "floorMb": floor,
            # ADDITIVE (#44 rework). `usable` can contain UNMARKED rows — ones
            # that predate the `clipped` field and so could have been clipped
            # without saying so. Any p50/p95/max drawn from them is a LOWER
            # BOUND: the real tail can only be at least this, never less.
            # `unmarkedInStat` says exactly how many of the rows behind the
            # number above are the unconfirmed kind.
            "lowerBound": lower_bound,
            "unmarkedInStat": len(unmarked),
            # Also additive: the measured max sitting at/near a cap this repo
            # is known to run under is the shape a clipped distribution always
            # has, whether or not anything in THIS population is itself
            # marked `clipped`.
            "atCap": at_cap(repo_max, cap_ref),
            "nearCapMb": cap_ref,
        }
        if not a.json:
            note = ""
            if floor is not None and floor > repo_max:
                note = f"   ! {len(clipped)} clipped window(s) reached >= {floor:.0f} MB"
            if out["repos"][repo]["atCap"]:
                note += f"   ! at cap ({cap_ref:.0f} MB)"
            mark = "≥" if lower_bound else ""
            p95_s = f"{mark}{pct(un,a.percentile):.0f}"
            max_s = f"{mark}{repo_max:.0f}"
            print(
                f"{repo[:32]:32} {len(rs):4} {len(clipped):5} "
                f"{pct(un,.5):8.0f} {p95_s:>8} {max_s:>8} {ratio:6.1f}x{note}"
            )

    if not a.json:
        print(f"\n{'node':9} {'RAM':>7} {'maxConc':>8} {'x p95':>9} {'verdict'}")
    for m, cfg in nodes.items():
        rs = by_node.get(m, [])
        if not rs:
            continue
        usable, clipped, unmarked = split_windows(rs)
        mc = cfg.get("maxConcurrent", 0)
        ram = cfg.get("ramGb", 0) * 1024
        floor = max((x["peak_unreclaimable_mb"] for x in clipped), default=None)
        if not usable:
            # `fits` IS A VERDICT AND HAS NO "PROBABLY". Every window this node
            # produced was clipped, so the p95 it would be computed from is a
            # ceiling artefact — and a `fits: true` derived from the cap is the
            # gate getting easier to pass the worse the memory pressure got.
            out["machines"][m] = {
                "n": len(rs),
                "usable": 0,
                "clipped": len(clipped),
                "unmarked": len(unmarked),
                "ramMb": ram,
                "maxConcurrent": mc,
                "p95Mb": None,
                "worstCaseMb": None,
                "fits": None,
                "why": (
                    f"no usable measurement: all {len(clipped)} window(s) on this node were "
                    "truncated by a cgroup OOM kill"
                ),
            }
            if not a.json:
                print(
                    f"{m:9} {ram/1024:6.0f}G {mc:8} {'—':>8}   "
                    f"no usable measurement ({len(clipped)} clipped)"
                )
            continue
        un = [x["peak_unreclaimable_mb"] for x in usable]
        need = mc * pct(un, a.percentile)
        fits = need <= ram
        lower_bound = is_lower_bound(unmarked)
        out["machines"][m] = {
            "n": len(rs),
            "usable": len(usable),
            "clipped": len(clipped),
            "unmarked": len(unmarked),
            "ramMb": ram,
            "maxConcurrent": mc,
            "p95Mb": pct(un, a.percentile),
            "worstCaseMb": round(need),
            "fits": fits,
            # ADDITIVE (#44 rework): `fits` above may be computed from a p95
            # that includes UNMARKED rows — a verdict built on a lower bound
            # can read `true` and still be wrong the moment the real figure
            # (which can only be higher) is known. Never nulled; just labelled.
            "unmarkedInStat": len(unmarked),
            "fitsIsLowerBound": lower_bound,
        }
        if not a.json:
            v = "fits" if fits else f"OVER by {(need-ram)/1024:.1f} GB — the count cap does not bound memory"
            if clipped:
                v += f" ({len(clipped)} clipped window(s) excluded)"
            if lower_bound:
                v += f" (lower bound: {len(unmarked)} unmarked window(s) in the p95)"
            need_s = f"{'≥' if lower_bound else ''}{need/1024:.1f}G"
            print(f"{m:9} {ram/1024:6.0f}G {mc:8} {need_s:>9}  {v}")

    if a.json:
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
