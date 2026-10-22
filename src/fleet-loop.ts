/**
 * fleet-loop — the fast loop that keeps the fleet serving: probe every node,
 * quarantine and repair the damaged ones, converge standing-registration labels,
 * and hand the JIT dispatcher its input.
 *
 * ONE RULE FOR `hadoku-builder`: a standing registration carries it iff its node
 * is SAFE — not quarantined, not drained, not disqualified by bootcamp
 * (`nodeIsSafe`). A guest's label is the backstop's (runner-health), under the
 * same rule. Placement among JIT nodes is `runners/traffic.ts`.
 *
 * THIS WAS A PRIORITY LADDER until 2026-09-21. GitHub has no runner priority,
 * so `runner-tiers.json` ranked nodes into tiers and this loop made lower tiers
 * invisible by stripping their label until the ones above filled. The all-JIT
 * conversion left it deciding nothing: every claw mints instead of carrying a
 * label, `carousel` forced every claw tier on, guests were skipped, and the one
 * signal it still fed the dispatcher was a constant. It was retired, along with
 * the file; a per-node ceiling (thermal or otherwise) is `maxConcurrent`.
 *
 * THE SIGNAL
 * ----------
 * Per-node concurrent job count, read over SSH. NOT the GitHub API: a
 * runner's `busy` flag is per-REGISTRATION, so a claw saturated by work for one
 * repo still reports idle on the other nineteen. mgmt-api runs as `hadoku` on
 * hokon, which administers every claw since 2026-08-17; the local node is
 * probed and repaired without ssh (`probeLocal`, `doctorCommand`).
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * An unreachable node, an unparseable count, a failed label write — none of
 * them strands capacity. The worst outcome of a bug here must be "we used a
 * node we did not need", never "CI queued because a node was left dark".
 */
import { execFile, spawn } from 'node:child_process';
import { isLocalNode } from './lib/node-identity.js';

import { nodeReservation, getPm2HostBusy, type Reservation } from './node-reservation.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, manifestDir, stateDir, storeDoctorPath, TOKEN_RETRY_MS } from './host.js';
import { withGhCaller } from './gh-budget.js';
import { coveredRepos } from './ci-runner-fallback.js';
import { dispatchEphemeral } from './runners/ephemeral-tick.js';
import type { FleetDispatch } from './fleet-report-types.js';
import { BUILDER_LABEL, PM2_HOST_LABEL } from './runners/census.js';
import {
	provesRequiredSet,
	requiredIdentitySet,
	type BootcampFacet,
	type DemandRecord,
	type ManifestNode as RegistryNode,
} from './capabilities.js';
import { isGuestNode, mintsOnDemand } from './lib/node-role.js';
import { isBackstopHeld } from './runners/backstop-hold.js';
import { readDrain } from './runners/drain.js';

// Injected, never __dirname arithmetic — see host.ts. The loader below fails
// SOFT, so a wrong path here reads as an empty fleet rather than an error.
/** Which claws each repo is covered by — the same file the reconciler applies. */
const FLEET_MANIFEST = () => resolve(manifestDir(), 'fleet-runner-manifest.json');
const SSH_TIMEOUT_MS = 8000;

/**
 * EXTENDS the registry's node shape rather than restating it. `provesRequiredSet`
 * and `isGuestNode` take `capabilities.ManifestNode`, and an interface without
 * that type's index signature is not assignable to it — so the choice was to
 * inherit or to cast at every call, and a cast is a second declaration of the
 * same shape that nothing keeps in step. The members below are the ones THIS
 * module reads; the registry's are the ones the capability vocabulary reads.
 */
interface ManifestNode extends RegistryNode {
	labels?: string[];
	placement?: string;
	excludeRepos?: Record<string, string>;
	/**
	 * This node mints runners on demand instead of carrying standing ones.
	 *
	 * Workstream B. claw-3 has carried this since 2026-08-28 and serves every
	 * job through a just-in-time mint; it holds no standing registrations at all.
	 * Enabling it on a node alters live scheduling, so it stays a deliberate
	 * edit to the manifest rather than a consequence of a deploy.
	 */
	ephemeral?: boolean;
	/** Concurrency cap. The dispatcher's admission budget for this node. */
	maxConcurrent?: number;
	/** Node memory floor, in MB. A mint must not push below it. */
	minFreeMb?: number;
	/** cgroup containment. `unitMaxMb` is the per-unit HARD CAP (MemoryMax). */
	slice?: { unitMaxMb?: number };
	/**
	 * Measured p95 of a JIT job's peak memory on this node, in MB.
	 *
	 * ADMISSION'S ESTIMATE, which is not the same thing as the hard cap and was
	 * conflated with it until 2026-09-01. `admitMint` reserves `requiredMb`
	 * against observed free memory; using `unitMaxMb` there reserves the
	 * WORST case for every job, so a node admits far fewer than it can hold.
	 * Measured that day from systemd's own per-unit accounting: p95 2970MB
	 * against a 4096MB cap on both nodes with enough JIT history to ask
	 * (claw-1 n=41, claw-3 n=227 — the same workload, so the agreement is
	 * expected rather than lucky).
	 *
	 * The cap still binds: MemoryMax stays `unitMaxMb` and MemorySwapMax is 0,
	 * so a job above the estimate is OOM-killed inside its own unit — bounded
	 * and attributable — rather than dragging the node down. Absent, admission
	 * falls back to `JOB_RESERVE_DEFAULT_MB` (not the cap, since 2026-09-14).
	 *
	 * SECOND ANSWER SINCE WAVE 3g (J2). The memory axis is the REPO, not the
	 * node, so admission first reads the queued run's repo figure —
	 * `fleet-runner-coverage.json`'s `facets[repo].jobP95Mb`, DERIVED by
	 * `reconcile --write-coverage` from job-metrics — and reaches this hand-set
	 * value only for a repo the roster has no figure for. See `jobReserve` in
	 * `runners/ephemeral-tick.ts`.
	 */
	jobP95Mb?: number;
	/**
	 * Repos that keep a STANDING runner here even when the node mints.
	 * Justified by availability, never by speed — see runners/residency.ts. An
	 * empty list is a real answer, and is claw-3's: a standing registration is
	 * assignable without asking the dispatcher, which is exactly what its
	 * thermal demotion exists to prevent.
	 */
	/**
	 * Repos this ephemeral node keeps a STANDING runner for. Declared in the
	 * manifest and read by scripts/admin/reconcile-fleet-runners.mjs, which
	 * parses the file itself — nothing in mgmt-api reads it, so this member
	 * exists to describe the file, not to be consumed here.
	 */
	residentRepos?: string[];
	/**
	 * The last `fleet bootcamp --write` finding for this node — same shape
	 * `docs/planning/supply-ledger-2026-09-07.md` documents for `$benchmark`,
	 * `$measured`: `{at, by, ...}` written straight onto this machine's entry.
	 *
	 * The REGISTRY'S shape, not a local subset. It used to declare only the two
	 * fields the old `nodeFailsBootcamp` read; since the ladder adopted
	 * `provesRequiredSet` the answer is computed from `earned` and `prereqs` as
	 * well, and a narrower copy here would mean a fixture that satisfies this
	 * module's types while proving nothing to the registry's.
	 */
	$capabilities?: BootcampFacet;
	/** `"claw"` | `"guest"`. Read through `isGuestNode`, never directly. */
	role?: string;
	/** `"on-demand"` on a guest. Read through `mintsOnDemand`, never directly. */
	mint?: string;
	/** An on-demand guest's standing exceptions. Read through `standingRepos`. */
	standingRepos?: string[];
}
interface FleetManifest {
	/** The manifest KEY. Operator config, not an identifier. */
	machines?: Record<string, ManifestNode>;
	repos?: Record<string, { needs?: string[]; skip?: boolean; ignore?: boolean }>;
}

