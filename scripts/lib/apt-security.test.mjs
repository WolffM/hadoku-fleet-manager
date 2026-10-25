/**
 * apt-security: the policy, its two renderers, and the dry-run judgement.
 *
 * The probe fixtures are claw-4's real output on 2026-10-25, before and after
 * the conf was rewritten — the incident and its fix, verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	AUTO_UPGRADES_CONF,
	aptSecurityPolicy,
	judgeProbe,
	parseProbe,
	renderUnattendedConf,
} from './apt-security.mjs';
import { loadNodeProfiles } from './node-profiles.mjs';
import { tempDir } from './test-tmpdir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = join(HERE, '..', '..', 'manifests', 'node-profiles.json');
const BOOTSTRAP = join(HERE, '..', 'node-bootstrap.sh');

const profiles = () => loadNodeProfiles({ path: PROFILES }).profiles;

test('the package profiles agree on one policy, and it pins the security archive by label', () => {
	const policy = aptSecurityPolicy(profiles());
	assert.deepEqual(policy.originsPattern, [
		'origin=Debian,codename=${distro_codename}-security,label=Debian-Security',
	]);
	assert.equal(policy.automaticReboot, false);
});

test('aptSecurityPolicy refuses the 10-25 shape, a missing block, and profiles that disagree', () => {
	const base = { automaticReboot: false, removeUnusedKernelPackages: true };
	const one = (uu) => new Map([['a', { unattendedUpgrades: uu }]]);
	assert.throws(
		() =>
			aptSecurityPolicy(
				one({ ...base, allowedOrigins: ['${distro_id}:${distro_codename}-security'] })
			),
		/originsPattern must be a non-empty list/
	);
	assert.throws(
		() =>
			aptSecurityPolicy(
				one({ ...base, originsPattern: ['origin=Debian,codename=trixie-security'] })
			),
		/names label=Debian-Security/
	);
	assert.throws(() => aptSecurityPolicy(new Map([['a', {}]])), /declares no unattendedUpgrades/);
	const pat = ['origin=Debian,codename=${distro_codename}-security,label=Debian-Security'];
	assert.throws(
		() =>
			aptSecurityPolicy(
				new Map([
					['a', { unattendedUpgrades: { ...base, originsPattern: pat } }],
					['b', { unattendedUpgrades: { ...base, automaticReboot: true, originsPattern: pat } }],
				])
			),
		/declare different unattendedUpgrades/
	);
});

/**
 * node-bootstrap's step 10, RUN, with `write_file` capturing into a directory.
 * The block between the markers is the bootstrap's whole renderer; if it reads
 * a key this stub does not provide, jq says so and the test fails.
 */
function bootstrapRender(profileJson) {
	const src = readFileSync(BOOTSTRAP, 'utf8');
	const block = /# BEGIN apt-security render\.[\s\S]*?# END apt-security render\./.exec(src)?.[0];
	assert.ok(block, 'node-bootstrap.sh lost its apt-security render markers');
	const dir = tempDir('apt-render-');
	const profile = join(dir, 'profile.json');
	writeFileSync(profile, JSON.stringify(profileJson));
	const script = `set -eu
PROFILE_FILE=${JSON.stringify(profile)}
OUT=${JSON.stringify(dir)}
parr() { jq -r "$1 // empty | .[]" "$PROFILE_FILE"; }
write_file() { local c; c="$(cat)"; printf '%s\\n' "$c" > "$OUT/$(basename "$1")"; }
${block}
`;
	execFileSync('bash', ['-c', script]);
	return {
		auto: readFileSync(join(dir, '20auto-upgrades'), 'utf8'),
		uu: readFileSync(join(dir, '50unattended-upgrades'), 'utf8'),
	};
}

