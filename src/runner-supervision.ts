/**
 * Is every Actions runner listener supervised by exactly one live systemd unit?
 *
 * This closes the blind spot that let nine broken runners sit unnoticed for
 * three days. `runner-health.ts` asks GitHub which runners are online, and
 * GitHub answers about the LISTENER — so a listener that has escaped its
 * systemd unit reports perfectly healthy while nothing will ever restart it.
 * Every existing alert was looking at the wrong side of the problem.
 *
 * Three conditions, none of them answerable from the GitHub API alone:
 *
 *   orphan     A listener whose supervising unit is not active — or which sits
 *              in no unit at all. It answers jobs today and dies permanently at
 *              the next reboot or crash. Nine runners were exactly this on
 *              2026-08-21: a bare `run.sh` tree outliving the system unit that
 *              lost the session race.
 *
 *   duplicate  Two listeners on one runner directory. They race for a single
 *              GitHub session; the loser burns 240s on SessionConflictException
 *              and exits 5, and any job landing in the overlap shares `_diag`
 *              and `_work/_temp` with a second process. That corrupted a
 *              hadoku-study run on 2026-08-20.
 *
 *   dead       A unit systemd has given up restarting, so there is no listener
 *              and no directory. This was ADDED on 2026-08-26 after the header
 *              spent months arguing it was unnecessary: the claim was that
 *              GitHub reports the runner offline and the label-floor alert
 *              covers it. Both halves were true and it still missed a 6h45m
 *              degradation — the floor only fires at ZERO online, which one
 *              runner among twenty-six never reaches.
 *
 * That third case is the one exception to the cgroup rule below: it matches
 * units by NAME, because a unit with no process has no cgroup to read.
 *
 * THE UNIT IS READ FROM THE PROCESS'S CGROUP, NEVER MATCHED BY NAME. Four unit
 * naming conventions are live across this fleet:
 *
 *   /system.slice/actions.runner.WolffM-hadoku-task.claw-2.service   claw, system
 *   /user.slice/…/app.slice/actions-runner-hadoku-merchant.service   claw, user
 *   /user.slice/…/app.slice/hokon-runner-b.service                   hokon, user
 *   /ci.slice/ci-runner.slice/github-runner.service                  hokon, ci.slice
 *
 * A name-based scan silently reports whichever convention it does not know
 * about as unsupervised, and this probe produced three separate false-positive
 * rounds that way before adopting the cgroup: all three hadoku-merchant runners
 * (user scope unknown), then all four hokon runners (ci.slice + a fourth naming
 * convention). The cgroup is ground truth and needs no convention list at all.
 *
 * Deliberately NOT an auto-repair. Killing a listener can abort a running job,
 * and the right resolution differs per condition. It reports and says what to
 * run, in the same shape runner-health's alerts already use.
 */
import { execFile } from 'node:child_process';
import { nodeShell } from './node-shell.js';

import { logger } from './host.js';
import { loadFleetNodeNames, loadGuestNodes } from './fleet-loop.js';

const SSH_TIMEOUT_MS = 15000;

export type SupervisionKind = 'orphan' | 'duplicate' | 'dead';
export type SupervisionScope = 'system' | 'user';

export interface SupervisionProblem {
	node: string;
	/** Runner directory basename, e.g. `actions-runner-hadoku-study`. */
	dir: string;
	kind: SupervisionKind;
	listeners: number;
	/** Which systemd manager owns it — `--user` units need a different query. */
	scope: SupervisionScope;
	/** Unit resolved from the cgroup, or 'none' when the process is in no service. */
	unit: string;
	unitState: string;
}

export interface SupervisionReport {
	nodes: string[];
	/** Nodes that could not be probed — reported, never counted as healthy. */
	unreachable: string[];
	/** Live listeners seen across every reachable node. */
	listenersSeen: number;
	problems: SupervisionProblem[];
	/**
	 * Guest nodes in the tier manifest that were deliberately NOT probed — named
	 * so the skip is reported, never silent. Optional only because a report can
	 * come from a test double; `checkSupervision` always sets it.
	 */
	skippedByRole?: string[];
}

/**
 * One line per LISTENER: `dir|unit|scope|state`.
 *
 * Listeners are found from `ps` and matched in the shell, never via
 * `pgrep -f "<path>"` — that matches full command lines including the invoking
 * shell, so the literal path lands in our own argv and every runner reads as
 * one listener too many. Same trap as `pkill -f` killing its own shell; it
 * produced a phantom "2 listeners everywhere" reading during the repair.
 */
