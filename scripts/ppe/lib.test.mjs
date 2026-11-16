// The promoter's push credential: fetched from mgmt-api, carried to git as a
// header in the environment, never in a URL or argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CouldNotLook, fetchPushToken, gitEnv } from './lib.mjs';

const answer = (status, body) => async () =>
	new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('a minted token is returned; the service key is what authenticates the ask', async () => {
	let seen;
	const token = await fetchPushToken({
		url: 'https://broker.example/push-token',
		serviceKey: 'svc-key',
		fetchImpl: async (url, init) => {
			seen = { url, method: init.method, key: init.headers['X-User-Key'] };
			return new Response(JSON.stringify({ success: true, token: 'ghs_scoped' }), { status: 200 });
		},
	});
	assert.equal(token, 'ghs_scoped');
	assert.deepEqual(seen, {
		url: 'https://broker.example/push-token',
		method: 'POST',
		key: 'svc-key',
	});
});

test("a refusal is CouldNotLook carrying the broker's reason; never a token", async () => {
	await assert.rejects(
		fetchPushToken({
			serviceKey: 'k',
			fetchImpl: answer(502, { success: false, error: 'GitHub App token: HTTP 422 not granted' }),
		}),
		(e) => e instanceof CouldNotLook && /HTTP 502 .*not granted/.test(e.message)
	);
	await assert.rejects(
		fetchPushToken({ serviceKey: 'k', fetchImpl: answer(200, { success: true }) }),
		(e) => e instanceof CouldNotLook && /no usable token/.test(e.message)
	);
	await assert.rejects(
		fetchPushToken({
			serviceKey: 'k',
			fetchImpl: async () => {
				throw new Error('ECONNREFUSED');
			},
		}),
		(e) => e instanceof CouldNotLook && /unreachable \(ECONNREFUSED\)/.test(e.message)
	);
});

test('the token reaches git as an https extraheader, and nothing else carries it', () => {
	const env = gitEnv('ghs_secret');
	assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
	assert.equal(
		env.GIT_CONFIG_VALUE_0,
		`AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`
	);
	const elsewhere = Object.entries(env).filter(
		([k, v]) => k !== 'GIT_CONFIG_VALUE_0' && String(v).includes('ghs_secret')
	);
	assert.deepEqual(elsewhere, []);
	assert.equal(gitEnv(null).GIT_CONFIG_COUNT, undefined, 'no token, no header');
});
