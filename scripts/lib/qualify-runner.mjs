/**
 * `fleet qualify`'s WINDOW: hold one node out of service, run the playlist
 * against it, put it back. Every side effect is a `deps` function, so the
 * whole window runs in a test against fakes (qualify-runner.test.mjs) and in
 * production against `qualify-node.mjs`'s live wiring.
 *
 * THE HOLD is `underIdleHold` (proof-drain.mjs), the same primitive bootcamp's
 * idle re-measure uses: drain (kind `training`, through `drain-node`'s capacity
 * guard), wait for the running jobs to finish, run, and UNDRAIN ON EVERY PATH,
 * a throwing test included. Its reason carries QUALIFY_DRAIN_REASON_PREFIX, the
 * claim `prove-job --under-own-drain` honours, so `ctx.mintJob` can put real
 * jobs on the node it holds.
 *
 * REFUSED, before anything is drained:
 *   - the backstop. "hokon remains the backstop" (operator, 2026-11-11).
 *   - a node someone else already holds. A qualification measures a node it
 *     emptied itself; a maintenance or reboot drain is a human's, not ours.
 *   - a second qualification anywhere in the fleet. One node at a time.
 *
 * COULD NOT LOOK is said, never scored. An empty playlist, a test that throws,
 * a test whose result breaks the contract, a test that would overrun the
 * window, a node that never went quiet: each is `could-not-look` WITH ITS
 * REASON, and none of them is a pass.
 */
import { QUALIFY_DRAIN_REASON_PREFIX, underIdleHold } from './proof-drain.mjs';
import { normalizeResult, validateTest } from './qualify-registry.mjs';
import { parseSamples, startSamplerScript, stopSamplerScript } from './qualify-sampler.mjs';

const reasonOf = (e) => (e instanceof Error ? e.message : String(e));

/** Why `node` may not be qualified right now, or null. Pure. */
export function refusal({ node, machine, drains }) {
	if (machine?.role === 'backstop')
		return `${node} is the backstop and is never qualified ("hokon remains the backstop", operator 2026-11-11)`;
	const own = drains?.[node];
	if (own)
		return (
			`${node} is already drained (kind=${own.kind ?? 'unset'}, ` +
			`reason=${JSON.stringify(own.reason ?? '')}); a qualification only runs on a node it emptied itself`
		);
	const other = Object.entries(drains ?? {}).find(
		([n, row]) =>
			n !== node &&
			typeof row?.reason === 'string' &&
			row.reason.startsWith(QUALIFY_DRAIN_REASON_PREFIX)
	);
	if (other) return `${other[0]} is being qualified now; one node at a time, fleet-wide`;
	return null;
}

/**
 * PURE. Which node `fleet qualify --next` takes tonight, or null with why.
 *
 * A node is DUE when any playlist test has never passed on it or last passed
 * longer ago than that test's `ttlDays`. Never the backstop; never a node
 * someone holds (any drain); never anything while another qualification
 * runs. Among the due nodes the one whose LAST ATTEMPT is oldest goes first,
 * a never-attempted node before any attempted one, so a node that was too
 * busy to open its window last night waits behind the rest instead of
 * taking every night.
 *
 * @param {{ manifest: object, results: Record<string, any>, drains: Record<string, any>,
 *   tests: {id: string, ttlDays: number}[], nowMs: number }} a
 * @returns {{ node: string|null, why: string, due: string[] }}
 */
export function nextNode({ manifest, results, drains, tests, nowMs }) {
	const machines = Object.entries(manifest?.machines ?? {});
	const busy = Object.entries(drains ?? {}).find(
		([, row]) =>
			typeof row?.reason === 'string' && row.reason.startsWith(QUALIFY_DRAIN_REASON_PREFIX)
	);
	if (busy) return { node: null, why: `${busy[0]} is being qualified now`, due: [] };
	const due = [];
	for (const [name, m] of machines) {
		if (m?.role === 'backstop' || drains?.[name]) continue;
		let lastAttempt = null;
		let isDue = false;
		for (const t of tests) {
			const e = results?.[`${name}::${t.id}`];
			const tried = Date.parse(e?.last?.at ?? '');
			if (Number.isFinite(tried)) lastAttempt = Math.max(lastAttempt ?? 0, tried);
			const passed = Date.parse(e?.lastPass?.at ?? '');
			if (!Number.isFinite(passed) || nowMs - passed > t.ttlDays * 86_400_000) isDue = true;
		}
		if (isDue) due.push({ name, lastAttempt });
	}
	if (!due.length) return { node: null, why: 'no node is due', due: [] };
	due.sort((a, b) => (a.lastAttempt ?? -1) - (b.lastAttempt ?? -1) || a.name.localeCompare(b.name));
	const pick = due[0];
	return {
		node: pick.name,
		why:
			pick.lastAttempt === null
				? 'never attempted'
				: `last attempted ${new Date(pick.lastAttempt).toISOString()}`,
		due: due.map((d) => d.name),
	};
}

