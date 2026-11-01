/**
 * The I/O half of minting: talk to GitHub, talk to systemd, and refuse to do
 * either when the decision layer says no.
 *
 * Every rule lives in ephemeral.ts / placement.ts / dispatcher.ts as a pure
 * function; this file only carries them out. `gh` and `sh` are injected the same
 * way `setTierEligibility` takes `gh`, so the ORDER of operations — which is
 * where the leaks and the clobbers live — is testable without a node.
 *
 * WAVE 5O LANE D SPLIT (pure move): the JIT mint (generate-jitconfig, the
 * slot/tarball machinery, `liveJitSlots`/`liveJitUnits`) moved to
 * `ephemeral-exec-jit.ts`, and the reap sweep to `ephemeral-exec-reap.ts`.
 * `GhLike`/`ShellLike` stay here — every external importer already reaches
 * them at this path — and this file re-exports `__resetTarballCacheForTesting`
 * so `src/tests/warm-cache.test.ts` (out of scope for this split) keeps
 * resolving it from here unchanged. What stays is the WARM (standing)
 * listener: its own mint/evict/withhold/read path never shared a GitHub call
 * shape with the JIT side, only a few small helpers it now imports back.
 */
import { ephemeralOnlyLabels } from '../lib/capability-labels.js';
import { logger } from '../host.js';
import { warmRunnerName } from './ephemeral.js';
import { warmSlotDir } from './ephemeral.js';
import { buildWarmSpawnPlan } from './ephemeral-mint.js';
import { nodeScriptCommand } from './node-script.js';
import { mintLabels } from './ephemeral-exec-jit.js';
import { describeGhError } from './ephemeral-exec-jit.js';
import { deleteRunnerByName } from './ephemeral-exec-jit.js';
import { shellQuote } from './ephemeral-exec-jit.js';
import { shellSingleQuote } from './ephemeral-exec-jit.js';

export { __resetTarballCacheForTesting } from './ephemeral-exec-jit.js';
// The one door the prove-job family (lifecycle) and reconcile-runner-identity
// use into ci-scheduling: each importer keeps a single declared layer-debt edge
// to this module however the scheduling side is split (wave 5o).
export {
	liveJitSlots,
	liveJitUnits,
	mintEphemeralRunner,
	runnerTarballUrl,
} from './ephemeral-exec-jit.js';
export { JIT_REAP_GRACE_MS, REAP_INTERVAL_MS } from './ephemeral-exec-reap.js';
export {
	JIT_PREFIX,
	JIT_UNIT_MAX_SEC,
	admitMint,
	backstopUnitMemoryMaxMb,
	jitRunnerName,
	slotDir,
	unitMemoryMaxMb,
} from './ephemeral.js';

export interface GhLike {
	write: (
		method: 'POST' | 'DELETE',
		path: string,
		token: string,
		body?: unknown,
		repo?: string
	) => Promise<{ ok: boolean; status: number; body?: unknown }>;
}

/** Run a command on a node. Returns stdout, or null if it failed. */
export type ShellLike = (node: string, command: string) => Promise<string | null>;

export interface MintOutcome {
	ok: boolean;
	unit?: string;
	reason?: string;
}

/**
 * Labels for a WARM listener — a mint's labels, minus the ephemeral-only ones.
 *
 * A warm listener is STANDING: it exists before the job does. So it must not
 * carry a label that means "only a fresh mint can serve this". `jit-canary` is
 * exactly that, and this used `mintLabels()`, so a warm listener on claw-3
 * carried it and answered the canary — five consecutive `site:jit-canary`
 * failures on 2026-09-08/09, every one served by `warm-claw-3-hadoku_site`,
 * failing the step named "prove this ran on a minted runner".
 *
 * The canary caught it, which is the design working: it asserts a `jit-` name
 * prefix precisely so that a standing answer reads as RED rather than as a
 * quiet pass. But the warm cache should never have been able to answer it, and
 * the registry already knew which labels are mint-only.
 */
export function warmLabels(declared: readonly string[]): string[] {
	const forbidden = new Set(ephemeralOnlyLabels());
	return mintLabels(declared).filter((l) => !forbidden.has(l));
}

// --- warm cache of one (P4.1) -------------------------------------------

export interface WarmMintRequest {
	node: string;
	repo: string;
	runnerName: string;
	labels: string[];
	homeDir: string;
	memoryMaxMb: number;
	tarballUrl?: string | null;
}

