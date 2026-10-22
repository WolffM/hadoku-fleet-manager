---
name: fleethealth
description: Run the hadoku CI fleet's health sweep — every fleet gate in @wolffm/fleet-manager, plus the hosted-job checks no gate covers — and report what is actually red. Use when the user asks to check fleet health, says the Command Station dashboard looks off, asks whether the claws/hokon are healthy, or after a migration that touched runners, manifests, or workflows.
---

# Fleet health sweep

Answers one question: **is the fleet actually healthy, and can I prove it?**

Run from the repo root of `hadoku-fleet-manager` — dev-vault resolves its key
from CWD, and `manifestDir()` resolves the operator manifests relative to the
checkout you are standing in.

    cd /home/hadoku/repos/hadoku-fleet-manager
    node dist/cli.js <subcommand>

If `dist/` is missing or older than `src/`, `pnpm build` first. A stale `dist`
sweeps a fleet that no longer exists.

## The rule this whole skill exists to enforce

From CLAUDE.md: **"I could not look" must never render as "nothing is wrong."**
An unreachable node, a missing checkout, an unreadable registry, zero repos
scanned — each of those is a FAILURE, not a pass. Exit 0 with no evidence is a
failure. Never report a gate as green because it printed nothing; report it
green because it printed what it measured.

Corollary for this skill: **do not read the dashboard and call that a health
check.** The Command Station is mgmt-api's aggregate. It is a good prompt and a
bad source. Run the gates.

## The sweep

Run in this order. Each line is the whole invocation; all read observed state.

| #   | command               | reads                          | ~time |
| --- | --------------------- | ------------------------------ | ----- |
| 1   | `capability-schema`   | manifest only, offline         | <1s   |
| 2   | `label-floor`         | manifest + GitHub              | ~2s   |
| 3   | `ci-watch --check`    | roster + workflows on disk     | ~5s   |
| 4   | `reconcile --json`    | GitHub API — registrations     | ~30s  |
| 5   | `identity`            | ssh, all nodes                 | ~30s  |
| 6   | `capabilities`        | ssh — EXECUTES each capability | ~60s  |
| 7   | `toolchain`           | ssh, all nodes                 | ~60s  |
| 8   | `slice --check`       | ssh — cgroup ceilings          | ~60s  |
| 9   | `throttle --check`    | ssh — concurrency hook         | ~60s  |
| 10  | `tool-inventory`      | workflows + ssh                | ~60s  |
| 11  | `tier-fleet`          | 25 sibling checkouts           | ~90s  |
| 12  | `header-audit --json` | 15 checkouts + npm registry    | ~60s  |
| 13  | `identity-model`      | hadoku_site                    | ~10s  |
| 14  | `mf-externals`        | micro-frontend builds          | ~20s  |
| 15  | `check-runner-var`    | sibling checkouts + GitHub API | ~30s  |

Batch 1–3 together, then 4–5, then the ssh-heavy ones in pairs. Do not run all
fourteen in one Bash call — one hang takes the whole sweep's output with it.

### Exit codes

These gates **exit 1 ON FINDINGS**. Non-zero is the gate working, not the gate
breaking. Never report "the checker crashed" without reading stdout first —
that inversion is the exact failure `scripts/lib/json-contract.mjs` documents.

`header-audit` needs `--json`. Its human output does not report registry
blindness (see Known finding 2), so the JSON is the only honest read.

## Reading gate 15, and two things no gate covers

**`check-runner-var` (gate 15 above)** replaced the hand-rolled `gh api` loop
this skill used to carry. It is WIDER than the coverage roster on purpose: a repo
that leaves the roster keeps its workflows and loses its writer, which is the
case it most exists for. An UNSET variable on a repo using the bare
`fromJSON(vars.CI_RUNNER)` form is a real finding — those workflows do not queue,
they fail to start. Detection only; it never writes. `"ubuntu-latest"` across the
whole fleet means mgmt-api has engaged the backstop — check whether the claws are
actually down before "fixing" it.

