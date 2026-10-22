#!/usr/bin/env python3
"""runner-mem-harvest — a per-JOB anon memory distribution for the CI fleet.

WHY THIS EXISTS
---------------
Step 1d of docs/planning/fleet-rearchitecture-2026-08-25.md. Steps 6, 9 and 10
all need to know how much memory a job on this fleet actually costs, and no
existing number answers that:

  - `memory.peak` is the high-water of `memory.current`, which is
    CACHE-INCLUSIVE. A live sample of the hadoku_site unit read 1,400 MB of
    memory.current against 30 MB of anon — 85% page cache, all of it reclaimed
    before a global OOM. Sizing a MemoryMax from that number caps nothing.
  - summed `ps` RSS counts shared library pages once per process, and each
    registration runs three, so it overstates by roughly the sharing factor.
  - the OOM journal's victim `anon-rss` is the node PARENT only and excludes
    every child it spawned.

The only figure that predicts a global OOM is ANON (plus shmem, which is also
unreclaimable, plus whatever has been pushed to swap). There is no anon
high-water counter in cgroup v2, so it has to be SAMPLED.

WHAT IT PRODUCES
----------------
One JSONL record per completed job window, where a window is "this runner unit's
cgroup contained a Runner.Worker". Records carry the anon peak that sizing needs
AND the memory.current / file peaks beside it, so the cache share stays visible
and nobody re-derives the retracted number from this data either.

A record also carries whether its window was CLIPPED — whether the cgroup
recorded an `oom_kill` (or was torn down and recreated) while the job ran. A
killed run is not a measurement: the peak cannot exceed the cap that killed it,
so the anon figure on a clipped window is a FLOOR. `runner-mem-report.py`
excludes them from every percentile and counts them separately, because the
alternative is sizing the next cap from the last cap.

Both supervision namespaces are walked. claw-2 runs 24 units under system.slice
and 3 under user@1000, and BOTH produced OOM victims, so a harvest that sees one
manager silently under-reports.

THE FLEET WENT ALL-JIT ON 2026-09-07 AND THIS SCRIPT'S GLOBS WENT WITH IT (#47)
------------------------------------------------------------------------------
Measured 2026-09-22: the units installed 2026-08-26/27 on claw-1/2/3 were still
`active` with clean journals while their samples had stopped on each claw's
conversion day — claw-1 on 2026-09-07, the day its standing runners were
removed — because every job since runs in a `jit-*` mint or a `warm-*` listener
and the three legacy stems below matched NONE of them. 399 jobs ran on claw-1
alone after that, all invisible: `unit_cgroups()` returned {} on every sweep and
the inflight snapshot said `windows: []` while jobs streamed past. A service
that is up and matches nothing is exactly the "active but silent" shape
`is-active` cannot see; `fleet mem-report --check` is the reader that can.
"""

import json
import os
import sys
import time
from pathlib import Path

CG = Path(os.environ.get("HARVEST_CG_ROOT", "/sys/fs/cgroup"))
INTERVAL = float(os.environ.get("HARVEST_INTERVAL", "3"))
# XDG_STATE_HOME is the correct home for data that persists across restarts
# but is neither config nor a disposable cache — which is exactly what a
# sample log is. ~/.hadoku is the operator's own directory (ci-throttle,
# vault keys, the agent token); a harvest does not belong in it.
STATE = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
OUT = Path(os.environ.get("HARVEST_OUT", str(STATE / "hadoku/runner-mem/samples.jsonl")))
# A window is only APPENDED to samples.jsonl when its job ends, so a node that
# dies hard loses the in-flight record entirely — which is precisely the case
# worth having: hadoku-contact-ui run 32972225869 died on claw-1 on 2026-08-26
# leaving no logs at all, because the runner went before it could upload them.
#
# INFLIGHT is rewritten every interval with whatever is open right now. It is
# tiny, it is truncated rather than appended, and after a hard death it is the
# last thing the node managed to say.
INFLIGHT = Path(os.environ.get("HARVEST_INFLIGHT", str(OUT.parent / "inflight.json")))
HOST = os.uname().nodename
MB = 1024 * 1024


