"""The `--check` gate half of `runner-mem-report.py` (wave 5q lane D split):
"active" is not "collecting" (#47).

Measured 2026-09-22: the harvesters on claw-1/2/3 were `systemctl is-active`
green with clean journals while their output had not moved in weeks — the
processes swept happily, matched zero runner cgroups under all-JIT naming,
and wrote an empty inflight snapshot every 3 s. `is-active` is exactly the
reader that cannot see that. So this gate reads three OUTPUTS and never asks
the unit manager anything:

  inflight.json  rewritten by the harvester EVERY sweep, jobs or not — the
                 heartbeat. Stale means nobody is sampling, whatever the
                 unit table says.
  samples.jsonl  one record per completed job window. Its newest record is
                 what the harvest CLAIMS to have seen.
  job-metrics.jsonl  the per-job hook, which demonstrably writes on every
                 node on every job today. Its newest row is what actually
                 HAPPENED on the node.

The cross of the last two is the finding `is-active` can never raise: a node
whose newest completed job POSTDATES its newest window is silent while jobs
stream past. Both timestamps come from the node's own files and clock (the
probe reads `date +%s` remotely), so no cross-node clock assumption is made.

LOADED LAZILY by `runner-mem-report.py`'s `_sibling()` helper, only when
`--check` is actually passed — see that function's own docstring for why
this module is never imported at anyone's module scope.
"""

import calendar
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _env():
    """`mem_report_env`, loaded by absolute path exactly like
    `runner-mem-report.py`'s own `_sibling()` — this module has no package to
    do a relative import with, and a plain `import mem_report_env` depends on
    `sys.path` having `scripts/` on it, which is only true when THIS file was
    reached by the CLI spawning the real `runner-mem-report.py` (never true
    under the two production checks, so never relied on).

    CACHED IN `sys.modules` UNDER THE SAME NAME `runner-mem-report.py`'s own
    `_sibling()` uses — see that function's docstring. `node_role_user`'s
    cache (and `ask_library`'s, and `harvest_interval`'s) lives on the
    `mem_report_env` module OBJECT; two independent `importlib` loads of the
    same file would give this function and that one two different objects,
    and a role warmed through one would be invisible to the other.
    """
    if "mem_report_env" in sys.modules:
        return sys.modules["mem_report_env"]
    import importlib.util

    path = (HERE / "mem_report_env.py").resolve()
    spec = importlib.util.spec_from_file_location("mem_report_env", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mem_report_env"] = mod
    spec.loader.exec_module(mod)
    return mod


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
    "samples": _env().REMOTE,
    "inflight": _env().INFLIGHT_REMOTE,
    "jobs": _env().JOB_METRICS_REMOTE,
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
    return Path(_env().ask_library()["stateDir"]) / "job-history.jsonl"


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


def _probe_node(name, local, machine):
    """Run PROBE on one node, as `ci`. Returns `(facts, finding_or_None)`.

    `machine` is this node's manifest entry (for `users.ci`, if it has been
    cut over). PROBE reads `ci`'s own files top to bottom — the harvester's
    `samples.jsonl`/`inflight.json`, the per-job hook's `job-metrics.jsonl`
    (both deployed `as: 'ci'`, `deploy-ci-throttle.mjs`) — and its very last
    line reads `runner-mem-harvest.service` through `systemctl --user`, which
    is ci's OWN systemd --user manager (CLAUDE.md: ci "runs every CI job...
    its own systemd manager with runners.slice"). `admin`'s `systemctl --user`
    is a different manager and would read that unit as not existing at all.
    """
    env = _env()
    try:
        if name == local:
            env.assert_can_act_locally(name, "ci", machine)
            r = subprocess.run(["bash", "-c", PROBE], capture_output=True, text=True, timeout=60)
            why = (r.stderr or "").strip()
        else:
            r = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=10",
                    env.ssh_destination(name, "ci", machine),
                    "bash -s",
                ],
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
    min_sampleable_s = 2 * env.harvest_interval()
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
    local = _env().local_node(list(nodes))
    findings, rows = [], {}
    for m in nodes:
        facts, err = _probe_node(m, local, nodes.get(m, {}))
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
                f"or installed and dead). Nothing samples this node"
            )
        elif facts["inflight_at"] is None:
            findings.append(f"{m}: inflight.json exists but carries no readable `at` — the heartbeat is unparseable")
        elif now and now - facts["inflight_at"] > HEARTBEAT_STALE_S:
            findings.append(
                f"{m}: heartbeat stale — last sweep {int(now - facts['inflight_at'])}s ago at "
                f"{_iso(facts['inflight_at'])}. The harvester is not sampling whatever `is-active` "
                f"says about the unit"
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
                    f"samples.jsonl does not exist; the harvest is collecting nothing"
                )
            elif facts["sample_end"] is None:
                findings.append(
                    f"{m}: active but silent — a job completed at {_iso(facts['job_ts'])} but the "
                    f"newest sample record is unparseable"
                )
            elif facts["sample_end"] + WINDOW_LAG_S < facts["job_ts"]:
                findings.append(
                    f"{m}: active but silent — the newest completed job ({_iso(facts['job_ts'])}) "
                    f"postdates the newest harvested window ({_iso(facts['sample_end'])}) by "
                    f"{int(facts['job_ts'] - facts['sample_end'])}s; jobs are streaming past "
                    f"unmeasured"
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
