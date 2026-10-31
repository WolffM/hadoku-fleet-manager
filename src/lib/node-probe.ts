import { execFile } from 'node:child_process';
import { nodeShell } from '../node-shell.js';
import { logger } from '../host.js';

const SSH_TIMEOUT_MS = 8000;

/** Concurrent jobs + cores on one node. null means UNKNOWN, which is treated as saturated. */
/**
 * The probe command. Shared by the ssh and local paths so they cannot drift.
 *
 * `pgrep -c` PRINTS 0 and EXITS 1 when nothing matches, so the obvious
 * `$(pgrep -c X || echo 0)` emits "0\n0" on an IDLE box — which parsed as
 * cores=0, read as saturated, and promoted every tier on a completely quiet
 * fleet. Capture the count, then default it; never chain `||` onto a command
 * that prints on failure.
 */
const PROBE_CMD =
	's=0; [ -s "$HOME/.hadoku/sick-runner" ] && s=1; ' +
	// A JOB is a Worker the runner SPAWNED: `.../bin*/Runner.Worker spawnclient
	// <in> <out>`. Matching the process name alone counted anything called
	// Runner.Worker — and ci-throttle.test.mjs copies bash to exactly that name
	// to stand in for one. Every run of this repo's suite on a CI node (claw-4,
	// claw-6) or an agent's worktree on hokon added phantom jobs: on 2026-10-25
	// claw-6 read `busy 7 / 2` holding two real jobs, and the dispatcher, which
	// charges these as standing work, refused it as at capacity while the
	// fan-out queued. `grep -c` prints 0 on no match, so this stays defaulted.
	'w=$(pgrep -ax Runner.Worker 2>/dev/null | grep -c " spawnclient "); ' +
	// Field 4: which REPO each running job belongs to, comma-joined.
	//
	// A node-wide worker count cannot answer "can repo R start a job here",
	// and that is the question the ladder actually needs — see
	// `repoBlockedOn`. Every runner instance lives in its own directory, and
	// that directory's `.runner` carries the authoritative `gitHubUrl`, so the
	// attribution costs nothing beyond the ssh this probe already makes.
	//
	// Read the repo from `.runner`, NOT from the directory name. The layout is
	// `~/actions-runner-<repo-suffix>` for every instance EXCEPT the original
	// primary, which is a bare `~/actions-runner` — on claw-2 that bare one is
	// hadoku_site. A name-derived mapping would silently miss exactly the repo
	// this fix is about.
	//
	// `${c%/bin*/Runner.Worker}` and not `${c%/bin/Runner.Worker}`: a Worker is
	// spawned from the VERSION-SUFFIXED directory (`bin.2.336.0/Runner.Worker`)
	// while the Listener runs from the plain `bin` symlink. Stripping `/bin/`
	// matched the listener path, produced no directory for any worker, and made
	// this field come back empty on a node that was demonstrably busy.
	'r=$(pgrep -ax Runner.Worker 2>/dev/null | grep " spawnclient " | while read -r _ c _; do ' +
	'd=${c%/bin*/Runner.Worker}; ' +
	'sed -n \'s#.*"gitHubUrl"[^"]*"https://github.com/\\([^"]*\\)".*#\\1#p\' ' +
	'"$d/.runner" 2>/dev/null; done | tr "\\n" ","); ' +
	// There was a fifth field here until 2026-08-29: the runners.slice OOM
	// counters, read from memory.events. Nothing ever consumed it — probeFleet
	// dropped it building NodeProbe, and the alert it was collected FOR was
	// never written, so it made an unmet precondition read as met. It also came
	// back `-` on hokon regardless, whose slice is ci-runner.slice. Reinstating
	// it is ~6 lines here plus a parse; do that in the same change as the alert
	// that reads it, not before.
	// ORDER MATTERS: events before repos. The repo field is VARIABLE LENGTH and
	// empty on an idle node, so anything after it lands in its position — an
	// idle box would have reported `0/0` as a repo slug and corrupted the very
	// map the per-repo starvation rule reads. Keep the only variable-length field
	// last, always.
	// Field 4: CAN THIS NODE RESOLVE GITHUB, as `g=1`/`g=0`. Reachable over ssh
	// is not reachable FROM GitHub's side: ssh goes over Tailscale addresses and
	// never resolves a name, so on 2026-10-16 claw-9 read `mintable` for two
	// hours while MagicDNS SERVFAILed every public name (a dhcpcd renewal raced
	// tailscale's resolv.conf watcher and left it no upstream). A runner minted
	// there for hadoku-bomberman sat in "Runner connect error: Resource
	// temporarily unavailable" for 65 minutes, and the dispatcher held its job
	// as in flight the whole time. The broker is the host a listener long-polls,
	// so this executes the capability rather than inferring it. TAGGED, so it
	// can never be mistaken for the repo field after it.
	'g=0; timeout 3 getent ahosts broker.actions.githubusercontent.com >/dev/null 2>&1 && g=1; ' +
	// THE OS AS RUNNING, tagged `o=<debian_version>,<kernel>` (comma, because Ubuntu's debian_version reads `trixie/sid`). The inventory read
	// `$measured`, which enrollment writes once: claw-1..3 predate enrollment and
	// showed no OS at all, and every other claw showed the release it joined
	// with. On 2026-10-25 the fleet spanned Debian 13.3 to 13.7 and no panel
	// could say so. `-` for a half that could not be read.
	'o="$(cat /etc/debian_version 2>/dev/null || echo -),$(uname -r 2>/dev/null || echo -)"; ' +
	'printf "%s %s %s g=%s o=%s %s" "${w:-0}" "$(nproc)" "$s" "$g" "$o" "$r"';