function readFleetManifest(): FleetManifest | null {
	try {
		return JSON.parse(readFileSync(FLEET_MANIFEST(), 'utf8')) as FleetManifest;
	} catch (err) {
		logger.warn(
			`[fleet-loop] cannot read ${FLEET_MANIFEST()} ` +
				`(${err instanceof Error ? err.message : String(err)})`
		);
		return null;
	}
}

/**
 * The nodes that are CLAWS — i.e. general CI capacity, not the production
 * host. Derived from the manifest by absence of `pm2-host`, so adding a node
 * needs no second list to update.
 *
 * Exported for runner-health, which must decide "is a claw alive" from node
 * IDENTITY rather than from label presence. Labels are ELIGIBILITY, which the
 * fast loop rewrites as nodes become safe or unsafe; conflating the two makes a
 * healthy unlabelled node read as absent. See P2.
 */
/**
 * Nodes that mint on demand rather than standing runners.
 *
 * Read from the manifest each call rather than cached, so turning a node
 * ephemeral takes effect on the next tick instead of needing a restart — the
 * restart being the thing (~5 a day) this workstream is trying to stop
 * depending on.
 */
export function loadEphemeralNodes(): Set<string> {
	const raw = readFleetManifest();
	const out = new Set<string>();
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (m.ephemeral === true) out.add(name);
	}
	return out;
}

/**
 * Repos an ephemeral node keeps a STANDING registration for — the same
 * manifest field `reconcile-fleet-runners.mjs` reads to create the pair.
 *
 * Read fresh each call, same as `loadEphemeralNodes`: emptying an entry (or
 * moving it to a different node) takes effect on the next tick. An unreadable
 * manifest returns no residents rather than throwing, matching every other
 * loader in this file — `setTierEligibility` already fails toward promotion,
 * and a resident set that silently vanished for a tick costs one missed label
 * write, not a wrong one.
 */
export function loadResidentRepos(node: string): string[] {
	const raw = readFleetManifest();
	return raw?.machines?.[node]?.residentRepos ?? [];
}

/**
 * The demand-derived REQUIRED SET, or `null` when it could not be read.
 *
 * `requiredIdentitySet` over the `class: "ci"` rows of
 * `~/.hadoku-mgmt/demand-ledger.jsonl` — the same derivation `check-label-floor`
 * uses, through the same registry function, so the gate that REPORTS the
 * contract and the ladder that ENFORCES it cannot drift.
 *
 * `null` means "I could not look", and it is DISTINCT from an empty set: a
 * missing file, an unreadable one and a malformed line are all `null`, while a
 * file that parsed and asked for nothing is `new Set()`. Both refuse to move a
 * label ({@link nodeFailsBootcamp}), but only one of them is a bug in the
 * writer, and the log line says which.
 *
 * A MALFORMED LINE IS `null`, NOT A SHORTER SET. Skipping the bad row would
 * silently under-count demand, which lowers the bar every node has to clear —
 * exactly the shape `parseDemandLedger` refuses on the gate side.
 */
function loadRequiredSet(): Set<string> | null {
	const path = resolve(stateDir(), 'demand-ledger.jsonl');
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		logger.warn(
			`[fleet-loop] cannot read the demand ledger at ${path} ` +
				`(${err instanceof Error ? err.message : String(err)}) — no label will move this tick`
		);
		return null;
	}
	const records: DemandRecord[] = [];
	const lines = text.split('\n');
	for (let n = 0; n < lines.length; n++) {
		if (!lines[n].trim()) continue;
		try {
			records.push(JSON.parse(lines[n]) as DemandRecord);
		} catch (err) {
			logger.warn(
				`[fleet-loop] ${path} line ${n + 1} is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}) — the position in that ` +
					'message is relative to the LINE, not the file. No label will move this tick.'
			);
			return null;
		}
	}
	return requiredIdentitySet(records);
}