/**
 * SUPERVISION COVERS STANDING RUNNERS ONLY, ON PURPOSE.
 *
 * The pattern below matches `/*<slash>actions-runner*<slash>bin/Runner.Listener`. A JIT runner is
 * minted into `~/.hadoku/jit/slotN`, so its listener is
 * `.../slot0/bin/Runner.Listener` and this probe cannot see it. Measured
 * 2026-08-30: hokon has 26 matching listeners, a JIT slot has none — including
 * the listener running the job that measured it.
 *
 * That is correct rather than a gap. This check exists for ONE failure: a
 * listener that escaped its systemd unit, so it still answers GitHub while
 * nothing will ever restart it (nine runners sat that way across three claws for
 * three days in August 2026). A JIT runner cannot fail that way — every mint is
 * a transient unit carrying `RuntimeMaxSec` (runners/ephemeral.ts), so an
 * orphaned listener is bounded by the cap rather than immortal, and the reaper
 * sweeps whatever the cap leaves.
 *
 * The consequence to keep in view: the fraction of the fleet this covers shrinks
 * as nodes go JIT, and it shrinks SILENTLY. If a JIT node ever grows a
 * standing runner, that runner is covered; if standing runners disappear
 * entirely, this check correctly reports nothing and is no longer load-bearing.
 * Reviewed and decided 2026-08-30; see the fleet worklist §8e.
 */
const PROBE = `
ps -eo pid=,args= | while read -r pid rest; do
  # ANCHORED at "/": a listener's argv[0] is an absolute path, while this
  # probe's own \`bash -c <script>\` process has argv starting with "bash" — and
  # its script text CONTAINS this very pattern. An unanchored \`*/actions-runner*\`
  # therefore matches the probe itself on every node, yielding a phantom
  # listener whose directory is the literal glob \`actions-runner*\` and a bogus
  # "2 listeners" duplicate. Same self-match trap as \`pgrep -f\`, one layer down.
  case "$rest" in
    /*/actions-runner*/bin/Runner.Listener*) ;;
    *) continue ;;
  esac
  bin=\${rest%%/bin/Runner.Listener*}
  dir=$(basename "$bin")
  cg=$(head -1 /proc/$pid/cgroup 2>/dev/null)
  case "$cg" in
    */user.slice/*) scope=user ;;
    *) scope=system ;;
  esac
  unit=none
  case "$cg" in
    *.service) unit=\${cg##*/} ;;
  esac
  state=none
  if [ "$unit" != none ]; then
    if [ "$scope" = user ]; then
      state=$(systemctl --user is-active "$unit" 2>/dev/null)
    else
      state=$(systemctl is-active "$unit" 2>/dev/null)
    fi
  fi
  printf '%s|%s|%s|%s\\n' "$dir" "$unit" "$scope" "\${state:-unknown}"
done

# --- second pass: runner units that are FAILED -----------------------------
# The pass above starts from PROCESSES, so a unit whose listener is gone
# produces no row and is invisible by construction. That is how
# github-runner-tenhands.service sat in start-limit-hit on 2026-08-26 with its
# registration deleted, while every existing signal stayed quiet: GitHub said
# "offline", and the label-floor alert only fires at ZERO online, which one
# runner among twenty-six never reaches.
#
# Name matching is safe HERE in a way it is not above. This filters an
# already-failed set, so a convention this list does not know about costs a
# MISSED report; up there the same miss produced a FALSE "unsupervised" verdict
# and three rounds of noise. Missing an alert is bad, inventing one is worse.
for scope in system user; do
  if [ "$scope" = user ]; then
    out=$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-units --state=failed --no-legend --plain 2>/dev/null)
  else
    out=$(systemctl list-units --state=failed --no-legend --plain 2>/dev/null)
  fi
  printf '%s\\n' "$out" | while read -r unit _rest; do
    case "$unit" in
      actions.runner.*|actions-runner-*|github-runner*|hokon-runner*) ;;
      *) continue ;;
    esac
    printf 'DEAD|%s|%s|failed\\n' "$unit" "$scope"
  done
done
`;

/** One live listener, as the probe reports it. */
export interface ListenerRow {
	dir: string;
	unit: string;
	scope: SupervisionScope;
	unitState: string;
}

