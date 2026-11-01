/**
 * `fleet floor-probe table` — split out of `scripts/floor-probe.mjs` (wave 5q
 * lane A, ctx restructure) so that file reaches the 800-line ceiling. Takes
 * the CLI's flags and run-scoped state through `ctx`, built once there; never
 * imports the CLI.
 */
import { flakyVerdicts } from './floor-probe-flaky.mjs';
import { loadLedger } from './floor-probe-state.mjs';
import { mergeProbeProvenance } from './floor-probe-table.mjs';
import { unitTable } from './floor-probe-rows.mjs';
import { samplesFor, pickBusiestUnit } from './floor-probe-unit-lookup.mjs';
import { parseUnit } from './floor-probe.mjs';

export function modeTable(ctx, rows) {
	const { flag, fail, JSON_OUT, emitter, log, NODES, CLAWS } = ctx;
	const key = parseUnit(flag('unit')) ?? pickBusiestUnit(rows, NODES, CLAWS);
	if (!key) fail('no unit to table — pass --unit "<owner>/<repo>#<job name>"');
	const fromHistory = samplesFor(rows, key, NODES);
	const { samples, tagged, extra } = mergeProbeProvenance(key, fromHistory);
	if (!samples.length) {
		fail(`no records for ${key.repo}#${key.job} — a table of zero samples is not a table`, { key });
	}
	const t = unitTable({ key, samples, roster: CLAWS });
	t.fromHistory = fromHistory.length;
	t.taggedByLedger = tagged;
	t.fromProbeLedgerOnly = extra;
	const verdicts = flakyVerdicts(loadLedger().filter((e) => e.settled));

	if (JSON_OUT) {
		emitter.emit({ ok: true, mode: 'table', ...t, flaky: verdicts });
	} else {
		log(`Per-node table — ${key.repo}  job "${key.job}"   (n=${t.total})`);
		log(
			`  ${t.fromHistory} from job-history (${t.taggedByLedger} of them tagged by the probe ` +
				`ledger), ${t.fromProbeLedgerOnly} the poller has not ingested yet`
		);
		log('');
		log('  node     samples  organic  shadow   rerun  pinned   p50     p95   fails  cxl  zones');
		for (const r of t.rows) {
			const zones = Object.entries(r.zones)
				.map(([z, n]) => `${z}:${n}`)
				.join(' ');
			log(
				`  ${r.node.padEnd(8)} ${String(r.samples).padStart(7)} ${String(r.organic).padStart(8)} ` +
					`${String(r.shadow).padStart(7)} ${String(r.rerun).padStart(7)} ${String(r.pinned).padStart(7)} ` +
					`${(r.p50Sec === null ? '—' : `${r.p50Sec}s`).padStart(6)} ` +
					`${(r.p95Sec === null ? '—' : `${r.p95Sec}s`).padStart(6)} ` +
					`${String(r.failures).padStart(6)} ${String(r.cancelled).padStart(4)}  ${zones}`
			);
		}
		if (verdicts.length) {
			log('');
			for (const v of verdicts) log(`  FLAKY  ${v.node}  ${v.repo}#${v.job}`);
		}
		log('');
		log(
			'  organic / shadow / rerun are counted apart on purpose: a RERUN sample exists\n' +
				'  BECAUSE something already failed, so its failure rate is conditioned on\n' +
				'  failure and is never a rate. PINNED is the subset of manufactured samples\n' +
				'  that landed on the node they were aimed at — the only column that is\n' +
				'  evidence about THAT node. A row with samples=0 is a node that produced\n' +
				'  nothing, not a node that is fine.'
		);
	}
	return 0;
}