def unit_cgroups():
    """Every runner unit's cgroup dir, in both managers.

    Globbed rather than derived from a name list: four naming conventions are
    live across this fleet and a list goes stale silently. A directory that
    stops matching simply stops being sampled, which is visible as a gap in the
    data rather than as wrong numbers.
    """
    stems = [
        "actions.runner.*.service",  # `svc.sh install`, system manager
        "actions-runner-*.service",  # reconciler-installed, user manager
        "github-runner*.service",  # hokon's two legacy pm2-host/taskauto units
        # THE all-JIT SHAPES — see the header. A per-mint transient unit and a
        # warm listener are where every job on this fleet has run since
        # 2026-09-07; leaving them out is not "fewer samples", it is ZERO, with
        # a service that stays green the whole time.
        "jit-*.service",
        "warm-*.service",
    ]
    # rglob, not a fixed root list. Runner units live under system.slice on the
    # claws, under user@1000/app.slice for reconciler-installed ones, and under
    # ci.slice/ci-runner.slice on hokon — three different depths, and the third
    # was missed by an explicit root list written from the first two. Searching
    # by unit-name shape at any depth cannot go stale when a slice is added,
    # which is exactly what step 1c will do.
    out = {}
    for st in stems:
        for d in CG.rglob(st):
            if d.is_dir():
                out[d.name] = d
    return out


def read_kv(path):
    try:
        return {
            k: int(v)
            for k, _, v in (ln.partition(" ") for ln in path.read_text().split("\n") if ln)
        }
    except (OSError, ValueError):
        return {}


def read_int(path):
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return 0


def has_worker(d):
    """True while a Runner.Worker lives in this cgroup — i.e. a job is running.

    Reads comm per pid rather than matching a command line: `pgrep -f` matches
    its own shell, and the listener and the worker share an install path so a
    path match cannot tell them apart.
    """
    try:
        pids = d.joinpath("cgroup.procs").read_text().split()
    except OSError:
        return False
    for pid in pids:
        try:
            if Path("/proc", pid, "comm").read_text().strip() == "Runner.Worker":
                return True
        except OSError:
            continue
    return False


def oom_kills(d):
    """Cumulative `oom_kill` for this cgroup and everything under it.

    THE KERNEL'S OWN COUNTER, never the journal. `memory.events` is written at
    the moment of the kill, lives in the same cgroup this window is sampling,
    and needs no privilege, no log retention and no clock agreement between the
    node and whoever reads the record later. The journal is a CROSS-CHECK — it
    carries the victim's comm and anon-rss, which this does not — but a harvest
    that depended on it would lose every kill older than the node's rotation.

    Returns 0 rather than None on an unreadable file: a missing counter is
    indistinguishable from zero kills HERE, and the reset detection in main()
    is what actually carries "something happened under us".
    """
    return read_kv(d / "memory.events").get("oom_kill", 0)


def cap_mb(d):
    """This unit's live `memory.max`, in MiB — None when it is `max`.

    Recorded on every window because it is THE number that decides whether the
    window is a measurement or a collision with a limit. A clipped window's
    peak cannot exceed the cap that killed it, so a reader has to be able to see
    the two side by side and say "that is a floor, not a requirement".
    """
    try:
        t = (d / "memory.max").read_text().strip()
    except OSError:
        return None
    if t == "max":
        return None
    try:
        return round(int(t) / MB, 1)
    except ValueError:
        return None


def sample(d):
    st = read_kv(d / "memory.stat")
    anon = st.get("anon", 0)
    shmem = st.get("shmem", 0)
    file_ = st.get("file", 0)
    slab = st.get("slab", 0)
    return {
        "anon": anon,
        "shmem": shmem,
        "file": file_,
        "slab": slab,
        "unreclaimable": anon + shmem,
        "swap": read_int(d / "memory.swap.current"),
        "current": read_int(d / "memory.current"),
    }