/**
 * Run one qualification window.
 *
 * @param {object} a
 * @param {string} a.node
 * @param {object} a.machine the node's manifest entry
 * @param {object} a.manifest
 * @param {object[]} a.tests the playlist (qualify-playlist.mjs QUALIFY_TESTS, or a test's own)
 * @param {number} a.windowMinutes
 * @param {boolean} [a.dryRun] report what would run; drain nothing, run nothing
 * @param {(m: string) => void} a.log
 * @param {{ held?: string|null }} [a.state] `held` names the node while drained, for a signal handler
 * @param {object} a.deps
 *   readDrains() → node → row; isDrained/drain/undrain/waitQuiet (underIdleHold's);
 *   runOn(node, script, {as, timeoutMs}) → {ok, stdout, stderr} (a test reaches it only as ctx.exec); proveJob(args) → doc|null with why;
 *   now() → ms
 * @returns {Promise<{ status: 'ran'|'refused'|'could-not-look'|'dry-run', reason: string|null,
 *   results: {id: string, status: string, reason: string, metrics: object}[], undrainFailed?: string }>}
 */
export async function runQualification(a) {
	const { node, machine, manifest, tests, windowMinutes, dryRun = false, log, deps } = a;
	const state = a.state ?? {};
	const notRun = (reason) =>
		tests.map((t) => ({ id: t?.id ?? 'unknown', status: 'could-not-look', reason, metrics: {} }));

	// REFUSALS FIRST: the backstop is refused whatever the playlist holds.
	let drains;
	try {
		drains = deps.readDrains();
	} catch (e) {
		const reason = `could not read the drain state: ${reasonOf(e)}`;
		return { status: 'could-not-look', reason, results: notRun(reason) };
	}
	const refused = refusal({ node, machine, drains });
	if (refused) return { status: 'refused', reason: refused, results: [] };

	const invalid = tests
		.map((t) => [t?.id ?? '(no id)', validateTest(t)])
		.filter(([, bad]) => bad.length);
	if (invalid.length) {
		const reason = `playlist breaks the test contract: ${invalid.map(([id, bad]) => `${id}: ${bad.join('; ')}`).join(' | ')}`;
		return { status: 'could-not-look', reason, results: notRun(reason) };
	}
	if (!tests.length)
		return {
			status: 'could-not-look',
			reason: 'no qualification tests are registered',
			results: [],
		};

	if (dryRun) {
		let used = 0;
		const results = tests.map((t) => {
			used += t.minutes;
			return {
				id: t.id,
				status: 'could-not-look',
				reason:
					used > windowMinutes
						? `dry run: would NOT start (${used} min > the ${windowMinutes}-min window)`
						: `dry run: would run as ${t.runsAs}, up to ${t.minutes} min`,
				metrics: {},
			};
		});
		return { status: 'dry-run', reason: `${tests.length} test(s), ${used} min budgeted`, results };
	}

	const held = await underIdleHold(
		node,
		tests.map((t) => t.id),
		deps,
		() => runPlaylist({ node, machine, manifest, tests, windowMinutes, log, deps }),
		state,
		{
			reason: `${QUALIFY_DRAIN_REASON_PREFIX} ${tests.map((t) => t.id).join(', ')} (returns when the window ends)`,
		}
	);
	if (held.status !== 'measured') {
		const reason = `the qualification window never opened: ${held.reason}`;
		return {
			status: 'could-not-look',
			reason,
			results: notRun(reason),
			...(held.undrainFailed ? { undrainFailed: held.undrainFailed } : {}),
		};
	}
	return {
		status: 'ran',
		reason: null,
		results: held.result,
		...(held.undrainFailed ? { undrainFailed: held.undrainFailed } : {}),
	};
}

