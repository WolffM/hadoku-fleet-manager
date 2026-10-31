/**
 * The JIT half of `ephemeral-exec.ts` (wave 5o lane D split, pure move): mint
 * one ephemeral runner, resolve the bootstrap tarball it may need, and read
 * back which `jit-*` units/slots are live on a node. The warm (standing)
 * listener and the reap sweep moved out to `ephemeral-exec.ts` (kept) and
 * `ephemeral-exec-reap.ts` respectively — see those files for why.
 *
 * `gh` and `sh` are still injected the same way the rest of this workstream
 * does it, so the ORDER of operations is testable without a node.
 */
import { IMPLICIT_LABELS } from '../lib/capability-labels.js';
import { logger } from '../host.js';
import { assertSafeJitConfig } from './ephemeral.js';
import { slotDir } from './ephemeral.js';
import { type AdmissionResult } from './ephemeral.js';
import { buildSpawnPlan } from './ephemeral-mint.js';
import { labelsFromUnitDescription } from './ephemeral-mint.js';
import { nodeScriptCommand } from './node-script.js';
import { type GhLike, type ShellLike } from './ephemeral-exec.js';

export interface MintRequest {
	node: string;
	repo: string;
	runnerName: string;
	labels: string[];
	slotIndex: number;
	homeDir: string;
	memoryMaxMb: number;
	ttlSeconds: number;
	/**
	 * The node's declared `slice.name`. Absent means the default slice — see
	 * `resolveSliceName`, which also refuses anything systemd would reject.
	 */
	sliceName?: string | null;
	/**
	 * Where the node may fetch a runner release if it has no standing install
	 * to copy a JIT payload out of. See runnerTarballUrl below and the BOOTSTRAP
	 * DEADLOCK note in scripts/jit-provision.sh.
	 *
	 * Optional: a node that already has a payload never reads it, and a null
	 * here degrades to exactly the old behaviour (SLOT-FAIL with a reason).
	 */
	tarballUrl?: string | null;
}

export interface MintOutcome {
	ok: boolean;
	unit?: string;
	reason?: string;
}

/** Escape for a single-quoted shell word: end the quote, emit \', reopen. */
export function shellSingleQuote(v: string): string {
	return v.replace(/'/g, `'\\''`);
}

/**
 * Where a node with NO standing install can fetch a runner release.
 *
 * This is the caller's half of the bootstrap deadlock fix. The full chain is
 * written out in scripts/jit-provision.sh; the short version is that a JIT
 * payload could only ever be copied out of a standing runner install, and the
 * reconciler never gives an ephemeral node one — so a box declared
 * `ephemeral: true` from the outset could never mint, and said so by reporting
 * green.
 *
 * Resolved HERE rather than on the node because this side holds the GitHub
 * token and the node deliberately does not. `/actions/runners/downloads` is
 * the same artifact GitHub hands a first-time installer, and it is
 * repo-scoped only in its URL — the payload it returns is the generic release.
 *
 * MEMOISED for a day. It changes only when actions/runner cuts a release, and
 * the alternative is one API call per mint on a path that runs dozens of times
 * an hour.
 *
 * FAIL-SOFT, returning null. A node that already has a payload does not need
 * this at all, so an outage here must not stop ordinary minting — it degrades
 * to precisely the pre-2026-08-30 behaviour.
 */
const TARBALL_TTL_MS = 24 * 60 * 60 * 1000;
let tarballCache: { url: string; at: number } | null = null;

export function __resetTarballCacheForTesting(): void {
	tarballCache = null;
}

export async function runnerTarballUrl(
	get: (path: string, token: string, repo?: string) => Promise<unknown>,
	token: string,
	repo: string,
	now: number = Date.now()
): Promise<string | null> {
	if (tarballCache && now - tarballCache.at < TARBALL_TTL_MS) return tarballCache.url;
	try {
		const body = (await get('/actions/runners/downloads', token, repo)) as
			{ os?: string; architecture?: string; download_url?: string }[] | null;
		if (!Array.isArray(body)) return null;
		// linux/x64 — every node in this fleet, asserted rather than assumed.
		// Picking the first entry would silently hand a claw an osx-arm64 tarball,
		// which unpacks fine and then fails at `Runner.Listener --version`.
		const hit = body.find((d) => d?.os === 'linux' && d?.architecture === 'x64');
		if (!hit?.download_url) {
			logger.warn(
				`[dispatch] runner downloads listed ${body.length} artifact(s), none linux/x64 — ` +
					'a node with no standing install cannot bootstrap a JIT payload'
			);
			return null;
		}
		tarballCache = { url: hit.download_url, at: now };
		return hit.download_url;
	} catch (err) {
		logger.warn(
			`[dispatch] could not resolve a runner release URL: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
		return null;
	}
}

