# runner-install — ONE answer to "is this directory a runner install?"
#
# Every node-side reader that turns a live Runner.Listener (or Runner.Worker)
# into "a runner to judge or act on" asks it here:
#
#   ci-throttle-install.sh    runner_dirs(), and the JOBTMP pass over workers
#   runner-identity-probe.sh  runner_dirs(), and the WORKER pass
#   runner-supervision.ts     SUPERVISION_PROBE
#   toolchain-doctor.mjs      the listener PATHs a capability is judged under
#
# It is PREPENDED to the script text by whoever ships it over ssh, and sourced
# from beside the script when one runs as a file (the tests, a hand run). It
# defines functions only: sourcing it does nothing.
#
# WHY ONE RULE. Each reader grew its own, and each was wrong in its own way.
# This package's own suite starts fake Runner.Listener and Runner.Worker
# processes in a temp dir while it runs as a CI job on a node, and:
#
#   - runner-identity-probe.sh dropped "$TMPDIR"/*, but its ssh shell never sees
#     the job's TMPDIR, so it only ever dropped /tmp.
#   - runner-supervision.ts kept anything matching "$HOME"/*/actions-runner*, and
#     a case `*` crosses "/": 11 "N listeners on one directory" pages from 11-01
#     to 11-16, every one this repo's own check or publish job
#     (fleet-manager#79).
#   - ci-throttle-install.sh had NO rule. On 2026-11-16 01:51Z hokon's
#     converger tried to RESTART four fixtures at /tmp/runner-drift-*/
#     actions-runner-x and reported them as failures.
#
# THE RULE. A runner install lives under the runner user's $HOME; that alone
# drops /tmp and every other system temp dir. What it does NOT drop is a temp
# dir INSIDE $HOME, and every CI job has one: ci-throttle-install.sh gives each
# job TMPDIR=$HOME/runner-tmp (RUNNER_TMPDIR there; keep the two in step). That
# is named outright, because it is the job's TMPDIR and this shell never has it.
# $TMPDIR is honoured as well, but only when it sits strictly inside $HOME: a
# fixture whose own $HOME is under /tmp (every hermetic test here) must not have
# all of its runners dropped by an unset TMPDIR falling back to /tmp.
#
# Deliberately NOT a naming rule. The listener unions exist to catch an install
# whose name no glob knows (the bare ~/actions-runner that ran hadoku_site
# unthrottled on three claws); a rule that narrowed names would restore that.

# runner_install_dir DIR: 0 when DIR is a runner install (standing, warm or a
# JIT slot), 1 for a test fixture, a job's temp tree, or anything outside $HOME.
runner_install_dir() {
	case "$1" in
	"$HOME"/runner-tmp | "$HOME"/runner-tmp/*) return 1 ;;
	esac
	__ri_tmp=${TMPDIR:-}
	__ri_tmp=${__ri_tmp%/}
	if [ -n "$__ri_tmp" ]; then
		case "$__ri_tmp" in
		"$HOME"/?*)
			case "$1" in "$__ri_tmp" | "$__ri_tmp"/*) return 1 ;; esac
			;;
		esac
	fi
	case "$1" in
	"$HOME"/?*) return 0 ;;
	esac
	return 1
}

# runner_jit_slot DIR: 0 when DIR is a JIT slot (or the payload they share).
# Minted per job, bounded by the dispatcher's admission check, capped by
# systemd-run: a runner install, but not a STANDING one. The node directory is
# ci-throttle-install.sh's NODE_DIR when the caller has one, spelled once here
# otherwise.
runner_jit_slot() {
	__ri_jit=${NODE_DIR:-$HOME/.hadoku}/jit
	case "$1" in
	"$__ri_jit" | "$__ri_jit"/*) return 0 ;;
	esac
	return 1
}

# listener_install_dirs: the directory of every live Runner.Listener that is a
# runner install. `pgrep -f` matches its own shell, so the exact argv token is
# filtered rather than the match trusted.
listener_install_dirs() {
	pgrep -af "bin/Runner\.Listener" 2>/dev/null | tr ' ' '\n' |
		while IFS= read -r __ri_tok; do
			case "$__ri_tok" in
			*/bin/Runner.Listener)
				__ri_dir=${__ri_tok%/bin/Runner.Listener}
				runner_install_dir "$__ri_dir" && printf '%s\n' "$__ri_dir"
				;;
			esac
		done
}

# standing_runner_dirs: every standing runner directory on this node, once.
# The known layouts by GLOB, UNION the live listeners, so a layout the glob
# does not know is still enumerated; JIT slots excluded. A caller that needs a
# `.runner` checks for it: a glob hit without one is itself worth reporting.
standing_runner_dirs() {
	{
		for __ri_d in "$HOME"/runners/actions-runner*/ "$HOME"/actions-runner*/ "$HOME"/repos/*/actions-runner*/; do
			__ri_d=${__ri_d%/}
			[ -d "$__ri_d" ] && printf '%s\n' "$__ri_d"
		done
		listener_install_dirs
	} | sort -u | while IFS= read -r __ri_d; do
		runner_jit_slot "$__ri_d" || printf '%s\n' "$__ri_d"
	done
}
