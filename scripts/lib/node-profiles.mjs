/**
 * node-profiles — read `node-profiles.json`, and refuse to read it badly.
 *
 * A node profile is the IMAGE and CONVERT half of the manifest: what a node of
 * a given shape must be, before anything about it is true enough to declare in
 * `fleet-runner-manifest.json`. `fleet usb-prep` resolves one here and copies it
 * onto the stick; `scripts/node-bootstrap.sh` reads that copy on the new box.
 *
 * WHY THIS IS A LOADER AND NOT A `jq` CALL IN A SHELL SCRIPT
 * ---------------------------------------------------------
 * Two callers need the same answer: usb-prep, on the control host, choosing what
 * to write; and later `fleet enroll`, reading a record back and comparing it to
 * what was promised. Two implementations of "which profile is that, and is it
 * coherent" would drift, and the one that drifts is the one nobody tests. So the
 * shell script SHELLS OUT to this — `node scripts/lib/node-profiles.mjs show
 * <id>` — rather than parsing JSON itself.
 *
 * WHY EVERY FAILURE HERE IS A THROW
 * ---------------------------------
 * The same reason `paths.mjs` and `host.ts` throw, restated for a new file: a
 * loader that returns `{}` for an unreadable manifest hands its caller a node
 * with no power policy, no sudo model and no trusted CIDR — and every one of
 * those reads downstream as "the profile did not ask for it". usb-prep would
 * then write a stick that images a box into a shape nobody declared, and it
 * would print a green summary while doing it. An empty profile is not a
 * permissive profile. It is a profile nobody looked at.
 *
 * @guards manifests/node-profiles.json
 * @guards scripts/node-bootstrap.sh
 * @guards scripts/node-usb-prep.sh
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { manifest as manifestFile } from './paths.mjs';
import { capability } from '../../dist/capabilities.js';
import { keepStdoutWhole } from './emit.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

/** The file name, in one place, because three callers name it. */
export const PROFILE_MANIFEST = 'node-profiles.json';

/** Roles a profile may claim. Coarse on purpose — see `$why-no-labels`. */
export const ROLES = ['runner', 'agent', 'both'];

/**
 * Lid states. `none` and `ignore` are DIFFERENT CLAIMS, not two spellings of
 * "do not suspend": `none` asserts the chassis has no lid at all, and
 * node-bootstrap.sh verifies that against /proc/acpi/button/lid before it
 * proceeds. Every power assumption in this repo was laptop-shaped until
 * 2026-08-30, and a desktop inheriting a lid rule "because it is harmless" is
 * how a laptop later inherits one too — silently, and not harmlessly.
 */
export const LID_STATES = ['none', 'ignore'];

const SUDO_MODELS = ['nopasswd', 'password'];
const CHASSIS = ['desktop', 'laptop'];

/** Documentation keys. Every `$`-prefixed key is prose and is never validated. */
const isProse = (k) => k.startsWith('$');

class ProfileError extends Error {}

function fail(message) {
	throw new ProfileError(`node-profiles: ${message}`);
}

/** The resolved path of the profile manifest. Throws if the directory is wrong. */
export function profileManifestPath() {
	return manifestFile(PROFILE_MANIFEST);
}

function readManifest(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		fail(
			`cannot read ${path}\n  ${err.message}\n` +
				`  This is fatal on purpose. Returning an empty profile set would hand the\n` +
				`  caller a node with no power policy, no sudo model and no trusted CIDR, and\n` +
				`  every one of those reads downstream as "the profile did not ask for it".\n` +
				`  Set FLEET_MANIFEST_DIR to the directory holding ${PROFILE_MANIFEST}.`
		);
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		fail(`${path} is not valid JSON: ${err.message}`);
	}
}

/**
 * Narrowed, not asserted. `JSON.parse` yields `any`, and a cast only moves the
 * unsafety somewhere nothing looks — check-exports.mjs reached the same
 * conclusion about package.json for the same reason.
 */
function requireObject(value, what) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		fail(`${what} must be an object`);
	}
	return value;
}

function requireString(obj, key, what, allowed) {
	const v = obj[key];
	if (typeof v !== 'string' || v.trim() === '') {
		fail(`${what}.${key} must be a non-empty string`);
	}
	if (allowed && !allowed.includes(v)) {
		fail(`${what}.${key} is "${v}"; expected one of ${allowed.join(', ')}`);
	}
	return v;
}