**a. Hardcoded `runs-on: ubuntu-latest`** across covered checkouts:

    grep -rn "runs-on:.*ubuntu-latest" /home/hadoku/repos/*/.github/workflows

Every hit must be in `allowHosted` in
`hadoku_site/scripts/admin/repo-policy-manifest.json`, keyed `repo:file`. A hit
that is not is drift. See the benign list below before flagging anything.

**b. Is the fleet's own control repo green?**

    gh run list -R WolffM/hadoku_site -b main -L 8
    gh run list -R WolffM/hadoku-fleet-manager -b main -L 5

## Known benign — verify, then do NOT flag

Every one of these was rediscovered and re-investigated at least once. Confirm
the state still matches the reason, then move on.

- **`ssh hokon` → Connection refused.** You are probably ON hokon
  (`hostname -f`). hokon refuses ssh to itself; that is `isLocalNode()`, the
  one-question-one-answer rule in CLAUDE.md. The gates print `(local)` for it.
- **claw-3 with 0 workers, 0 of 16 registrations, "mintable".** claw-3 is the
  JIT canary, and thermally marginal (96C against a 100C trip with one worker;
  its `maxConcurrent` is the safety control, not tuning). It holds no
  standing runners by design. Prove it is working by finding minted runners in
  recent jobs — names look like `jit-claw-3-<repo>-r<runid>-<n>` — not by
  counting registrations. `reconcile` reporting `desiredPairs: 78` (26 repos ×
  the three non-claw-3 nodes) is correct, not a shortfall.
- **`manifests/node-profiles.json` differs from the hadoku_site copy.**
  Deliberate, in both directions. `manifests/` here is the published TEST
  FIXTURE and carries the RFC 5737 placeholder LAN `192.0.2.0/24`; the operator
  copy in `hadoku_site/scripts/admin/` carries the real range and is private.
  Never paste the real range into this repo. The other three manifests should be
  identical — if one of those drifts, that IS a finding.
- **`av1-nvenc=listed-but-encode-failed` on claw-1/2/3.** They do not declare
  that capability; only hokon's RTX 4090 does. claw-1's GTX 860M is a real
  NVIDIA GPU that genuinely cannot AV1-encode. The gate still passes.
- **`(pull_request && author_association not in OWNER/MEMBER/COLLABORATOR &&
'["ubuntu-latest"]') || vars.CI_RUNNER`.** Untrusted fork PRs routed off the
  self-hosted fleet. A security control. Present in hadoku-aggregator,
  hadoku-contact-ui, hadoku-craft, hadoku-jobplatform, hadoku-resume-bot,
  hadoku-task, hadoku-task-mobile, vibecheck.
- **Plain `ubuntu-latest` in brave-quartet (ci, publish-bundle,
  publish-server-image) and hadoku-tenhands (test.yml, pages.yml).** All five
  are in `allowHosted` with reasons: brave-quartet needs a Rust toolchain and
  password-free sudo the claws do not have; tenhands' hosted jobs are the
  zero-secret fork fallback and a public Pages build. These are what the
  dashboard's ~2% github-hosted slice is made of.
- **Three `vars.CI_RUNNER || '[...]'` holdouts in hadoku-promptsmith**
  (ci, redeploy, vibecompact). Already named in CLAUDE.md. Dead code, since the
  variable is always set on covered repos. Do not convert
  `hadoku_site/templates/*` to the bare form — a freshly scaffolded repo has no
  `CI_RUNNER` until the nightly reconcile admits it.
- **A raw grep for the `||` fallback overcounts.** Four repos carry a comment
  reading "do NOT restore the `vars.CI_RUNNER || ...` fallback here", and grep
  scores that as a use of the thing it forbids. Filter with
  `grep -v "do NOT restore"`.
- **`header-audit` going registry-blind on a local run.** `npm view` against
  npm.pkg.github.com needs `NODE_AUTH_TOKEN`; without it the `stale-package` and
  `stale-peer` rules skip silently. That is a hole in YOUR run, not fleet drift
  — say so explicitly rather than reporting the audit clean.
- **`mf-externals` size-only notes** (hadoku-aggregator, hadoku-task inline
  zod). The gate exits 0. Notes, not findings.

## Reporting

Lead with the verdict, then the red items with the command that produced them,
then one line on what was verified green. For anything green, say what was
measured (nodes probed, repos scanned, files read) — a count is the evidence
that the gate was not blind.

If the user pasted dashboard numbers, cross-check the interesting ones against
the API rather than repeating them. Failure rate by runner over a bounded sample:

    for run in $(gh api "/repos/WolffM/<repo>/actions/runs?per_page=25" --jq '.workflow_runs[].id'); do
      gh api "/repos/WolffM/<repo>/actions/runs/$run/jobs?per_page=50" \
        --jq '.jobs[] | "\(.runner_name // "hosted")\t\(.conclusion)"'
    done | awk -F'\t' '{t[$1]++; if($2=="failure")f[$1]++} END{for(r in t) printf "%-12s %4d jobs %4d failed %5.1f%%\n", r, t[r], f[r]+0, 100*(f[r]+0)/t[r]}'

hokon's rate is not comparable to a claw's: it runs deploy/taskauto work with a
~20s median, the claws run builds at ~35s with a much longer tail. Before
calling a claw failure rate a fleet problem, open the failing jobs — a red test
on a push is a repo bug, an OOM or a hung job is a fleet bug. The dashboard's
"Recovery, last tick" row (auto-reruns, OOM, hung, queued past 10m) is the fast
discriminator: all zeros means the failures are red tests, not infrastructure.