export interface ProbeResult {
	workers: number;
	cores: number;
	sick: boolean;
	/**
	 * `false` when the node could not resolve GitHub's broker — see the `g=`
	 * field in PROBE_CMD. `undefined` when the field was absent, which claims
	 * nothing either way.
	 */
	githubDns?: boolean;
	/**
	 * repo slug -> jobs of that repo running on this node right now.
	 *
	 * `null` means the node did not report the field at all (a box still
	 * running the three-field probe, mid-rollout). That is UNKNOWN, not "none":
	 * callers fall back to the node-wide number, which is exactly today's
	 * behaviour, so a partly-rolled-out fleet degrades to the old ladder rather
	 * than to a wrong one.
	 */
	busyRepos: ReadonlyMap<string, number> | null;
	/**
	 * `/etc/debian_version` and `uname -r` as the node runs them now — the `o=`
	 * probe field. Absent when the field was; a half that could not be read is
	 * `null`.
	 */
	os?: { release: string | null; kernel: string | null };
}

/** Test seam: the probe command itself, so a test can run it against a stub `pgrep`. */
export const __PROBE_CMD_FOR_TESTING = PROBE_CMD;

/** Test seam: the probe's wire format is the contract between two nodes. */
export function __parseProbeForTesting(stdout: string): ProbeResult | null {
	return parseProbe(stdout);
}

function parseProbe(stdout: string): ProbeResult | null {
	const fields = String(stdout).trim().split(/\s+/);
	const [w, c, sickField] = fields;
	// The TAGGED fields (`g=`, `o=`) are optional and precede the repo list,
	// the one untagged field after the third: with no tags, the next field is
	// the repo list exactly as it was before the tags existed.
	let i = 3;
	let githubDns: boolean | undefined;
	let os: ProbeResult['os'];
	for (; i < fields.length; i++) {
		const dnsTag = /^g=([01])$/.exec(fields[i]);
		const osTag = /^o=([^,]*),(.*)$/.exec(fields[i]);
		if (dnsTag) githubDns = dnsTag[1] === '1';
		else if (osTag) {
			const half = (v: string): string | null => (v && v !== '-' ? v : null);
			os = { release: half(osTag[1]), kernel: half(osTag[2]) };
		} else break;
	}
	const repoField = fields[i];
	const workers = Number(w);
	const cores = Number(c);
	if (!Number.isFinite(workers) || !Number.isFinite(cores) || cores <= 0) return null;
	// The sick field is OPTIONAL on purpose. A node still running the
	// two-field probe (mid-rollout, or an older image) must parse as healthy
	// rather than as null — null reads as saturated, which would silently
	// demote a perfectly good box for the sake of a field it never sent.
	const sick = Number(sickField) === 1;

	// An IDLE node emits a trailing space and nothing after it, so `split`
	// on the TRIMMED string yields three fields and `repoField` is undefined —
	// indistinguishable from an old three-field probe, and it must not be
	// reported as UNKNOWN or an idle fleet would permanently disable the
	// per-repo signal. `workers === 0` settles it: nothing is running, so the
	// empty attribution is the complete and correct answer.
	if (repoField === undefined) {
		return {
			workers,
			cores,
			sick,
			githubDns,
			...(os ? { os } : {}),
			busyRepos: workers === 0 ? new Map() : null,
		};
	}
	const busyRepos = new Map<string, number>();
	for (const slug of repoField.split(',')) {
		if (!slug) continue; // trailing comma from `tr`
		busyRepos.set(slug, (busyRepos.get(slug) ?? 0) + 1);
	}
	return { workers, cores, sick, githubDns, ...(os ? { os } : {}), busyRepos };
}