function requireArray(obj, key, what, { allowEmpty = false } = {}) {
	const v = obj[key];
	if (!Array.isArray(v)) fail(`${what}.${key} must be an array`);
	if (!allowEmpty && v.length === 0) {
		fail(
			`${what}.${key} is empty. An empty list here is indistinguishable from a ` +
				`forgotten one, and the forgotten one is the dangerous case.`
		);
	}
	return v;
}

/** IPv4 CIDR, checked structurally rather than by shape-of-a-string. */
function validCidr(s) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
	if (!m) return false;
	const octets = m.slice(1, 5).map(Number);
	if (octets.some((o) => o > 255)) return false;
	return Number(m[5]) <= 32;
}

/**
 * Every capability a profile claims must be in the registry AND provable by a
 * probe.
 *
 * Registry membership alone is not enough. `taskauto` is a real capability and
 * a profile claiming it would be claiming something node-bootstrap.sh cannot
 * demonstrate — the toolchain floor is exactly the set of things the box can be
 * made to DO and then observed doing, which is `verify: 'probe'`. Anything else
 * belongs in the node's manifest entry, decided by a human at enrollment.
 *
 * `pm2-host` was this paragraph's example until 2026-09-15, when it became a
 * PROBED capability (#6) and stopped being one. It is now admissible here, and
 * that is correct rather than a hole: an imaging floor that lists it is saying
 * every box built from this profile must supervise a process, which
 * `capability-probe.sh` starts, lists and kills. No profile claims it today.
 */
function validateCapabilityFloor(ids, what) {
	for (const id of ids) {
		if (typeof id !== 'string') fail(`${what}.capabilities holds a non-string entry`);
		const cap = capability(id);
		if (!cap) {
			fail(
				`${what}.capabilities claims "${id}", which src/capabilities.ts does not define. ` +
					`A capability nothing defines is a promise nothing can check.`
			);
		}
		if (cap.verify !== 'probe') {
			fail(
				`${what}.capabilities claims "${id}", whose verification is "${cap.verify}", not ` +
					`"probe". node-bootstrap.sh proves the floor by EXECUTING capability-probe.sh; ` +
					`a capability no probe can execute would be declared met by nobody looking.`
			);
		}
	}
	return ids;
}

