/**
 * The guard that makes this extraction safe.
 *
 * Every path below feeds a loader that fails SOFT. Moved out of mgmt-api with a
 * wrong path, nothing throws: the manifest reads as absent, `loadClawNodes()`
 * returns empty, and empty is deliberately interpreted as "unknown → fall back to
 * the label reading" — which is the P2 fixed on 2026-08-27. Measured before the
 * move, on two real runners: clawsOnline 2 with the manifest, 1 without. That
 * number decides whether the fleet declares an outage and promotes the
 * production host.
 *
 * So these assertions are not defensive coding tests. They are the reason a
 * mis-pathed deploy cannot reach production quietly.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	cronProfilesPath,
	githubToken,
	installCliHost,
	installHost,
	logger,
	manifestDir,
	postDiscord,
	recordAlertQuietly,
	recordJobResult,
	storeDoctorPath,
	__setHostForTesting,
	type FleetHost,
} from '../host.js';
import { testHost } from './install-test-host.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REAL_MANIFESTS = resolve(HERE, '..', '..', 'manifests');

function hostWith(over: Partial<FleetHost>): FleetHost {
	return { ...testHost, manifestDir: REAL_MANIFESTS, ...over };
}

test('installHost accepts a host whose manifests all exist', () => {
	assert.doesNotThrow(() =>
		installHost(
			hostWith({
				storeDoctorPath: resolve(REAL_MANIFESTS, 'fleet-runner-manifest.json'),
				cronProfilesPath: resolve(REAL_MANIFESTS, 'fleet-runner-manifest.json'),
			})
		)
	);
	__setHostForTesting(testHost);
});

test('a missing manifest DIRECTORY throws, naming every file it could not find', () => {
	assert.throws(
		() => installHost(hostWith({ manifestDir: '/nonexistent/fleet-manifests' })),
		(err: Error) => {
			assert.match(err.message, /required path\(s\) do not exist/);
			assert.match(err.message, /fleet-runner-manifest\.json/, 'must name the fleet manifest');
			assert.match(err.message, /fleet-runner-coverage\.json/, 'must name the coverage file');
			assert.match(err.message, /fails SOFT/, 'must say WHY this is fatal');
			return true;
		}
	);
	__setHostForTesting(testHost);
});

test('a missing store-doctor or cron-profiles path throws too', () => {
	for (const key of ['storeDoctorPath', 'cronProfilesPath'] as const) {
		assert.throws(
			() => installHost(hostWith({ [key]: '/nonexistent/thing.sh' })),
			new RegExp(key),
			`${key} must be required, not optional`
		);
	}
	__setHostForTesting(testHost);
});

test('an unset stateDir throws — job history would land somewhere unowned', () => {
	assert.throws(
		() =>
			installHost(
				hostWith({
					stateDir: '',
					storeDoctorPath: resolve(REAL_MANIFESTS, 'fleet-runner-manifest.json'),
					cronProfilesPath: resolve(REAL_MANIFESTS, 'fleet-runner-manifest.json'),
				})
			),
		/stateDir is required/
	);
	__setHostForTesting(testHost);
});

test('using a fleet module with no host installed throws, rather than reading empty', () => {
	__setHostForTesting(null);
	// This accessor is what every manifest loader calls. It must REFUSE rather
	// than return a default, because every one of those loaders turns a failed
	// read into an empty result — which reads as a healthy fleet with nothing in
	// it, not as an error.
	assert.throws(() => manifestDir(), /host not installed/);
	__setHostForTesting(testHost);
});

test('installCliHost refuses to replace an installed host (it must never mask mgmt-api)', () => {
	__setHostForTesting(testHost);
	assert.throws(
		() =>
			installCliHost({ logger: testHost.logger, manifestDir: REAL_MANIFESTS, stateDir: '/tmp/x' }),
		/already installed/
	);
});

test('a CLI host serves logging and paths, and THROWS on alerts, the job sink and the doctor path', async () => {
	__setHostForTesting(null);
	try {
		assert.throws(() => manifestDir(), /host not installed/);
		const lines: string[] = [];
		installCliHost({
			logger: {
				info: (m) => lines.push(m),
				warn: (m) => lines.push(m),
				error: (m) => lines.push(m),
			},
			manifestDir: REAL_MANIFESTS,
			stateDir: '/tmp/x',
		});
		assert.equal(manifestDir(), REAL_MANIFESTS);
		logger.info('hello');
		assert.deepEqual(lines, ['hello']);
		assert.throws(() => recordAlertQuietly('x', 's'), /not available to a CLI host/);
		assert.throws(() => void postDiscord('x', 's'), /not available to a CLI host/);
		assert.throws(() => void recordJobResult('j', 'failed', 1), /not available to a CLI host/);
		assert.throws(() => storeDoctorPath(), /not available to a CLI host/);
		assert.throws(() => cronProfilesPath(), /not available to a CLI host/);
		assert.throws(() => githubToken() ?? assert.fail('no token is undefined'), /no token/);
	} finally {
		__setHostForTesting(testHost);
	}
});

test('installCliHost throws on a manifestDir that does not exist', () => {
	__setHostForTesting(null);
	try {
		assert.throws(
			() =>
				installCliHost({
					logger: testHost.logger,
					manifestDir: '/nonexistent-dir',
					stateDir: '/tmp/x',
				}),
			/manifestDir does not exist/
		);
	} finally {
		__setHostForTesting(testHost);
	}
});
