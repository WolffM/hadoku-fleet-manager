#!/usr/bin/env node
/**
 * fleet hosting-request — read an app's hosting request the way the fleet will.
 *
 *   fleet hosting-request WolffM/hadoku-cardtable     # its shipped hosting.json
 *   fleet hosting-request ./hosting.json              # a draft on disk
 *   (both take --json)
 *
 * The schema and every rule are `lib/hosting-request.mjs`. This prints the
 * NORMALIZED request (defaults filled in, what the planner reads) or every
 * problem with its reason. EXIT 0 only for a valid request. A repo that
 * cannot be read, or ships no hosting.json, is a failure that says which.
 */
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { shipped } from './lib/fleet-source.mjs';
import { validateHostingRequest } from './lib/hosting-request.mjs';

const target = process.argv.slice(2).find((a) => !a.startsWith('-'));
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

function fail(why) {
	log(`hosting-request: ${why}`);
	if (emitter.json) emitter.emit({ ok: false, source: target ?? null, error: why });
	process.exit(1);
}

if (!target) fail('name an app repo (owner/name) or a hosting.json path.');

let text;
let source;
if (existsSync(target)) {
	source = target;
	text = readFileSync(target, 'utf8');
} else {
	source = `${target}:hosting.json`;
	try {
		text = shipped(target).read('hosting.json');
	} catch (err) {
		fail(`cannot read ${target}: ${err.reason ?? err.message}`);
	}
	if (text === null || text === undefined) fail(`${target} ships no hosting.json at its root.`);
}

let raw;
try {
	raw = JSON.parse(text);
} catch (err) {
	fail(`${source} is not JSON: ${err.message}`);
}
const { ok, request, problems } = validateHostingRequest(raw);
if (ok) {
	const { app, kind, slices, network, availability } = request;
	log(`✓ ${source}: ${app} (${kind})`);
	log(
		`  slices: ${slices.min}-${slices.max} × ${slices.unit.memoryMb} MiB / ${slices.unit.cores} cores`
	);
	log(
		`  ingress: ${network.ingress}${network.ports.length ? ` on ${network.ports.join(',')}` : ''}`
	);
	log(
		`  notice: ${availability.noticeMin} min${availability.singleton ? ', singleton' : ''}${availability.stateful ? ', stateful' : ''}`
	);
	log(`  CI may read it: ${request.isolation.ciMayRead ? 'yes' : 'NO'}`);
} else {
	log(`✗ ${source}:`);
	for (const p of problems) log(`  ${p.path || '(root)'}: ${p.why}`);
}
if (emitter.json) emitter.emit({ ok, source, request, problems });
process.exitCode = ok ? 0 : 1;
