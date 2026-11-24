#!/usr/bin/env node
/**
 * `fleet garage-layout`: the storage pool's Garage layout and tenant buckets,
 * declared against observed (storage bootcamp F6, hadoku-fleet-manager#141).
 *
 *   fleet garage-layout                     the plan; touches nothing (a dry run)
 *   fleet garage-layout --apply             carry it out: bring-up, layout, buckets
 *   fleet garage-layout --apply --override "<reason>"   past a refused rule, recorded
 *   fleet garage-layout --declare claw-9 --disk SERIAL=800G[,SERIAL=...]
 *   fleet garage-layout --declare claw-1 --root 200G     a fixed quota on `/`
 *   fleet garage-layout --drain claw-9      take it out (drain before remove)
 *   fleet garage-layout --forget claw-9     drop a drained zone's declaration
 *   fleet garage-layout --bucket photos [--key dp-photos]   bucket dp-photos for a tenant
 *
 * The declared pool is garage-layout.json (garage-layout-state.mjs, its one
 * writer); the rules and the plan are garage-layout.mjs; the reads and the
 * writes on nodes are garage-apply.mjs. A declaration only edits the file:
 * nothing reaches a node until `--apply`, which re-reads after bring-up and
 * applies only what the re-read plan still allows.
 *
 * Secrets come from this process's environment (`GARAGE_RPC_SECRET`,
 * `GARAGE_ADMIN_TOKEN`; run under dev-vault). Absent, a zone's bring-up is
 * BLOCKED and says so; the plan still prints.
 */
import { lookup } from 'node:dns/promises';
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { parseStrict } from './lib/argv.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { runOn } from './lib/fleet-exec.mjs';
import { RPC_PORT, nodeAdmin } from './lib/garage-admin.mjs';
import {
	applyBringUp,
	applyBuckets,
	applyLayout,
	observe,
	observeBuckets,
	stopZone,
} from './lib/garage-apply.mjs';
import { bucketAlias, parseSize, planBuckets, planLayout } from './lib/garage-layout.mjs';
import {
	declareBucket,
	declareZone,
	declaredPath,
	drainZone,
	forgetZone,
	readDeclared,
	recordOverride,
	updateDeclared,
} from './lib/garage-layout-state.mjs';
import { readQualifyResults } from './lib/qualify-results.mjs';
import { GARAGE_SECRET_ITEMS } from './lib/toolchain-garage.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';

const args = parseStrict(ARGV_SPECS['garage-layout.mjs'], process.argv.slice(2));
const emitter = createEmitter({ argv: process.argv });
const log = (m) => emitter.log(m);
const finish = (doc, code) => {
	if (emitter.json) emitter.emit(doc);
	process.exit(code);
};
const fail = (error) => {
	log(`fleet garage-layout: ${error}`);
	finish({ ok: false, error }, 1);
};
const at = new Date().toISOString();

