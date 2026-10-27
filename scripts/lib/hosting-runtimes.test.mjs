import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { KINDS, validateHostingRequest } from './hosting-request.mjs';
import { RUNTIMES, SERVICE_MANAGERS, runtimeFor, runtimeOf } from './hosting-runtimes.mjs';

const ARCHIVEBOT = JSON.parse(
	readFileSync(new URL('./fixtures/hosting-archivebot.json', import.meta.url), 'utf8')
);

test('every runtime serves a known kind, and only an agent waits for an executable', () => {
	for (const [name, r] of Object.entries(RUNTIMES)) {
		assert.ok(KINDS.includes(r.kind), `${name}: kind ${r.kind}`);
		const n = r.names('x-app');
		assert.equal(Boolean(n.exec), r.kind === 'agent', `${name}: exec`);
		assert.equal(Boolean(n.pathUnit), typeof r.pathUnit === 'function', `${name}: path unit`);
	}
	assert.deepEqual(SERVICE_MANAGERS, ['pm2']);
});

test('a service may name any service runtime in the table, and nothing else', () => {
	for (const manager of SERVICE_MANAGERS) {
		const v = validateHostingRequest({ ...ARCHIVEBOT, runtime: { manager } });
		assert.equal(v.ok, true);
		assert.equal(runtimeOf(v.request), manager);
	}
	const v = validateHostingRequest({ ...ARCHIVEBOT, runtime: { manager: 'docker' } });
	assert.match(v.problems.find((p) => p.path === 'runtime.manager').why, /one of pm2/);
});

test('a spec naming no runtime is an error, never an empty unit', () => {
	assert.throws(() => runtimeFor({ app: 'x', runtime: 'docker' }), /no hosting runtime "docker"/);
});
