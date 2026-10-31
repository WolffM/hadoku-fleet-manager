/**
 * The profile loader must THROW on everything it cannot answer.
 *
 * The failure this suite exists against is not "a profile was wrong". It is a
 * loader that hands back `{}` for a manifest it could not read, and a caller
 * that then images a node with no power policy, no sudo model and no trusted
 * CIDR — every one of which reads downstream as "the profile did not ask for
 * it". `host.ts` measured the same shape one layer up: census with an EMPTY
 * manifest reported `clawsOnline 1` where the real one reported 2, and nothing
 * threw.
 *
 * MUTATION-AIMED, per docs/planning/handoff-2026-08-30.md §4. Every fixture
 * below starts from a profile that is VALID and breaks exactly one thing, so
 * deleting the guard under test makes the case pass and the assertion fail.
 * A fixture that was already invalid for a second reason would keep passing
 * with the guard removed, which is the vacuous test that handoff describes.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { loadNodeProfiles, nodeProfile, profileIds, profileManifestPath } =
	await import('./node-profiles.mjs');
// The BUILT registry, the same copy the loader itself validates against — so a
// fixture that names a capability cannot drift from what `verify` really says.
const { capability } = await import('../../dist/capabilities.js');

const SHIPPED = fileURLToPath(new URL('../../manifests/node-profiles.json', import.meta.url));

/** The real manifest, so a fixture is a MUTATION of something that works. */
function realDoc() {
	return JSON.parse(readFileSync(SHIPPED, 'utf8'));
}

/** Write a doc to a throwaway file and return its path. */
function fixture(doc) {
	const dir = mkdtempSync(join(tmpdir(), 'node-profiles-'));
	const path = join(dir, 'node-profiles.json');
	writeFileSync(path, JSON.stringify(doc, null, 2));
	return path;
}

/** Mutate one profile of the shipped manifest and load it. */
function mutated(id, mutate) {
	const doc = realDoc();
	mutate(doc.profiles[id]);
	return fixture(doc);
}

const cleanup = [];
process.on('exit', () => {
	for (const p of cleanup) rmSync(join(p, '..'), { recursive: true, force: true });
});
const keep = (p) => (cleanup.push(p), p);

// ── the shipped manifest is the first fixture ───────────────────────────────

test('the shipped manifest loads, and declares exactly the two profiles', () => {
	const { profiles } = loadNodeProfiles({ path: SHIPPED });
	assert.deepEqual(
		[...profiles.keys()],
		['desktop-debian-trixie', 'laptop-debian-trixie'],
		'ship exactly two: one for the new hardware, one describing the claws that ' +
			'already exist. A format proven only against the case it was invented for is ' +
			'not proven.'
	);
});

test('a desktop can say it has no lid, and a laptop says something different', () => {
	// The whole reason `lid` is not a boolean "doNotSuspend". Every power
	// assumption in this repo was laptop-shaped until 2026-08-30, and
	// node-bootstrap.sh REFUSES to run a `lid: none` profile on a box that has a
	// lid switch — which it can only do because the two are distinguishable.
	assert.equal(nodeProfile('desktop-debian-trixie', { path: SHIPPED }).power.lid, 'none');
	assert.equal(nodeProfile('laptop-debian-trixie', { path: SHIPPED }).power.lid, 'ignore');
});

test('the laptop profile carries the vendor kernel the --surface flag used to', () => {
	const p = nodeProfile('laptop-debian-trixie', { path: SHIPPED });
	const surface = p.os.kernelExtras['Microsoft Corporation'];
	assert.ok(surface, 'keyed by /sys/class/dmi/id/sys_vendor, so the node derives it');
	assert.ok(surface.packages.includes('linux-image-surface'));
	assert.ok(
		surface.forbidPackages.includes('tlp'),
		'the retrospective records TLP hanging Surface hardware'
	);
});

// ── refusals ────────────────────────────────────────────────────────────────

test('a missing manifest THROWS; it never yields an empty profile set', () => {
	assert.throws(
		() => loadNodeProfiles({ path: '/nonexistent/node-profiles.json' }),
		/cannot read .*node-profiles\.json/
	);
});

test('a manifest with zero profiles is a failure, not an empty fleet', () => {
	const path = keep(fixture({ version: 1, profiles: { $comment: 'all prose, no profiles' } }));
	assert.throws(() => loadNodeProfiles({ path }), /declares no profiles/);
});

test('an unknown profile id names what IS declared instead of defaulting', () => {
	assert.throws(
		() => nodeProfile('desktop-omarchy', { path: SHIPPED }),
		/no profile "desktop-omarchy".*Declared: desktop-debian-trixie, laptop-debian-trixie/s
	);
});