# A unit whose cgroup DISAPPEARS is how a JIT mint or a warm listener ends:
# the transient unit exits with its one job. For any other shape (a standing
# runner, hokon's backstop units) the cgroup going away mid-job means it was
# torn down under the job, which is not a clean measurement.
VANISH_IS_NORMAL = ("jit-", "warm-")

# How far back into samples.jsonl recovery looks for a window it already wrote.
RECOVER_DEDUPE_LINES = 5000


def close_record(name, w, end, closed_by, **extra):
    """The samples.jsonl record for one finished window.

    `closed_by` says how the end was seen, on EVERY record, for the same reason
    `clipped` is: a key that appears only sometimes cannot be told apart from a
    harvester too old to write it.
      exit       a sweep saw the unit with no Runner.Worker in it
      vanished   the unit's cgroup was gone; `end` is the last sweep that saw
                 the worker, and `vanished_at` the first that saw it gone
      recovered  written at startup from the previous process's snapshot
    A peak the window never measured is OMITTED, not written as 0: a recovered
    window from an old snapshot knows only its unreclaimable and current peaks,
    and a 0 would read as a measurement.
    """
    rec = {
        "host": HOST,
        "unit": name,
        "start": round(w["start"], 1),
        "end": round(end, 1),
        "dur_s": round(end - w["start"], 1),
        "samples": w["n"],
        "closed_by": closed_by,
    }
    # The number sizing must use first, then the rest. Kept beside it so the
    # cache share stays visible and the retracted memory.peak figure cannot be
    # re-derived from this file by accident.
    for key, field in (
        ("unreclaimable", "peak_unreclaimable_mb"),
        ("anon", "peak_anon_mb"),
        ("shmem", "peak_shmem_mb"),
        ("swap", "peak_swap_mb"),
        ("current", "peak_current_mb"),
        ("file", "peak_file_mb"),
        ("slab", "peak_slab_mb"),
    ):
        if key in w["peak"]:
            rec[field] = round(w["peak"][key] / MB, 1)
    # THE SIZING INPUT IS BOUNDED BY THE LIMIT IT EXISTS TO SET.
    #
    # A cgroup kill at `memory.max` truncates the window: the peak can never
    # exceed the cap that killed it, so the number is a FLOOR and not a
    # requirement. brave-quartet's only two windows were its two killed runs
    # (2026-09-19 10:55 and 11:26, CONSTRAINT_MEMCG, anon-rss 3830164kB) and it
    # reported 3,739 MiB — one hair under the 4 GiB that stopped it, which is
    # what a clipped distribution always looks like. Unmarked, that number would
    # have been read as "this repo needs 3.7 GB" and sized the next cap from the
    # last cap.
    #
    # WRITTEN ON EVERY RECORD, true or false. A key that only appears when
    # something went wrong cannot be told from a harvest too old to have the key
    # at all, and the report has to be able to separate those two.
    rec["clipped"] = bool(w["oom"] or w["reset"])
    rec["oom_kills"] = w["oom"]
    rec["cgroup_reset"] = w["reset"]
    # The cap this window ran under, so a reader can see the peak against it.
    rec["cap_mb"] = w["cap_mb"]
    rec.update(extra)
    return rec


