/**
 * `fleet floor-probe candidates` — split out of `scripts/floor-probe.mjs`
 * (wave 5q lane A, ctx restructure) so that file reaches the 800-line
 * ceiling. Takes the CLI's flags and run-scoped state through `ctx`, built
 * once there; never imports the CLI.
 */
import { nodeOf } from '../../dist/runners/census.js';
import { PER_NODE_SAMPLES, buildCandidateList } from './floor-probe-ranking.mjs';
import { flakyVerdicts } from './floor-probe-flaky.mjs';
import { loadLedger } from './floor-probe-state.mjs';
import { demandFor, drainedNodes } from './floor-probe-candidates.mjs';
import { samplesFor, pickBusiestUnit } from './floor-probe-unit-lookup.mjs';
import { parseUnit } from './floor-probe.mjs';

/**
 * The capability set a node has actually PROVEN, per `fleet bootcamp`.
 *
 * §1.1 names `$capabilities.earned` and only that. Measured against the live
 * manifest on 2026-09-08, `earned` is EMPTY on all six claws — bootcamp writes
 * `earned` only for a capability whose surface is a LABEL and which the node
 * also declares, and everything else it proved goes to `prereqs`. Every
 * non-label capability the demand ledger asks for — `python-toolcache` among
 * them, which is exactly what hadoku-pygmalion's `test` job demands and what
 * issue #3 is about — therefore lives in `prereqs` and in no node's `earned`.
 *
 * Reading `earned` alone would exclude every claw for that unit and report a
 * candidate list of zero for a job the fleet demonstrably serves several times
 * a day. That is the "unreadable roster reads as a clean audit" shape, so this
 * reads the UNION and says so. Flagged to the tracker as a disagreement with
 * §1.1 rather than fixed quietly: either the design means "proven", or bootcamp
 * should be promoting prereqs into `earned`, and that is lane P's call.
 */
function provenCapabilities(node, machines) {
	const c = machines[node]?.$capabilities ?? {};
	return new Set([...(c.earned ?? []), ...(c.prereqs ?? []).map((p) => p.id)]);
}

/** §2's `excluded`: eligibility failures the manifest and the ledger state with certainty. */
function exclusionsFor(key, CLAWS, machines) {
	const drained = new Set(drainedNodes());
	const demanded = demandFor(key.repo, key.job);
	const out = [];
	for (const node of CLAWS) {
		if (drained.has(node)) {
			out.push({ node, reason: 'drained' });
			continue;
		}
		if (demanded === null) continue; // could not look — do NOT invent an exclusion
		const have = provenCapabilities(node, machines);
		const missing = [...demanded].filter((c) => !have.has(c));
		if (missing.length) out.push({ node, reason: 'capability', detail: missing.join(', ') });
	}
	return { excluded: out, demandKnown: demandFor(key.repo, key.job) !== null };
}

function routableJobsByNode(rows, NODES) {
	const out = {};
	for (const r of rows) {
		const n = nodeOf(r.runner, NODES);
		out[n] = (out[n] ?? 0) + 1;
	}
	return out;
}

export function modeCandidates(ctx, rows) {
	const { flag, fail, JSON_OUT, emitter, log, NODES, CLAWS, machines } = ctx;
	const key = parseUnit(flag('unit')) ?? pickBusiestUnit(rows, NODES, CLAWS);
	if (!key) fail('no unit — pass --unit "<owner>/<repo>#<job name>"');
	const samples = samplesFor(rows, key, NODES);
	const { excluded, demandKnown } = exclusionsFor(key, CLAWS, machines);
	const list = buildCandidateList({
		key,
		samples,
		roster: CLAWS,
		excluded,
		flaky: flakyVerdicts(loadLedger().filter((e) => e.settled)),
		routableJobsByNode: routableJobsByNode(rows, NODES),
		timeoutSec: Number(flag('timeout-sec')) || undefined,
	});
	if (JSON_OUT) {
		emitter.emit({ ok: true, mode: 'candidates', ...list, demandKnown });
	} else {
		log(
			`Candidates — ${key.repo}#${key.job}   (${list.floorConfidence}, ${list.measuredRuns} measured runs)`
		);
		log(
			'  weakest capable first: the floor is TRIED first, so the fast nodes stay free for bursts'
		);
		log('');
		for (const [i, c] of list.candidates.entries()) {
			const tags = [
				c.flaky && 'FLAKY',
				c.batchLane && 'batch-lane',
				!c.measured && 'unmeasured',
				c.thinSample && `thin-sample (n<${PER_NODE_SAMPLES})`,
			]
				.filter(Boolean)
				.join(' ');
			log(
				`  ${i + 1}. ${c.node.padEnd(8)} p50=${c.p50Sec ?? '—'}  p95=${c.p95Sec ?? '—'}  ` +
					`margin=${c.margin ?? '—'}  n=${c.sampleCount}  ${tags}`
			);
		}
		for (const e of list.excluded)
			log(`  —  ${e.node.padEnd(8)} excluded: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
		log('');
		log(
			'  The roster is the EPHEMERAL nodes. hokon is absent because no placement\n' +
				'  decision here can reach it: it holds standing registrations and GitHub\n' +
				'  assigns to those directly, which is the second of the two assignment paths\n' +
				'  in traffic-model-2026-09-02.md. It still appears in the table, where the\n' +
				'  question is what RAN rather than what could be chosen.'
		);
		const thin = list.candidates.filter((c) => c.thinSample);
		if (thin.length) {
			log('');
			log(
				`  THIN SAMPLE (${thin.map((c) => `${c.node} n=${c.sampleCount}`).join(', ')}): fewer than ` +
					`${PER_NODE_SAMPLES} runs of THIS\n` +
					'  unit on THIS node is not a p50, so it is not ranked and never sorts ahead of\n' +
					'  a node that has ten or more. No 95% interval on a median exists below n=6 at\n' +
					'  all — the number is not wrong, it is unsupported. `table` mode still prints\n' +
					'  it; the sample COUNT is reported here, because three runs is a different\n' +
					'  finding from none.'
			);
		}
		if (!demandKnown) {
			log('');
			log(
				'  NOTE: no demand-ledger record for this unit, so capability exclusions could\n' +
					'  not be computed. That is "I could not look", not "nothing is excluded" —\n' +
					'  run `fleet tool-inventory --write` before trusting the exclusions here.'
			);
		}
	}
	return 0;
}
