/**
 * `node-profiles` — the CLI door onto `lib/node-profiles.mjs`.
 *
 *   node scripts/node-profiles.mjs list
 *   node scripts/node-profiles.mjs show <id> [--file PATH]
 *   node scripts/node-profiles.mjs check-resolved --file PATH
 *
 * Split out of `lib/node-profiles.mjs` (wave clean-2 lane D): that file is a
 * config-layer validation library, read directly by `scripts/apt-security.mjs`
 * and `scripts/converge-toolchain.mjs` (`import { loadNodeProfiles } from
 * './lib/node-profiles.mjs'`) and by `scripts/onboarding.sh` /
 * `scripts/refresh-preseed.sh` (a bare `import("...lib/node-profiles.mjs")`).
 * Importing `./lib/emit.mjs` there for the sake of a CLI mode those callers
 * never touch put a config-layer file one layer above where it belongs. This
 * file is the thin surfaces-layer shell instead — same shape as
 * `scripts/fleet-source.mjs` — and `scripts/lib/usb-prep-cli.sh`'s
 * `profiles()` and `scripts/check-capability-schema.test.mjs` now shell out
 * to THIS path rather than `lib/node-profiles.mjs` directly.
 *
 * STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
 * and on a pipe `process.exit` throws away whatever the stream still had
 * queued — measured on this host, 149,133 bytes in and 146,176 out, which
 * `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
 * blocking mode so there is nothing left to lose. Issue #33; the shared
 * emitter calls the same function for the scripts that use it.
 *
 * @guards manifests/node-profiles.json
 * @guards scripts/node-bootstrap.sh
 * @guards scripts/node-usb-prep.sh
 */
import process from 'node:process';
import { keepStdoutWhole } from './lib/emit.mjs';
import {
	ProfileError,
	loadNodeProfiles,
	nodeProfile,
	validateProfile,
	requireObject,
	readManifest,
} from './lib/node-profiles.mjs';

keepStdoutWhole();

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