def step(open_windows, units, now):
    """One sweep: sample every running unit, return the windows that finished.

    A window used to close in ONE place, a sweep that still found the unit and
    found no worker in it. A JIT unit is transient: when its job ends the unit
    exits and its cgroup is removed, usually inside one interval, so the unit
    simply stopped being returned by unit_cgroups() and its window stayed open
    for the life of the process, written nowhere. Measured 2026-10-10: 147 to
    710 such windows per claw in inflight.json, the oldest 17 days, against
    roughly 80-90% of JIT jobs never producing a record (#99).

    So a window whose unit is missing is closed too, but only once its cgroup
    DIRECTORY is gone. Missing from one rglob is not the same as gone: cgroups
    are created and removed while the walk runs, and closing on a scan miss
    would split one job into two windows. A window keeps the path it was
    opened on, and that path is the test.
    """
    done = []
    for name, d in units.items():
        running = has_worker(d)
        w = open_windows.get(name)
        if running:
            s = sample(d)
            k_now = oom_kills(d)
            if w is None:
                w = open_windows[name] = {
                    "start": now,
                    "n": 0,
                    "peak": {},
                    # The counter as it stood when this window OPENED. A
                    # cgroup's oom_kill is cumulative over the life of the
                    # cgroup, so only the DELTA belongs to this job.
                    "oom_prev": k_now,
                    "oom": 0,
                    "reset": False,
                    "cap_mb": cap_mb(d),
                }
            w["n"] += 1
            w["last"] = now
            w["path"] = str(d)
            # ACCUMULATED FROM POSITIVE STEPS, not taken as end-minus-start.
            # A standing runner has Restart=always, so a cgroup kill is
            # followed by systemd recreating the cgroup with the counter
            # back at zero. Differencing the endpoints would read that as
            # -1 kills and score the window CLEAN — the exact window that
            # most needs marking. A step DOWN is itself evidence the cgroup
            # was torn down under the job, which is not a clean measurement
            # either, so it is recorded rather than smoothed over.
            if k_now > w["oom_prev"]:
                w["oom"] += k_now - w["oom_prev"]
            elif k_now < w["oom_prev"]:
                w["reset"] = True
            w["oom_prev"] = k_now
            if w["cap_mb"] is None:
                w["cap_mb"] = cap_mb(d)
            for k, v in s.items():
                if v > w["peak"].get(k, -1):
                    w["peak"][k] = v
        elif w is not None:
            done.append(close_record(name, w, now, "exit"))
            del open_windows[name]

    for name in [n for n in open_windows if n not in units]:
        w = open_windows[name]
        path = w.get("path")
        if path and Path(path).exists():
            continue
        if not name.startswith(VANISH_IS_NORMAL):
            w["reset"] = True
        done.append(
            close_record(name, w, w.get("last", w["start"]), "vanished", vanished_at=round(now, 1))
        )
        del open_windows[name]
    return done


def snapshot(open_windows, now):
    """What is open right now, rewritten every sweep (see INFLIGHT).

    It also carries each window's full state (raw peaks, the oom counter, the
    cgroup path, the last sweep that saw the worker), so a restarted harvester
    can resume a job that is still running and write out one that finished
    while it was down, instead of losing both (see recover()). The readable
    fields stay as they were for the readers that already use them.
    """
    return {
        "host": HOST,
        "at": round(now, 1),
        "windows": [
            {
                "unit": name,
                "start": round(w["start"], 1),
                "elapsed_s": round(now - w["start"], 1),
                "samples": w["n"],
                "peak_unreclaimable_mb": round(w["peak"].get("unreclaimable", 0) / MB, 1),
                "peak_current_mb": round(w["peak"].get("current", 0) / MB, 1),
                "oom_kills": w["oom"],
                "cap_mb": w["cap_mb"],
                "state": {
                    "peak": w["peak"],
                    "oom_prev": w["oom_prev"],
                    "reset": w["reset"],
                    "last": w.get("last"),
                    "path": w.get("path"),
                },
            }
            for name, w in open_windows.items()
        ],
    }