test('omitting kernelExtras is refused; declaring it EMPTY is accepted', () => {
	// The distinction the --surface flag never had. `{}` says "no chassis vendor
	// here needs a kernel of its own"; a missing key says nobody decided, and
	// silently images a Surface with the stock kernel.
	const omitted = keep(
		mutated('desktop-debian-trixie', (p) => {
			delete p.os.kernelExtras;
		})
	);
	assert.throws(() => loadNodeProfiles({ path: omitted }), /kernelExtras is missing/);

	const empty = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.os.kernelExtras = {};
		})
	);
	assert.doesNotThrow(() => loadNodeProfiles({ path: empty }));
});

test('omitting toolchain.thirdPartySources is refused; declaring it EMPTY is accepted', () => {
	// Same distinction as kernelExtras, one level down: `{}` says "every
	// package in toolchain.packages resolves from the base archive"; a missing
	// key means nobody decided, which is how P1.5's `gh` — not in trixie's own
	// archive — would have shipped in a package list apt cannot satisfy, with
	// nothing in this file saying why.
	const omitted = keep(
		mutated('desktop-debian-trixie', (p) => {
			delete p.toolchain.thirdPartySources;
		})
	);
	assert.throws(() => loadNodeProfiles({ path: omitted }), /thirdPartySources is missing/);

	const empty = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.toolchain.thirdPartySources = {};
		})
	);
	assert.doesNotThrow(() => loadNodeProfiles({ path: empty }));
});

test('a third-party source missing aptKeyUrl or aptList is refused', () => {
	// A source with a repo line and no key, or a key and no repo line, installs
	// nothing — `apt-get update` fails on the dangling half either way, and
	// silently letting either be absent would ship that failure to a fresh box
	// instead of catching it here.
	for (const field of ['aptKeyUrl', 'aptKeyPath', 'aptList']) {
		const path = keep(
			mutated('desktop-debian-trixie', (p) => {
				delete p.toolchain.thirdPartySources['github-cli'][field];
			})
		);
		assert.throws(
			() => loadNodeProfiles({ path }),
			new RegExp(`thirdPartySources\\["github-cli"\\]\\.${field} must be a non-empty string`)
		);
	}
});

test('both shipped profiles carry the github-cli source for the gh package', () => {
	// P1.5: gh is not in trixie's own archive, so the package alone (added to
	// toolchain.packages) is not enough — GitHub's source has to be added
	// first, or apt-get install fails on it outright. This is the fixture
	// against which docs/handoff/ws-c.md's "fresh-profile dry run shows gh in
	// the package list" was actually checked.
	for (const id of ['desktop-debian-trixie', 'laptop-debian-trixie']) {
		const p = nodeProfile(id, { path: SHIPPED });
		assert.ok(p.toolchain.packages.includes('gh'), `${id}: gh missing from toolchain.packages`);
		const src = p.toolchain.thirdPartySources['github-cli'];
		assert.ok(src, `${id}: no github-cli entry in thirdPartySources`);
		assert.match(src.aptKeyUrl, /^https:\/\//);
		assert.match(src.aptList, /githubcli-archive-keyring\.gpg/);
	}
});

test('a lid state outside {none, ignore} is refused rather than coerced', () => {
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.power.lid = 'closed';
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /power\.lid is "closed"; expected one of/);
});

test('trustedCidrs missing the LAN is refused — that is the fail2ban lockout', () => {
	// 2026-03-03: fail2ban banned the operator's own workstation after a client
	// offered several keys, and the ban SURVIVED `ufw disable` because fail2ban
	// writes nftables rules directly. Everything else in the fixture is valid,
	// so this case is unreachable unless the guard is there.
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.network.trustedCidrs = p.network.trustedCidrs.filter((c) => c !== p.network.lanCidr);
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /does not include lanCidr/);
});

test('trustedCidrs missing loopback is refused too', () => {
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.network.trustedCidrs = p.network.trustedCidrs.filter((c) => !c.startsWith('127.'));
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /does not include a loopback range/);
});

test('MaxAuthTries below 4 is refused', () => {
	// The exact v4 value. A client whose agent offers every key it holds exhausts
	// 3 attempts before the server ever reaches password auth.
	const path = keep(
		mutated('laptop-debian-trixie', (p) => {
			p.network.sshd.maxAuthTries = 3;
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /maxAuthTries must be an integer >= 4/);
});

test('a capability the registry does not define is refused', () => {
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.capabilities = ['ffmpeg', 'rustc'];
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /claims "rustc", which src\/capabilities\.ts/);
});

test('a capability no PROBE can execute is refused, even though it is real', () => {
	// `taskauto` is a genuine registry capability with `verify: 'role'`. A profile
	// claiming it would claim something node-bootstrap.sh cannot demonstrate — and
	// the toolchain floor is exactly the set of things that get executed and
	// observed. This is the case that registry-membership alone would let through.
	//
	// It was `pm2-host` until 2026-09-15, when #6 made that one PROBED — which is
	// why the example is asserted against the registry rather than assumed: a
	// fixture naming a capability whose `verify` has moved makes this test pass
	// for the wrong reason, or fail for one that is not about profiles at all.
	assert.equal(capability('taskauto')?.verify, 'role', 'the fixture must still be role-verified');
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.capabilities = ['ffmpeg', 'taskauto'];
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /whose verification is "role", not "probe"/);
});

