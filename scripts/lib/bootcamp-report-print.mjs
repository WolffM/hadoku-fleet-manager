/**
 * `fleet bootcamp`'s per-node report printer — split out of
 * scripts/bootcamp.mjs (wave 5p lane D) so the CLI stays under the 800-line
 * ceiling. Takes the CLI's flags and run-scoped state through `ctx`; never
 * imports the CLI.
 */
import { isSeedFinding } from './capability-seeds.mjs';

export function printReport(ctx) {
	const { report, toolResults, seedResultsByNode, WRITE, log } = ctx;
	for (const [name, r] of Object.entries(report).sort()) {
		const failedTools = (toolResults[name] ?? []).filter((t) => t.action === 'failed');
		const seedFindings = (seedResultsByNode[name] ?? []).filter((s) => isSeedFinding(s.status));
		// Under `--write` an unjudged measurement is a run that was asked to record
		// and could not look; without it, nothing was going to be recorded anyway.
		const heldOut = WRITE ? r.inconclusive : [];
		const verdict =
			r.unearned.length ||
			r.blocked.length ||
			failedTools.length ||
			seedFindings.length ||
			heldOut.length ||
			r.idleHold?.undrainFailed
				? 'FAILS'
				: 'PASSES';
		log(`\n── ${name}  ${verdict}`);
		for (const t of toolResults[name] ?? []) {
			if (t.action === 'failed') {
				ctx.findings++;
				log(`   TOOL FAILED: ${t.id} — ${t.detail}`);
			} else if (t.action === 'installed') log(`   installed: ${t.id} — ${t.detail}`);
			else if (t.action === 'advisory') log(`   advisory: ${t.detail}\n     ${t.fix}`);
		}
		for (const s of seedResultsByNode[name] ?? []) {
			if (s.status === 'seeded') {
				log(`   seeded:    ${s.id} — ${s.proof} (pin ${s.pin}, ${s.freeMb} MiB free)`);
			} else if (isSeedFinding(s.status)) {
				ctx.findings++;
				log(`   SEED FAILED: ${s.id} — ${s.reason}`);
			} else if (s.status === 'busy') {
				log(`   seed skipped: ${s.id} — a Runner.Worker is live`);
			}
		}
		if (r.prereqs.length) {
			log(`   proven:    ${r.prereqs.map((p) => `${p.id} (${p.detail})`).join(', ')}`);
		}
		if (r.earned.length) log(`   earned:    ${r.earned.join(', ')}`);
		for (const p of r.jobProofs) log(`   ${p.line}`);
		for (const u of r.unearned) {
			ctx.findings++;
			log(`   UNEARNED:  ${u.id} — declared here but the probe says: ${u.detail}`);
			log(`              work routes here on that label and fails on arrival.`);
		}
		for (const b of r.blocked) {
			ctx.findings++;
			log(`   BLOCKED:   ${b.id} — a toolchain prerequisite this node fails: ${b.detail}`);
			log(`              it should not be carrying general CI until this passes.`);
		}
		for (const n of r.notEarned) {
			// Deliberately lower-case and uncounted: the UPPER-CASE lines above are
			// faults, this is the reason behind an absence.
			log(`   not earned: ${n.id} — ${n.detail}`);
		}
		if (r.idleHold?.status === 'measured') {
			log(
				`   idle re-measure: ${r.idleHold.capabilities.join(', ')} — ` +
					(r.idleHold.heldBy === 'bootcamp'
						? 'drained, waited out, re-measured, undrained'
						: "waited out under someone else's drain (left in place), re-measured")
			);
		}
		if (r.idleHold?.undrainFailed) {
			ctx.findings++;
			log(
				`   STILL DRAINED: bootcamp could not lift its own idle-measurement drain: ${r.idleHold.undrainFailed}`
			);
			log(`              the node is out of service until \`fleet drain ${name} --undo\`.`);
		}
		for (const i of r.inconclusive) {
			// LOUD, and never a verdict: the record on disk stands for this capability.
			const kept = `previous record kept (${i.kept})`;
			if (WRITE) {
				ctx.findings++;
				log(`   INCONCLUSIVE: ${i.id} — ${i.reason}; ${kept}`);
				log(
					`              nothing new was written for it: a busy measurement neither earns nor strips.`
				);
			} else {
				log(`   not judged: ${i.id} — ${i.reason}; ${kept}`);
				log(
					`              read-only run, nothing recorded; \`--write\` drains the node to re-measure idle.`
				);
			}
		}
		for (const u of r.unclaimed) {
			// NO LONGER "capacity the fleet cannot route to". Since the mint and the
			// reconciler derive a node's label offer from `$capabilities.earned`
			// (`nodeOffer`, issue #19), a proven label IS routed to without anybody
			// declaring it. This line records which ones arrived that way.
			log(
				`   unclaimed: ${u} — proven here, declared nowhere; routed from \`earned\`, not a label.`
			);
		}
		for (const id of r.unprobed) {
			ctx.findings++;
			log(`   UNPROBED:  ${id} — required of every node, and the probe never answered.`);
			log(`              The manifest and capability-probe.sh disagree about what exists.`);
		}
		if (!r.prereqs.length && !r.earned.length && !r.unearned.length && !r.blocked.length) {
			// Nothing proven AND nothing failed means the probe told us nothing at all.
			ctx.findings++;
			log(`   NO EVIDENCE: the probe returned no verdict for any declared capability.`);
		}
	}
}