def recently_written(lines=RECOVER_DEDUPE_LINES):
    """(unit, start) of the windows already in samples.jsonl's tail.

    A window is appended and THEN dropped from the snapshot, one sweep apart.
    A process that dies between the two would otherwise write that window a
    second time on recovery.
    """
    try:
        with OUT.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - lines * 600))
            tail = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return set()
    seen = set()
    for ln in tail[-lines:]:
        try:
            r = json.loads(ln)
            seen.add((r["unit"], round(float(r["start"]), 1)))
        except (ValueError, KeyError, TypeError):
            continue
    return seen


def recover(snap, units, now, seen):
    """Resume or write out the previous process's open windows.

    Before this, every restart (a redeploy, a crash, a reboot) dropped every
    window in flight: the state lived only in memory. The snapshot now carries
    enough to do better:
      - the unit's cgroup still exists: RESUME the window. The oom counter is
        re-read now, so a kill during the gap is not counted against this job,
        and is not missed after it either.
      - the cgroup is gone, or has no worker in it: the job ended while no
        harvester was looking. The
        window is written with `closed_by: recovered`, ending at the last sweep
        that saw the worker. A snapshot from before this change has no `last`,
        so the end is estimated as start + samples x INTERVAL and marked
        `dur_approx`.
    A snapshot from another host (a copied home dir) is ignored whole.
    """
    open_windows, done = {}, []
    if not isinstance(snap, dict) or snap.get("host") != HOST:
        return open_windows, done
    for win in snap.get("windows") or []:
        try:
            name = win["unit"]
            start = float(win["start"])
            n = int(win.get("samples") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if (name, round(start, 1)) in seen:
            continue
        st = win.get("state") if isinstance(win.get("state"), dict) else {}
        peak = st.get("peak") if isinstance(st.get("peak"), dict) else None
        if peak is None:
            peak = {}
            for key, field in (
                ("unreclaimable", "peak_unreclaimable_mb"),
                ("current", "peak_current_mb"),
            ):
                if isinstance(win.get(field), (int, float)):
                    peak[key] = int(win[field] * MB)
        w = {
            "start": start,
            "n": n,
            "peak": peak,
            "oom_prev": 0,
            "oom": int(win.get("oom_kills") or 0),
            "reset": bool(st.get("reset", False)),
            "cap_mb": win.get("cap_mb"),
        }
        d = units.get(name)
        # Resume only a job that is still RUNNING. A unit that outlives its job
        # (a warm listener's cgroup, a standing runner's) with no worker in it
        # finished while nobody was looking; resuming it would close it at
        # `now` with a duration covering the whole gap.
        if d is not None and has_worker(d):
            w["oom_prev"] = oom_kills(d)
            w["path"] = str(d)
            if st.get("last") is not None:
                w["last"] = float(st["last"])
            open_windows[name] = w
            continue
        if d is None and not name.startswith(VANISH_IS_NORMAL):
            w["reset"] = True
        if st.get("last") is not None:
            done.append(close_record(name, w, float(st["last"]), "recovered"))
        else:
            done.append(
                close_record(name, w, start + n * INTERVAL, "recovered", dur_approx=True)
            )
    return open_windows, done


def append(records):
    if not records:
        return
    with OUT.open("a") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    try:
        prev = json.loads(INFLIGHT.read_text())
    except (OSError, ValueError):
        prev = None
    open_windows, recovered = recover(prev, unit_cgroups(), time.time(), recently_written())
    append(recovered)
    while True:
        now = time.time()
        append(step(open_windows, unit_cgroups(), now))
        # Truncate-and-rewrite, not append: this is a SNAPSHOT of now, and a
        # growing file would be another thing to reason about after a crash.
        # Written every sweep even when empty, so "no in-flight work" is a
        # positive statement rather than a stale file from an hour ago.
        try:
            tmp = INFLIGHT.with_suffix(".tmp")
            tmp.write_text(json.dumps(snapshot(open_windows, now)))
            tmp.replace(INFLIGHT)
        except OSError:
            # Never let bookkeeping kill the harvest. A missing snapshot costs
            # one incident's forensics; a dead harvester costs all of them.
            pass

        time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