// ── declarations: edit the file, touch no node ───────────────────────────────
const declare = args.value('--declare');
const drain = args.value('--drain');
const forget = args.value('--forget');
const bucket = args.value('--bucket');
if (declare || drain || forget || bucket) {
	try {
		const next = updateDeclared((d) => {
			if (declare) {
				const disks = [];
				for (const part of (args.value('--disk') ?? '').split(',').filter(Boolean)) {
					const [serial, size] = part.split('=');
					const capacityBytes = parseSize(size);
					if (!serial || !capacityBytes)
						throw new Error(`--disk ${part}: want SERIAL=SIZE (800G, 3.2T)`);
					disks.push({ serial, capacityBytes });
				}
				const root = args.value('--root');
				if (root) {
					const capacityBytes = parseSize(root);
					if (!capacityBytes) throw new Error(`--root ${root}: want a size (200G)`);
					disks.push({ serial: null, capacityBytes, root: true });
				}
				if (!disks.length) throw new Error('--declare needs --disk SERIAL=SIZE or --root SIZE');
				return declareZone(d, declare, disks, at);
			}
			if (drain) return drainZone(d, drain, at);
			if (forget) {
				if (d.zones[forget]?.state !== 'drain') {
					throw new Error(
						`${forget} is not a draining zone; --drain it and let the plan say it is drained first`
					);
				}
				return forgetZone(d, forget);
			}
			bucketAlias(bucket);
			return declareBucket(d, bucket, args.value('--key') ?? bucketAlias(bucket), at);
		});
		log(`fleet garage-layout: ${declaredPath()} updated; \`fleet garage-layout\` shows the plan`);
		finish({ ok: true, declared: next }, 0);
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
}

// ── the plan ─────────────────────────────────────────────────────────────────
const { declared, error } = readDeclared();
if (error) fail(error);
if (!Object.keys(declared.zones).length && !Object.keys(declared.buckets).length) {
	log(
		'fleet garage-layout: nothing is declared; `--declare <node> --disk SERIAL=SIZE` starts a pool'
	);
	finish({ ok: true, declared, plan: null }, 0);
}

// Named literally so the env-reads guard sees them; the items are GARAGE_SECRET_ITEMS.
const secrets = {
	GARAGE_RPC_SECRET: process.env.GARAGE_RPC_SECRET ?? '',
	GARAGE_ADMIN_TOKEN: process.env.GARAGE_ADMIN_TOKEN ?? '',
};
const secretsMissing = GARAGE_SECRET_ITEMS.filter((i) => !secrets[i]);
const ctx = {
	exec: (node, script, opts = {}) => runOn(node, script, { as: 'admin', ...opts }),
	admin: (node) =>
		nodeAdmin(node, (script) => runOn(node, script, { as: 'admin', timeoutMs: 30_000 })),
	rpcAddr: async (node) => `${(await lookup(node)).address}:${RPC_PORT}`,
	secrets,
	log,
};
const override = args.value('--override');

async function planNow() {
	const seen = await observe(ctx, declared);
	const plan = planLayout({
		declared,
		cluster: seen.cluster,
		state: seen.state,
		zones: seen.zones,
		// F2's verdicts: a zone's disks must have passed qualification.
		ledger: readQualifyResults(stateDir()),
		override,
		secretsMissing,
	});
	let buckets = null;
	if (seen.cluster) {
		const admin = ctx.admin(seen.via);
		buckets = planBuckets({
			declared,
			observed: await observeBuckets(admin, declared),
			buckets: seen.cluster.buckets ?? [],
		});
	}
	return { seen, plan, buckets };
}

const gb = (b) => (b === null || b === undefined ? '—' : `${(b / 1e9).toFixed(1)} GB`);
function render({ seen, plan, buckets }) {
	log(
		`\n══ garage pool  ${seen.cluster ? `read via ${seen.via}, layout v${seen.cluster.layout.version}` : seen.why}`
	);
	for (const [node, z] of Object.entries(seen.zones)) {
		log(`   ${node.padEnd(9)} ${z.probe}${z.why ? ` — ${z.why}` : ''}`);
	}
	log('\n   bring-up');
	if (!plan.bringUp.length) log('     none');
	for (const s of plan.bringUp)
		log(`     ${s.blocked ? 'BLOCKED ' : ''}${s.node} ${s.step}: ${s.why}`);
	log('   layout');
	if (!plan.changes.length) log('     no change');
	for (const c of plan.changes)
		log(`     ${c.node} ${c.kind}${c.kind === 'stop' ? '' : `: ${gb(c.from)} → ${gb(c.to)}`}`);
	log('   rules');
	for (const c of plan.checks) {
		log(`     ${c.status.toUpperCase().padEnd(14)} ${c.rule.padEnd(9)} ${c.why}`);
	}
	for (const w of plan.waiting) log(`   WAIT ${w.node}: ${w.why}`);
	for (const k of plan.known) log(`   known ${k.node}: ${k.why}`);
	if (buckets) {
		log('   buckets');
		if (!buckets.ops.length && !buckets.problems.length) log('     as declared');
		for (const o of buckets.ops)
			log(`     ${o.ns}: ${o.op}${o.alias ? ` ${o.alias}` : ''}${o.key ? ` key ${o.key}` : ''}`);
		for (const p of buckets.problems) log(`     COULD NOT LOOK ${p.ns}: ${p.why}`);
		for (const a of buckets.undeclared) log(`     undeclared ${a}: left as it is`);
	} else if (Object.keys(declared.buckets).length) {
		log(
			`   buckets  ${Object.keys(declared.buckets).length} declared; created once the layout is applied`
		);
	}
	if (plan.refused) {
		log(
			plan.checks.some((c) => c.status === 'could-not-look')
				? '\n   REFUSED: something could not be read; no override passes that'
				: '\n   REFUSED: a rule breaks; `--override "<reason>"` goes ahead and records why'
		);
	} else if (plan.overridden.length) {
		log(`\n   OVERRIDDEN (${plan.overridden.join(', ')}): ${override}`);
	}
}

const summary = ({ seen, plan, buckets }) => ({
	via: seen.via,
	clusterWhy: seen.why,
	zones: seen.zones,
	state: seen.state,
	plan,
	buckets,
});

const first = await planNow();
render(first);
if (!args.has('--apply')) {
	log('\n   dry run: `--apply` carries it out');
	finish(
		{ ok: !first.plan.refused, applied: false, ...summary(first) },
		first.plan.refused ? 1 : 0
	);
}
if (first.plan.refused) finish({ ok: false, applied: false, ...summary(first) }, 1);
if (first.plan.blocked) {
	log('\n   BLOCKED: a bring-up step cannot run (above); nothing was applied on any node');
	finish({ ok: false, applied: false, ...summary(first) }, 1);
}

try {
	if (first.plan.bringUp.length) {
		log('\n── bring-up');
		await applyBringUp(ctx, first.plan.bringUp);
	}
	// Re-read: the layout is applied from what the nodes say NOW.
	const now = first.plan.bringUp.length ? await planNow() : first;
	if (now !== first) render(now);
	if (now.plan.refused || now.plan.bringUp.length) {
		fail('after bring-up the plan is still refused or still waits on bring-up; nothing applied');
	}
	if (now.plan.overridden.length) {
		updateDeclared((d) => recordOverride(d, now.plan.overridden, override, at));
	}
	const via =
		now.seen.via ?? Object.keys(now.seen.zones).find((n) => now.seen.zones[n].probe === 'ok');
	if (now.plan.layout) {
		log(`\n── layout v${now.plan.layout.version}`);
		await applyLayout(ctx, via, now.plan.layout, now.seen.zones);
	}
	for (const c of now.plan.changes.filter((x) => x.kind === 'stop')) {
		log(`── stop ${c.node}`);
		await stopZone(ctx, c.node);
	}
	if (via && Object.keys(declared.buckets).length) {
		const admin = ctx.admin(via);
		const b = planBuckets({ declared, observed: await observeBuckets(admin, declared) });
		if (b.problems.length)
			fail(`buckets could not be read: ${b.problems.map((p) => p.why).join('; ')}`);
		if (b.ops.length) {
			log('── buckets');
			await applyBuckets(ctx, admin, b.ops);
		}
	}
	const after = await planNow();
	render(after);
	finish({ ok: true, applied: true, ...summary(after) }, 0);
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}
