"""The node-identity / ssh-role half of `runner-mem-report.py` (wave 5q lane D
split, fleet-manager#19 follow-on: the file crossed the 800-line ceiling).

Everything here answers "which tree, which role, which user" by EXECUTING the
package's own built TS/JS modules — never a Python second opinion of
`isLocalNode`/`nodeUser`/`manifestDir` — for exactly the reasons the functions'
own docstrings give. This module is PULLED IN LAZILY, never imported at
`runner-mem-report.py`'s module scope: see `_sibling()` there for why
(`scripts/lib/slice-placement-guard.test.mjs` copies or mutates ONLY that one
file into a directory with no siblings, and a module-scope import would fail
loading that copy at all, for code it never calls).

Loaded the same way `runner-mem-harvest.py` always was (`harvest_interval()`
below) — `importlib.util.spec_from_file_location` against this file's own
absolute path, never a plain `import mem_report_env`, because a plain import
depends on `sys.path` having this directory on it, which is true when this
package's CLI spawns `python3 runner-mem-report.py` directly (CPython adds the
launched script's own directory) but NOT true under
`importlib.util.spec_from_file_location`, the loading method every test in
this tree uses instead.
"""

import getpass
import json
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The harvester's own output, read both locally (collect()'s local branch,
# in runner-mem-report.py) and over ssh (collect()'s remote branch, and the
# PROBE in mem_report_check.py). Derived once here so every reader of either
# path agrees with the harvester's own writer by construction.
REMOTE = "~/.local/state/hadoku/runner-mem/samples.jsonl"
INFLIGHT_REMOTE = REMOTE.rsplit("/", 1)[0] + "/inflight.json"
JOB_METRICS_REMOTE = "~/.hadoku/job-metrics.jsonl"


def _node_error_message(stderr):
    """The script's own message, stripped of V8's stack frames. An uncaught
    throw prints its (possibly multi-line) message BEFORE the stack frames;
    taking the last line would hand the operator a stack frame instead of a
    reason — the undiagnosable-finding shape this repo retired from
    check-queue-health. Shared by every `node -e` call this file makes
    (`ask_library`, `node_role_user`) so the one rule has one copy."""
    msg = []
    for ln in (stderr or "").splitlines():
        if msg and ln.lstrip().startswith("at "):
            break
        if ln.strip():
            msg.append(ln.rstrip())
    return "\n  ".join(msg) if msg else "no reason printed"


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

_LIB_CACHE = {}


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
        raise SystemExit(
            "fleet mem-report: the library refused to resolve the manifest:\n  "
            + _node_error_message(r.stderr)
        )
    try:
        res = json.loads(r.stdout)
    except ValueError:
        raise SystemExit(f"fleet mem-report: unparseable answer from {paths_mod}: {r.stdout[:200]!r}")
    _LIB_CACHE[key] = res
    return res


# ── which USER an ssh/rsync acts as, asked of the one place that knows ──────
#
# "Every command on a node acts as a ROLE: `admin` or `ci`" (CLAUDE.md), and
# `src/lib/node-users.ts` is the single place a role becomes a user name — the
# JS/TS side's `scripts/lib/fleet-exec.mjs` asks it through `nodeUser` and
# `sshDestination` rather than keeping a second copy. This file cannot import
# that module any more than it can import `fleet-paths.ts`, so it EXECUTES it
# the same way `ask_library` already does: one `node` run over the package's
# own built module. The alternative — a Python literal for the admin default,
# or a `$(id -un)` guess — is exactly the second answer to "who plays this
# role" that `node-users-guard.test.mjs` exists to refuse on the JS/TS side;
# this file keeps the same discipline even though that guard cannot see `.py`.
#
# BOTH SSH CALLS `collect()` AND THE PROBE MAKE ACT AS `ci`, NEVER `admin`.
# Every path either reads lives under the ci user's `$HOME`: `REMOTE`/
# `INFLIGHT_REMOTE` are `runner-mem-harvest.py`'s own output, and
# `JOB_METRICS_REMOTE` is `job-metrics.sh`'s — both deployed `as: 'ci'` by
# `deploy-ci-throttle.mjs` (its one `runOn` call installs the hook, the
# throttle conf AND the harvester together). The PROBE script's `systemctl
# --user show ... runner-mem-harvest.service` reads that same unit's OWN
# systemd --user manager, which CLAUDE.md names as ci's — admin's `systemctl
# --user` is a different manager entirely and would read ci's unit as absent.
_ROLE_ASK = """const [usersMod, machine, role] = process.argv.slice(1);
const { nodeUser } = await import(usersMod);
process.stdout.write(nodeUser(JSON.parse(machine), role));"""

_ROLE_CACHE = {}


def node_role_user(machine, role):
    """The user that plays `role` on `machine` (a manifest node entry, or
    `None`) — asked of `src/lib/node-users.ts`'s own `nodeUser`, never
    restated here. The admin default (`DEFAULT_ADMIN_USER`) and the rule that
    `ci` falls back to `admin` when a node has not been cut over both live in
    that module alone; a second copy in Python is exactly the kind of drift
    `isLocalNode` had five of before one survived an FQDN (2026-08-30)."""
    key = (json.dumps(machine or {}, sort_keys=True), role)
    if key in _ROLE_CACHE:
        return _ROLE_CACHE[key]
    mod = (HERE.parent / "dist" / "lib" / "node-users.js").resolve()
    if not mod.is_file():
        raise SystemExit(
            f"fleet mem-report: {mod} does not exist — the package is not built.\n"
            "  Build it before this report can name which user a role plays."
        )
    exe = shutil.which("node")
    if not exe:
        raise SystemExit("fleet mem-report: cannot find `node` to resolve a node-users role.")
    try:
        r = subprocess.run(
            [exe, "--input-type=module", "-e", _ROLE_ASK, mod.as_uri(), json.dumps(machine or {}), role],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit(f"fleet mem-report: resolving the '{role}' role through {mod} timed out")
    if r.returncode != 0:
        raise SystemExit(
            f"fleet mem-report: could not resolve the '{role}' role: {_node_error_message(r.stderr)}"
        )
    _ROLE_CACHE[key] = r.stdout
    return r.stdout


def ssh_destination(node, role, machine):
    """`<user>@<node>` for ROLE — the Python twin of
    `scripts/lib/fleet-exec.mjs`'s `sshDestination`: same rule, same source of
    truth (`nodeUser`), so the two transports can never name a role
    differently."""
    return f"{node_role_user(machine, role)}@{node}"


def assert_can_act_locally(node, role, machine):
    """Mirrors `nodeCommand`'s local branch (`src/lib/node-users.ts`): acting
    as a role that is not admin, on THIS box, needs this process to already
    be logged in as that role's user — there is no sudo switch inside this
    script, and guessing otherwise is how a local read of `collect()`/PROBE
    would silently read the WRONG `$HOME` instead of failing loudly. Never a
    literal comparison: both names come from `node_role_user`, the same
    source `ssh_destination` uses, so the two can never disagree about what a
    role is called."""
    user = node_role_user(machine, role)
    admin = node_role_user(machine, "admin")
    me = getpass.getuser()
    if user != admin and me != user:
        raise SystemExit(
            f"fleet mem-report: {node} is this box, which runs as {me}; "
            f"acting as {role} needs {user}."
        )


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
    import importlib.util

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
