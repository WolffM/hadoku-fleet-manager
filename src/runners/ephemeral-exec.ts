/**
 * The I/O half of minting: talk to GitHub, talk to systemd, and refuse to do
 * either when the decision layer says no.
 *
 * Every rule lives in ephemeral.ts / placement.ts / dispatcher.ts as a pure
 * function; this file only carries them out. `gh` and `sh` are injected the same
 * way `setTierEligibility` takes `gh`, so the ORDER of operations — which is
 * where the leaks and the clobbers live — is testable without a node.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMPLICIT_LABELS, ephemeralOnlyLabels } from '../capabilities.js';
import { logger } from '../host.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from '../lib/concurrency.js';
import {
	JIT_PREFIX,
	assertSafeJitConfig,
	buildSpawnPlan,
	labelsFromUnitDescription,
	buildWarmSpawnPlan,
	parseJitName,
	slotDir,
	warmRunnerName,
	warmSlotDir,
	type AdmissionResult,
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
function shellSingleQuote(v: string): string {
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
	const prov = await sh(
		req.node,
		`SLOT=${req.slotIndex} RESET=1${tarball} bash ~/.hadoku/jit-provision.sh`
	);
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
function mintLabels(declared: readonly string[]): string[] {
	return [...new Set([...IMPLICIT_LABELS, ...declared])];
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
function warmLabels(declared: readonly string[]): string[] {
	const forbidden = new Set(ephemeralOnlyLabels());
	return mintLabels(declared).filter((l) => !forbidden.has(l));
}

/** GitHub's validation message, when it sent one. */
function describeGhError(res: { body?: unknown }): string {
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

// --- warm cache of one (P4.1) -------------------------------------------

/**
 * The warm-provision script's own text, read from THIS package rather than
 * from a copy pre-deployed onto the node.
 *
 * jit-provision.sh is deployed by `scripts/deploy-ci-throttle.mjs` — a
 * different lane's file (WS-A provenance) — which base64-embeds it into
 * `ci-throttle-install.sh`. Wiring warm-provision.sh into that same pipeline
 * needs a change there, out of scope for this lane. So the warm construction
 * path takes the SEPARATE path the brief asked for in the fullest sense: it
 * carries its own script inline on every mint (see {@link mintWarmListener})
 * rather than depending on a deploy step that has not run yet — an
 * `ephemeral: true` node the JIT deploy pipeline has never reached can still
 * host a warm listener the first time this code asks it to.
 *
 * Memoised because the file never changes within one process's lifetime; a
 * fresh read costs nothing on the rare mint, but there is no reason to stat
 * the disk on every tick either.
 */
let warmProvisionScript: string | null = null;

export function __resetWarmProvisionScriptCacheForTesting(): void {
	warmProvisionScript = null;
}

function loadWarmProvisionScript(): string {
	if (warmProvisionScript !== null) return warmProvisionScript;
	// dist/runners/ephemeral-exec.js -> dist -> package root -> scripts/. Same
	// two-level-up shape src/cli.ts uses to find its own SCRIPTS dir, adjusted
	// for this file living one directory deeper.
	const path = resolve(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'scripts',
		'warm-provision.sh'
	);
	warmProvisionScript = readFileSync(path, 'utf8');
	return warmProvisionScript;
}

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

	// 2. Provision + register on the node. See loadWarmProvisionScript for why
	// the script travels with this call instead of living on the node already.
	let script: string;
	try {
		script = loadWarmProvisionScript();
	} catch (err) {
		return { ok: false, reason: `could not read warm-provision.sh: ${(err as Error).message}` };
	}
	const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
	const url = `https://github.com/${req.repo}`;
	const tarball = req.tarballUrl ? ` RUNNER_TARBALL_URL='${shellSingleQuote(req.tarballUrl)}'` : '';
	const dest = '$HOME/.hadoku/.warm-provision.sh';
	const cmd =
		`mkdir -p "$HOME/.hadoku" && printf %s '${scriptB64}' | base64 -d > ${dest} && ` +
		`RESET=1 URL='${shellSingleQuote(url)}' REPO='${shellSingleQuote(req.repo)}' ` +
		`REG_TOKEN='${shellSingleQuote(regToken)}' NAME='${shellSingleQuote(req.runnerName)}' ` +
		`LABELS='${shellSingleQuote(warmLabels(req.labels).join(','))}'${tarball} bash ${dest}; ` +
		`rm -f ${dest}`;
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

/**
 * Quote one argv element for a remote shell.
 *
 * A jitconfig is 4 KB of base64 and the unit name is ours, but this runs over
 * ssh where the whole command is re-parsed by a second shell — so nothing is
 * interpolated unquoted, whatever it looks like today.
 */
function shellQuote(a: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * How often the reap sweep may run, INDEPENDENT of the dispatch tick.
 *
 * The sweep costs one runner listing per repo. Since 2026-10-16 that listing
 * is CONDITIONAL — `ghGet` sends the last ETag, and GitHub's 304 is a statement
 * about the CURRENT registration list, so it is exactly as safe to delete on as
 * a full body, and free. That lowers the typical spend, not the ceiling: a repo
 * with jobs running changes its listing between sweeps (runners flip `busy`)
 * and is charged every time, so the arithmetic below is still the bound. When
 * it was written every call here was unconditional, and the ceiling was the
 * spend; that is what made this affordable at the ladder's 60s tick and fatal
 * at the dispatcher's 15s one:
 *
 *   27 repos x  60 ticks/hr =  1,620 calls/hr   (ladder cadence, fine)
 *   27 repos x 240 ticks/hr =  6,480 calls/hr   (15s cadence, over a 5,000 cap)
 *
 * Measured 2026-09-06, before this constant existed: the token hit
 * `remaining: 0` at ~:13 past EVERY hour and stayed there until the reset at
 * ~:33 — 19 minutes an hour with the fleet unable to poll or mint. All 6,903
 * rate-limited calls in the log were this one path. Jobs queued during the
 * blackout started at ~:32 regardless of when they arrived, which is what
 * `ci:queue-health` had been flapping on.
 *
 * 60s costs 1,620/hr and buys back the budget. Reaping faster cannot reap
 * anything sooner anyway: `graceMs` is 10 minutes, so an orphan is not eligible
 * until long after even the slowest cadence here would have seen it. The only
 * thing a faster sweep changes is how quickly an ALREADY-eligible orphan goes,
 * and that moves from ~10m15s to ~11m.
 */
export const REAP_INTERVAL_MS = 60_000;

/**
 * How often the sweep re-lists a repo that has NOTHING TO REAP (#116).
 *
 * REAP_INTERVAL_MS bounded how often the sweep runs; it did not bound what one
 * sweep costs, and that grew with the roster: 30 repos x 60/hr = 1,800 calls an
 * hour, the largest single spender on HADOKU_SITE_TOKEN, paid whether anything
 * had been minted or not. In the 2026-10-16 18:30-19:15Z window that ended in
 * the fourth blackout in six days it was ~1,350 of the calls.
 *
 * Almost none of them could find anything. An orphan is a `jit-*` registration,
 * and one exists in a repo only if something minted there — so a repo whose
 * last listing held no `jit-*` registration, and that this process has not
 * minted to since, has nothing to reap until someone mints again. The sweep
 * still walks it, every five minutes rather than every minute, because the
 * process that minted may not be THIS one: `fleet prove-job` mints from the
 * CLI, and the previous mgmt-api's mints outlive it (the first sweep after a
 * restart walks every repo, since none has been listed yet).
 *
 *   idle fleet:  30 repos x 12/hr            =   360 calls/hr
 *   each repo holding or minting JIT         +    48 calls/hr while it does
 *
 * THE REAP LATENCY DOES NOT MOVE, and that is a constraint on this number, not
 * luck: it must stay at most JIT_REAP_GRACE_MS - REAP_INTERVAL_MS. A repo that
 * receives a mint from outside this process is then listed BEFORE that mint's
 * grace runs out, the listing shows the `jit-*` name, the repo becomes active,
 * and the orphan goes on the first sweep past its grace — grace + one sweep,
 * as before. `fleet identity`'s UNREAPED_AFTER_MS (grace + two sweeps) depends
 * on exactly that, and `dispatch-pass.test.ts` asserts the inequality.
 */
export const REAP_IDLE_INTERVAL_MS = 5 * 60_000;

/**
 * How old a JIT registration must be before the sweep may delete it. Exported
 * so `fleet identity` can tell an orphan the sweep has not REACHED yet from one
 * it has FAILED to clear, from this number rather than a second copy of it.
 */
export const JIT_REAP_GRACE_MS = 10 * 60_000;

/**
 * Reap JIT registrations whose listener is gone — §12.8's sweep, which the rest
 * of this workstream referred to and nothing implemented.
 *
 * WHY A LEAK HERE IS WORSE THAN A LEAK USUALLY IS
 * ------------------------------------------------
 * A registration GitHub can see is a runner GitHub will SCHEDULE ONTO. An
 * orphan does not sit harmlessly in a list: it takes a job, nothing answers,
 * and the job hangs until its timeout. Every successful mint created one of
 * these, because `deleteRunnerByName` was only ever called on failure paths.
 *
 * THE GRACE COMES FROM THE NAME, NOT FROM MEMORY. mgmt-api restarts ~5x a day
 * and the sweep must not treat a 30-second-old mint as an orphan just because
 * the process that made it is gone — that would reap a fleet's worth of healthy
 * runners on every redeploy. The mint epoch is in the name for exactly this, and
 * a name that cannot be parsed is treated as IMMEDIATELY reapable, per §12.8:
 * an unaged name is one we cannot vouch for.
 *
 * A BUSY REGISTRATION IS NEVER TOUCHED, whatever the node says. `busy` comes
 * free in the listing this sweep already makes, and it is the only witness that
 * comes from the party that ASSIGNED the job. The node probe answers wrongly in
 * the quiet direction when it is partial; GitHub's `busy` does not depend on the
 * node being reachable at all. Both have to fail before a running job dies.
 *
 * FAIL-SAFE ON AN UNREACHABLE NODE. If a node cannot be probed we cannot
 * know whether its listeners are alive, so nothing belonging to it is reaped.
 * Deleting a registration whose listener is mid-job kills the job — the exact
 * outage this workstream exists to avoid — and the cost of waiting is one more
 * sweep.
 */
export async function reapJitRunners(
	repos: readonly string[],
	nodes: readonly string[],
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: ShellLike,
	opts: {
		graceMs?: number;
		nowMs?: number;
		/**
		 * Jobs observed QUEUED this pass. A live idle JIT minted for one of them
		 * past the grace is STRANDED and released (fleet-manager#2). Absent,
		 * nothing live is.
		 */
		queuedJobIds?: ReadonlySet<number>;
	} = {}
): Promise<{
	reaped: number;
	kept: number;
	unreachable: string[];
	/**
	 * Every repo whose listing was READ, and whether it held any `jit-*`
	 * registration after this sweep's deletes. A repo whose listing could not be
	 * read is ABSENT, never `heldJit: false` — the caller decides from this which
	 * repos it may leave alone, and "I could not look" must not clean a repo.
	 */
	observed: { repo: string; heldJit: boolean }[];
}> {
	const graceMs = opts.graceMs ?? JIT_REAP_GRACE_MS;
	const nowMs = opts.nowMs ?? Date.now();

	const liveUnits = new Set<string>();
	const unreachable: string[] = [];
	await Promise.all(
		nodes.map(async (m) => {
			const probe = await sh(m, 'echo REACHABLE');
			if (probe === null || !probe.includes('REACHABLE')) {
				unreachable.push(m);
				return;
			}
			for (const u of await liveJitUnits(m, sh)) liveUnits.add(u);
		})
	);

	let reaped = 0;
	let kept = 0;
	const observed: { repo: string; heldJit: boolean }[] = [];
	// BOUNDED, not sequential and not `Promise.all` — the same shape, and the same
	// SWEEP_CONCURRENCY, as the queued-runs poll in dispatch-tick.
	//
	// Sequential was a latency bug with teeth. Every listing here carries a 10s
	// fetch timeout, so at 27 repos one sweep could run 270s while the dispatcher
	// that calls it holds `dispatchInFlight` — 17 ticks skipped, and discovery
	// latency IS queue latency under all-JIT. That is not theoretical: on
	// 2026-09-07 the API slowed under a burst of its own making, 866 of these
	// listings timed out in two hours, and the fleet stopped serving work from
	// 01:56 to 04:08. runner-health missed every 10-minute tick in that window.
	//
	// Six-wide turns the worst case into ~45s and the ordinary case into a round
	// or two. Not unbounded: one token serves this sweep, the poll and
	// runner-health, and a wide simultaneous burst trips GitHub's SECONDARY rate
	// limit, which stalls all three rather than just this one.
	//
	// Counters are plain increments because the event loop is single-threaded —
	// no interleaving can land between the read and the write of `reaped++`. The
	// only thing that changes is the ORDER of the per-repo log lines.
	await mapConcurrent(repos, SWEEP_CONCURRENCY, async (repo) => {
		const list = (await gh.get('/actions/runners?per_page=100', token, repo)) as
			{ runners?: { id: number; name: string; busy?: boolean }[] } | undefined;
		// Held AFTER this sweep: a registration it deleted is not one to come back
		// for, and a failed delete is (it is still there).
		let jitSeen = 0;
		let deletedHere = 0;
		for (const r of list?.runners ?? []) {
			if (!r.name.startsWith(JIT_PREFIX)) continue;
			jitSeen++;
			// BUSY MEANS A JOB IS RUNNING ON IT RIGHT NOW. Deleting the registration
			// under a live job kills the job — the outage this whole sweep exists to
			// avoid — so this is checked before anything else can conclude "orphan".
			//
			// It is a SECOND, INDEPENDENT witness, not a duplicate of the liveUnits
			// check below. That one asks the NODE ("is a unit by this name running?")
			// over ssh, and it answers wrongly in the quiet direction whenever the
			// probe is partial, the glob listing is truncated, or the unit is named
			// something the parser did not expect. This one asks GITHUB, which is the
			// party that assigned the job and the only one that knows a job was
			// accepted. Two sources have to fail together before a job dies.
			//
			// It costs NOTHING. `busy` is already in the listing this sweep performs
			// per repo — the field was simply not read. That matters here more than
			// usual: a listing with a busy runner in it is one that keeps changing,
			// so its ETag rarely answers 304 and the ceiling is the spend — a second
			// call per runner would have been unaffordable at fleet size. See
			// REAP_INTERVAL_MS.
			//
			// `busy` absent is NOT treated as busy: the other guards (live unit,
			// mint-epoch grace) still stand behind it, and treating every listing
			// that omitted the field as busy would disable the sweep entirely the
			// first time GitHub changed its serialisation.
			if (r.busy) {
				kept++;
				continue;
			}
			// Scoped by node, so one unreachable box does not freeze the sweep
			// for the rest of the fleet.
			if (unreachable.some((m) => r.name.startsWith(`${JIT_PREFIX}${m}-`))) {
				kept++;
				continue;
			}
			const parsed = parseJitName(r.name);
			// A live listener is kept unless it is STRANDED: idle (busy was checked
			// above) while the job it was minted for is still queued, and — by the
			// grace below — past any honest mint-to-assignment gap. GitHub assigns a
			// matching idle runner in seconds, so one that has listened this long
			// beside its own job is one GitHub will not give the job to. On
			// 2026-10-23 a hokon mint for hadoku-bomberman registered without
			// `hadoku-builder`, and "already has a runner in flight" held the job
			// off every claw until a hand delete 59 minutes later; nothing else
			// would have cleared it before JIT_UNIT_MAX_SEC, six and a half hours.
			// Deleting the registration is the whole release: the listener sees
			// "runner no longer exists on the server" and exits, its unit goes, and
			// the next pass places the job again. Only a job-scoped name can say
			// which job it was minted for.
			const stranded =
				liveUnits.has(r.name) && parsed?.jobId != null && opts.queuedJobIds?.has(parsed.jobId)
					? parsed
					: null;
			if (liveUnits.has(r.name) && !stranded) {
				kept++;
				continue;
			}
			if (parsed && nowMs - parsed.mintedAtMs < graceMs) {
				kept++;
				continue;
			}
			const res = await gh.write('DELETE', `/actions/runners/${r.id}`, token, undefined, repo);
			if (res.ok) {
				reaped++;
				deletedHere++;
				logger.info(
					stranded
						? `[ephemeral] released stranded registration ${r.name} from ${repo}: idle ` +
								`${Math.round((nowMs - stranded.mintedAtMs) / 60_000)}m beside its still-queued ` +
								`job ${stranded.jobId} — GitHub will not assign it there`
						: `[ephemeral] reaped orphaned registration ${r.name} from ${repo}`
				);
			} else {
				logger.warn(`[ephemeral] failed to reap ${r.name} from ${repo}: ${res.status}`);
			}
		}
		if (Array.isArray(list?.runners)) observed.push({ repo, heldJit: jitSeen > deletedHere });
	});
	if (reaped || unreachable.length) {
		logger.info(
			`[ephemeral] reap: ${reaped} removed, ${kept} kept` +
				(unreachable.length ? `, skipped nodes ${unreachable.join(',')}` : '')
		);
	}
	return { reaped, kept, unreachable, observed };
}