function validateProfile(id, raw) {
	const what = `profiles["${id}"]`;
	const p = requireObject(raw, what);

	requireString(p, 'role', what, ROLES);

	const os = requireObject(p.os, `${what}.os`);
	requireString(os, 'distro', `${what}.os`);
	requireString(os, 'codename', `${what}.os`);
	// PRESENT-BUT-EMPTY is a declaration; ABSENT is an omission. A desktop
	// profile saying "no chassis vendor here needs a kernel of its own" and a
	// profile whose author forgot the key must not be the same value, because
	// the second one silently images a Surface with the stock kernel.
	if (!Object.prototype.hasOwnProperty.call(os, 'kernelExtras')) {
		fail(
			`${what}.os.kernelExtras is missing. Declare it as {} to mean "no chassis vendor ` +
				`needs extra kernel packages" — omitting it means nobody decided, and this ` +
				`replaces the --surface flag whose only record was a retrospective.`
		);
	}
	requireObject(os.kernelExtras, `${what}.os.kernelExtras`);
	for (const [vendor, extras] of Object.entries(os.kernelExtras)) {
		if (isProse(vendor)) continue;
		const ex = requireObject(extras, `${what}.os.kernelExtras["${vendor}"]`);
		requireArray(ex, 'packages', `${what}.os.kernelExtras["${vendor}"]`);
	}

	const power = requireObject(p.power, `${what}.power`);
	requireString(power, 'chassis', `${what}.power`, CHASSIS);
	requireString(power, 'lid', `${what}.power`, LID_STATES);
	requireArray(power, 'maskSleepTargets', `${what}.power`);
	requireObject(power.logind, `${what}.power.logind`);
	const wd = requireObject(power.watchdog, `${what}.power.watchdog`);
	requireArray(wd, 'modules', `${what}.power.watchdog`);
	if (typeof wd.maxLoadPerCore !== 'number' || wd.maxLoadPerCore <= 0) {
		fail(
			`${what}.power.watchdog.maxLoadPerCore must be a positive number. It is a ` +
				`PER-CORE multiplier, never an absolute: a fixed ceiling shut claw-1 down three ` +
				`times in one hour on 2026-08-17 at a healthy load of 40 on 8 cores.`
		);
	}

	const users = requireObject(p.users, `${what}.users`);
	requireString(users, 'fleetUser', `${what}.users`);
	requireString(users, 'sudo', `${what}.users`, SUDO_MODELS);
	requireArray(users, 'groups', `${what}.users`);

	const net = requireObject(p.network, `${what}.network`);
	const lan = requireString(net, 'lanCidr', `${what}.network`);
	if (!validCidr(lan)) fail(`${what}.network.lanCidr is not an IPv4 CIDR: "${lan}"`);
	const port = net.sshPort;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		fail(`${what}.network.sshPort must be an integer port, got ${JSON.stringify(port)}`);
	}
	const trusted = requireArray(net, 'trustedCidrs', `${what}.network`);
	// Localhost and the LAN must BOTH be in fail2ban's ignoreip. Leaving the LAN
	// out is not a hardening choice, it is the 2026-03-03 lockout: fail2ban
	// banned the operator's own workstation after a client offered several keys,
	// and the ban survived `ufw disable` because fail2ban writes nftables rules
	// directly.
	if (!trusted.includes(lan)) {
		fail(
			`${what}.network.trustedCidrs does not include lanCidr ${lan}. fail2ban would be ` +
				`free to ban the operator's own workstation, and that ban survives \`ufw disable\`.`
		);
	}
	if (!trusted.some((c) => typeof c === 'string' && c.startsWith('127.'))) {
		fail(`${what}.network.trustedCidrs does not include a loopback range.`);
	}
	// The tailscale block is LOAD-BEARING as of 2026-09-01, so it gets validated
	// rather than read optimistically. `tags` is what makes a node key stop
	// expiring: a tagged device is owned by its tag, not by a user, and Tailscale
	// disables key expiry for it. A typo here (`tag`, or a bare string instead of
	// an array) is INVISIBLE — node-bootstrap would print an un-tagged
	// `tailscale up`, the box would join fine, and the 180-day clock would start
	// with nothing anywhere reporting it. That is the failure claw-1 had on
	// 2026-08-31: expired, silent, and only found by looking directly.
	const ts = requireObject(net.tailscale, `${what}.network.tailscale`);
	for (const flag of ['install', 'ssh']) {
		if (typeof ts[flag] !== 'boolean') {
			fail(`${what}.network.tailscale.${flag} must be a boolean, got ${JSON.stringify(ts[flag])}`);
		}
	}
	// Absent is allowed and means "untagged, and the operator accepted the
	// treadmill". Present-but-wrong is not: it reads as tagged and is not.
	if ('tags' in ts) {
		const tags = requireArray(ts, 'tags', `${what}.network.tailscale`);
		for (const tag of tags) {
			if (typeof tag !== 'string' || !tag.startsWith('tag:')) {
				fail(
					`${what}.network.tailscale.tags entries must be strings prefixed "tag:", got ` +
						`${JSON.stringify(tag)}. Tailscale rejects a login advertising an unprefixed tag.`
				);
			}
		}
	}

	const sshd = requireObject(net.sshd, `${what}.network.sshd`);
	if (!Number.isInteger(sshd.maxAuthTries) || sshd.maxAuthTries < 4) {
		fail(
			`${what}.network.sshd.maxAuthTries must be an integer >= 4. A client whose agent ` +
				`offers every key it holds exhausts a smaller budget before reaching password auth.`
		);
	}

	validateCapabilityFloor(requireArray(p, 'capabilities', what), what);

	const tool = requireObject(p.toolchain, `${what}.toolchain`);
	requireArray(tool, 'packages', `${what}.toolchain`);
	// PRESENT-BUT-EMPTY IS A DECLARATION, ABSENT IS AN OMISSION — the same rule
	// os.kernelExtras enforces above, for the same reason. A package this
	// profile lists that is not in the base archive (P1.5's `gh`, from
	// GitHub's own apt repo rather than Debian's) needs a source added before
	// `apt-get install` can resolve it, and a profile whose author forgot to
	// declare that source would silently ship a package list apt cannot
	// satisfy — which reads, on the node, as `apt-get install` failing outright
	// rather than as a decision anyone can find in this file.
	if (!Object.prototype.hasOwnProperty.call(tool, 'thirdPartySources')) {
		fail(
			`${what}.toolchain.thirdPartySources is missing. Declare it as {} to mean "every ` +
				`package in toolchain.packages resolves from the base archive" — omitting it means ` +
				`nobody decided.`
		);
	}
	requireObject(tool.thirdPartySources, `${what}.toolchain.thirdPartySources`);
	for (const [src, spec] of Object.entries(tool.thirdPartySources)) {
		if (isProse(src)) continue;
		const s = requireObject(spec, `${what}.toolchain.thirdPartySources["${src}"]`);
		requireString(s, 'aptKeyUrl', `${what}.toolchain.thirdPartySources["${src}"]`);
		requireString(s, 'aptKeyPath', `${what}.toolchain.thirdPartySources["${src}"]`);
		requireString(s, 'aptList', `${what}.toolchain.thirdPartySources["${src}"]`);
	}

	return { id, ...p };
}

