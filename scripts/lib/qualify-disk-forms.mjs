/**
 * `fleet qualify`'s DISK FORMS, out of qualify-node.mjs: which onboarding step
 * the flags ask for, its plan without `--confirm`, and its test with it
 * (storage bootcamp F2, #137; data-driven admission, #156).
 *
 *   --disks                    SMR, SMART, link: read-only, every candidate
 *   --wipe <serial>            what it carries; --confirm records it and clears it
 *   --burn-in <serial>         the plan; --confirm burns it in (resumable)
 *   --disk-bench               the zone's performance, judged against the pool (drains)
 *   --node-impact              the node under Garage-shaped load on the zone (drains)
 *
 * Every step that touches a disk is wrapped in `withLinkCheck`: the kernel log
 * over the step's own window is read after it, and a link error, reset or
 * device-disable for the disk REJECTS it (#156), whatever the step said.
 *
 * `selectDiskForm` returns `{ tests }` to run, `{ done: { doc, code } }` when
 * the form ends without a window (a plan, a refusal), or null when no disk
 * flag is present.
 */
import { BUDGET_MINUTES, makeBurninTest, planBurnin } from './qualify-disk-burnin.mjs';
import { linkCheck, rejectionOf } from './qualify-disk-link.mjs';
import { makeWipeTest, planWipe } from './qualify-disk-wipe.mjs';
import { makeBenchTest } from './qualify-disk-bench.mjs';
import { makeImpactTest } from './qualify-disk-impact.mjs';
import { poolReadings } from './qualify-disk-bench-judge.mjs';
import { diskTests } from './qualify-playlist.mjs';
import { QUALIFY_WINDOW_MINUTES } from './qualify-registry.mjs';

/** Value flags of the disk forms, for `machineArg`'s `valueFlags`. */
export const DISK_VALUE_FLAGS = ['--burn-in', '--minutes', '--wipe'];

/**
 * A step with the kernel log read around it. `serials()` names the disks the
 * step touched (known only once it ran, for a step that finds its own). A
 * link error rejects that disk; one on any other device is node impact.
 * A log that could not be read turns a pass into could-not-look.
 */
export function withLinkCheck(test, serials, { now = Date.now } = {}) {
	return {
		...test,
		async run(ctx) {
			const sinceSec = Math.floor(now() / 1000) - 1;
			const r = await test.run(ctx);
			const names = typeof serials === 'function' ? serials(r) : serials;
			const disks = [...(r?.metrics?.disks ?? [])];
			const links = [];
			const impact = new Map();
			for (const serial of names) {
				const link = await linkCheck(ctx, serial, sinceSec);
				links.push({ serial, verdict: link.verdict, reason: link.reason });
				const i = disks.findIndex((d) => d?.serial === serial);
				const rejection = rejectionOf(serial, link, test.id);
				if (rejection) {
					const was = i >= 0 ? disks[i] : { serial };
					disks.splice(i >= 0 ? i : disks.length, i >= 0 ? 1 : 0, {
						...was,
						verdict: 'fail',
						reason: link.reason,
						rejection,
					});
				}
				for (const x of link.nodeImpact) if (!names.includes(x.serial)) impact.set(x.device, x);
			}
			const metrics = {
				...(r?.metrics ?? {}),
				disks,
				link: links,
				linkNodeImpact: [...impact.values()],
			};
			const rejected = links.filter((l) => l.verdict === 'fail');
			if (rejected.length)
				return {
					status: 'fail',
					reason: `${rejected.map((l) => `${l.serial}: ${l.reason}`).join('; ')} (during ${test.id}, which said: ${r?.reason ?? 'nothing'})`,
					metrics,
				};
			const blind = links.filter((l) => l.verdict === 'blocked');
			if (blind.length && r?.status === 'pass')
				return {
					status: 'could-not-look',
					reason: `${r.reason}; but the kernel log was not read for ${blind.map((l) => `${l.serial} (${l.reason})`).join(', ')}`,
					metrics,
				};
			return { ...r, metrics };
		},
	};
}

/**
 * @param {{ argv: string[], node: string, next: boolean, rejected: () => ({ ok: true, rejected: object } | { ok: false, reason: string }),
 *   pool?: () => ({ ok: true, declared: object, results: object } | { ok: false, reason: string }),
 *   zonePaths?: { rootZoneDir: string, mountPointFor: (serial: string) => string },
 *   planExec: (script: string, o?: object) => Promise<any>, log: (m: string) => void }} a
 */
