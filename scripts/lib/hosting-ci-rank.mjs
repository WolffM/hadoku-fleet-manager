/**
 * HOW EACH CI PROCESS ON A SHARED HOSTING NODE IS RANKED, read from /proc.
 *
 * Split out of hosting.mjs, which observes a node and splices this loop into
 * its observe script; `judgeHosting` there turns the counts into findings.
 */

import { CI_OOM_SCORE_ADJ } from '../../dist/runners/hosting-record.js';

/**
 * Count the CI processes and how each is ranked: in `runners.slice`, and at
 * CI's oom score. A process is read in ONE place, its cgroup and its score
 * each read once; one that EXITS between `pgrep` and the read is gone, not
 * CI, and is counted as `ciGone`. The loop used to read a vanished pid as
 * outside the slice at oom 0, so a runner finishing at the instant of a
 * declare refused it (claw-6, watchparty, 2026-10-29: the warm listener had
 * restarted 5 s before). `$PROC` is /proc on a node; the test points it at a
 * fixture tree.
 *
 * A listener the MINTERS run for a moment is tooling, not CI, and is counted
 * as `ciTooling` (fleet-manager#59): `--version` (jit-provision, warm-provision,
 * runner-payload), `configure`/`remove` (warm-provision), and the capability
 * probe's `run --jitconfig not-a-real-config`. They run from the ssh session,
 * so they sit in `session-N.scope` at oom 0, and a declare that overlapped one
 * went red on claw-4/6/8 for one tick each. The test is the process's own
 * argv, not where it runs: a listener started by hand with a real `run` in a
 * session scope is CI outside the slice, and must still be found.
 *
 * Every read goes through `$SEE`: `sudo -n` on a node, empty in the test.
 * claw-1/2/3 mount /proc `hidepid=invisible`, so admin's own `pgrep` and
 * `cat /proc/<pid>/…` cannot see ci's processes there and the loop counted
 * none with jobs live (fleet-manager#69). The caller checks `$SEE` works
 * first and emits nothing otherwise, so a node it cannot look at reads null.
 */
export const CI_RANK_SCRIPT = `n=0; out=0; low=0; min=; gone=0; tool=0
for q in $($SEE pgrep -x 'Runner\\.(Listener|Worker)'); do
	cg=$($SEE cat "$PROC/$q/cgroup" 2>/dev/null) && a=$($SEE cat "$PROC/$q/oom_score_adj" 2>/dev/null) && [ -n "$a" ] &&
		argv=$($SEE cat "$PROC/$q/cmdline" 2>/dev/null | tr '\\0' ' ') && [ -n "$argv" ] || {
		gone=$((gone+1))
		continue
	}
	case "$argv" in
	*/Runner.Listener\\ --version\\ * | */Runner.Listener\\ configure\\ * | */Runner.Listener\\ remove\\ * | \\
		*/Runner.Listener\\ run\\ --jitconfig\\ not-a-real-config\\ *)
		tool=$((tool+1))
		continue
		;;
	esac
	n=$((n+1))
	case "$cg" in */runners.slice/*) ;; *) out=$((out+1)) ;; esac
	[ "$a" -lt ${CI_OOM_SCORE_ADJ} ] && low=$((low+1))
	if [ -z "$min" ] || [ "$a" -lt "$min" ]; then min=$a; fi
done
echo "ciProcs=$n"
echo "ciOutsideRunners=$out"
echo "ciBelowOom=$low"
echo "ciMinOom=$min"
echo "ciGone=$gone"
echo "ciTooling=$tool"
`;

/**
 * The observe script's whole CI section: the two counts and the rank loop.
 * By PROCESS NAME (-x), never the command line (-f): mgmt-api's own probes run
 * as `bash -c '... pgrep -ax Runner.Worker ...'`, in the ssh session's scope at
 * oom 0, and a command-line match counted them as unranked CI (claw-9,
 * 2026-10-27 06:57Z, during cardtable's A6). Through `sudo -n`, for hidepid
 * (above); without it nothing is printed, so every count reads null ("could
 * not count"), never 0.
 */
export const CI_OBSERVE_SCRIPT = `SEE='sudo -n'
if $SEE true 2>/dev/null; then
echo "ciWorkers=$($SEE pgrep -cx 'Runner\\.Worker' || true)"
echo "ciListeners=$($SEE pgrep -cx 'Runner\\.Listener' || true)"
PROC=/proc
${CI_RANK_SCRIPT}fi
`;