test('node-bootstrap and `fleet apt-security --confirm` write the same bytes from the same profile', () => {
	for (const [id, p] of profiles()) {
		const got = bootstrapRender(p);
		const policy = aptSecurityPolicy(new Map([[id, p]]));
		assert.equal(got.uu, renderUnattendedConf(policy), id);
		assert.equal(got.auto, AUTO_UPGRADES_CONF, id);
		assert.match(got.uu, /^Unattended-Upgrade::Origins-Pattern \{$/m);
		assert.doesNotMatch(got.uu, /Allowed-Origins/);
	}
});

const probe = ({ exit = 0, origins, selected, candidates = '30', timer = 'enabled', tail } = {}) =>
	[
		'BEGIN apt-security',
		`DRYRUN-EXIT ${exit}`,
		origins !== undefined ? `ORIGINS ${origins}` : null,
		selected !== undefined ? `SELECTED ${selected}` : null,
		...(tail ?? []).map((t) => `DRYRUN-TAIL ${t}`),
		`CANDIDATES ${candidates}`,
		'PERIODIC 1 1',
		`TIMER apt-daily.timer ${timer}`,
		'TIMER apt-daily-upgrade.timer enabled',
		'END apt-security',
	]
		.filter((l) => l !== null)
		.join('\n');

test('claw-4 on 10-25, BEFORE: the resolved origin pins nothing and 30 pending are selected by none', () => {
	const p = parseProbe(probe({ origins: 'o=Debian,a=trixie-security' }));
	assert.equal(p.ok, true);
	const drift = judgeProbe(p);
	assert.equal(drift.length, 2, drift.join('\n'));
	assert.match(drift[0], /resolved origins "o=Debian,a=trixie-security".*label=Debian-Security/);
	assert.match(drift[1], /30 security update\(s\) are pending and the dry run selects none/);
});

test('claw-4 on 10-25, AFTER: the pattern resolves and selects — no drift', () => {
	const p = parseProbe(
		probe({
			origins: 'origin=Debian,codename=trixie-security,label=Debian-Security',
			selected: 'ca-certificates curl jq libssl3t64 linux-image-amd64 openssl',
		})
	);
	assert.deepEqual(judgeProbe(p), []);
	assert.equal(p.selected.length, 6);
});

test('a pinned pattern that still selects nothing while updates are pending is drift', () => {
	// The file looks right and the box does not patch: the check is the dry run, not the file.
	const p = parseProbe(
		probe({ origins: 'origin=Debian,codename=trixie-security,label=Debian-Security' })
	);
	assert.deepEqual(
		judgeProbe(p).map((d) => d.slice(0, 20)),
		['30 security update(s']
	);
	// Nothing pending and nothing selected is a patched box.
	assert.deepEqual(
		judgeProbe(
			parseProbe(
				probe({
					candidates: '0',
					origins: 'origin=Debian,codename=trixie-security,label=Debian-Security',
				})
			)
		),
		[]
	);
});

test('a disabled timer or periodic switch is drift, named', () => {
	const p = parseProbe(
		probe({
			timer: 'masked',
			origins: 'origin=Debian,codename=trixie-security,label=Debian-Security',
			selected: 'curl',
		}).replace('PERIODIC 1 1', 'PERIODIC 1 0')
	);
	assert.deepEqual(judgeProbe(p), [
		'apt-config has APT::Periodic::Update-Package-Lists=1 and Unattended-Upgrade=0; both must be 1',
		'apt-daily.timer is masked, not enabled',
	]);
});

test('could not look: a held apt lock, a cut-off answer, an uncountable apt are never drift and never clean', () => {
	const lock = parseProbe(
		probe({
			exit: 1,
			tail: [
				'Cache lock can not be acquired, exiting',
				'upgrade result: False Lock could not be acquired',
			],
		})
	);
	assert.equal(lock.ok, false);
	assert.match(lock.error, /exited 1: Cache lock can not be acquired/);
	assert.equal(parseProbe('BEGIN apt-security\nDRYRUN-EXIT 0\n').ok, false);
	const noCount = parseProbe(probe({ candidates: 'ERR E: dpkg was interrupted' }));
	assert.equal(noCount.ok, false);
	assert.match(
		noCount.error,
		/could not count pending security updates: ERR E: dpkg was interrupted/
	);
});