/**
 * Whether NODE's last `fleet bootcamp` finding disqualifies it from carrying
 * `hadoku-builder` — P1.2/P1.3, `bootcamp-earned-labels-2026-09-02.md` §4.
 * `hadoku-builder` used to be a hand-applied label nothing verified; this is
 * its producer.
 *
 * IT NOW ASKS `provesRequiredSet`, the predicate `check-label-floor` has been
 * REPORTING against since 2026-09-07 while this function fell back on "no
 * blocked, no unprobed" (wave 3a/3b §D1). One rule, one implementation: the gate
 * and the ladder can no longer disagree about what `hadoku-builder` means.
 *
 * THREE STATES REFUSE TO MOVE A LABEL, and each is a different fact:
 *
 *   GUEST            the node is not the ladder's to judge at all. A guest
 *                    lends the fleet a registration and is out of scope for
 *                    bootcamp's required set (operator, 2026-09-14). It never
 *                    reaches a write anyway — `planTierWrites` drops it — and
 *                    this is the second half of the same statement, so a
 *                    resident-registration caller cannot route around it.
 *   UNREADABLE SET   `required === null`. The ledger is missing, unreadable or
 *                    malformed, so the bar is unknown. Demoting here would take
 *                    the ENTIRE FLEET down at once on one bad file, at 3am,
 *                    which is why `provesRequiredSet`'s own header said this
 *                    flip "is only safe once the required set can be read
 *                    reliably". `check-label-floor` is what goes RED on it.
 *   EMPTY SET        `required.size === 0`. The ledger parsed and asked for
 *                    nothing. Every node clears a bar of zero, so enforcing it
 *                    would be a green fleet proving nothing — 3a settled that
 *                    an empty required set is a failure, not a pass. Same
 *                    refusal, different reason, and the reason is logged.
 *
 * FAIL-OPEN ON AN ABSENT RECORD STAYS, and is deliberately NOT delegated to
 * `provesRequiredSet` (which calls a node with no record `ok: false`).
 * `bootcamp.mjs`'s own header: "'I could not probe' is not 'the node cannot do
 * it'". A node `fleet bootcamp --write` has never reached has NO evidence
 * against it, and treating that as disqualifying would demote a freshly enrolled
 * claw before anyone had run bootcamp on it — the "capacity stranded on a fleet
 * that did nothing wrong" outcome this file's header names as the one failure
 * mode worse than a slow runner. `check-label-floor` prints those nodes as
 * `unverifiedNodes`, so the quiet fallback is never also a silent one.
 *
 * A RECORDED finding is a different thing: bootcamp executed the required set
 * and named what did not pass, and that disqualifies exactly as thermal/sick
 * demotion already does — per node, never fleet-wide.
 */
export function nodeFailsBootcamp(
	node: string,
	raw: FleetManifest | null = readFleetManifest(),
	required: ReadonlySet<string> | null = loadRequiredSet()
): boolean {
	const entry = raw?.machines?.[node];
	if (isGuestNode(entry)) return false; // not the ladder's to judge
	const rec = entry?.$capabilities;
	if (!rec) return false; // never probed — not the same as proven bad
	if (!required) return false; // could not read the bar — no label moves
	if (required.size === 0) {
		logger.warn(
			'[fleet-loop] the demand ledger yielded an EMPTY required set — every node clears a ' +
				'bar of zero, so no label moves this tick. Regenerate it with `fleet tool-inventory ' +
				'--write`.'
		);
		return false;
	}
	const verdict = provesRequiredSet(entry, required);
	if (!verdict.ok) {
		logger.warn(
			`[fleet-loop] ${node} does not prove the required set: ${verdict.reason} ` +
				`(missing ${verdict.missing.join(', ') || '(none)'})`
		);
	}
	return !verdict.ok;
}

/** Guest nodes, by name — `machines[<node>].role`, read fresh each tick. */
export function loadGuestNodes(): Set<string> {
	const raw = readFleetManifest();
	const out = new Set<string>();
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (isGuestNode(m)) out.add(name);
	}
	return out;
}

export function loadClawNodes(): Set<string> {
	// An unreadable manifest must not silently declare the fleet clawless — that
	// would read as a total outage. readFleetManifest() returns null there, and
	// the empty set means "unknown", which callers treat as "fall back".
	const raw = readFleetManifest();
	const out = new Set<string>();
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (!(m.labels ?? []).includes(PM2_HOST_LABEL)) out.add(name);
	}
	return out;
}

/**
 * Every node the fleet manifest declares, pm2-host included.
 *
 * `loadClawNodes` deliberately excludes the pm2-host because it answers "is
 * this a claw". Attributing a runner to its node is a different question and
 * needs the whole list, or `hokon-tenhands` folds onto nothing.
 */
export function loadFleetNodeNames(): string[] {
	return Object.keys(readFleetManifest()?.machines ?? {});
}

/**
 * Every machine entry, or `null` when the manifest could not be read.
 *
 * For the label floor's MINTING arm, which must ask `nodeOffer` the same
 * question the dispatcher asks and so needs the whole entry, not a name. `null`
 * is "I could not look" — never an empty fleet, which would read as "no minting
 * node offers anything" and page every label at once.
 */
export function loadFleetManifestMachines(): Record<string, RegistryNode> | null {
	const raw = readFleetManifest();
	return raw ? (raw.machines ?? {}) : null;
}

/**
 * Per-node concurrent-job budget: the node's declared `maxConcurrent`, the one
 * number admission mints against. The probe reports `free` against it.
 */
export function loadNodeCapacity(): Record<string, number> {
	const raw = readFleetManifest();
	const out: Record<string, number> = {};
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (typeof m.maxConcurrent === 'number') out[name] = m.maxConcurrent;
	}
	return out;
}

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
	'w=$(pgrep -c Runner.Worker 2>/dev/null); ' +
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
	'r=$(pgrep -a Runner.Worker 2>/dev/null | while read -r _ c _; do ' +
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
	'printf "%s %s %s g=%s %s" "${w:-0}" "$(nproc)" "$s" "$g" "$r"';

/**
 * Where pnpm-guarded-install.sh records that it found this node's store
 * damaged. The guard is the only thing that knows, and it knows at the moment
 * the evidence exists — see scripts/ci/pnpm-guarded-install.sh.
 *
 * Read here rather than from GitHub because the damage is NODE-scoped (one
 * store, ~28 runner instances), this probe is already ssh-ing every node
 * each tick so it costs nothing, and the guard usually REPAIRS — so the job
 * passes and there is no failed run for anything to inspect. A node that
 * damaged its own store is worth retiring even when the job it damaged went
 * green.
 */
const SICK_MARKER = '$HOME/.hadoku/sick-runner';

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
}

/** Test seam: the probe's wire format is the contract between two nodes. */
export function __parseProbeForTesting(stdout: string): ProbeResult | null {
	return parseProbe(stdout);
}

function parseProbe(stdout: string): ProbeResult | null {
	const fields = String(stdout).trim().split(/\s+/);
	const [w, c, sickField] = fields;
	// The DNS field is tagged and optional: absent, the next field is the repo
	// list exactly as it was before the tag existed.
	const dnsTag = /^g=([01])$/.exec(fields[3] ?? '');
	const repoField = dnsTag ? fields[4] : fields[3];
	const githubDns = dnsTag ? dnsTag[1] === '1' : undefined;
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
		return { workers, cores, sick, githubDns, busyRepos: workers === 0 ? new Map() : null };
	}
	const busyRepos = new Map<string, number>();
	for (const slug of repoField.split(',')) {
		if (!slug) continue; // trailing comma from `tr`
		busyRepos.set(slug, (busyRepos.get(slug) ?? 0) + 1);
	}
	return { workers, cores, sick, githubDns, busyRepos };
}