/**
 * Mint one ephemeral runner.
 *
 * ORDER IS THE WHOLE POINT, and it is the opposite of the obvious one.
 *
 * The slot is prepared BEFORE the jitconfig is requested. A jitconfig is a live
 * registration the moment GitHub issues it, and §12.8 measured that a JIT
 * registration whose listener never starts does NOT deregister itself — it sits
 * there reporting `online` with nothing behind it, which is worse than a queued
 * job because GitHub will assign work to it and nothing will pick that work up.
 * So every failure that can be discovered without minting must be discovered
 * first. Provisioning is idempotent and cheap; a leaked registration needs the
 * reaper.
 */
export async function mintEphemeralRunner(
	req: MintRequest,
	token: string,
	gh: GhLike,
	sh: ShellLike
): Promise<MintOutcome> {
	// 1. Slot first — see above.
	const slot = slotDir(req.homeDir, req.slotIndex);
	// The URL is a leading assignment like SLOT and RESET, and it is SHELL-QUOTED
	// rather than interpolated bare: it comes from a GitHub API response, and a
	// value with a space or a backtick in it would otherwise be command
	// injection into a root-capable box.
	const tarball = req.tarballUrl ? ` RUNNER_TARBALL_URL='${shellSingleQuote(req.tarballUrl)}'` : '';
	let provision: string;
	try {
		provision = nodeScriptCommand('jit-provision.sh', `SLOT=${req.slotIndex} RESET=1${tarball}`);
	} catch (err) {
		return { ok: false, reason: `could not read jit-provision.sh: ${(err as Error).message}` };
	}
	const prov = await sh(req.node, provision);
	if (!prov || !prov.includes('SLOT-READY')) {
		return { ok: false, reason: `slot ${req.slotIndex}: ${prov?.trim() || 'unreachable'}` };
	}

	// 2. Mint.
	const res = await gh.write(
		'POST',
		'/actions/runners/generate-jitconfig',
		token,
		{ name: req.runnerName, runner_group_id: 1, labels: mintLabels(req.labels) },
		req.repo
	);
	const encoded = (res.body as { encoded_jit_config?: string } | undefined)?.encoded_jit_config;
	if (!res.ok || !encoded) {
		// A 2xx WITH NO USABLE CONFIG still created a registration. Leaving it is
		// §12.8's black hole — a runner GitHub will schedule onto with nothing
		// listening — and it is exactly what happened while ghWrite discarded the
		// response body: two real registrations, both reported as failed mints.
		if (res.ok) await deleteRunnerByName(req.repo, req.runnerName, token, gh);
		return {
			ok: false,
			// The BODY, not just the status. A bare 422 cost a deploy cycle to
			// diagnose when the cause (an empty labels array) was named in it.
			reason: `generate-jitconfig returned ${res.status}: ${describeGhError(res)}`,
		};
	}

	// 3. Refuse an unsafe config BEFORE spawning. A runner that self-updated in
	// place would rewrite the payload hardlinked into every other slot on the
	// node (§12.16), so this is checked rather than assumed — and if it fails
	// the registration is deleted rather than left to leak.
	const safe: AdmissionResult = assertSafeJitConfig(encoded);
	if (!safe.ok) {
		await deleteRunnerByName(req.repo, req.runnerName, token, gh);
		return { ok: false, reason: `unsafe jitconfig: ${safe.reason}` };
	}

	// 4. Spawn as a transient unit. Not a child process: mgmt-api restarts ~5x a
	// day and the job that restarts it runs on the pilot node, so a child
	// would die mid-job (§12.2).
	const plan = buildSpawnPlan({
		unit: req.runnerName,
		slot,
		jitConfig: encoded,
		memoryMaxMb: req.memoryMaxMb,
		sliceName: req.sliceName,
		ttlSeconds: req.ttlSeconds,
		labels: mintLabels(req.labels),
	});
	// Write the config FIRST, at 0600, then start the unit that reads it. Order
	// matters for the same reason the throttle installs its hook before pointing
	// anything at it: a unit whose config file is missing fails at exec with the
	// registration already created.
	//
	// base64 over the wire, so the secret is not re-parsed by the remote shell and
	// cannot be mangled by quoting. `umask 077` rather than a chmod afterwards —
	// a chmod leaves a window where the file exists world-readable.
	const writeCfg = [
		`umask 077`,
		`mkdir -p ${shellQuote(slot)}`,
		`printf %s ${shellQuote(Buffer.from(plan.configContent ?? '', 'utf8').toString('base64'))}` +
			` | base64 -d > ${shellQuote(plan.configPath ?? '')}`,
	].join(' && ');
	const wroteCfg = await sh(req.node, `${writeCfg} && echo CFG-OK`);
	if (wroteCfg === null || !wroteCfg.includes('CFG-OK')) {
		await deleteRunnerByName(req.repo, req.runnerName, token, gh);
		return { ok: false, reason: 'could not stage the jitconfig; registration removed' };
	}

	const spawned = await sh(req.node, plan.argv.map(shellQuote).join(' '));
	if (spawned === null) {
		// The registration exists and nothing is listening — exactly §12.8's black
		// hole. Clean it up here rather than waiting for the sweep, which runs on
		// its own schedule and would leave the hole open in between.
		await deleteRunnerByName(req.repo, req.runnerName, token, gh);
		return { ok: false, reason: 'spawn failed; registration removed' };
	}
	logger.info(`[ephemeral] minted ${req.runnerName} on ${req.node} for ${req.repo}`);
	return { ok: true, unit: plan.unit };
}