/** The tests, in order, inside an open window. */
async function runPlaylist({ node, machine, manifest, tests, windowMinutes, log, deps }) {
	const started = deps.now();
	const results = [];
	for (const t of tests) {
		const elapsedMin = (deps.now() - started) / 60_000;
		if (elapsedMin + t.minutes > windowMinutes) {
			results.push({
				id: t.id,
				status: 'could-not-look',
				reason:
					`not started: ${Math.round(elapsedMin)} min used, it budgets ${t.minutes}, ` +
					`and the window is ${windowMinutes}`,
				metrics: {},
			});
			continue;
		}
		log(`── ${node}  ${t.id}  (as ${t.runsAs}, up to ${t.minutes} min)`);
		const samplers = [];
		const ctx = testContext({ node, machine, manifest, test: t, deps, log, samplers });
		let result;
		try {
			result = normalizeResult(await t.run(ctx));
		} catch (e) {
			result = { status: 'could-not-look', reason: `the test threw: ${reasonOf(e)}`, metrics: {} };
		} finally {
			// A sampler the test did not stop is stopped here, so a test that throws
			// mid-step cannot leave one running.
			for (const s of samplers) if (!s.stopped) await s.stop().catch(() => {});
		}
		log(`   ${result.status.toUpperCase()}: ${result.reason}`);
		results.push({ id: t.id, ...result });
	}
	return results;
}

/** What a test is handed. Everything on the node runs as the test's declared role. */
function testContext({ node, machine, manifest, test, deps, log, samplers }) {
	// Bound to this node and to the role the test declared; a test never names a user.
	const exec = (script, o = {}) =>
		deps.runOn(node, script, { timeoutMs: 120_000, ...o, as: test.runsAs });
	return {
		node,
		machine,
		manifest,
		log,
		nowMs: deps.now(),
		exec,
		/**
		 * `count` copies of one real job, side by side, on this node, through
		 * `fleet prove-job --under-own-drain --no-record`. Each entry is the run's
		 * outcome; a copy that produced no JSON says why.
		 */
		async mintJob({ repo, workflow, job, ref = 'main', count = 1, timeoutMin = 40 }) {
			const args = [
				'--node',
				node,
				'--repo',
				repo,
				'--workflow',
				workflow,
				'--job',
				job,
				'--ref',
				ref,
			];
			args.push('--timeout-min', String(timeoutMin), '--under-own-drain', '--no-record', '--json');
			const runs = await Promise.all(Array.from({ length: count }, () => deps.proveJob(args)));
			return runs.map((r) =>
				r.doc === null
					? {
							ok: false,
							verdict: 'error',
							reason: `fleet prove-job did not produce JSON: ${r.why}`,
						}
					: {
							ok: r.doc.ok === true,
							verdict: r.doc.verdict ?? null,
							runId: r.doc.runId ?? null,
							durationSec: r.doc.durationSec ?? null,
							jobConclusion: r.doc.jobConclusion ?? null,
							ranOnTarget: r.doc.ranOnTarget === true,
							reason: r.doc.proofInconclusive ?? r.doc.verdict ?? null,
						}
			);
		},
		/** Start the node-side sampler; `stop()` returns its rows (lib/qualify-sampler.mjs). */
		async sample({ everySec = 5, maxMinutes = 180 } = {}) {
			const started = await exec(startSamplerScript({ everySec, maxMinutes }));
			const dir = started.stdout?.match(/^SAMPLER (\S+)$/m)?.[1];
			if (!started.ok || !dir)
				throw new Error(
					`the sampler did not start: ${(started.stderr || started.stdout || '').trim().slice(-300)}`
				);
			const handle = {
				stopped: false,
				async stop() {
					handle.stopped = true;
					const r = await exec(stopSamplerScript(dir));
					if (!r.ok)
						throw new Error(
							`the sampler did not stop cleanly: ${(r.stderr || '').trim().slice(-300)}`
						);
					return parseSamples(r.stdout);
				},
			};
			samplers.push(handle);
			return handle;
		},
	};
}