/**
 * Probe THIS node without ssh.
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
function probeLocal(): Promise<ProbeResult | null> {
	return new Promise((res) => {
		execFile('bash', ['-c', PROBE_CMD], { timeout: SSH_TIMEOUT_MS }, (err, stdout) => {
			res(err ? null : parseProbe(stdout));
		});
	});
}

export async function probeNode(node: string): Promise<ProbeResult | null> {
	if (isLocalNode(node)) return probeLocal();
	return new Promise((res) => {
		execFile(
			'ssh',
			['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node, PROBE_CMD],
			{ timeout: SSH_TIMEOUT_MS },
			(err, stdout) => {
				res(err ? null : parseProbe(stdout));
			}
		);
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
		});
	}
	return out;
}

/**
 * Last probe from the fast loop, for readers that must not ssh themselves.
 * In-memory and null until the first tick, exactly like the runner-health
 * snapshot — a restart clears it rather than serving a stale fleet.
 */
let lastFleetProbe: { at: string; nodes: Record<string, NodeProbe> } | null = null;

/**
 * The last dispatch input a fast-loop tick built, so the dispatcher can run WITHOUT one.
 *
 * The dispatcher used to be called at the end of `tickFleet`, which tied its
 * cadence to the ladder's. Two loops doing unrelated work at unrelated natural
 * frequencies: the ladder writes labels and re-probes on a 60s rhythm, while
 * discovery latency IS queue latency and wants to be as fast as the API allows.
 *
 * Measured 2026-09-05, JIT jobs against standing ones on the same fleet:
 *   JIT      queue p50 45s   (mint itself: 3s)
 *   standing queue p50  2s
 * The whole difference is waiting for the next tick to look.
 *
 * That coupling also made a LABEL bug read as a queue bug: when carousel and the
 * backstop fought over hokon, the fast-loop tick stretched to a 119s median and
 * dispatch — riding on it — inherited every second.
 *
 * Conditional polling removed the reason to be slow: unchanged listings now cost
 * nothing, so the fleet spends ~480 calls/hr against 5,000 where it once
 * exhausted the budget. What is left is a timer.
 */
let lastDispatchInput: Parameters<typeof dispatchEphemeral>[0] | null = null;
/** One dispatch pass at a time. Two overlapping passes could both mint for the
 *  same run: `dispatch-pass` reconstructs in-flight work from LIVE units, and a
 *  pass that has not spawned yet is invisible to the one beside it. */
let dispatchInFlight = false;

/**
 * What the JIT dispatcher did last. Same lifetime rules as `lastFleetProbe`:
 * in-memory, cleared by a restart rather than serving a stale answer.
 *
 * `failingSince` is the only field that needs history, and it needs it because
 * the question worth alerting on is not "did a mint fail" — mints fail for
 * ordinary reasons — but "has this node stopped being able to mint at all".
 */
let lastDispatch: FleetDispatch = {
	at: null,
	minted: null,
	failed: null,
	skipped: null,
	inFlight: null,
	reaped: null,
	error: null,
	failingSince: null,
	totals: { minted: 0, failed: 0 },
};

/** What the last dispatch pass did, for the Fleet panel. */
export function getDispatchSnapshot(): FleetDispatch {
	return lastDispatch;
}

/**
 * Fold one pass into the snapshot.
 *
 * Exported for tests: the fast loop reaches this only through a real dispatch,
 * and the state that matters (a failing streak across passes) takes several
 * ticks to express.
 */
export function recordDispatch(
	res: {
		minted: number;
		failed: number;
		skipped: number;
		inFlight: number;
		reaped: number | null;
	} | null,
	error: string | null,
	nowIso: string = new Date().toISOString()
): void {
	const prev = lastDispatch;
	// A pass that threw minted nothing we can vouch for, so it counts as failing
	// — but its COUNTS stay null, because we did not observe them.
	const attemptedAndAllFailed = res ? res.failed > 0 && res.minted === 0 : true;
	lastDispatch = {
		at: nowIso,
		minted: res?.minted ?? null,
		failed: res?.failed ?? null,
		skipped: res?.skipped ?? null,
		inFlight: res?.inFlight ?? null,
		reaped: res?.reaped ?? null,
		error,
		failingSince: attemptedAndAllFailed ? (prev.failingSince ?? nowIso) : null,
		totals: {
			minted: prev.totals.minted + (res?.minted ?? 0),
			failed: prev.totals.failed + (res?.failed ?? 0),
		},
	};
}

let lastReservation: Reservation = { reserved: false, reason: null, detail: null };

/** What the last tick decided about the priority ladder, for the Fleet panel. */
export function getReservationSnapshot(): Reservation {
	return lastReservation;
}

/**
 * One dispatch pass, between fast-loop ticks, on the ladder's last known facts.
 *
 * Returns a reason rather than throwing or logging on the quiet paths, so the
 * caller can stay silent for the ordinary ones — `no-input` is every tick before
 * the first ladder pass, and `busy` is a pass still running, both normal.
 *
 * The staleness this accepts is bounded and deliberate. `fleetProbe` is up to one
 * fast-loop tick old, so `freeMb` can lag; what actually bounds concurrency is
 * `liveUnits`, and `dispatch-pass` re-reads that from the NODES on every pass.
 * So a second pass sees the first pass's units and stops at the same cap the
 * single-pass design stopped at — the count bound is unchanged, only the memory
 * reading is older. A pass that could not probe returns null and mints nothing.
 */
