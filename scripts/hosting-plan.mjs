#!/usr/bin/env node
/**
 * fleet hosting-plan — where could this tenant's next slice go?
 *
 *   fleet hosting-plan WolffM/hadoku-cardtable     # its shipped hosting.json
 *   fleet hosting-plan ./hosting.json              # a draft
 *   (both take --json)
 *
 * Reads the request (`lib/hosting-request.mjs`), measures every claw
 * (`lib/collect-offers.mjs`) and ranks them (`lib/hosting-plan.mjs`). It
 * recommends and changes nothing: a slice is declared with `fleet hosting`,
 * by the operator. EXIT 0 when the plan was made, ranked list empty or not;
 * 1 when the request or a claw could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { collectOffers } from './lib/collect-offers.mjs';
import { createEmitter } from './lib/emit.mjs';
import { loadManifest } from './lib/fleet-exec.mjs';
import { shipped } from './lib/fleet-source.mjs';
import { planFor } from './lib/hosting-plan.mjs';
import { validateHostingRequest } from './lib/hosting-request.mjs';

const target = process.argv.slice(2).find((a) => !a.startsWith('-'));
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

function fail(why) {
	log(`hosting-plan: ${why}`);
	if (emitter.json) emitter.emit({ ok: false, error: why });
	process.exit(1);
}

if (!target) fail('name an app repo (owner/name) or a hosting.json path.');
let text;
try {
	text = existsSync(target) ? readFileSync(target, 'utf8') : shipped(target).read('hosting.json');
} catch (err) {
	fail(`cannot read ${target}: ${err.reason ?? err.message}`);
}
if (text === null || text === undefined) fail(`${target} ships no hosting.json at its root.`);
let parsed;
try {
	parsed = JSON.parse(text);
} catch (err) {
	fail(`${target}'s hosting.json is not JSON: ${err.message}`);
}
const { ok: valid, request, problems } = validateHostingRequest(parsed);
if (!valid)
	fail(`the request is invalid: ${problems.map((p) => `${p.path}: ${p.why}`).join('; ')}`);

const { offers } = await collectOffers(loadManifest());
const plan = planFor(request, offers);
const unit = request.slices.unit;
log(
	`${plan.app}: one slice is ${unit.memoryMb} MiB / ${unit.cores} cores; holds ${plan.held.length} of ${request.slices.max}${plan.held.length ? ` (${plan.held.join(', ')})` : ''}.`
);
log(`CI-may-read policy: ${plan.ciMayReadPolicy}.`);
if (plan.atMax) log('At its maximum: no further slice is offered.');
plan.ranked.forEach((r, i) => {
	log(
		`${String(i + 1).padStart(2)}. ${r.node.padEnd(8)} CI jobs ${r.ciJobs.before} → ${r.ciJobs.after}, ${r.memoryLeftMb} MiB left after${r.cutOver ? ', CI cut over' : ''}`
	);
	if (r.risk) log(`      risk: ${r.risk}`);
});
for (const r of plan.refused) log(`  ✗ ${r.node.padEnd(8)} ${r.reasons.join('; ')}`);
const unreadable = offers.filter((o) => !o.reachable && !o.expectedDown);
if (emitter.json) emitter.emit({ ok: unreadable.length === 0, request, plan });
process.exitCode = unreadable.length === 0 ? 0 : 1;