export async function selectDiskForm({
	argv,
	node,
	next,
	rejected,
	pool,
	zonePaths,
	planExec,
	log,
}) {
	const flagValue = (name) => {
		const i = argv.indexOf(name);
		return i < 0 ? null : (argv[i + 1] ?? '');
	};
	const confirm = argv.includes('--confirm');
	const burnIn = flagValue('--burn-in');
	const wipe = flagValue('--wipe');
	const disks = argv.includes('--disks');
	const bench = argv.includes('--disk-bench');
	const impact = argv.includes('--node-impact');
	const asked = [disks, burnIn !== null, wipe !== null, bench, impact].filter(Boolean).length;
	if (!asked) return null;
	const refuse = (error, code = 2) => {
		log(`fleet qualify: ${error}`);
		return { done: { doc: { ok: false, node, error }, code } };
	};
	if (next) return refuse('a disk form names one node with --machine, never --next');
	if (asked > 1)
		return refuse(
			'--disks, --wipe, --burn-in, --disk-bench and --node-impact are one step each; give one'
		);
	const planCtx = { node, nowMs: Date.now(), exec: planExec };

	if (disks) {
		// A disk already rejected stays rejected in the scan (#156); an unreadable
		// record is refused, never read as "nothing rejected".
		const rej = rejected();
		if (!rej.ok) return refuse(`the disk rejections are unreadable: ${rej.reason}`, 1);
		return { tests: diskTests({ rejected: rej.rejected }) };
	}

	if (bench || impact) {
		// The node's declared zone, and every OTHER zone's last bench: the pool
		// this zone is judged against. Unreadable is refused, never "no pool".
		const p = pool();
		if (!p.ok) return refuse(`the pool could not be read: ${p.reason}`, 1);
		const zone = p.declared.zones?.[node];
		if (impact) {
			// The soak sizes its load from this node's own bench and takes its
			// decoy job, and that job's time, from this node's own ramp.
			const own = (id) => p.results?.[`${node}::${id}`]?.last;
			const benchDisks = own('disk-bench')?.metrics?.disks ?? [];
			const t = makeImpactTest({
				zoneDisks: zone && zone.state === 'active' ? zone.disks : null,
				benchOf: (serial) => benchDisks.find((d) => d.serial === serial)?.reading ?? null,
				ramp: own('concurrency-ramp')?.metrics ?? null,
				...zonePaths,
			});
			return { tests: [withLinkCheck(t, (r) => t.touched(r))] };
		}
		const t = makeBenchTest({
			zoneDisks: zone && zone.state === 'active' ? zone.disks : null,
			pool: poolReadings({ declared: p.declared, results: p.results, exceptNode: node }),
			...zonePaths,
		});
		return { tests: [withLinkCheck(t, (r) => t.touched(r))] };
	}

	if (wipe !== null) {
		let t;
		try {
			t = makeWipeTest({ serial: wipe });
		} catch (e) {
			return refuse(`--wipe: ${e.message}`);
		}
		if (confirm) return { tests: [withLinkCheck(t, [wipe])] };
		const plan = await planWipe(planCtx, wipe);
		if ('error' in plan) {
			log(`fleet qualify --wipe ${wipe} on ${node}: ${plan.error}`);
			return {
				done: { doc: { ok: false, node, status: 'could-not-look', reason: plan.error }, code: 1 },
			};
		}
		log(`fleet qualify --wipe ${wipe} on ${node} — PLAN, nothing written:`);
		log(`   ${plan.dev} carries ${plan.carries}`);
		log('   add --confirm to record it and clear it (wipefs -a on each partition, then the disk)');
		return {
			done: {
				doc: {
					ok: true,
					node,
					status: 'dry-run',
					serial: wipe,
					plan: {
						device: plan.dev,
						carries: plan.carries,
						pttype: plan.wipe.pttype,
						partitions: plan.wipe.partitions,
						signatures: plan.wipe.signatures,
					},
				},
				code: 0,
			},
		};
	}

	const minutesArg = flagValue('--minutes');
	const budgetMinutes = minutesArg === null ? BUDGET_MINUTES : Number(minutesArg);
	if (
		!Number.isInteger(budgetMinutes) ||
		budgetMinutes <= 0 ||
		budgetMinutes + 5 > QUALIFY_WINDOW_MINUTES
	)
		return refuse(`--minutes must be a whole number from 1 to ${QUALIFY_WINDOW_MINUTES - 5}`);
	let burnin;
	try {
		burnin = makeBurninTest({ serial: burnIn, budgetMinutes });
	} catch (e) {
		return refuse(`--burn-in: ${e.message}`);
	}
	if (confirm) return { tests: [withLinkCheck(burnin, [burnIn])] };
	// The plan reads the disk and its state file; it drains and writes nothing.
	const plan = await planBurnin(planCtx, burnIn);
	if ('error' in plan) {
		log(`fleet qualify --burn-in ${burnIn} on ${node}: ${plan.error}`);
		return {
			done: { doc: { ok: false, node, status: 'could-not-look', reason: plan.error }, code: 1 },
		};
	}
	log(`fleet qualify --burn-in ${burnIn} on ${node} — PLAN, nothing drained or written:`);
	log(`   ${plan.disk.device} ${plan.disk.model ?? ''}: ${plan.summary}`);
	log(`   add --confirm to run it for up to ${budgetMinutes} min under the drain`);
	return {
		done: {
			doc: {
				ok: true,
				node,
				status: 'dry-run',
				serial: burnIn,
				plan: { summary: plan.summary, state: plan.state },
			},
			code: 0,
		},
	};
}