/**
 * The COMPLETE label set for a minted runner.
 *
 * A runner registered with `config.sh` is given `self-hosted`, `Linux` and `X64`
 * by GitHub automatically. `generate-jitconfig` does NOT: the `labels` array is
 * the whole set, and anything missing from it the runner simply does not have.
 *
 * So a mint carrying only the node's declared labels answers no fleet
 * workflow at all — every one of them asks for `self-hosted`. Observed on the
 * pilot's first canary: the runner came up online and idle with
 * `hadoku-builder,jit-canary`, the job asked for `self-hosted,jit-canary`, and
 * the two never matched. The runner sat there for its full hour and the job
 * stayed queued.
 *
 * Added here rather than at the call site because this is the single place a
 * mint is created, and a caller that forgets produces a runner that looks
 * perfectly healthy and can never be given work.
 */
export function mintLabels(declared: readonly string[]): string[] {
	return [...new Set([...IMPLICIT_LABELS, ...declared])];
}

/** GitHub's validation message, when it sent one. */
export function describeGhError(res: { body?: unknown }): string {
	const b = res.body as { message?: string; errors?: unknown[] } | undefined;
	if (!b) return '(no body)';
	return [b.message, b.errors ? JSON.stringify(b.errors) : null].filter(Boolean).join(' ');
}

/**
 * Remove a registration by NAME.
 *
 * Used on every failure path after minting. The id is not known at that point —
 * `generate-jitconfig` returns the config, not the runner — so it is looked up.
 * A failure to clean up is logged loudly rather than swallowed: the residue is a
 * runner GitHub will schedule onto and nothing will answer.
 */
