/**
 * gh-app — bulk gates move onto a GitHub App installation token
 * (fleet-manager#9). GitHub is a fetch double; the JWT is verified against a
 * real key pair, because a signature nothing checked is how a broken App
 * would first be noticed in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { appCredentials, appJwt, mintInstallationToken, useAppPool } from './gh-app.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
const NOW = Date.now();
const EXPIRES = new Date(NOW + 3600_000).toISOString();

/** A fetch double: `routes` maps `METHOD path` to `[status, body]`, and every call is kept. */
function github(routes) {
	const calls = [];
	const fetchFn = async (url, init) => {
		const key = `${init.method} ${new URL(url).pathname}`;
		calls.push({ key, auth: init.headers.authorization });
		const [status, body] = routes[key] ?? [404, { message: 'Not Found' }];
		return { ok: status < 300, status, text: async () => JSON.stringify(body) };
	};
	return { fetchFn, calls };
}

const installed = {
	'GET /app/installations': [
		200,
		[
			{ id: 7, account: { login: 'someone' } },
			{ id: 42, account: { login: 'WolffM' } },
		],
	],
	'POST /app/installations/42/access_tokens': [201, { token: 'ghs_app', expires_at: EXPIRES }],
};

test('the JWT is RS256, signed by the App key, issued by the App, inside GitHub’s ten minutes', () => {
	const jwt = appJwt('123', KEY, NOW);
	const [h, b, sig] = jwt.split('.');
	assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
	const claims = JSON.parse(Buffer.from(b, 'base64url'));
	assert.equal(claims.iss, '123');
	assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses a JWT living past ten minutes');
	assert.ok(claims.iat < NOW / 1000, 'iat is backdated for clock drift');
	assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, sig, 'base64url'));
});

test('credentials: both id and key or nothing; an escaped key is unescaped', () => {
	assert.equal(appCredentials({ FLEET_GH_APP_ID: '1' }), null);
	assert.equal(appCredentials({ FLEET_GH_APP_KEY: KEY }), null);
	const c = appCredentials({ FLEET_GH_APP_ID: ' 1 ', FLEET_GH_APP_KEY: KEY.replace(/\n/g, '\\n') });
	assert.equal(c.appId, '1');
	assert.equal(c.key, KEY.trim());
	assert.equal(c.installationId, null);
});

test('mint finds the installation on the fleet owner, case-blind, and exchanges the JWT for it', async () => {
	const { fetchFn, calls } = github(installed);
	const t = await mintInstallationToken({ appId: '1', key: KEY }, { owner: 'wolffm', fetchFn });
	assert.deepEqual(t, { token: 'ghs_app', expiresAtMs: Date.parse(EXPIRES), installationId: '42' });
	assert.deepEqual(
		calls.map((c) => c.key),
		['GET /app/installations', 'POST /app/installations/42/access_tokens']
	);
	assert.ok(
		calls.every((c) => c.auth.startsWith('Bearer ')),
		'an App JWT goes as Bearer'
	);
});

test('a given installation id skips the lookup', async () => {
	const { fetchFn, calls } = github(installed);
	await mintInstallationToken(
		{ appId: '1', key: KEY, installationId: '42' },
		{ owner: 'WolffM', fetchFn }
	);
	assert.deepEqual(
		calls.map((c) => c.key),
		['POST /app/installations/42/access_tokens']
	);
});

test('installed elsewhere only: the reason names where it IS installed', async () => {
	const { fetchFn } = github({
		'GET /app/installations': [200, [{ id: 7, account: { login: 'someone' } }]],
	});
	await assert.rejects(
		mintInstallationToken({ appId: '1', key: KEY }, { owner: 'WolffM', fetchFn }),
		/not installed on WolffM \(installed on: someone\)/
	);
});

test('useAppPool sets GH_TOKEN, so every gh this process spawns spends the App pool', async () => {
	const env = { FLEET_GH_APP_ID: '1', FLEET_GH_APP_KEY: KEY };
	const warned = [];
	const r = await useAppPool('reconcile', {
		env,
		owner: 'WolffM',
		fetchFn: github(installed).fetchFn,
		warn: (m) => warned.push(m),
	});
	assert.equal(r.pool, 'app');
	assert.equal(env.GH_TOKEN, 'ghs_app');
	assert.deepEqual(warned, []);
});

test('no App configured: the user pool, said out loud with why', async () => {
	const env = {};
	const warned = [];
	const r = await useAppPool('history-coverage', {
		env,
		owner: 'WolffM',
		warn: (m) => warned.push(m),
	});
	assert.equal(r.pool, 'user');
	assert.equal(env.GH_TOKEN, undefined);
	assert.equal(warned.length, 1);
	assert.match(warned[0], /^history-coverage: spending the USER's GitHub pool/);
	assert.match(warned[0], /FLEET_GH_APP_ID and FLEET_GH_APP_KEY are unset/);
});

test('a mint GitHub refuses: the user pool, carrying GitHub’s own reason', async () => {
	const env = { FLEET_GH_APP_ID: '1', FLEET_GH_APP_KEY: KEY };
	const warned = [];
	const { fetchFn } = github({
		'GET /app/installations': [401, { message: 'A JSON web token could not be decoded' }],
	});
	const r = await useAppPool('reconcile', {
		env,
		owner: 'WolffM',
		fetchFn,
		warn: (m) => warned.push(m),
	});
	assert.equal(r.pool, 'user');
	assert.equal(env.GH_TOKEN, undefined);
	assert.match(
		warned[0],
		/could not be minted: GET \/app\/installations\?per_page=100 answered 401: A JSON web token could not be decoded/
	);
});

test('a GH_TOKEN someone already set is left alone, and nothing is minted', async () => {
	const env = { GH_TOKEN: 'chosen', FLEET_GH_APP_ID: '1', FLEET_GH_APP_KEY: KEY };
	const { fetchFn, calls } = github(installed);
	const r = await useAppPool('reconcile', { env, owner: 'WolffM', fetchFn, warn: () => {} });
	assert.equal(r.pool, 'preset');
	assert.equal(env.GH_TOKEN, 'chosen');
	assert.equal(calls.length, 0);
});
