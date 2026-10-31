import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadManifest, manifestPath } from './fleet-exec.mjs';
import { landingLine, runGit } from './manifest-target.mjs';
import { manifestEdit } from './manifest-edit.mjs';
import { measuredFacets } from '../../dist/lib/measured.js';
import {
	BENCHMARK_DUE_DAYS,
	seedPlan,
	bootcampProbeArgs,
	benchmarkStep,
	healthStep,
	safeJson,
} from './provision-plan.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

// ── execution helpers ────────────────────────────────────────────────────────

function run(argv0, argv, { captureJson = false } = {}) {
	let dir = null;
	let fd = null;
	const opts = { stdio: ['inherit', 'inherit', 'inherit'] };
	if (captureJson) {
		// STDOUT INTO A FILE, never a pipe: a script that prints and then exits
		// loses everything past 8 KB through a pipe on this host (#33), and the
		// whole point of capturing is to parse it.
		dir = mkdtempSync(join(tmpdir(), 'fleet-provision-'));
		fd = openSync(join(dir, 'out.json'), 'w');
		opts.stdio = ['inherit', fd, 'inherit'];
	}
	const r = spawnSync(argv0, argv, opts);
	if (fd !== null) closeSync(fd);
	let text = null;
	if (captureJson) {
		text = readFileSync(join(dir, 'out.json'), 'utf8');
		rmSync(dir, { recursive: true, force: true });
		process.stdout.write(text);
	}
	return { status: r.status ?? 1, text };
}

const P = (m) => console.log(m);

// ── the onboarding chain, phase by phase ─────────────────────────────────────