/**
 * Probe a node, as its ci user. THIS node is probed without ssh
 * ({@link nodeShell}'s local branch).
 *
 * mgmt-api runs on hokon, and hokon does not accept ssh to itself — sshd is not
 * listening on loopback, so `ssh hokon` is a hard `Connection refused`. That made
 * probeNode('hokon') fail on every tick since hokon joined the fleet, and
 * because the tier maths OMITS an unreachable node, hokon contributed
 * ZERO free slots forever: any tier containing it read as permanently saturated
 * and its four slots never counted once. The failure was invisible because the
 * fail-open direction is silent by design — it lights up the next tier rather
 * than complaining. It only surfaced when the Fleet panel rendered hokon red.
 *
 * reconcile-fleet-runners.mjs already had this exact special case; the fast loop
 * did not.
 */
export async function probeNode(node: string): Promise<ProbeResult | null> {
	let bin: string;
	let argv: string[];
	try {
		// As ci: the probe reads the sick-runner marker in CI's own $HOME.
		[bin, argv] = nodeShell(node, 'ci', PROBE_CMD);
	} catch (err) {
		logger.warn(
			`[fleet-loop] cannot probe ${node}: ${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
	return new Promise((res) => {
		execFile(bin, argv, { timeout: SSH_TIMEOUT_MS }, (err, stdout) => {
			res(err ? null : parseProbe(stdout));
		});
	});
}

/** What one node looked like on the last probe. `null` probe ⇒ unreachable. */
/**
 * What an injected probe must return. Every field beyond the two the ladder
 * cannot work without is OPTIONAL, so the dozens of existing test probes that
 * return `{workers, cores}` keep compiling and keep meaning what they meant.
 */
export interface ProbeResultLike {
	workers: number;
	cores: number;
	sick?: boolean;
	busyRepos?: ReadonlyMap<string, number> | null;
	githubDns?: boolean;
	os?: ProbeResult['os'];
}

export interface NodeProbe {
	/** Runner.Worker processes running right now. */
	workers: number;
	cores: number;
	/** Configured slot capacity — see $capacityNote; deliberately not cores. */
	capacity: number;
	/** The guard found this node's pnpm store damaged. See SICK_MARKER. */
	sick: boolean;
	free: number;
	reachable: boolean;
	/**
	 * Why `reachable` is false, when the node answered ssh but cannot serve CI
	 * anyway. Absent for a node that did not answer at all.
	 */
	unreachableWhy?: string;
	/**
	 * repo slug -> jobs of that repo running here. `null` = the node did not
	 * report it; see ProbeResult.busyRepos.
	 *
	 * `free` above is a NODE number and cannot answer "may repo R start a job
	 * here", because a repo reaches a node only through its own runner
	 * registration — one per (node, repo) since the -b/-c/-d pools were
	 * retired on 2026-08-24. This is what makes that question answerable.
	 */
	busyRepos: ReadonlyMap<string, number> | null;
	/**
	 * `/etc/debian_version` and `uname -r` as the node runs them now — the `o=`
	 * probe field. Absent when the field was; a half that could not be read is
	 * `null`.
	 */
	os?: { release: string | null; kernel: string | null };
}

const DNS_BLIND_WHY =
	'answers ssh but cannot resolve broker.actions.githubusercontent.com — ' +
	'its listeners cannot reach GitHub';

/** Nodes last seen DNS-blind, so the transition is logged once each way. */
const dnsBlind = new Set<string>();

function noteDnsBlind(node: string, blind: boolean): void {
	if (blind && !dnsBlind.has(node)) {
		dnsBlind.add(node);
		logger.warn(
			`[fleet-loop] ${node} ${DNS_BLIND_WHY}; treating it as unreachable until it resolves ` +
				'(check: getent hosts api.github.com; journalctl -u tailscaled | grep "no upstream")'
		);
	} else if (!blind && dnsBlind.delete(node)) {
		logger.info(`[fleet-loop] ${node} resolves GitHub again — reachable`);
	}
}

/**
 * Test seam: clear the DNS-blind set. Cross-tick memory, like every other
 * module-level set in this file — a node left blind by one test would
 * suppress the next test's "resolves again" transition log and swallow a
 * blind-to-blind repeat that a real second probe would have re-announced.
 */
export function __resetDnsBlindForTesting(): void {
	dnsBlind.clear();
}

/**
 * Probe every node once and keep the RAW numbers, not just the derived slot
 * count. The fast loop only needs `free`, but it is the sole thing on the host
 * that ssh's the fleet on a schedule, so throwing away `workers`/`cores` meant
 * anything else wanting live node state had to open its own ssh — per HTTP
 * request, for a dashboard. This keeps one probe per node per tick and lets
 * readers derive the rest.
 */
export async function probeFleet(
	nodes: string[],
	capacity: Record<string, number> = {},
	probe: (node: string) => Promise<ProbeResultLike | null> = probeNode
): Promise<Map<string, NodeProbe>> {
	const probes = await Promise.all(nodes.map(async (m) => [m, await probe(m)] as const));
	const out = new Map<string, NodeProbe>();
	for (const [m, p] of probes) {
		if (!p) {
			out.set(m, {
				workers: 0,
				cores: 0,
				capacity: capacity[m] ?? 0,
				free: 0,
				reachable: false,
				// UNREACHABLE is not SICK. Sickness is a positive claim backed by the
				// guard's marker; a box we cannot see makes no claim either way, and
				// retiring it on silence would turn every network blip into a
				// quarantine.
				sick: false,
				// An unreachable node offers nothing to anyone; `free: 0` already
				// says so, and an empty map keeps the per-repo pass agreeing with it
				// instead of reading the node as UNKNOWN and fading back to it.
				busyRepos: new Map(),
			});
			continue;
		}
		const cap = capacity[m] ?? Math.max(1, Math.floor(p.cores / 4));
		// ANSWERED SSH, CANNOT REACH GITHUB: unreachable for every purpose CI has.
		// Folded into `reachable` rather than carried beside it so every reader of
		// the probe — the mint, the warm cache, the label floor, the census and the
		// CI_RUNNER fallback behind it — stops counting the node at once, instead
		// of each having to learn a second field. `unreachableWhy` keeps the
		// reason, because "unreachable" for a box that answers ssh sends an
		// operator to the wrong problem. A node that never sent the field claims
		// nothing and stays reachable.
		if (p.githubDns === false) {
			noteDnsBlind(m, true);
			out.set(m, {
				workers: p.workers,
				cores: p.cores,
				capacity: cap,
				free: 0,
				reachable: false,
				unreachableWhy: DNS_BLIND_WHY,
				sick: p.sick === true,
				busyRepos: new Map(),
				...(p.os ? { os: p.os } : {}),
			});
			continue;
		}
		noteDnsBlind(m, false);
		out.set(m, {
			workers: p.workers,
			cores: p.cores,
			capacity: cap,
			free: Math.max(0, cap - p.workers),
			reachable: true,
			sick: p.sick === true,
			busyRepos: p.busyRepos ?? null,
			...(p.os ? { os: p.os } : {}),
		});
	}
	return out;
}