export async function dispatchBetweenTicks(
	token: string,
	gh: Parameters<typeof dispatchEphemeral>[2],
	dispatch: typeof dispatchEphemeral = dispatchEphemeral
): Promise<'ok' | 'no-input' | 'busy'> {
	if (!lastDispatchInput) return 'no-input';
	if (dispatchInFlight) return 'busy';
	dispatchInFlight = true;
	try {
		// `res` is the pass result, `null` its "could not look" answer — see
		// dispatchEphemeral. Passing `res ?? null` with a null error was the bug:
		// the function returned `void`, so EVERY pass recorded a resultless one,
		// `recordDispatch` scored that as attempted-and-all-failed, and the panel
		// pinned `failingSince` to the first pass after each restart forever.
		const input = lastDispatchInput;
		const res = await withGhCaller('dispatch-poll', () => dispatch(input, token, gh));
		recordDispatch(res, res ? null : 'no ephemeral node could be probed — see the warnings above');
		return 'ok';
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Recorded BEFORE the log line, because the log line is what this whole
		// field exists to stop being the only record. A dispatcher that throws
		// must never take label toggling down with it.
		recordDispatch(null, msg);
		logger.warn(`[fleet-loop] ephemeral dispatch failed (label toggling unaffected): ${msg}`);
		return 'ok';
	} finally {
		dispatchInFlight = false;
	}
}

/** Test seam. Not part of the supported API. */
export function __setDispatchInputForTesting(
	input: Parameters<typeof dispatchEphemeral>[0] | null
): void {
	lastDispatchInput = input;
}

/** Test seam. Not part of the supported API. */
export function __resetDispatchInputForTesting(): void {
	lastDispatchInput = null;
	dispatchInFlight = false;
}

export function getFleetProbeSnapshot(): {
	at: string;
	nodes: Record<string, NodeProbe>;
} | null {
	return lastFleetProbe;
}

/**
 * Test seam. Not part of the supported API.
 *
 * The label floor now asks the census whether any ephemeral node can MINT before
 * it pages, and that answer comes from this probe. Without a seam the only way to
 * reach the suppressing branch from a test is to run a whole fast-loop tick, so the
 * branch that decides whether the fleet pages would go untested — which is the
 * one direction that must not regress silently.
 */
export function __setFleetProbeForTesting(
	probe: { at: string; nodes: Record<string, NodeProbe> } | null
): void {
	lastFleetProbe = probe;
}

/**
 * Every runner registration for a node across the fleet, with its current labels.
 *
 * `repos` defaults to every covered repo; a resident ephemeral node passes its
 * OWN (small) resident set instead, so processing it costs one API call per
 * resident repo rather than the full fleet walk — see the ephemeral branch in
 * `setTierEligibility`.
 */
async function registrationsFor(
	node: string,
	token: string,
	ghGet: (path: string, token: string, repo?: string) => Promise<unknown>,
	repos: readonly string[] = coveredRepos()
): Promise<{ repo: string; id: number; hasBuilder: boolean }[]> {
	const out: { repo: string; id: number; hasBuilder: boolean }[] = [];
	for (const repo of repos) {
		const resp = (await ghGet('/actions/runners?per_page=100', token, repo)) as {
			runners?: { id: number; name: string; labels?: { name: string }[] }[];
		} | null;
		if (!resp?.runners) continue;
		for (const r of resp.runners) {
			// A node owns the runner named for it plus any `<node>-*` instance.
			// The -b/-c/-d pools were retired on 2026-08-24 (one runner per node
			// now), but the prefix match stays: it costs nothing and is what makes
			// re-introducing an instance a config change rather than a code change.
			if (r.name !== node && !r.name.startsWith(`${node}-`)) continue;
			out.push({
				repo,
				id: r.id,
				hasBuilder: (r.labels ?? []).some((l) => l.name === BUILDER_LABEL),
			});
		}
	}
	return out;
}

export interface LabelAction {
	node: string;
	direction: 'promote' | 'demote';
	changed: number;
	failed: number;
}

/**
 * How often to re-assert every node's labels against GitHub even when nothing
 * this loop can see has changed. At 60s polling this is roughly every 10
 * minutes — frequent enough that external drift is a blip, cheap enough that
 * the common case (already in the desired state) writes nothing at all.
 */
export const RECONCILE_EVERY_TICKS = 10;

/** Ticks since process start. Drives the periodic full reconcile above. */
let tickCount = 0;

/**
 * Nodes the guard has reported as having damaged their own pnpm store.
 *
 * SICKNESS OVERRIDES EVERY OTHER ELIGIBILITY INPUT, `alwaysOn` INCLUDED. The
 * fast loop recomputes eligibility from free capacity on every tick, so simply
 * stripping the label elsewhere would be undone within one tick — tier1 is
 * `alwaysOn` and would be re-promoted immediately. Quarantine therefore has to
 * be an INPUT to this decision rather than a competing write to the same label,
 * which is also why it lives in this module: eligibility has one owner.
 *
 * Deliberately NO capacity floor. If every claw damages its store, every claw is
 * retired and `CI_RUNNER` flips the fleet to GitHub-hosted — which is the
 * existing, tested answer to "no self-hosted capacity". Keeping a known-bad
 * node eligible to preserve a number would hand jobs to the one box we have
 * positive evidence against.
 */
const sickNodes = new Map<string, { repairAttempts: number }>();

/**
 * Clear quarantine state. Test-only seam.
 *
 * `sickNodes` is module-level and therefore LEAKS between tests: a test that
 * marks claw-1 sick makes every later test in the file see it as sick, and
 * `setTierEligibility` then silently declines to promote it. That cost a real
 * debugging round — a correct regression guard failed because a test three
 * hundred lines earlier had poisoned the node it used. runner-health.ts
 * already documents this exact hazard for its own cross-tick maps; this module
 * had the same one with no way to reset it.
 */
export function __resetSickForTesting(): void {
	sickNodes.clear();
}

export function markNodeSick(node: string): void {
	if (!sickNodes.has(node)) {
		sickNodes.set(node, { repairAttempts: 0 });
		logger.warn(`[fleet-loop] QUARANTINE ${node} — its pnpm store was damaged; demoting it`);
	}
}

export function nodeIsSick(node: string): boolean {
	return sickNodes.has(node);
}

export function sickNodeNames(): string[] {
	return [...sickNodes.keys()].sort();
}

/**
 * Repair a quarantined node and release it.
 *
 * Without this the quarantine is a capacity TRAP: a demoted node receives no
 * jobs, so the guard never runs there, so the store is never repaired and the
 * box never returns. Repair therefore cannot wait for CI to do it.
 *
 * Runs the same doctor CI runs, over the ssh transport this module already uses
 * for probing, against BOTH stores — the default one and the pinned
 * tool_cache one, since different workflows use different stores and only one of
 * them may be damaged. Clears the marker only if the doctor succeeded, so a
 * node that cannot be fixed stays retired rather than flapping.
 */