/** Parse the probe output into one row per live listener. */
export function parseListeners(stdout: string): ListenerRow[] {
	const rows: ListenerRow[] = [];
	for (const line of stdout.split('\n')) {
		const parts = line.trim().split('|');
		if (parts.length !== 4) continue;
		const [dir, unit, scopeRaw, unitState] = parts;
		// A unit-driven row: no listener exists, so `dir` is the sentinel.
		if (dir === 'DEAD') {
			rows.push({ dir, unit, scope: scopeRaw === 'user' ? 'user' : 'system', unitState });
			continue;
		}
		// ssh banners and MOTD lines arrive on this stream too.
		if (!dir.startsWith('actions-runner')) continue;
		rows.push({ dir, unit, scope: scopeRaw === 'user' ? 'user' : 'system', unitState });
	}
	return rows;
}

/**
 * Turn per-listener rows into per-directory verdicts.
 *
 * `duplicate` outranks `orphan`: two listeners actively corrupt each other's
 * jobs, where an orphan merely will not survive a restart.
 */
export function classify(node: string, rows: ListenerRow[]): SupervisionProblem[] {
	const byDir = new Map<string, ListenerRow[]>();
	for (const r of rows) {
		const list = byDir.get(r.dir) ?? [];
		list.push(r);
		byDir.set(r.dir, list);
	}

	const problems: SupervisionProblem[] = [];

	// DEAD units first, and NOT grouped by directory — they have no listener and
	// therefore no directory. One problem per failed unit.
	//
	// This is the case the module's header used to say it deliberately did not
	// detect, on the reasoning that GitHub reports an offline runner and the
	// label-floor alert covers it. Both halves of that were true and it still
	// missed a 6h45m degradation on 2026-08-26: GitHub did say offline, but the
	// floor alert only fires at ZERO online, which one runner among twenty-six
	// never reaches. A unit that systemd has given up restarting is a fleet
	// problem in its own right.
	for (const r of rows) {
		if (r.dir !== 'DEAD') continue;
		problems.push({
			node,
			dir: r.unit,
			kind: 'dead',
			listeners: 0,
			unit: r.unit,
			scope: r.scope,
			unitState: r.unitState,
		});
	}

	for (const [dir, list] of byDir) {
		if (dir === 'DEAD') continue;
		const head = list[0];
		if (list.length > 1) {
			problems.push({
				node,
				dir,
				kind: 'duplicate',
				listeners: list.length,
				scope: head.scope,
				unit: head.unit,
				unitState: head.unitState,
			});
			continue;
		}
		// No unit owns the process (a hand-started run.sh sits in a session
		// scope), or the unit that does is not active — either way nothing will
		// bring this listener back, while GitHub keeps reporting it online.
		if (head.unit === 'none' || head.unitState !== 'active') {
			problems.push({
				node,
				dir,
				kind: 'orphan',
				listeners: 1,
				scope: head.scope,
				unit: head.unit,
				unitState: head.unitState,
			});
		}
	}
	return problems;
}