function declarePhase(node, { confirm, noPush, address }) {
	const MANIFEST = manifestPath();
	let doc = null;
	try {
		doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	} catch {
		// loadManifest below is the loud version of this read; here a missing
		// manifest reads as "not declared", which is the honest answer for it.
	}
	if (doc?.machines?.[node]) {
		P(`   · already declared in the manifest — nothing to do`);
		return { status: 0 };
	}
	if (!confirm) {
		P(`   · not declared. The proposal (nothing written):`);
		// enroll's exit 1 on a clean proposal is its own design; here it is the
		// preview, not a chain failure.
		run(process.execPath, [
			resolve(HERE, 'enroll-node.mjs'),
			node,
			...(address ? ['--address', address] : []),
		]);
		return {
			status: 1,
			remedy:
				`dry run stops at the first step: ${node} is not declared, and every later step reads ` +
				`the manifest. \`fleet provision --machine ${node} --confirm\` declares it from the ` +
				`bootstrap record (measurement + derived placement) and runs the whole chain.`,
		};
	}
	const ff = fastForwardManifest(MANIFEST);
	if (!ff.ok) return { status: 1, remedy: ff.why };
	P(`   · ${ff.note}`);
	const s = run(process.execPath, [
		resolve(HERE, 'enroll-node.mjs'),
		node,
		'--write',
		...(noPush ? ['--no-push'] : []),
		...(address ? ['--address', address] : []),
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'enroll refused — its output above names which fatal check failed. A record/box ' +
				'disagreement on cores, hostname or memory means the capture is not this box; a ' +
				'landing refusal names the checkout state to fix.',
		};
	// THE READER IS NOT THE WRITER: re-read the manifest rather than trusting
	// the child's exit code.
	let after = null;
	try {
		after = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	} catch {
		/* handled below */
	}
	if (!after?.machines?.[node])
		return {
			status: 1,
			remedy:
				'enroll exited 0 but the node is not in the manifest afterwards — read its landing line above.',
		};
	return { status: 0 };
}

function convergePhase(node, { confirm }) {
	const s = run(process.execPath, [
		resolve(HERE, 'converge-toolchain.mjs'),
		'--machine',
		node,
		...(confirm ? ['--write'] : []),
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'the toolchain did not converge — its output above names the package or the node. ' +
				'apt failures and an unreachable box are different jobs, and it says which.',
		};
	return { status: 0 };
}

/**
 * THE BOOTCAMP PHASE: probe, seed what the report says is missing, judge again.
 *
 * The manual record's steps 3-6: bootcamp FAILED on python-toolcache and
 * playwright, the operator READ the failure, typed two seed commands, and
 * bootcamp PASSED. The chain derives the same remedies from the EARNED set —
 * never by parsing the failure prose — and only a passing bootcamp records
 * `$capabilities`.
 */
function bootcampPhase(node, { confirm, noPush }) {
	const probe = run(
		process.execPath,
		[resolve(HERE, 'bootcamp.mjs'), ...bootcampProbeArgs(node, { confirm })],
		{ captureJson: true }
	);
	const probeReport = safeJson(probe.text)?.report?.[node] ?? null;
	if (!probeReport)
		return {
			status: 1,
			remedy:
				'bootcamp produced no report for this node — an unreachable node is a failure, not ' +
				'a pass, and its output above says why.',
		};
	const plan = seedPlan(probeReport.earned);
	if (plan.length) {
		for (const r of plan) {
			P(`   · not earned: ${r.capability} — seeding (${r.why})`);
			const s = run(process.execPath, [
				resolve(HERE, r.script),
				...r.argsFor(node),
				...(confirm ? ['--confirm'] : []),
			]);
			if (s.status !== 0)
				return {
					status: 1,
					remedy:
						`the seed for ${r.capability} failed — its output above names the cause. A dead ` +
						'peer, an unwritable destination and a full disk are three different jobs.',
				};
		}
	} else {
		P(`   · python-toolcache, playwright and jitconfig all earned — no seeding owed`);
	}
	// THE JUDGE IS THE SECOND RUN: probe (and, when applying, record) again.
	const judge = run(
		process.execPath,
		[
			resolve(HERE, 'bootcamp.mjs'),
			...bootcampProbeArgs(node, { confirm }),
			...(confirm ? ['--write'] : []),
			...(noPush ? ['--no-push'] : []),
		],
		{ captureJson: true }
	);
	const judgeReport = safeJson(judge.text)?.report?.[node] ?? null;
	if (!judgeReport)
		return {
			status: 1,
			remedy: 'the post-seed bootcamp run produced no report — its output above says why.',
		};
	const missing = plan.filter((r) => !(judgeReport.earned ?? []).includes(r.capability));
	if (missing.length && confirm)
		return {
			status: 1,
			remedy:
				`seeded ${missing.map((m) => m.capability).join(', ')} and bootcamp STILL does not earn ` +
				'it — the seed’s own output above says why the copy did not take.',
		};
	if (missing.length && !confirm)
		P(
			`   · dry run: would seed ${missing.map((m) => m.capability).join(', ')} and re-verify (seeding did not run)`
		);
	if (judge.status !== 0 && confirm)
		return {
			status: 1,
			remedy:
				'bootcamp still reports findings seeding cannot fix — read them above. A BLOCKED ' +
				'toolchain prerequisite or an UNEARNED declared label names the exact gap; that is a ' +
				'node problem, not a chain problem.',
		};
	if (judge.status !== 0 && !confirm)
		P(`   · dry run: bootcamp reports findings (above) that --confirm would have to clear`);
	return { status: 0, earned: judgeReport.earned ?? [] };
}

function benchmarkPhase(node, { confirm }) {
	// ASK FIRST, and ask the question the nightly cron asks. `--report` reads
	// the stored stamps and touches nothing: no ssh, no load, no write.
	const rep = run(
		process.execPath,
		[
			resolve(HERE, 'benchmark-fleet.mjs'),
			'--due',
			String(BENCHMARK_DUE_DAYS),
			'--report',
			'--json',
		],
		{ captureJson: true }
	);
	const verdict = benchmarkStep(safeJson(rep.text), node);
	if (verdict.action === 'fail') return { status: 1, remedy: verdict.why };
	if (verdict.action === 'none') {
		P(`   · ${verdict.why} — nothing to do`);
		return { status: 0 };
	}
	if (!confirm) {
		P(`   · dry run: would measure (${verdict.why})`);
		return { status: 0 };
	}
	P(`   · ${verdict.why} — measuring`);
	const s = run(process.execPath, [
		resolve(HERE, 'benchmark-fleet.mjs'),
		node,
		'--due',
		String(BENCHMARK_DUE_DAYS),
		'--write',
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'benchmark failed or left this node never-measured — its findings above name which. ' +
				'A node the guard refused to overwrite (a degraded record) needs a rooted capture by ' +
				'hand: on the node, `sudo sh scripts/benchmark-node.sh > F`, then ' +
				'`fleet benchmark <node> --from F --write`.',
		};
	return { status: 0 };
}

function healthPhase(node, { confirm }) {
	const manifest = loadManifest();
	const stored = measuredFacets('health', manifest.machines ?? {}).nodes[node];
	const verdict = healthStep(stored, {
		capabilities: manifest.machines?.[node]?.$capabilities ?? null,
	});
	if (verdict.action === 'none') {
		P(`   · ${verdict.why} — nothing to do`);
		return { status: 0 };
	}
	if (verdict.action === 'fail')
		return {
			status: 1,
			remedy:
				`the stored $health record carries BLOCKING findings: ${verdict.why}. Fix the NODE, ` +
				'not the record, then re-run — this step re-probes and records.',
		};
	if (!confirm) {
		P(`   · dry run: would probe and record (${verdict.why})`);
		return { status: 0 };
	}
	const s = run(process.execPath, [
		resolve(HERE, 'lib', 'doctor-run.mjs'),
		'--machine',
		node,
		'--write',
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'doctor recorded BLOCKING findings — the chain ends here: a node is not serving-healthy ' +
				'while $health carries one. The findings above name them; the record is already written.',
		};
	return { status: 0 };
}

/**
 * Bring the manifest checkout level with `origin/main` BEFORE a write — the
 * manual record's step 1 failed on exactly this ("enroll refused to push:
 * checkout behind origin"). FAST-FORWARD ONLY: it cannot lose local work and
 * cannot conflict. A checkout with local commits main does not hold (a failed
 * push leaves one) is the operator's to fix, and the refusal says so.
 *
 * A fetch that fails is a WARNING, not a stop: if this run's writes change no
 * bytes there is nothing to land, and if they do, `landWrite`'s own ancestor
 * test refuses to push blind. "Could not look" is carried, never swallowed.
 */
export function fastForwardManifest(manifestFile, { git = runGit } = {}) {
	const top = git(['rev-parse', '--show-toplevel'], dirname(manifestFile));
	if (top.status !== 0 || !top.stdout.trim())
		return {
			ok: false,
			why: `${dirname(manifestFile)} is not inside a git working tree, so a manifest write can never become a commit: ${top.stderr.trim() || 'no toplevel'}`,
		};
	const repo = resolve(top.stdout.trim());
	if (git(['remote', 'get-url', 'origin'], repo).status !== 0)
		return { ok: true, note: 'no origin remote — nothing to fast-forward from' };
	const fetch = git(['fetch', 'origin', 'main'], repo);
	if (fetch.status !== 0)
		return {
			ok: true,
			note: `could not fetch origin/main (${fetch.stderr.trim().slice(0, 140)}) — continuing; a write that changes bytes will refuse to push rather than push blind`,
		};
	const ff = git(['merge', '--ff-only', 'FETCH_HEAD'], repo);
	if (ff.status !== 0)
		return {
			ok: false,
			why:
				`${repo} cannot be fast-forwarded onto origin/main (${ff.stderr.trim().split('\n')[0]}). ` +
				'The checkout holds local commits main does not, or a dirty tree blocks the merge — ' +
				'push or rebase it by hand, then re-run provision. Every step re-derives its state, ' +
				'so the run resumes where it stopped.',
		};
	return {
		ok: true,
		note: /Already up to date/i.test(ff.stdout)
			? 'already level with origin/main'
			: 'fast-forwarded onto origin/main',
	};
}

/**
 * Write the derived placement fields (and, when earned, `ephemeral`) onto a
 * DECLARED entry and land the commit — the manual record's steps 8, 9 and the
 * `ephemeral` flip as one idempotent write.
 *
 * Exported because it is the WRITE PATH this chain owns, and the fixture test
 * proves it against a scratch checkout: `writeTarget` first (the deploy-tree /
 * not-a-checkout / dirty refusals), surgical assignment (never a replacement —
 * the entry's `$measured`, `$capabilities`, `$health` and every human override
 * survive), `renderJson` (the owning repo's prettier), read it back, `landWrite`.
 *
 * @returns {{ok: boolean, why?: string, note?: string}} plus `note` carrying
 *   the landing line for the caller to print
 */
export async function applyPlacementWrite({
	manifestPath: mp,
	node,
	backfill,
	ephemeral,
	noPush = false,
}) {
	const wrote = [];
	const result = await manifestEdit(
		(doc) => {
			const entry = doc.machines?.[node];
			if (!entry)
				throw new Error(
					`${node} is not in ${mp} — placement writes an EXISTING entry; the declare step creates it`
				);
			for (const [k, v] of Object.entries(backfill ?? {})) {
				entry[k] = v;
				wrote.push(k);
			}
			if (ephemeral) {
				entry.ephemeral = true;
				wrote.push('ephemeral');
			}
			return wrote.length > 0;
		},
		{
			target: mp,
			writer: 'provision',
			reason: () => `placement for ${node}${ephemeral ? ' (ephemeral on)' : ''}`,
			push: !noPush,
		}
	);
	if ('ok' in result && result.ok === false) return { ok: false, why: result.why };
	if (!result.changed)
		return { ok: true, note: 'nothing to write — placement already complete', landed: null };
	const landed = result.landed;
	return {
		ok: landed.ok,
		why: landed.ok ? undefined : landed.why,
		note: `${landingLine(landed, { writer: 'provision' })}${result.formatter ? '' : '\n  ! written UNFORMATTED — no prettier resolved; run the owning repo’s format before pushing'}`,
		fields: wrote,
		landed,
	};
}

export { run, P, declarePhase, convergePhase, bootcampPhase, benchmarkPhase, healthPhase };
