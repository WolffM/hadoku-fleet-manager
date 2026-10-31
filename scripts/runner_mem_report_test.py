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

stdlib `unittest`, not pytest (wave 5h lane D): the fleet's own toolchain
floor (`manifests/node-profiles.json`) images every node with `python3` via
apt, but pytest is a pip package nothing in that floor, `scripts/lib/
toolchain-floor.mjs`, or `capability-probe.sh` installs or probes for — and
this repo's own CI job runs on the generic `hadoku-builder` label
(`.github/workflows/ci.yml`'s `vars.CI_RUNNER`), not on a node that has
earned (and been PROBED for) the `python-venv` capability. pytest is
therefore not a safe thing to require on the box running `pnpm run check`.
`scripts/lib/python-tests.test.mjs` is the gate that runs this file and
fails loudly, naming `python3`, if the interpreter itself is missing.

Run with: `python3 -m unittest scripts/runner_mem_report_test -v`
"""

import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "runner-mem-report.py"
DIST_NODE_USERS = (HERE.parent / "dist" / "lib" / "node-users.js").resolve()


def _load_module():
    spec = importlib.util.spec_from_file_location("runner_mem_report", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class RunnerMemReportNodeUsersTest(unittest.TestCase):
    """Loads `runner-mem-report.py` once per class (mirrors the old
    module-scoped `mem_report` pytest fixture)."""

    @classmethod
    def setUpClass(cls):
        cls.mem_report = _load_module()

    def setUp(self):
        if not DIST_NODE_USERS.is_file():
            self.skipTest(f"{DIST_NODE_USERS} missing — run `pnpm run build` first")

    # ── node_role_user / ssh_destination: asked of node-users.ts, never restated ─

    def test_ci_falls_back_to_admin_before_a_node_is_cut_over(self):
        # No `users` field at all — every node's state before #108's cutover.
        # `ci` must answer exactly what `admin` answers: the single shared user.
        mem_report = self.mem_report
        self.assertEqual(
            mem_report.node_role_user({}, "ci"), mem_report.node_role_user({}, "admin")
        )

    def test_ci_resolves_to_its_own_user_once_cut_over(self):
        mem_report = self.mem_report
        machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
        self.assertEqual(mem_report.node_role_user(machine, "ci"), "hadoku-ci")
        self.assertEqual(mem_report.node_role_user(machine, "admin"), "hadoku")

    def test_a_malformed_user_name_throws_rather_than_falling_back(self):
        # `nodeUser` (src/lib/node-users.ts) throws on a name that is not a valid
        # user name, rather than silently falling back to admin — a typo that
        # fell back would run every job as the user this concept exists to keep
        # jobs away from. The Python side must see that failure, not swallow it.
        mem_report = self.mem_report
        machine = {"users": {"ci": "../etc/passwd"}}
        with self.assertRaises(SystemExit):
            mem_report.node_role_user(machine, "ci")

    def test_ssh_destination_is_the_roles_user_at_the_node(self):
        mem_report = self.mem_report
        machine = {"users": {"ci": "hadoku-ci"}}
        self.assertEqual(
            mem_report.ssh_destination("claw-9", "ci", machine), "hadoku-ci@claw-9"
        )

    def test_ssh_destination_for_admin_is_different_from_ci_once_cut_over(self):
        mem_report = self.mem_report
        machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
        self.assertEqual(
            mem_report.ssh_destination("claw-9", "admin", machine), "hadoku@claw-9"
        )
        self.assertEqual(
            mem_report.ssh_destination("claw-9", "ci", machine), "hadoku-ci@claw-9"
        )

    # ── assert_can_act_locally: nodeCommand's local-branch guard, ported ────────

    def test_local_read_is_fine_when_ci_still_defaults_to_admin(self):
        # Before a cutover, ci IS admin, so the controller's own process (running
        # as admin) may read ci's files locally without a role mismatch.
        mem_report = self.mem_report
        mem_report.assert_can_act_locally("hokon", "ci", {})  # must not raise

    def test_local_read_refuses_a_separate_ci_this_process_is_not(self):
        mem_report = self.mem_report
        machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
        with mock.patch.object(mem_report.getpass, "getuser", return_value="hadoku"):
            with self.assertRaisesRegex(SystemExit, "acting as ci needs hadoku-ci"):
                mem_report.assert_can_act_locally("hokon", "ci", machine)

    def test_local_read_is_fine_when_this_process_already_is_the_ci_user(self):
        mem_report = self.mem_report
        machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
        with mock.patch.object(mem_report.getpass, "getuser", return_value="hadoku-ci"):
            mem_report.assert_can_act_locally("hokon", "ci", machine)  # must not raise

    # ── collect() / _probe_node(): the ssh argv itself, never a bare node name ──

    def test_collect_sshes_as_ci_not_a_bare_node_name(self):
        mem_report = self.mem_report
        machine = {"users": {"ci": "hadoku-ci"}}
        # WARM THE ROLE CACHE FIRST, for real, before `subprocess.run` is patched:
        # `node_role_user` itself shells out to `node`, and patching `subprocess.run`
        # before that first (real) call would make the mock answer its OWN question.
        mem_report.node_role_user(machine, "ci")
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="no samples yet")

        with mock.patch.object(mem_report, "local_node", new=lambda nodes: None), mock.patch.object(
            mem_report.subprocess, "run", new=fake_run
        ):
            mem_report.collect({"claw-9": machine})

        self.assertEqual(len(calls), 1, "collect() must try exactly the one node it was given")
        cmd = calls[0]
        self.assertEqual(cmd[0], "ssh")
        self.assertIn("hadoku-ci@claw-9", cmd, f"ci's user must be the ssh destination, got {cmd}")
        self.assertNotIn("claw-9", cmd, f"the bare node name must never be the ssh destination, got {cmd}")

    def test_probe_node_sshes_as_ci(self):
        mem_report = self.mem_report
        machine = {"users": {"ci": "hadoku-ci"}}
        # See the matching comment in test_collect_sshes_as_ci_not_a_bare_node_name:
        # warm the real cache before `subprocess.run` is mocked underneath it.
        mem_report.node_role_user(machine, "ci")
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="unreachable")

        with mock.patch.object(mem_report.subprocess, "run", new=fake_run):
            mem_report._probe_node("claw-9", None, machine)

        self.assertEqual(len(calls), 1)
        cmd = calls[0]
        self.assertEqual(cmd[0], "ssh")
        self.assertIn("hadoku-ci@claw-9", cmd, f"ci's user must be the ssh destination, got {cmd}")
        self.assertNotIn("claw-9", cmd, f"the bare node name must never be the ssh destination, got {cmd}")

    def test_collect_refuses_a_local_read_as_a_role_this_process_is_not(self):
        # Before a node is cut over, the local read may proceed (tested above via
        # assert_can_act_locally directly); here one IS cut over and this process
        # is not its ci user, so collect() must refuse before ever touching `cat`.
        mem_report = self.mem_report
        machine = {"users": {"admin": "hadoku", "ci": "hadoku-ci"}}
        # Warm the real cache before `subprocess.run` is mocked underneath it —
        # same reasoning as the two tests above.
        mem_report.node_role_user(machine, "ci")
        mem_report.node_role_user(machine, "admin")

        def fail_if_called(cmd, **kwargs):
            raise AssertionError(f"collect() must not run anything locally here, tried {cmd}")

        with mock.patch.object(
            mem_report, "local_node", new=lambda nodes: "hokon"
        ), mock.patch.object(mem_report.getpass, "getuser", return_value="hadoku"), mock.patch.object(
            mem_report.subprocess, "run", new=fail_if_called
        ):
            with self.assertRaisesRegex(SystemExit, "acting as ci needs hadoku-ci"):
                mem_report.collect({"hokon": machine})


if __name__ == "__main__":
    unittest.main()