export async function repairSickNode(
	node: string,
	run: (node: string, args: string[]) => Promise<boolean> = runDoctor
): Promise<boolean> {
	const state = sickNodes.get(node);
	if (!state) return true;
	state.repairAttempts++;

	// BOTH stores. update-packages.yml uses the default one and every gate
	// workflow pins the tool_cache one, so only one of them may be damaged and
	// repairing the wrong one silently achieves nothing.
	let ok = true;
	for (const store of REPAIR_STORES) {
		if (!(await run(node, ['--store', store, '--fix', '--drop-index']))) ok = false;
	}

	if (!ok) {
		logger.warn(
			`[fleet-loop] repair FAILED on ${node} (attempt ${state.repairAttempts}) — it stays retired`
		);
		return false;
	}
	// Clear the marker ONLY after the doctor actually succeeded. Doing it in the
	// same command as the repair is how a release gets decided by whether `rm`
	// worked rather than by whether the store was fixed — a node would return
	// to service still broken. A test caught exactly that.
	if (!(await run(node, ['--clear-marker']))) {
		logger.warn(`[fleet-loop] ${node}: repaired but could not clear its marker — stays retired`);
		return false;
	}
	sickNodes.delete(node);
	logger.info(
		`[fleet-loop] RELEASED ${node} — store repaired after ${state.repairAttempts} attempt(s)`
	);
	return true;
}

const REPAIR_STORES = ['$HOME/.local/share/pnpm/store', '/opt/hostedtoolcache/pnpm-store'];

/** Injected: the store doctor is a CONTRACT WITH CI, not internal detail. */
const DOCTOR_PATH = () => storeDoctorPath();

/**
 * How to run a shell COMMAND on NODE: over ssh, or in a local shell when NODE
 * is the box this process runs on.
 *
 * mgmt-api runs on hokon and `ssh hokon` from hokon is REFUSED. Until
 * 2026-09-21 the repair always took the ssh path, so a quarantined hokon could
 * never be repaired: a marker left by an install killed mid-write on
 * 2026-09-19 kept it retired for two days while both of its stores were clean,
 * failing ~1,400 repairs with no reason logged. The probe (`probeLocal`) and
 * runner-supervision already special-cased the local node; this was the one
 * path that did not.
 *
 * LOCAL GOES THROUGH `bash -c`, not a bare `spawn('bash', args)`. The command
 * carries `$HOME/...` store paths that the REMOTE shell expands on the ssh path;
 * a bare spawn would hand the doctor a literal `$HOME` and fail the same silent
 * way. One command string, expanded by a shell on either side.
 */
export function doctorCommand(node: string, command: string, self?: string): [string, string[]] {
	return isLocalNode(node, self)
		? ['bash', ['-c', command]]
		: ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node, command]];
}

/**
 * Run the doctor on NODE by PIPING THE SCRIPT OVER STDIN.
 *
 * Not by invoking a path on the far side: the claws have no canonical checkout
 * (the repo lives under a per-runner `_work` tree that may not exist), and a
 * missing path made `bash …/doctor.sh` fail while the command as a whole still
 * exited 0 — so a still-sick node was released. Piping it also means the
 * remote runs the SAME doctor CI runs, with no second copy to drift.
 *
 * A failure is LOGGED WITH ITS REASON — exit code and the tail of stderr. The
 * hokon outage above was invisible for two days because this said only
 * "repair FAILED", and the reason ("Connection refused") was discarded.
 */
export function runDoctor(
	node: string,
	args: string[],
	opts: { self?: string; script?: string } = {}
): Promise<boolean> {
	let script = '';
	if (args[0] !== '--clear-marker') {
		try {
			script = opts.script ?? readFileSync(DOCTOR_PATH(), 'utf8');
		} catch {
			logger.warn(`[fleet-loop] cannot read ${DOCTOR_PATH()} — repair unavailable`);
			return Promise.resolve(false);
		}
	}
	const command =
		args[0] === '--clear-marker' ? `rm -f "${SICK_MARKER}"` : ['bash -s --', ...args].join(' ');
	const [cmd, cmdArgs] = doctorCommand(node, command, opts.self);
	return new Promise((res) => {
		const child = spawn(cmd, cmdArgs, {
			timeout: REPAIR_TIMEOUT_MS,
			stdio: ['pipe', 'ignore', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-400);
		});
		child.on('error', (err) => {
			logger.warn(`[fleet-loop] ${node}: repair could not start (${cmd}): ${err.message}`);
			res(false);
		});
		child.on('close', (code) => {
			if (code !== 0) {
				logger.warn(
					`[fleet-loop] ${node}: \`${args.join(' ')}\` exited ${code} via ${cmd}` +
						(stderr.trim() ? ` — ${stderr.trim().split('\n').pop()}` : '')
				);
			}
			res(code === 0);
		});
		/*
		 * The child's 'error' handler above does NOT cover this stream.
		 *
		 * EPIPE from writing the repair script arrives on the stdin socket, not
		 * on the ChildProcess, so it is a separate unhandled 'error' event —
		 * and this function runs IN-PROCESS inside mgmt-api, where an uncaught
		 * exception is not a failed repair but a dead API. The window is real:
		 * ssh exits the instant it cannot open the connection, which is exactly
		 * the case this repair path exists to handle.
		 */
		child.stdin.on('error', (err) => {
			logger.warn(`[fleet-loop] ${node}: repair script not delivered: ${err.message}`);
		});
		child.stdin.end(script);
	});
}

const REPAIR_TIMEOUT_MS = 120_000;

/**
 * Converge one node's STANDING registrations onto `hadoku-builder` = safe.
 *
 * SAFE means: not quarantined, not drained, and not disqualified by its last
 * bootcamp finding (`nodeFailsBootcamp`). That is the whole rule. There is no
 * "is more throughput needed" input any more — the tier ladder that supplied it
 * was retired on 2026-09-21, having decided nothing under `carousel`.
 *
 * WHICH REGISTRATIONS. An ephemeral node serves its jobs through JIT mints and
 * carries no standing registrations, EXCEPT its `residentRepos` — standing
 * registrations the reconciler creates outside the mint path, born unlabelled
 * and waiting for this. Only that set is walked for an ephemeral node, which
 * keeps the O(repos x nodes) label traffic off the fleet. A non-ephemeral node
 * is walked across every covered repo.
 *
 * NOT GUESTS. A guest (hokon) lends the fleet a reserve registration, and its
 * builder label is the BACKSTOP's in runner-health, which applies the same
 * safety rule. One writer per label; the caller skips guests.
 */
