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
"""

import argparse
import calendar
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REMOTE = "~/.local/state/hadoku/runner-mem/samples.jsonl"
# The other two files the gate reads, spelled ONCE each and derived from the
# one above where they share its directory. They were written out longhand in
# the probe below — eight more copies of one garage's paths in a published
# library, and eight places to miss when one moves. Same consolidation
# `ci-throttle-install.sh` made for `NODE_DIR`.
INFLIGHT_REMOTE = REMOTE.rsplit("/", 1)[0] + "/inflight.json"
JOB_METRICS_REMOTE = "~/.hadoku/job-metrics.jsonl"


# ── ask the package's own library, never a Python second opinion ────────────
#
# `src/lib/fleet-paths.ts` is the settled answer to "where are the manifests"
# and `src/lib/node-identity.ts` to "is this node the box I am on" — and this
# file must not grow a Python copy of either. isLocalNode had five
# implementations before one survived an FQDN; a sixth written in another
# language is not an improvement. A Python script cannot import them, so it
# EXECUTES them: one `node` run over the package's built modules, the same
# modules `fleet` itself used to print the banner this report runs under. If
# that resolution THROWS — no site checkout and no FLEET_MANIFEST_DIR — the
# reason is carried out verbatim: this report refuses exactly where the CLI's
# banner would have refused, instead of quietly answering about another tree.

_LIB_ASK = """const [pathsMod, identMod, machinesRaw] = process.argv.slice(1);
const { manifestDir, stateDir } = await import(pathsMod);
const { isLocalNode } = await import(identMod);
const out = { manifestDir: manifestDir(), stateDir: stateDir() };
for (const m of JSON.parse(machinesRaw)) if (isLocalNode(m)) out.local = m;
process.stdout.write(JSON.stringify(out));"""

_HUB_ASK = """const { hubRepo } = await import(process.argv[1]);
process.stdout.write(hubRepo());"""

_LIB_CACHE = {}
_HUB_CACHE = []


def ask_library(machines=()):
    """`{manifestDir, stateDir, local?}` — the manifest directory, the
    operator-state directory (job-history.jsonl lives there), and which (if
    any) of `machines` is this box, all from the package's own resolvers."""
    key = tuple(sorted(machines))
    if key in _LIB_CACHE:
        return _LIB_CACHE[key]
    paths_mod = (HERE.parent / "dist" / "lib" / "fleet-paths.js").resolve()
    ident_mod = (HERE.parent / "dist" / "lib" / "node-identity.js").resolve()
    for p in (paths_mod, ident_mod):
        if not p.is_file():
            raise SystemExit(
                f"fleet mem-report: {p} does not exist — the package is not built.\n"
                "  Build it, or pass FLEET_MANIFEST_DIR to name the manifests directly."
            )
    exe = shutil.which("node")
    if not exe:
        raise SystemExit(
            "fleet mem-report: cannot find `node` to resolve the fleet's paths.\n"
            "  This report resolves its manifest through the package's own library\n"
            "  (dist/lib/fleet-paths.js); pass FLEET_MANIFEST_DIR to bypass it."
        )
    try:
        r = subprocess.run(
            [exe, "--input-type=module", "-e", _LIB_ASK, paths_mod.as_uri(), ident_mod.as_uri(), json.dumps(list(machines))],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit(f"fleet mem-report: resolving the manifest through {paths_mod} timed out")
    if r.returncode != 0:
        # An uncaught throw prints its (possibly multi-line) message BEFORE the
        # stack frames; taking the last line would hand the operator a stack
        # frame instead of a reason — the undiagnosable-finding shape this repo
        # retired from check-queue-health.
        msg = []
        for ln in (r.stderr or "").splitlines():
            if msg and ln.lstrip().startswith("at "):
                break
            if ln.strip():
                msg.append(ln.rstrip())
        raise SystemExit(
            "fleet mem-report: the library refused to resolve the manifest:\n  "
            + ("\n  ".join(msg) if msg else "no reason printed")
        )
    try:
        res = json.loads(r.stdout)
    except ValueError:
        raise SystemExit(f"fleet mem-report: unparseable answer from {paths_mod}: {r.stdout[:200]!r}")
    _LIB_CACHE[key] = res
    return res


def hub_repo():
    """The hub repo's name, from `src/lib/fleet-config.ts` — never spelled here.

    That module is the one answer to "who does this fleet belong to", and the
    names below are the only place this report needed it. Kept in a separate
    call from the manifest ask on purpose: `repo_of` must keep working where no
    manifest resolves (CI has no sibling checkout), and folding the two would
    make a unit-name lookup depend on operator config it does not read.
    """
    if _HUB_CACHE:
        return _HUB_CACHE[0]
    mod = (HERE.parent / "dist" / "lib" / "fleet-config.js").resolve()
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


_HARVEST_INTERVAL_CACHE = []


def harvest_interval():
    """`HARVEST_INTERVAL`, read from the harvester's own module — never a
    second literal here (#94). Imported locally, from this report's own
    `scripts/` directory, exactly like `ask_library` imports the TS library
    instead of re-deriving its answer: a hand-copied `3` beside the real
    constant is the shape that drifts the day only one of the two copies is
    updated. This runs on the box invoking the CHECK, not over ssh to the
    node being checked — correct because `HARVEST_INTERVAL` has no per-node
    override anywhere this fleet is deployed (checked: nothing sets it outside
    this file and its own test), so the value this process resolves is the
    value every node's harvester resolves too.
    """
    if _HARVEST_INTERVAL_CACHE:
        return _HARVEST_INTERVAL_CACHE[0]
    path = (HERE / "runner-mem-harvest.py").resolve()
    if not path.is_file():
        raise SystemExit(
            f"fleet mem-report: {path} does not exist — cannot read HARVEST_INTERVAL "
            "from the harvester's own constant"
        )
    spec = importlib.util.spec_from_file_location("runner_mem_harvest", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _HARVEST_INTERVAL_CACHE.append(mod.INTERVAL)
    return _HARVEST_INTERVAL_CACHE[0]


# The production host refuses ssh to ITSELF, so the local branch below is
# load-bearing rather than an optimisation — a loop that ssh'd unconditionally
# reads that node as permanently unreachable. The comparison is the library's
# normalising one; a raw `uname().nodename ==` compare is the FQDN bug
# `isLocalNode` exists to prevent.
def local_node(nodes):
    """Which of `nodes` is this box, or None."""
    return ask_library(list(nodes)).get("local")


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
    silently dropped — 'I could not look' must not read as 'there was nothing'."""
    rows, unreachable = [], []
    local = local_node(nodes)
    for m in nodes:
        cmd = (
            ["cat", os.path.expanduser(REMOTE)]
            if m == local
            else ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", m, f"cat {REMOTE}"]
        )
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


# ── the gate: "active" is not "collecting" (#47) ─────────────────────────────
#
# Measured 2026-09-22: the harvesters on claw-1/2/3 were `systemctl is-active`
# green with clean journals while their output had not moved in weeks — the
# processes swept happily, matched zero runner cgroups under all-JIT naming,
# and wrote an empty inflight snapshot every 3 s. `is-active` is exactly the
# reader that cannot see that. So this gate reads three OUTPUTS and never asks
# the unit manager anything:
#
#   inflight.json  rewritten by the harvester EVERY sweep, jobs or not — the
#                  heartbeat. Stale means nobody is sampling, whatever the
#                  unit table says.
#   samples.jsonl  one record per completed job window. Its newest record is
#                  what the harvest CLAIMS to have seen.
#   job-metrics.jsonl  the per-job hook, which demonstrably writes on every
#                  node on every job today. Its newest row is what actually
#                  HAPPENED on the node.
#
# The cross of the last two is the finding `is-active` can never raise: a node
# whose newest completed job POSTDATES its newest window is silent while jobs
# stream past. Both timestamps come from the node's own files and clock (the
# probe reads `date +%s` remotely), so no cross-node clock assumption is made.
#
# HEARTBEAT_STALE_S is ~300 missed sweeps at INTERVAL=3 — generous enough that
# a busy box is never false-red, tight enough that a dead sampler is caught
# within the hour. JOB_FRESH_S bounds the cross-check: on an idle fleet an old
# samples file is not a finding (nothing to harvest), which is why liveness is
# the heartbeat's job and completeness is only judged where a job says so.
HEARTBEAT_STALE_S = 900
JOB_FRESH_S = 6 * 3600
WINDOW_LAG_S = 900
# A JOB THAT ENDED BEFORE THE SAMPLER STARTED WAS NEVER THE SAMPLER'S TO CATCH.
#
# The harvest appends only when a window CLOSES, so a freshly installed node
# legitimately has no samples until its next job ends. Measured 2026-09-23:
# claw-8's last job ended 83 SECONDS before its harvester started, and claw-6's
# an hour and a half before — both brand new and working, both indistinguishable
# from a broken node if the cross-check looks only at the two output files.
# Bounding the question by the sampler's start separates "stale because broken"
# from "stale because nothing has run yet", and the two want opposite responses.
#
# READING A START TIMESTAMP IS NOT THE `is-active` TRAP. What made `is-active`
# useless here is that it reports a VERDICT — up, therefore fine — about a
# process that was matching nothing. This reads a moment in time and uses it
# only to bound a window of responsibility; the health question is still
# answered entirely from the output files. A node whose sampler cannot be dated
# is judged WITHOUT the bound, which is the stricter direction.
SAMPLER_WARMUP_S = 60

# #94: the single newest completed job is not enough to judge "silent" by — a
# job whose Runner.Worker ran for less than `2 * HARVEST_INTERVAL` cannot be
# sampled (the harvester only has a window open while `has_worker()` is true,
# `runner-mem-harvest.py` ~L131), and reading that as "jobs streaming past
# unmeasured" pages for nothing. Probing the last few candidates, oldest to
# newest, lets the cross-check skip a too-short one and fall back to the
# newest job that WAS long enough to judge — which is also what keeps a MIXED
# history (a long unmeasured job followed by a short one) still flagged: the
# short one is evidence of nothing and must neither raise nor clear a finding.
# 5 is comfortably more than one quiet pair of jobs; JOB_FRESH_S below still
# bounds how far back a qualifying job can reach to raise one.
#
# #94's OWN claw-5 case turned out NOT to be a too-short job: its real
# duration (job-history `durationSec`) was 7s, still at or above the 6s floor
# here, so this rule still flags it. The actual fault is that
# `runner-mem-harvest.py` closes a window only when a sweep VISITS a unit that
# is still PRESENT with no worker (~L230-294) — a unit whose cgroup is gone
# entirely by the next sweep is never visited again at all, so its window
# never closes. Measured live: claw-5's `inflight.json` held
# `jit-claw-5-hadoku-pygmalio-j111777744078-…` open at `elapsed_s` past
# 37,000 with `samples: 2` — sampled twice right after mint, then never
# revisited, never closed. That is a harvester bug, not a sampling-interval
# one, and is out of this lane's scope (CHECK only, not the harvester).
LASTJOB_PROBE_N = 5

# One round trip per node. Lines are prefixed records so partial output (an
# ssh cut mid-probe) is detectable per fact rather than one blob.
PROBE = r"""
now=$(date +%%s 2>/dev/null) || now=0
echo "NOW $now"
for f in %(samples)s %(inflight)s %(jobs)s; do
	if [ -e "$f" ]; then
		echo "EXISTS $f $(stat -c %%Y "$f" 2>/dev/null || echo 0)"
	else
		echo "ABSENT $f"
	fi
done
echo "LASTSAMPLE $(tail -n 1 %(samples)s 2>/dev/null | head -c 4000)"
echo "INFLIGHT $(head -c 4000 %(inflight)s 2>/dev/null | tr -d "\n")"
tail -n %(jobn)s %(jobs)s 2>/dev/null | while IFS= read -r jl || [ -n "$jl" ]; do
	echo "LASTJOB $(printf '%%s' "$jl" | head -c 2000)"
done
# An EMPTY timestamp must stay empty: `date -d ""` is today's midnight, which
# turned an undateable sampler into one that started at 00:00 UTC and excused
# every job before it (red in the first minutes after midnight, lenient after).
sampler_ts=$(systemctl --user show -p ActiveEnterTimestamp --value runner-mem-harvest.service 2>/dev/null)
if [ -n "$sampler_ts" ]; then
	echo "SAMPLERSTART $(date -u -d "$sampler_ts" +%%s 2>/dev/null)"
else
	echo "SAMPLERSTART "
fi
""" % {
    "samples": REMOTE,
    "inflight": INFLIGHT_REMOTE,
    "jobs": JOB_METRICS_REMOTE,
    "jobn": LASTJOB_PROBE_N,
}


def _lead_number(text, key):
    """`"<key>": <number>` from a possibly TRUNCATED JSON object.

    The byte budgets in PROBE bound one ssh round trip; they are not a promise
    that the record fits. `inflight.json` grows with every OPEN window, so the
    read is longest exactly when the sampler is busiest — measured live on
    2026-09-23, claw-1 and claw-5 were mid-window, their snapshot passed 400
    bytes, `json.loads` failed, and the gate reported the heartbeat unreadable
    on the two nodes that were demonstrably sampling. A gate that reddens
    BECAUSE the thing it checks is working is worse than no gate.

    Both numbers this file needs — the snapshot's `at` and a window's `end` —
    are written before the long fields (`windows`, the peak set), so they
    survive the cut even when the closing brace does not.
    """
    m = re.search(r'"%s"\s*:\s*(-?\d+(?:\.\d+)?)' % re.escape(key), text)
    return float(m.group(1)) if m else None


def _number_from(text, key):
    """The key's value, from a whole record when it parses and from the leading
    bytes when it does not. Parsing WINS: a regex over valid JSON could match a
    same-named key nested somewhere later, and the parser cannot."""
    try:
        v = json.loads(text).get(key)
        return float(v) if isinstance(v, (int, float)) else None
    except ValueError:
        return _lead_number(text, key)


def _lead_string(text, key):
    """`"<key>": "<value>"` from a possibly TRUNCATED JSON object — the string
    counterpart of `_lead_number`, same reasoning: the budgets in PROBE bound
    one ssh round trip, not the record."""
    m = re.search(r'"%s"\s*:\s*"([^"]*)"' % re.escape(key), text)
    return m.group(1) if m else None


def _string_from(text, key):
    """The key's STRING value, parsed whole when it parses, from the leading
    bytes when it does not — same precedence as `_number_from` and for the
    same reason."""
    try:
        v = json.loads(text).get(key)
        return v if isinstance(v, str) else None
    except ValueError:
        return _lead_string(text, key)


# NOT the JIT unit's own name. A runner's NAME says who it was MINTED for, not
# necessarily who it ended up serving — measured live, one runner (minted
# 13:11Z) actually served a job that started 16:20:49Z: names and jobIds are
# visibly shuffled across the fleet's own job-history. And even where the name
# and the job line up, mint-to-completion is the wrong span regardless — it
# includes the wait for GitHub to ASSIGN the job to this runner, which the
# harvester's sampler was never going to see either way (`has_worker`,
# `runner-mem-harvest.py` ~L131, only opens a window once a `Runner.Worker`
# process exists in the cgroup). The CONTROLLER already has the honest number:
# `durationSec` in the operator-state job-history, keyed on the same `jobId`
# this hook writes — see `job_history_durations()` below.


def _job_history_path():
    """Where the controller's job-history lives — ASKED from the package's
    own library (`stateDir()`, the same `ask_library()` call `manifest_path()`
    already makes for `manifestDir()`), never a second spelling of the state
    directory in this file. Read LOCALLY, on the box the CHECK runs from —
    never over ssh to the node being checked, because job-history is
    controller state, not per-node state; a node has no copy of it to read.
    """
    return Path(ask_library()["stateDir"]) / "job-history.jsonl"


_JOB_HISTORY_CACHE = {}  # path (str) -> {jobId: durationSec}


def job_history_durations():
    """`{jobId: durationSec}` from the controller's job-history. A missing
    file, an unparseable line, or a line missing either key simply leaves
    that jobId out of the map — never a crash, never a guessed duration. A
    job-metrics row whose `jobId` is not in this map (including every
    standing/`warm-*` row, whose `jobId` is always `null`) has an UNKNOWN
    duration, and the call site must judge unknown the strict way: never
    treated as too short to matter.

    The SAME rule applies one level up: `ask_library()` itself can fail (the
    package is not built, `node` is not on PATH, its resolver throws) and
    raises `SystemExit` when it does. That failure is real, but it is not
    THIS gate's failure to report — `manifest_path()` lets it propagate
    because a report with no manifest cannot run at all, whereas a report
    with no reachable job-history can still check the heartbeat and the
    stale-window cross-check; it just loses the one caveat on top. So it is
    caught here, narrowly, and turned into the same "nothing to look up"
    empty map every other unreadable-history case already produces.
    """
    try:
        path = _job_history_path()
    except SystemExit:
        return {}
    key = str(path)
    if key in _JOB_HISTORY_CACHE:
        return _JOB_HISTORY_CACHE[key]
    out = {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                jid = rec.get("jobId")
                dur = rec.get("durationSec")
                if isinstance(jid, int) and isinstance(dur, (int, float)):
                    out[jid] = dur
    except OSError:
        pass  # no job-history here — every candidate's duration reads UNKNOWN
    _JOB_HISTORY_CACHE[key] = out
    return out


def _parse_job_record(text, history):
    """`(ts_epoch, dur_s)` for one job-metrics.jsonl row. `dur_s` is the
    CONTROLLER's own `durationSec` for this row's `jobId` (from `history`,
    see `job_history_durations()`) — `None` when `jobId` is null/absent or
    has no matching job-history record."""
    ts_s = _string_from(text, "ts")
    if ts_s is None:
        return None, None
    try:
        ts_epoch = calendar.timegm(time.strptime(ts_s, "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        return None, None
    job_id_f = _number_from(text, "jobId")
    job_id = int(job_id_f) if job_id_f is not None else None
    dur = history.get(job_id) if job_id is not None else None
    return ts_epoch, dur


def _iso(ts):
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
    except (ValueError, OverflowError):
        return f"epoch {ts}"


def _probe_node(name, local):
    """Run PROBE on one node. Returns `(facts, finding_or_None)`."""
    try:
        if name == local:
            r = subprocess.run(["bash", "-c", PROBE], capture_output=True, text=True, timeout=60)
            why = (r.stderr or "").strip()
        else:
            r = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", name, "bash -s"],
                input=PROBE,
                capture_output=True,
                text=True,
                timeout=60,
            )
            why = (r.stderr or "").strip() or "no output"
        if r.returncode != 0:
            return None, f"{name}: unreachable, so nothing on it was checked — {why[:120]}"
    except subprocess.TimeoutExpired:
        return None, f"{name}: unreachable — the probe timed out after 60s"
    facts = {
        "exists": {},
        "absent": [],
        "now": None,
        "sample_end": None,
        "inflight_at": None,
        "job_ts": None,
        "job_dur_s": None,
        "job_short_skipped": 0,
        "sampler_start": None,
    }
    job_candidates = []  # raw LASTJOB text, oldest to newest — resolved below
    for ln in r.stdout.splitlines():
        kind, _, rest = ln.partition(" ")
        if kind == "NOW":
            facts["now"] = int(rest) if rest.isdigit() else None
        elif kind in ("EXISTS", "ABSENT"):
            path = rest.split(" ")[0]
            if kind == "ABSENT":
                facts["absent"].append(path)
            else:
                mtime = rest.split(" ")[1] if " " in rest else "0"
                facts["exists"][path] = int(mtime) if mtime.isdigit() else 0
        elif kind == "LASTSAMPLE":
            facts["sample_end"] = _number_from(rest, "end")
        elif kind == "INFLIGHT":
            facts["inflight_at"] = _number_from(rest, "at")
        elif kind == "SAMPLERSTART":
            facts["sampler_start"] = int(rest) if rest.strip().isdigit() else None
        elif kind == "LASTJOB":
            job_candidates.append(rest)
    # #94: walk the candidates NEWEST FIRST and stop at the first one that is
    # not PROVABLY too short to have been sampled. A too-short job is evidence
    # of nothing, so it is skipped rather than used to clear or raise a
    # finding — which is also why a job whose duration is UNKNOWN (no
    # job-history record for its jobId) is never treated as too short: "could
    # not tell" is judged the strict way, same as an undateable sampler above.
    min_sampleable_s = 2 * harvest_interval()
    history = job_history_durations()
    for rest in reversed(job_candidates):
        ts_epoch, dur = _parse_job_record(rest, history)
        if ts_epoch is None:
            continue  # unparseable row — not usable as a candidate at all
        if dur is not None and dur < min_sampleable_s:
            facts["job_short_skipped"] += 1
            continue
        facts["job_ts"] = ts_epoch
        facts["job_dur_s"] = dur
        break
    return facts, None


def run_checks(nodes, as_json=False):
    """The --check gate. Returns process exit code."""
    local = local_node(list(nodes))
    findings, rows = [], {}
    for m in nodes:
        facts, err = _probe_node(m, local)
        guest = (
            " [guest — the fleet does not deploy here, so the remedy is manual]"
            if nodes.get(m, {}).get("role") == "guest"
            else ""
        )
        if err:
            findings.append(err)
            rows[m] = {"ok": False, "finding": err}
            continue
        rows[m] = {"ok": True, **facts}
        now = facts["now"] or 0
        have_inflight = any("inflight.json" in p for p in facts["exists"])
        have_samples = any("samples.jsonl" in p for p in facts["exists"])
        have_jobs = any("job-metrics.jsonl" in p for p in facts["exists"])
        # 1. THE HEARTBEAT — liveness, independent of job traffic.
        if not have_inflight:
            findings.append(
                f"{m}: no inflight.json — the harvester has never swept here (not installed, "
                f"or installed and dead). Nothing samples this node{guest}"
            )
        elif facts["inflight_at"] is None:
            findings.append(f"{m}: inflight.json exists but carries no readable `at` — the heartbeat is unparseable{guest}")
        elif now and now - facts["inflight_at"] > HEARTBEAT_STALE_S:
            findings.append(
                f"{m}: heartbeat stale — last sweep {int(now - facts['inflight_at'])}s ago at "
                f"{_iso(facts['inflight_at'])}. The harvester is not sampling whatever `is-active` "
                f"says about the unit{guest}"
            )
        # 2. THE CROSS-CHECK — a completed job that the harvest never saw.
        #    Bounded by the sampler's start: see SAMPLER_WARMUP_S above. A node
        #    whose sampler cannot be dated is judged without the bound.
        started = facts["sampler_start"]
        answerable = started is None or (
            facts["job_ts"] is not None and facts["job_ts"] > started + SAMPLER_WARMUP_S
        )
        if answerable and have_jobs and facts["job_ts"] and now and now - facts["job_ts"] <= JOB_FRESH_S:
            if not have_samples:
                findings.append(
                    f"{m}: active but silent — a job completed at {_iso(facts['job_ts'])} but "
                    f"samples.jsonl does not exist; the harvest is collecting nothing{guest}"
                )
            elif facts["sample_end"] is None:
                findings.append(
                    f"{m}: active but silent — a job completed at {_iso(facts['job_ts'])} but the "
                    f"newest sample record is unparseable{guest}"
                )
            elif facts["sample_end"] + WINDOW_LAG_S < facts["job_ts"]:
                findings.append(
                    f"{m}: active but silent — the newest completed job ({_iso(facts['job_ts'])}) "
                    f"postdates the newest harvested window ({_iso(facts['sample_end'])}) by "
                    f"{int(facts['job_ts'] - facts['sample_end'])}s; jobs are streaming past "
                    f"unmeasured{guest}"
                )
    ok = not findings
    doc = {"ok": ok, "nodes": rows, "findings": findings}
    # `--json` is a contract like every other subcommand's: parseable stdout,
    # findings named, and a non-zero exit that a consumer reads as a FINDING
    # rather than a crash. The human lines go to stdout only when it is off.
    # THE EXIT CODE IS DERIVED FROM `ok`, NEVER FROM REACHING THE END. Written
    # as a trailing `raise SystemExit(1)` it fired under `--json` even with
    # zero findings, which is a gate that is red forever: the cron reads a
    # non-zero exit as a FINDING, so a healthy fleet would have paged
    # indefinitely and the one thing the gate exists to say would be lost in
    # the noise. Caught by the busy-node test on 2026-09-23.
    if as_json:
        print(json.dumps(doc, indent=2))
    elif ok:
        print(
            f"✓ the harvest is alive on all {len(nodes)} node(s) and no completed job "
            f"postdates its newest window (checked output files, never `is-active`)."
        )
    else:
        for f in findings:
            print(f"! {f}")
        print(
            f"\n✗ {len(findings)} finding(s) across {len(nodes)} node(s). 'active' is not 'collecting':",
            file=sys.stderr,
        )
        print(
            "  the unit can be green while the sampler matches nothing; only its output can say.",
            file=sys.stderr,
        )
    return 0 if ok else 1


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
    rows, unreachable = collect(list(nodes))
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