/**
 * Register and start one warm (standing) listener.
 *
 * ORDER MIRRORS `mintEphemeralRunner`'s reasoning but the registration step is
 * a genuinely different API: `generate-jitconfig` cannot produce a
 * non-ephemeral runner, so a warm listener is registered the classic way — a
 * registration TOKEN, handed to `config.sh` on the node. That token is
 * short-lived (GitHub expires it in about an hour) and scoped only to
 * registering or removing a runner, unlike a jitconfig's `.credentials`,
 * which is why it is passed as a leading shell assignment the same way
 * `RUNNER_TARBALL_URL` already is rather than routed around argv entirely —
 * the blast radius the jitconfig secret-in-argv avoidance exists for does not
 * apply to a token this narrow and this short-lived.
 */
export async function mintWarmListener(
	req: WarmMintRequest,
	token: string,
	gh: GhLike,
	sh: ShellLike
): Promise<MintOutcome> {
	// 1. A registration token. Requested fresh for every mint — it is
	// single-use in practice (config.sh consumes it immediately) and caching it
	// would only risk handing an expired one to a slower node.
	const res = await gh.write(
		'POST',
		'/actions/runners/registration-token',
		token,
		undefined,
		req.repo
	);
	const regToken = (res.body as { token?: string } | undefined)?.token;
	if (!res.ok || !regToken) {
		return {
			ok: false,
			reason: `registration-token returned ${res.status}: ${describeGhError(res)}`,
		};
	}

	// 2. Provision + register on the node. The script travels with this call;
	// see node-script.ts.
	const url = `https://github.com/${req.repo}`;
	const tarball = req.tarballUrl ? ` RUNNER_TARBALL_URL='${shellSingleQuote(req.tarballUrl)}'` : '';
	let cmd: string;
	try {
		cmd = nodeScriptCommand(
			'warm-provision.sh',
			`RESET=1 URL='${shellSingleQuote(url)}' REPO='${shellSingleQuote(req.repo)}' ` +
				`REG_TOKEN='${shellSingleQuote(regToken)}' NAME='${shellSingleQuote(req.runnerName)}' ` +
				`LABELS='${shellSingleQuote(warmLabels(req.labels).join(','))}'${tarball}`
		);
	} catch (err) {
		return { ok: false, reason: `could not read warm-provision.sh: ${(err as Error).message}` };
	}
	const prov = await sh(req.node, cmd);
	if (!prov || !prov.includes('WARM-READY')) {
		return { ok: false, reason: `warm slot: ${prov?.trim() || 'unreachable'}` };
	}

	// 3. Spawn as a LONG-LIVED transient unit — no RuntimeMaxSec, no jitconfig,
	// see buildWarmSpawnPlan for why this cannot reuse buildSpawnPlan.
	const dir = warmSlotDir(req.homeDir);
	const plan = buildWarmSpawnPlan({
		unit: req.runnerName,
		slot: dir,
		memoryMaxMb: req.memoryMaxMb,
	});
	const spawned = await sh(req.node, plan.argv.map(shellQuote).join(' '));
	if (spawned === null) {
		await evictWarmListener(req.node, req.repo, req.runnerName, token, gh, sh);
		return { ok: false, reason: 'spawn failed; registration removed' };
	}
	logger.info(`[warm-cache] minted ${req.runnerName} on ${req.node} for ${req.repo}`);
	return { ok: true, unit: plan.unit };
}

/**
 * Remove a warm listener: delete the registration, THEN stop the unit — and
 * stop nothing if GitHub will not delete it.
 *
 * THE ORDER IS THE SAFETY. Every caller checks the listener is idle first, but
 * GitHub can assign it a job between that check and the stop, and a stop then
 * kills the job before its first step: cardtable CI run 37859515259 (2026-10-08
 * 23:27:15Z), job `check` on warm-claw-9, assigned at :14, failed at :16 with
 * ZERO steps and no log, while the warm tick logged evicting that listener at
 * :15.954. It was the deploy gate, so the head sat undeployed. GitHub refuses
 * to DELETE a runner that is running a job, so deleting first makes the
 * busy-check atomic on GitHub's side: an assignment that won the race turns
 * the delete into a refusal, and the listener is left to finish its job.
 *
 * This was stop-first until then, to shrink the window where a registration
 * with no process behind it looks live. Deleting first closes that window too —
 * the registration is gone before the process is.
 */
/**
 * Stop GitHub ASSIGNING to a warm listener without touching the job it runs.
 *
 * A busy registration cannot be deleted (422 "currently running a job"), and a
 * listener under load is busy almost every time anyone looks: it takes its next
 * job the moment one ends. So on 2026-10-25 drained claw-9's warm listener
 * refused deletion at 05:05 and went on starting hadoku_site jobs until 05:12,
 * 13 of them after the drain landed at 04:57. Removing every custom label
 * (`DELETE .../labels`, which leaves only self-hosted/OS/arch) makes it
 * unmatchable by any fleet job; the running one finishes, and the next pass
 * finds it idle and evicts it as before. Idempotent: a listener with no custom
 * labels left is reported withheld without a write.
 */