export async function setNodeEligibility(
	node: string,
	token: string,
	gh: {
		get: (path: string, token: string, repo?: string) => Promise<unknown>;
		write: (
			method: 'POST' | 'DELETE',
			path: string,
			token: string,
			body?: unknown,
			repo?: string
		) => Promise<{ ok: boolean; status: number }>;
	},
	/** Whether the node should carry the label — see `nodeIsSafe`. */
	want: boolean,
	/** Resident repos for an ephemeral node; `undefined` means every covered repo. */
	repos?: readonly string[]
): Promise<LabelAction> {
	let changed = 0;
	let failed = 0;
	for (const reg of await registrationsFor(node, token, gh.get, repos)) {
		if (reg.hasBuilder === want) continue; // already in the desired state
		const res = want
			? await gh.write(
					'POST',
					`/actions/runners/${reg.id}/labels`,
					token,
					{ labels: [BUILDER_LABEL] },
					reg.repo
				)
			: await gh.write(
					'DELETE',
					`/actions/runners/${reg.id}/labels/${BUILDER_LABEL}`,
					token,
					undefined,
					reg.repo
				);
		if (res.ok) changed++;
		else if (!want && res.status === 404) {
			// Already gone: converged by someone else's hand. Not a failure.
		} else {
			failed++;
			logger.warn(
				`[fleet-loop] ${want ? 'promote' : 'demote'} ${node}@${reg.repo} → HTTP ${res.status}`
			);
		}
	}
	return { node, direction: want ? 'promote' : 'demote', changed, failed };
}

/**
 * The one safety predicate for a node carrying `hadoku-builder`: not
 * quarantined, not drained, not disqualified by bootcamp.
 */
export function nodeIsSafe(
	node: string,
	drainedNodes: ReadonlySet<string>,
	fleetManifest: FleetManifest | null,
	requiredSet: ReadonlySet<string> | null
): boolean {
	return (
		!nodeIsSick(node) &&
		!drainedNodes.has(node) &&
		!nodeFailsBootcamp(node, fleetManifest, requiredSet)
	);
}

/**
 * The label state this loop last converged each node to. Empty after a
 * restart, so the first tick is a full reconcile — which is what makes a
 * restart a valid way to heal drift.
 */
let believedLabel = new Map<string, boolean>();
let started = false;
/**
 * Has a pass run WITH a token since start? Until one has, a missing token is
 * retried every TOKEN_RETRY_MS rather than at the next interval (#133).
 */
let tokenSeen = false;
let tokenWaitHandle: ReturnType<typeof setTimeout> | null = null;
let tokenRetryMs = TOKEN_RETRY_MS;
/** Test seam: shorten the wait between token reads before the first pass. */
export function __setFastLoopTokenRetryForTesting(ms: number | null): void {
	tokenRetryMs = ms ?? TOKEN_RETRY_MS;
}

export function __resetFleetLoopForTesting(): void {
	lastFleetProbe = null;
	lastDispatch = {
		at: null,
		minted: null,
		failed: null,
		skipped: null,
		inFlight: null,
		reaped: null,
		error: null,
		failingSince: null,
		totals: { minted: 0, failed: 0 },
	};
	believedLabel = new Map();
	tickCount = 0;
	started = false;
	tokenSeen = false;
	if (tokenWaitHandle) clearTimeout(tokenWaitHandle);
	tokenWaitHandle = null;
}

export interface FleetTickResult {
	actions: LabelAction[];
}

/**
 * One pass of the fast loop: probe, quarantine and repair, converge standing
 * labels, and hand the dispatcher its input. Returns what it did so the caller
 * can log one line and tests can assert without stubbing timers.
 */
