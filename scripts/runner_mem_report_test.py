#!/usr/bin/env python3
"""Tests for `runner-mem-report.py`'s node-role resolution (fleet-manager#19).

CLAUDE.md: "Every command on a node acts as a ROLE: `admin` or `ci`" and
`src/lib/node-users.ts` is the only place a role becomes a user name. Before
this fix, `runner-mem-report.py`'s two ssh calls (`collect()`'s harvest read,
`_probe_node()`'s PROBE) logged in as a bare node name — whoever ssh's own
config said, the single shared identity that predates the 2026-10-27 cutover.
This file is the guard `scripts/lib/node-users-guard.test.mjs` cannot be,
since that guard scans only `.ts`/`.mjs`/`.sh` (confirmed by reading it: its
`files()` walk filters on `/\\.(ts|mjs|sh)$/`).

NO SSH IS EVER INVOKED FOR REAL. Every test that exercises `collect()` or
`_probe_node()` monkeypatches `subprocess.run` and inspects the argv it
received; the role-resolution tests call `node_role_user` directly, which
shells out to `node` against the package's OWN built `dist/lib/node-users.js`
— the same module `scripts/lib/fleet-exec.mjs` asks on the JS/TS side — never
a Python restatement of the rule.

Needs the package BUILT first (`pnpm run build`): skipped otherwise, the same
way `node_role_user` itself refuses loudly rather than silently answering
about the wrong tree.

Run with: `python3 -m pytest scripts/runner_mem_report_test.py -q`
"""

import importlib.util
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "runner-mem-report.py"
DIST_NODE_USERS = (HERE.parent / "dist" / "lib" / "node-users.js").resolve()


def _load_module():
    spec = importlib.util.spec_from_file_location("runner_mem_report", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def mem_report():
    return _load_module()


@pytest.fixture(autouse=True)
def _require_build():
    if not DIST_NODE_USERS.is_file():
        pytest.skip(f"{DIST_NODE_USERS} missing — run `pnpm run build` first")


# ── node_role_user / ssh_destination: asked of node-users.ts, never restated ─


def test_ci_falls_back_to_admin_before_a_node_is_cut_over(mem_report):
    # No `users` field at all — every node's state before #108's cutover.
    # `ci` must answer exactly what `admin` answers: the single shared user.
    assert mem_report.node_role_user({}, "ci") == mem_report.node_role_user({}, "admin")


def test_ci_resolves_to_its_own_user_once_cut_over(mem_report):
    machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
    assert mem_report.node_role_user(machine, "ci") == "hadoku-ci"
    assert mem_report.node_role_user(machine, "admin") == "hadoku"


def test_a_malformed_user_name_throws_rather_than_falling_back(mem_report):
    # `nodeUser` (src/lib/node-users.ts) throws on a name that is not a valid
    # user name, rather than silently falling back to admin — a typo that
    # fell back would run every job as the user this concept exists to keep
    # jobs away from. The Python side must see that failure, not swallow it.
    machine = {"users": {"ci": "../etc/passwd"}}
    with pytest.raises(SystemExit):
        mem_report.node_role_user(machine, "ci")


def test_ssh_destination_is_the_roles_user_at_the_node(mem_report):
    machine = {"users": {"ci": "hadoku-ci"}}
    assert mem_report.ssh_destination("claw-9", "ci", machine) == "hadoku-ci@claw-9"


def test_ssh_destination_for_admin_is_different_from_ci_once_cut_over(mem_report):
    machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
    assert mem_report.ssh_destination("claw-9", "admin", machine) == "hadoku@claw-9"
    assert mem_report.ssh_destination("claw-9", "ci", machine) == "hadoku-ci@claw-9"


# ── assert_can_act_locally: nodeCommand's local-branch guard, ported ────────


def test_local_read_is_fine_when_ci_still_defaults_to_admin(mem_report):
    # Before a cutover, ci IS admin, so the controller's own process (running
    # as admin) may read ci's files locally without a role mismatch.
    mem_report.assert_can_act_locally("hokon", "ci", {})  # must not raise


def test_local_read_refuses_a_separate_ci_this_process_is_not(mem_report, monkeypatch):
    monkeypatch.setattr(mem_report.getpass, "getuser", lambda: "hadoku")
    machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
    with pytest.raises(SystemExit, match="acting as ci needs hadoku-ci"):
        mem_report.assert_can_act_locally("hokon", "ci", machine)


def test_local_read_is_fine_when_this_process_already_is_the_ci_user(mem_report, monkeypatch):
    monkeypatch.setattr(mem_report.getpass, "getuser", lambda: "hadoku-ci")
    machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
    mem_report.assert_can_act_locally("hokon", "ci", machine)  # must not raise


# ── collect() / _probe_node(): the ssh argv itself, never a bare node name ──


def test_collect_sshes_as_ci_not_a_bare_node_name(mem_report, monkeypatch):
    machine = {"users": {"ci": "hadoku-ci"}}
    # WARM THE ROLE CACHE FIRST, for real, before `subprocess.run` is patched:
    # `node_role_user` itself shells out to `node`, and patching `subprocess.run`
    # before that first (real) call would make the mock answer its OWN question.
    mem_report.node_role_user(machine, "ci")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="no samples yet")

    monkeypatch.setattr(mem_report, "local_node", lambda nodes: None)
    monkeypatch.setattr(mem_report.subprocess, "run", fake_run)
    mem_report.collect({"claw-9": machine})

    assert len(calls) == 1, "collect() must try exactly the one node it was given"
    cmd = calls[0]
    assert cmd[0] == "ssh"
    assert "hadoku-ci@claw-9" in cmd, f"ci's user must be the ssh destination, got {cmd}"
    assert "claw-9" not in cmd, f"the bare node name must never be the ssh destination, got {cmd}"


def test_probe_node_sshes_as_ci(mem_report, monkeypatch):
    machine = {"users": {"ci": "hadoku-ci"}}
    # See the matching comment in test_collect_sshes_as_ci_not_a_bare_node_name:
    # warm the real cache before `subprocess.run` is mocked underneath it.
    mem_report.node_role_user(machine, "ci")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="unreachable")

    monkeypatch.setattr(mem_report.subprocess, "run", fake_run)
    mem_report._probe_node("claw-9", None, machine)

    assert len(calls) == 1
    cmd = calls[0]
    assert cmd[0] == "ssh"
    assert "hadoku-ci@claw-9" in cmd, f"ci's user must be the ssh destination, got {cmd}"
    assert "claw-9" not in cmd, f"the bare node name must never be the ssh destination, got {cmd}"


def test_collect_refuses_a_local_read_as_a_role_this_process_is_not(mem_report, monkeypatch):
    # Before a node is cut over, the local read may proceed (tested above via
    # assert_can_act_locally directly); here one IS cut over and this process
    # is not its ci user, so collect() must refuse before ever touching `cat`.
    machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
    # Warm the real cache before `subprocess.run` is mocked underneath it —
    # same reasoning as the two tests above.
    mem_report.node_role_user(machine, "ci")
    mem_report.node_role_user(machine, "admin")

    def fail_if_called(cmd, **kwargs):
        raise AssertionError(f"collect() must not run anything locally here, tried {cmd}")

    monkeypatch.setattr(mem_report, "local_node", lambda nodes: "hokon")
    monkeypatch.setattr(mem_report.getpass, "getuser", lambda: "hadoku")
    monkeypatch.setattr(mem_report.subprocess, "run", fail_if_called)

    with pytest.raises(SystemExit, match="acting as ci needs hadoku-ci"):
        mem_report.collect({"hokon": machine})