export async function withholdWarmListener(
	repo: string,
	name: string,
	token: string,
	gh: GhLike & { get?: (path: string, token: string, repo?: string) => Promise<unknown> }
): Promise<'withheld' | 'not-found' | 'failed'> {
	const list = (await gh.get?.('/actions/runners?per_page=100', token, repo)) as
		| { runners?: { id: number; name: string; labels?: { name: string; type?: string }[] }[] }
		| undefined;
	const hit = list?.runners?.find((r) => r.name === name);
	if (!hit) return 'not-found';
	const custom = (hit.labels ?? []).filter((l) => l.type !== 'read-only');
	if (!custom.length) return 'withheld';
	const res = await gh.write('DELETE', `/actions/runners/${hit.id}/labels`, token, undefined, repo);
	if (!res.ok) {
		logger.warn(`[ephemeral] could not withhold ${name} in ${repo} (remove labels): ${res.status}`);
		return 'failed';
	}
	return 'withheld';
}

export async function evictWarmListener(
	node: string,
	repo: string,
	runnerName: string,
	token: string,
	gh: GhLike & { get?: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: ShellLike
): Promise<boolean> {
	const removed = await deleteRunnerByName(repo, runnerName, token, gh);
	if (!removed) return false;
	await sh(
		node,
		`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${shellQuote(runnerName)} 2>/dev/null || true`
	);
	// Best-effort. A stale marker naming a repo nothing is registered for would
	// make the NEXT tick believe a slot exists when it does not, and lock it
	// against eviction for no reason (planWarmCache reads "no slot" from its
	// absence). Not fatal if this fails — the next successful mint overwrites it.
	await sh(node, 'rm -f "$HOME/.hadoku/warm/repo" 2>/dev/null || true');
	return true;
}

/**
 * The ONE runner listing this tick reads about a node's warm slot, and BOTH
 * facts it needs off it.
 *
 * `isRunnerBusy` answered only the first. The second — is GitHub reporting this
 * registration **online** — is what `NodeState.warmRepo` is required to be
 * sourced from: see its docblock, issue #17, and CLAUDE.md's "the reader for a
 * facet may not read what the writer wrote". The node-side marker file is the
 * warm tick's OWN writer's artefact and said "fine" about claw-3/4/5 while
 * every one of their listeners was dead.
 *
 * Asking for status separately would DOUBLE a listing on a path whose ceiling
 * IS its spend (see `REAP_INTERVAL_MS`'s arithmetic): `ghGet` revalidates with
 * an ETag, so an unchanged listing is free, but a warm slot's listing changes
 * whenever its runner flips busy or online, and that is the case to size for.
 * So: one call, two facts, and the call count is exactly what it was before
 * this function existed.
 *
 * `null` means the listing did not contain the registration — gone, never
 * created, or unreadable because `ghGet` fail-softs to `null`. Those three are
 * NOT distinguished here, deliberately, because both callers want the same
 * answer for all of them: "cannot vouch for it". For the eviction decision that
 * is LOCKED (§12.8's fail-closed direction); for placement it is NO AFFINITY,
 * which `warmRepo: undefined` already documents as the fall-through.
 */
export async function warmRegistration(
	repo: string,
	name: string,
	token: string,
	gh: { get: (path: string, token: string, repo?: string) => Promise<unknown> }
): Promise<{ busy: boolean; online: boolean; labels: string[] } | null> {
	const list = (await gh.get('/actions/runners?per_page=100', token, repo)) as
		| {
				runners?: {
					name: string;
					status?: string;
					busy?: boolean;
					labels?: { name: string }[];
				}[];
		  }
		| undefined;
	const hit = list?.runners?.find((r) => r.name === name);
	if (!hit) return null;
	// `labels` (wave 4e follow-up, #102): THE SAME RESPONSE already carries
	// each registration's current labels — GitHub's shape is `{id, name,
	// type}[]`, same as `runner-health.ts`'s own `runner.labels` reads. Reusing
	// this ONE listing rather than a second call is what keeps the
	// workload-gate rotation fix from costing anything: the rotate decision
	// below reads `hit.labels` off the busy/online check this function
	// already paid for, never a call of its own.
	return {
		busy: Boolean(hit.busy),
		online: hit.status === 'online',
		labels: (hit.labels ?? []).map((l) => l.name),
	};
}

/**
 * The warm marker as it stands on the node: which repo it names, and whether
 * the listener behind that registration is actually running.
 *
 * Same rule as everywhere else in this workstream (§12.8, B9): the marker
 * file this reads is written by `warm-provision.sh` at mint time and is the
 * record, because mgmt-api's own memory is wrong after every one of its ~5
 * daily restarts.
 *
 * `active` IS THREE-VALUED, AND THAT IS THE WHOLE POINT OF THIS FUNCTION
 * EXISTING BESIDE `currentWarmSlot`. `true` is a live listener; `false` is a
 * marker whose unit systemd positively reports as not running; `null` is "I
 * could not look" — the ssh failed, or `is-active` answered nothing at all.
 * `currentWarmSlot` collapses the last two into "no slot", which is correct
 * for the fill/rotate DECISION and fatal for a DELETE decision: the second
 * one may only ever act on a positively-observed death (see
 * `reapDeadWarmListener` in ephemeral-tick.ts, and #61 — the ghost that
 * outlived its install).
 *
 * `markerAtMs` is the marker file's own mtime, touched at mint and again
 * whenever a later tick observes the listener busy (see dispatchWarmCache) —
 * the closest approximation to "minted or refreshed" this file can measure
 * without a webhook, and precise enough given the warm-cache tick's own
 * interval is wider than the assign window it is protecting.
 */
export async function readWarmMarker(
	node: string,
	sh: ShellLike
): Promise<{ repo: string; unit: string; markerAtMs: number; active: boolean | null } | null> {
	const out = await sh(
		node,
		'f="$HOME/.hadoku/warm/repo"; ' +
			'[ -f "$f" ] && printf "%s %s" "$(cat "$f")" "$(stat -c %Y "$f" 2>/dev/null || echo 0)" || true'
	);
	const trimmed = out?.trim();
	if (!trimmed) return null;
	const sp = trimmed.lastIndexOf(' ');
	if (sp < 0) return null;
	const repo = trimmed.slice(0, sp);
	const markerAtMs = Number(trimmed.slice(sp + 1)) * 1000;
	if (!repo || !Number.isFinite(markerAtMs)) return null;
	const unit = warmRunnerName(node, repo);
	const out2 = await sh(
		node,
		`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active ${shellQuote(unit)} 2>/dev/null || true`
	);
	// `|| true` means the node always exits 0, so a `null` here is the ssh
	// failing, not systemd answering. An EMPTY answer is equally unreadable —
	// `is-active` always prints a word when it ran at all. Both are `null`.
	const answer = out2?.trim();
	const active = answer ? answer.startsWith('active') : null;
	return { repo, unit, markerAtMs, active };
}

/**
 * The repo this node is currently warm for, with a listener confirmed live —
 * READ FROM THE NODE, not remembered.
 *
 * A marker with no live unit behind it is STALE — the listener crashed or was
 * killed outside this code path — and must read as NO SLOT, not as a slot for
 * the wrong repo: the alternative would have `planWarmCache` try to rotate a
 * slot that is already gone and delete a registration that no longer exists.
 * The stale marker is not DISCARDED by that collapse, only kept out of the
 * planner's input — `readWarmMarker` is what the tick reads to find it, and
 * what the reap of #61's ghost acts on.
 */
export async function currentWarmSlot(
	node: string,
	sh: ShellLike
): Promise<{ repo: string; unit: string; markerAtMs: number } | null> {
	const m = await readWarmMarker(node, sh);
	if (!m || m.active !== true) return null;
	return { repo: m.repo, unit: m.unit, markerAtMs: m.markerAtMs };
}

/** Touch the warm marker so its mtime reflects "just seen serving a job" —
 * see currentWarmSlot's `markerAtMs` note. Best-effort; a failure here means
 * the next tick's lock window starts from a slightly stale timestamp, never
 * that eviction becomes unsafe (busy is still checked independently). */
export async function refreshWarmMarker(node: string, sh: ShellLike): Promise<void> {
	await sh(node, 'touch "$HOME/.hadoku/warm/repo" 2>/dev/null || true');
}

/**
 * Is this registration busy right now, per GitHub? `null` means the listing
 * did not include it — gone, unreachable, or never registered — and the
 * caller must treat that as "cannot vouch for it", never as "safe", the same
 * fail-closed direction §12.8's reap takes on an unreachable node.
 */
export async function isRunnerBusy(
	repo: string,
	name: string,
	token: string,
	gh: { get: (path: string, token: string, repo?: string) => Promise<unknown> }
): Promise<boolean | null> {
	const list = (await gh.get('/actions/runners?per_page=100', token, repo)) as
		{ runners?: { name: string; busy?: boolean }[] } | undefined;
	const hit = list?.runners?.find((r) => r.name === name);
	if (!hit) return null;
	return Boolean(hit.busy);
}