export async function deleteRunnerByName(
	repo: string,
	name: string,
	token: string,
	gh: GhLike & { get?: (path: string, token: string, repo?: string) => Promise<unknown> }
): Promise<boolean> {
	const list = (await gh.get?.('/actions/runners?per_page=100', token, repo)) as
		{ runners?: { id: number; name: string }[] } | undefined;
	const hit = list?.runners?.find((r) => r.name === name);
	if (!hit) {
		logger.warn(`[ephemeral] could not find ${name} in ${repo} to clean up`);
		return false;
	}
	const res = await gh.write('DELETE', `/actions/runners/${hit.id}`, token, undefined, repo);
	if (!res.ok) logger.warn(`[ephemeral] failed to delete ${name} from ${repo}: ${res.status}`);
	return res.ok;
}

/**
 * Slot indices currently occupied by a live JIT listener on this node.
 *
 * From the PROCESS TREE, not from a unit name and not from memory. The slot is
 * only visible in the listener's own argv (`.../jit/slot<N>/bin/Runner.Listener`),
 * and that is the honest place to read it: a unit can exist without a listener
 * (§12.8) and mgmt-api's memory is wrong after every restart (B9).
 *
 * Getting this wrong is not cosmetic. Provisioning runs `RESET=1`, so minting
 * into a slot that is already serving a job wipes that job's payload — §12.16,
 * reproduced in the code written to prevent it because the slot index came from
 * a loop counter that restarted at 0 on every pass.
 */
export async function liveJitSlots(node: string, sh: ShellLike): Promise<Set<number>> {
	const out = await sh(
		node,
		"pgrep -af 'jit/slot[0-9]+/bin/Runner\\.Listener' 2>/dev/null || true"
	);
	const slots = new Set<number>();
	for (const line of (out ?? '').split('\n')) {
		const m = /jit\/slot(\d+)\//.exec(line);
		if (m) slots.add(Number(m[1]));
	}
	return slots;
}

/**
 * Live `jit-*` transient units on a node — B9's post-restart reconstruction.
 *
 * LIVE MEANS NOT FAILED, and that is now said on purpose. Both callers treat a
 * unit here as a job in flight: dispatch counts it against capacity and marks
 * its job as served, and the JIT reap keeps its registration. A FAILED unit is
 * neither — its listener is gone. Until #98 it was excluded by accident:
 * without `--plain` systemctl prefixes a failed unit with `●`, the first token
 * became the dot, and the line was dropped. `--plain` makes the columns
 * reliable (UNIT LOAD ACTIVE SUB …) and the ACTIVE column decides. Mints pass
 * `--collect`, so a failed unit is normally garbage-collected at once anyway.
 * `check-boundary-contracts` asserts the same flag.
 */
export async function liveJitUnits(node: string, sh: ShellLike): Promise<string[]> {
	return (await liveJitUnitRecords(node, sh)).map((u) => u.name);
}

/** A live JIT unit and the labels its mint stamped on it (`null`: not stamped). */
export interface LiveJitUnit {
	name: string;
	labels: string[] | null;
}

/** {@link liveJitUnits}, with each unit's stamped labels off the same one listing. */
export async function liveJitUnitRecords(node: string, sh: ShellLike): Promise<LiveJitUnit[]> {
	const out = await sh(
		node,
		"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-units 'jit-*' --no-legend --plain"
	);
	if (!out) return [];
	return out
		.split('\n')
		.map((l) => l.trim().split(/\s+/))
		.filter(([u, , active]) => u && u.startsWith('jit-') && active !== 'failed')
		.map(([u, , , , ...description]) => ({
			name: u.replace(/\.service$/, ''),
			labels: labelsFromUnitDescription(description.join(' ')),
		}));
}

/**
 * Retire a JIT runner that can never serve the job it was minted for: its
 * registration, then its unit — {@link evictWarmListener}'s order, for its
 * reason. GitHub refuses to delete a runner that is running a job, so a runner
 * that took some OTHER job its labels fit is left to finish it.
 */
export async function retireStrandedJit(
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
	return true;
}

/**
 * Quote one argv element for a remote shell.
 *
 * A jitconfig is 4 KB of base64 and the unit name is ours, but this runs over
 * ssh where the whole command is re-parsed by a second shell — so nothing is
 * interpolated unquoted, whatever it looks like today.
 */
export function shellQuote(a: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}