/**
 * Every declared profile, validated.
 *
 * @param {{ path?: string }} [opts] `path` overrides FLEET_MANIFEST_DIR resolution
 *   (usb-prep passes the copy it wrote to the stick; tests pass a fixture).
 */
export function loadNodeProfiles(opts = {}) {
	const path = opts.path ?? profileManifestPath();
	const doc = requireObject(readManifest(path), path);
	const profiles = requireObject(doc.profiles, `${path} .profiles`);

	const ids = Object.keys(profiles).filter((k) => !isProse(k));
	if (ids.length === 0) {
		fail(
			`${path} declares no profiles. Zero profiles is not a pass: it renders as ` +
				`"nothing needs imaging" for a fleet nobody looked at.`
		);
	}

	const out = new Map();
	for (const id of ids) out.set(id, validateProfile(id, profiles[id]));
	return { path, profiles: out };
}

/** Declared profile ids, in declaration order. */
export function profileIds(opts = {}) {
	return [...loadNodeProfiles(opts).profiles.keys()];
}

/** One profile by id. Never guesses, never returns a default. */
export function nodeProfile(id, opts = {}) {
	const { path, profiles } = loadNodeProfiles(opts);
	const found = profiles.get(id);
	if (!found) {
		fail(
			`no profile "${id}" in ${path}. Declared: ${[...profiles.keys()].join(', ')}\n` +
				`  A profile is chosen, not defaulted — imaging a node into a shape nobody ` +
				`declared is how a desktop ends up with a laptop's power policy.`
		);
	}
	return found;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// `fleet usb-prep` calls this rather than parsing JSON in bash, so profile
// resolution has ONE implementation and ONE test suite.
//
//   node scripts/lib/node-profiles.mjs list
//   node scripts/lib/node-profiles.mjs show <id> [--file PATH]
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const [verb, ...rest] = process.argv.slice(2);
	const fi = rest.indexOf('--file');
	const opts = fi > -1 ? { path: rest[fi + 1] } : {};
	try {
		if (verb === 'list') {
			for (const p of loadNodeProfiles(opts).profiles.values()) {
				console.log(`${p.id}\t${p.role}\t${p.os.distro}/${p.os.codename}\t${p.power.chassis}`);
			}
		} else if (verb === 'show') {
			const id = rest.find((a) => !a.startsWith('--') && a !== opts.path);
			if (!id) throw new ProfileError('node-profiles: show needs a profile id');
			console.log(JSON.stringify(nodeProfile(id, opts), null, 2));
		} else if (verb === 'check-resolved') {
			// A stick carries ONE profile, already resolved, at
			// profiles/<id>.json — not a manifest. `node-bootstrap.sh` reads it
			// with plain jq (`.power.chassis`), because on a freshly imaged node
			// there is no fleet tooling, only jq.
			//
			// usb-prep's verifier used to call `show --file` on it, which runs the
			// MANIFEST loader and demands a top-level `.profiles`. The writer and
			// the real reader agreed; the verifier was checking the wrong shape,
			// and it failed after Ventoy had already been installed and the
			// payload written — the worst possible moment to discover it.
			const file = opts.path;
			if (!file) throw new ProfileError('node-profiles: check-resolved needs --file <path>');
			const doc = requireObject(readManifest(file), file);
			if (doc.profiles) {
				throw new ProfileError(
					`${file} looks like a profile MANIFEST, not a resolved profile. ` +
						`The stick carries one already-resolved profile so the node can read it ` +
						`with jq alone.`
				);
			}
			validateProfile(doc.id ?? '(resolved)', doc);
			console.log(doc.id ?? '(resolved)');
		} else {
			throw new ProfileError(`node-profiles: unknown verb ${JSON.stringify(verb ?? '')}`);
		}
	} catch (err) {
		console.error(err instanceof ProfileError ? err.message : `node-profiles: ${err.message}`);
		process.exit(1);
	}
}