test('pm2-host is admissible in an imaging floor now that a probe settles it', () => {
	// The other half of the move, and the reason the swap above is not just a
	// rename: `pm2-host` must now PASS this gate. A registry entry that slid back
	// to `verify: 'role'` would make the test above pass and this one fail, so the
	// pair cannot both be green against a reverted registry.
	assert.equal(capability('pm2-host')?.verify, 'probe');
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.capabilities = ['ffmpeg', 'pm2-host'];
		})
	);
	assert.doesNotThrow(() => loadNodeProfiles({ path }));
});

test('a watchdog load trigger is refused, at any value', () => {
	const path = keep(
		mutated('laptop-debian-trixie', (p) => {
			p.power.watchdog.maxLoadPerCore = 8;
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /maxLoadPerCore is refused/);
});

test('an empty required list is refused — it reads as a forgotten one', () => {
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.power.maskSleepTargets = [];
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /maskSleepTargets is empty/);
});

test('a malformed lanCidr is refused rather than passed to ufw', () => {
	const path = keep(
		mutated('desktop-debian-trixie', (p) => {
			p.network.lanCidr = '192.0.2.0';
			p.network.trustedCidrs = ['127.0.0.1/8', '192.0.2.0'];
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /is not an IPv4 CIDR/);
});

test('$-prefixed keys are prose everywhere and are never validated', () => {
	// The repo has been bitten three times by prose being read as evidence
	// (handoff §2). Here the direction is the other one — prose must not be read
	// as a DECLARATION either. `$why` beside a vendor key must not be validated
	// as a vendor.
	const ids = profileIds({ path: SHIPPED });
	assert.ok(!ids.some((i) => i.startsWith('$')));
	const p = nodeProfile('laptop-debian-trixie', { path: SHIPPED });
	assert.ok(p.os.kernelExtras.$why, 'the prose is still there, it is just not a vendor');
});

// ── resolution ──────────────────────────────────────────────────────────────

test('the manifest is resolved through FLEET_MANIFEST_DIR, not __dirname', () => {
	// A `__dirname` walk resolves into node_modules once this package is
	// installed, and every reader behind it degrades quietly. This is the same
	// property paths.test.mjs pins for siteRoot().
	const dir = mkdtempSync(join(tmpdir(), 'fleet-manifests-'));
	const prev = process.env.FLEET_MANIFEST_DIR;
	try {
		process.env.FLEET_MANIFEST_DIR = dir;
		assert.equal(profileManifestPath(), join(dir, 'node-profiles.json'));
		// And it still THROWS, because the directory is real but the file is not.
		assert.throws(() => loadNodeProfiles(), /cannot read/);
	} finally {
		if (prev === undefined) delete process.env.FLEET_MANIFEST_DIR;
		else process.env.FLEET_MANIFEST_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a FLEET_MANIFEST_DIR that does not exist throws naming it', () => {
	const prev = process.env.FLEET_MANIFEST_DIR;
	try {
		process.env.FLEET_MANIFEST_DIR = '/nonexistent/manifests';
		assert.throws(() => profileManifestPath(), /FLEET_MANIFEST_DIR does not exist/);
	} finally {
		if (prev === undefined) delete process.env.FLEET_MANIFEST_DIR;
		else process.env.FLEET_MANIFEST_DIR = prev;
	}
});

/**
 * THE ROUND TRIP: what usb-prep WRITES must be what its verifier READS.
 *
 * These two disagreed until 2026-08-30. `show <id>` emits one ALREADY-RESOLVED
 * profile — the shape `node-bootstrap.sh` reads on the node with plain jq,
 * because a freshly imaged box has jq and no fleet tooling. The verifier called
 * `show --file` on that file, which runs the MANIFEST loader and demands a
 * top-level `.profiles`.
 *
 * No test fed one command's output to the other, so nothing caught it. It
 * surfaced on real hardware at the worst possible moment: AFTER Ventoy was
 * installed and the payload written, leaving a half-built stick and "do NOT use
 * this stick".
 */
const CLI = fileURLToPath(new URL('./node-profiles.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('what `show` writes to the stick passes `check-resolved`', () => {
	const shown = cli('show', 'desktop-debian-trixie', '--file', SHIPPED);
	assert.equal(shown.status, 0, shown.stderr);

	const dir = mkdtempSync(join(tmpdir(), 'node-profiles-rt-'));
	const onStick = join(dir, 'desktop-debian-trixie.json');
	writeFileSync(onStick, shown.stdout);
	keep(onStick);

	const checked = cli('check-resolved', '--file', onStick);
	assert.equal(
		checked.status,
		0,
		`usb-prep writes what \`show\` emits and verifies with \`check-resolved\`; ` +
			`they must agree.\n${checked.stderr}`
	);
});

test('a profile MANIFEST handed to check-resolved is refused, naming both shapes', () => {
	const r = cli('check-resolved', '--file', SHIPPED);
	assert.equal(r.status, 1, 'a manifest is not a resolved profile');
	assert.match(r.stderr, /MANIFEST, not a resolved profile/);
});

test('check-resolved refuses a resolved profile that lost a required section', () => {
	const shown = cli('show', 'desktop-debian-trixie', '--file', SHIPPED);
	const doc = JSON.parse(shown.stdout);
	delete doc.power;
	const dir = mkdtempSync(join(tmpdir(), 'node-profiles-rt-'));
	const bad = join(dir, 'nopower.json');
	writeFileSync(bad, JSON.stringify(doc));
	keep(bad);

	const r = cli('check-resolved', '--file', bad);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /power must be an object/);
});

/**
 * The round trip above proves the two verbs AGREE. It cannot prove usb-prep
 * calls the right one — and calling the wrong one is exactly what happened.
 * Comments are blanked first: this file and usb-prep both discuss the wrong
 * form in prose, and a rule about code must never be satisfiable by writing
 * about it.
 */
test('usb-prep verifies the stick profile with check-resolved, not show', () => {
	const prep = fileURLToPath(new URL('../node-usb-prep.sh', import.meta.url));
	const code = readFileSync(prep, 'utf8')
		.split('\n')
		.map((l) => (l.trimStart().startsWith('#') ? '' : l))
		.join('\n');

	assert.match(
		code,
		/profiles check-resolved --file/,
		'the stick carries ONE resolved profile; verifying it with the manifest loader ' +
			'fails after the disk is already erased'
	);
	assert.doesNotMatch(
		code,
		/profiles show "\$PROFILE" --file/,
		'`show --file` runs the MANIFEST loader against a resolved profile and always fails'
	);
});

// ── tailscale tags ──────────────────────────────────────────────────────────
//
// These exist because the failure they guard is SILENT. An un-tagged node joins
// the tailnet perfectly, works for 180 days, and then its key expires — and
// nothing in the fleet notices, because every gate reaches the claws over LAN
// and none of them reads the tailnet. claw-1 sat expired from 2026-08-31 until
// someone looked directly. A tag typo produces exactly that state.

test('a tags entry without the tag: prefix is refused — Tailscale rejects the login', () => {
	const path = keep(
		mutated('laptop-debian-trixie', (p) => {
			p.network.tailscale.tags = ['claw'];
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /prefixed "tag:"/);
});

test('tags as a bare string is refused — it reads as tagged and is not', () => {
	const path = keep(
		mutated('laptop-debian-trixie', (p) => {
			p.network.tailscale.tags = 'tag:claw';
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /tags/);
});

test('a non-boolean tailscale.ssh is refused rather than read as truthy', () => {
	const path = keep(
		mutated('laptop-debian-trixie', (p) => {
			p.network.tailscale.ssh = 'yes';
		})
	);
	assert.throws(() => loadNodeProfiles({ path }), /tailscale\.ssh must be a boolean/);
});

test('omitting tags is allowed — untagged is a choice, not a typo', () => {
	const path = keep(
		mutated('laptop-debian-trixie', (p) => {
			delete p.network.tailscale.tags;
		})
	);
	assert.doesNotThrow(() => loadNodeProfiles({ path }));
});

test('every shipped profile declares tag:claw, so no onboarded node starts a 180-day clock', () => {
	for (const id of profileIds({ path: SHIPPED })) {
		const p = nodeProfile(id, { path: SHIPPED });
		assert.deepEqual(
			p.network.tailscale.tags,
			['tag:claw'],
			`${id} would be onboarded untagged, and its key expiry would be invisible`
		);
	}
});

test('node-bootstrap prints the tag it was given, and warns when it has none', () => {
	// The script is the only thing that turns the manifest into an instruction a
	// human runs. A profile carrying tags that node-bootstrap drops on the floor
	// is the same silent outcome as no tags at all.
	const sh = readFileSync(fileURLToPath(new URL('../node-bootstrap.sh', import.meta.url)), 'utf8');
	assert.match(sh, /--advertise-tags=\$TS_TAGS/, 'the printed command must carry the tags');
	assert.match(sh, /tailscale\.tags \/\/ \[\]/, 'tags must come from the profile, not a literal');
	assert.match(sh, /WILL expire in 180 days/, 'an untagged node must say so out loud');
});
