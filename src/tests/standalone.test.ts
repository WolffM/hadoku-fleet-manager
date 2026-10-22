import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { chunkForDiscord, standaloneHost } from '../standalone.js';

/** The two paths the service may not guess. Every host below starts from these. */
const PATHS = { FLEET_MANIFEST_DIR: '/m', HADOKU_STATE_DIR: '/s' };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test('chunking keeps every character and never exceeds the limit', () => {
	const text = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(8)).join('\n');
	const parts = chunkForDiscord(text, 200);
	assert.ok(parts.length > 1);
	assert.ok(parts.every((p) => p.length <= 200));
	assert.equal(parts.join('\n'), text);
});

test('an over-long single line is cut, not dropped', () => {
	const parts = chunkForDiscord('x'.repeat(450), 200);
	assert.deepEqual(
		parts.map((p) => p.length),
		[200, 200, 50]
	);
});

test('an alert with no webhook is reported undelivered and recorded, never thrown', async () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		return new Response('{}', { status: 200 });
	}) as typeof fetch;
	const host = standaloneHost({
		...PATHS,
		FLEET_SERVICE_KEY: 'svc',
		MONITORING_API_BASE: 'https://mon.test/health',
	});
	const r = await host.alerts.post('runner down', 'runner-health');
	assert.equal(r.posted, false);
	assert.equal(r.sinkRecorded, true);
	assert.ok(calls.includes('https://mon.test/health/api/unsent-alerts/record'));
});

test('a job record with no address or key is skipped, not thrown — reporting must not stop the fleet', async () => {
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		return new Response('{}');
	}) as typeof fetch;
	await standaloneHost({ ...PATHS, FLEET_SERVICE_KEY: 'svc' }).jobs.recordJobResult(
		'ci:fleet-coverage',
		'succeeded',
		10
	);
	assert.equal(called, false);
});

test('credentials and paths come from the environment the CLI also reads', () => {
	const host = standaloneHost({
		FLEET_GITHUB_TOKEN: ' tok \n',
		HADOKU_STATE_DIR: '/s',
		FLEET_MANIFEST_DIR: '/m',
	});
	assert.equal(host.githubToken(), 'tok');
	assert.equal(host.stateDir, '/s', 'the same variable the CLI reads, so both see one state');
	assert.equal(host.manifestDir, '/m');
	assert.match(host.storeDoctorPath, /scripts\/pnpm-store-doctor\.sh$/);
	assert.equal(host.cronProfilesPath, undefined, 'busy periods arrive as leases, not a schedule');
});

test('the service REFUSES to start without being told where its manifests and state are', () => {
	// Falling back would derive them from a sibling hadoku_site checkout — the
	// coupling this service exists to end. The first version did fall back, and
	// its tests passed on the author's machine only because the sibling existed.
	assert.throws(() => standaloneHost({ HADOKU_STATE_DIR: '/s' }), /FLEET_MANIFEST_DIR is required/);
	assert.throws(() => standaloneHost({ FLEET_MANIFEST_DIR: '/m' }), /HADOKU_STATE_DIR is required/);
});