/** Probe one node. null = unreachable, which is reported rather than assumed healthy. */
export async function probeSupervision(
	node: string
): Promise<{ listeners: number; rows: ListenerRow[]; problems: SupervisionProblem[] } | null> {
	let cmd: string;
	let args: string[];
	try {
		// As ci: the listeners are CI's units, in its own manager.
		[cmd, args] = nodeShell(node, 'ci', PROBE);
	} catch (err) {
		logger.warn(
			`[supervision] cannot reach ${node} as ci: ${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}

	const stdout = await new Promise<string | null>((res) => {
		execFile(cmd, [...args], { timeout: SSH_TIMEOUT_MS }, (err, out) =>
			res(err ? null : String(out))
		);
	});
	if (stdout === null) return null;

	// `rows` is returned as well as the verdicts so a caller — in practice the
	// self-match regression test — can assert on what was actually seen, not
	// only on what was judged wrong about it.
	const rows = parseListeners(stdout);
	return { listeners: rows.length, rows, problems: classify(node, rows) };
}

/** What `checkSupervision` reads and runs — injectable so the role skip is testable without ssh. */
export interface SupervisionDeps {
	/** Every node the fleet manifest declares; `null` = could not read it. */
	nodes: () => string[] | null;
	guests: () => ReadonlySet<string>;
	probe: typeof probeSupervision;
}

const LIVE_DEPS: SupervisionDeps = {
	nodes: () => {
		const names = loadFleetNodeNames();
		return names.length ? names : null;
	},
	guests: loadGuestNodes,
	probe: probeSupervision,
};

/** Probe every node the fleet manifest declares; guests are skipped by role and named. */
export async function checkSupervision(
	deps: SupervisionDeps = LIVE_DEPS
): Promise<SupervisionReport | null> {
	// The fleet manifest, not the retired tier ladder: every node it declares
	// has runner units worth auditing, including ones no ladder ever ranked.
	const listed = deps.nodes();
	if (!listed) return null;

	// A guest's runner units are the identity gate's question only (operator,
	// 2026-09-14) — the fleet chain never probes, pages about or repairs them.
	// An unreadable fleet manifest yields NO guests, so every node is probed:
	// the strict direction, same as `nodeRole`'s default.
	const guests = deps.guests();
	const nodes = listed.filter((n) => !guests.has(n));
	const skippedByRole = listed.filter((n) => guests.has(n));

	const problems: SupervisionProblem[] = [];
	const unreachable: string[] = [];
	let listenersSeen = 0;

	for (const node of nodes) {
		const found = await deps.probe(node);
		if (found === null) {
			unreachable.push(node);
			continue;
		}
		listenersSeen += found.listeners;
		problems.push(...found.problems);
	}

	return { nodes, unreachable, listenersSeen, problems, skippedByRole };
}

/** The right systemctl invocation for the manager that owns this unit. */
function startCmd(p: SupervisionProblem): string {
	return p.scope === 'user' ? `systemctl --user start ${p.unit}` : `sudo systemctl start ${p.unit}`;
}

/** One human-readable line per problem, with the command that resolves it. */
export function describeProblem(p: SupervisionProblem): string {
	if (p.kind === 'dead') {
		// Deliberately worded around the ONE thing that made this invisible: the
		// runner exits 0 on "no retry needed", so systemd sees a clean exit,
		// honours Restart=always, burns StartLimitBurst inside 90s, and parks the
		// unit. Nothing about that looks like a failure to anything watching
		// GitHub — the registration is simply gone and the runner simply offline.
		return (
			`\`${p.node}\` **${p.unit} is ${p.unitState}** — systemd has given up ` +
			`restarting it, so this runner is gone until someone intervenes. It will ` +
			`NOT appear as a fleet outage: GitHub just reports one runner offline, and ` +
			`the label-floor alert only fires at zero. Check for a lost registration ` +
			`(\`Failed to create a session ... registration has been deleted\`), then ` +
			`re-register and \`${startCmd(p)}\`.`
		);
	}
	if (p.kind === 'duplicate') {
		return (
			`\`${p.node}\` ${p.dir} — **${p.listeners} listeners on one directory**. ` +
			`They race for one GitHub session; the loser exits 5 and any job caught in ` +
			`the overlap corrupts the other's \`_work/_temp\`. ` +
			`Resolve: keep one supervisor, stop the other.`
		);
	}
	// `unit: none` means the process sits in no service cgroup at all, so there
	// is nothing to start — printing `systemctl start none` would be worse than
	// saying nothing.
	return p.unit === 'none'
		? `\`${p.node}\` ${p.dir} — **listener alive but in NO systemd unit**. ` +
				`GitHub reports this runner ONLINE; it dies at the next reboot and nothing ` +
				`will restart it. Resolve: re-register it, or stop the stray listener.`
		: `\`${p.node}\` ${p.dir} — **listener alive but ${p.unit} is ${p.unitState}**. ` +
				`GitHub reports this runner ONLINE; it will not survive a reboot and nothing ` +
				`will restart it. Resolve: stop the stray listener, then \`${startCmd(p)}\`.`;
}

/** Log-and-summarise helper for callers that want one line. */
function summarise(report: SupervisionReport): string {
	const byKind = report.problems.reduce<Record<string, number>>((acc, p) => {
		acc[p.kind] = (acc[p.kind] ?? 0) + 1;
		return acc;
	}, {});
	const parts = Object.entries(byKind).map(([k, n]) => `${n} ${k}`);
	const unreachable = report.unreachable.length
		? `, ${report.unreachable.length} unreachable (${report.unreachable.join(', ')})`
		: '';
	const skipped = report.skippedByRole?.length
		? `; skipped by role (guest): ${report.skippedByRole.join(', ')}`
		: '';
	return parts.length
		? `${parts.join(', ')} across ${report.nodes.length} node(s)${unreachable}${skipped}`
		: `${report.listenersSeen} listener(s) singly supervised on ` +
				`${report.nodes.length} node(s)${unreachable}${skipped}`;
}

export function logReport(report: SupervisionReport): void {
	if (report.problems.length) {
		logger.warn(`[runner-supervision] ${summarise(report)}`);
	} else {
		logger.info(`[runner-supervision] ${summarise(report)}`);
	}
}