export async function tickFleet(
	token: string,
	gh: {
		get: (path: string, token: string, repo?: string) => Promise<unknown>;
		write: (
			method: 'POST' | 'DELETE',
			path: string,
			token: string,
			body?: unknown,
			repo?: string
		) => Promise<{ ok: boolean; status: number }>;
	},
	/** Injectable so the tick is testable. Without it every test sshes for real. */
	probe: (node: string) => Promise<ProbeResultLike | null> = probeNode,
	/**
	 * Whether hokon is currently serving pm2-host work. Passed in because the
	 * caller already holds the runner listing.
	 */
	pm2HostBusy = getPm2HostBusy(),
	/**
	 * Injectable: without it this reads the real wall clock and the real cron
	 * profiles, so a test would assert what time CI happened to run.
	 */
	reserve: (busy: boolean) => Reservation = (busy) => nodeReservation(new Date(), busy),
	/**
	 * Injectable: without it a test that puts a node in the sick set SSHes the
	 * real fleet and runs a real repair against production stores — which is
	 * exactly what happened the first time these tests ran.
	 */
	repair: (node: string) => Promise<boolean> = repairSickNode,
	/**
	 * Injectable: `dispatchEphemeral` shells out to every ephemeral node, so a
	 * unit suite without this needs the fleet powered on.
	 */
	dispatch: typeof dispatchEphemeral = dispatchEphemeral,
	/** Which nodes mint instead of carrying labels. Read ONCE per tick. */
	ephemeralOverride?: ReadonlySet<string>,
	/** Which nodes are GUESTS. Injected for the same reason. */
	guestOverride?: ReadonlySet<string>
): Promise<FleetTickResult> {
	// Counted BEFORE anything can fail, so a reconcile cannot be starved by
	// ticks that bail. tickCount starts at 0: the first tick is a full reconcile.
	const thisTick = tickCount++;

	const fleetManifest = readFleetManifest();
	const allNodes = Object.keys(fleetManifest?.machines ?? {});
	const fleetProbe = await probeFleet(allNodes, loadNodeCapacity(), probe);
	lastFleetProbe = { at: new Date().toISOString(), nodes: Object.fromEntries(fleetProbe) };

	// SICK-NODE RETIREMENT, before anything else reads eligibility. The probe
	// carries the guard's own verdict. Quarantine first so nothing below can
	// promote the node, then repair — a retired node gets no jobs, so nothing
	// else ever would.
	for (const [node, p] of fleetProbe) {
		if (p.sick) markNodeSick(node);
	}
	for (const node of sickNodeNames()) {
		// Only repair a node we can see; an unreachable one keeps its quarantine.
		if (fleetProbe.get(node)?.reachable) await repair(node);
	}

	// Recorded for the Fleet panel. hokon is a guest, so the reservation acts
	// through the BACKSTOP (runner-health), not through a write here.
	lastReservation = reserve(pm2HostBusy);

	const ephemeralNodes = ephemeralOverride ?? loadEphemeralNodes();
	const guestNodes = guestOverride ?? loadGuestNodes();
	// Read ONCE per tick, so every node is judged against the same bar.
	const drainedNodes = new Set(Object.keys(readDrain()));
	const requiredSet = loadRequiredSet();
	const dueReconcile = thisTick % RECONCILE_EVERY_TICKS === 0;

	const actions: LabelAction[] = [];
	for (const node of allNodes) {
		if (guestNodes.has(node)) continue; // the backstop's label, not ours
		const resident = ephemeralNodes.has(node) ? loadResidentRepos(node) : undefined;
		if (resident !== undefined && resident.length === 0) continue; // nothing standing
		const want = nodeIsSafe(node, drainedNodes, fleetManifest, requiredSet);
		if (!dueReconcile && believedLabel.get(node) === want) continue;
		const act = await setNodeEligibility(node, token, gh, want, resident);
		// Believed only once nothing failed, so a partial write is retried next tick.
		if (!act.failed) believedLabel.set(node, want);
		if (act.changed || act.failed) actions.push(act);
	}

	// CACHED for the dispatcher, which runs on its own faster timer — see
	// `dispatchBetweenTicks`. Recomputing these there would mean a second place
	// deciding them, and re-probing would put an ssh sweep on a 15s timer.
	lastDispatchInput = {
		fleetProbe,
		ephemeral: ephemeralNodes,
		nodes: fleetManifest?.machines ?? {},
		isSick: nodeIsSick,
		repos: coveredRepos(),
		// Standing runners that can take a queued job RIGHT NOW: the non-ephemeral
		// nodes carrying the label. A guest carries it only while the backstop
		// has promoted it — its own record of that, not a belief about it. EMPTY
		// (the normal all-JIT case) removes the dispatcher's age gate. An
		// ON-DEMAND guest stands nothing up (#120): promoting it makes it a mint
		// target, which is exactly the case the age gate is removed for.
		standingEligible: new Set(
			allNodes.filter(
				(n) =>
					!ephemeralNodes.has(n) &&
					!mintsOnDemand(fleetManifest?.machines?.[n]) &&
					nodeIsSafe(n, drainedNodes, fleetManifest, requiredSet) &&
					(guestNodes.has(n) ? isBackstopHeld(n) : true)
			)
		),
	};
	await dispatchBetweenTicks(token, gh, dispatch);

	return { actions };
}

/** Seconds between fast-loop passes: probe, repair, labels. */
export const FAST_LOOP_SECONDS = 60;
/**
 * Seconds between dispatcher passes. Faster than the loop because discovery
 * latency IS queue latency under all-JIT: nothing starts until a poll finds it
 * (measured 2026-09-05: JIT queue p50 45s against standing 2s, with the mint
 * itself taking 3s — the gap was waiting for the next tick to look).
 * Conditional polling made an unchanged listing free, so ~480 calls/hr fits
 * the 5,000 budget.
 */
export const DISPATCH_SECONDS = 15;

/**
 * Start the fast loop and the dispatcher. Separate from runner-health's
 * 10-minute tick: this one keeps queues short, so it reacts in seconds.
 */
export function startFastLoop(
	getToken: () => string | undefined,
	gh: Parameters<typeof tickFleet>[1],
	/** Test seam: the pass itself, so a test can start the loop without ssh. */
	tick: typeof tickFleet = tickFleet
): void {
	if (started) return;
	started = true;
	logger.info(
		`[fleet-loop] fast loop every ${FAST_LOOP_SECONDS}s, dispatcher every ${DISPATCH_SECONDS}s`
	);
	// Tick IMMEDIATELY, then on the interval: a restart must not leave the Fleet
	// panel showing every node "unprobed" for the first minute.
	const startedAtMs = Date.now();
	let waitLogged = false;
	//
	// A boot with the vault still sealed has no token yet (#133). That pass
	// used to return silently and the probe waited a whole interval, so an
	// unseal 5s after boot still left the panel `machines probing…` for a
	// minute. Until the first pass with a token, look again every
	// TOKEN_RETRY_MS, and say once that the loop is waiting.
	const run = () => {
		const token = getToken();
		if (!token) {
			if (!tokenSeen && !tokenWaitHandle) {
				if (!waitLogged) {
					logger.warn(
						`[fleet-loop] no GitHub token from host yet (vault sealed?) — first probe waits for it, ` +
							`retrying every ${tokenRetryMs / 1000}s`
					);
					waitLogged = true;
				}
				tokenWaitHandle = setTimeout(() => {
					tokenWaitHandle = null;
					run();
				}, tokenRetryMs);
				tokenWaitHandle.unref?.();
			}
			return;
		}
		if (!tokenSeen && waitLogged) {
			logger.info(
				`[fleet-loop] GitHub token arrived after ${Math.round((Date.now() - startedAtMs) / 1000)}s — probing now`
			);
		}
		tokenSeen = true;
		if (tokenWaitHandle) clearTimeout(tokenWaitHandle);
		tokenWaitHandle = null;
		withGhCaller('fleet-loop', () => tick(token, gh))
			.then((r) => {
				for (const a of r.actions) {
					logger.info(
						`[fleet-loop] ${a.direction} ${a.node}: ${a.changed} label(s) changed, ${a.failed} failed`
					);
				}
			})
			.catch((err) => {
				// Fail-open: a broken tick must never strand capacity.
				logger.warn(
					`[fleet-loop] tick threw: ${err instanceof Error ? err.message : String(err)} — leaving labels as-is`
				);
			});
	};
	run();
	setInterval(run, FAST_LOOP_SECONDS * 1000).unref?.();

	const dispatchRun = () => {
		const token = getToken();
		if (!token) return;
		void dispatchBetweenTicks(token, gh).catch((err: unknown) => {
			// Belt and braces: a timer that can throw would stop dispatching forever.
			logger.warn(
				`[fleet-loop] dispatch timer threw: ${err instanceof Error ? err.message : String(err)}`
			);
		});
	};
	setInterval(dispatchRun, DISPATCH_SECONDS * 1000).unref?.();
}
