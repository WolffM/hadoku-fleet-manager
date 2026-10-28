/**
 * THE TENANT'S LAST INSTALLED AGENT, kept so the fleet can install it on a
 * slice the tenant did not hand-place (fleet-manager#16, asked by cardtable
 * 2026-10-28). An agent artifact is node-independent: cardtable's `run`
 * bundle carries the coordinator's public key and nothing per-node, and
 * claw-8 and claw-9 run one sha. So the converger can install the same bytes
 * on every slice it declares. Install stays the fleet's; placement inside the
 * slice stays the tenant's.
 *
 * Written ONLY by `fleet hosting --install`, after the node said INSTALL-OK.
 * So a kept artifact is one the tenant installed and the fleet verified, never
 * one merely handed in. The next install replaces it.
 *
 * `<stateDir>/hosting-artifacts/<tenant>/run` plus `artifact.json`
 * `{ sha256, size, at, by }`. Reading re-hashes the bytes. A file that no
 * longer matches its record is `{ ok: false }` with the reason, never an
 * install of bytes nobody verified.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dirOf = (stateDir, tenant) => join(stateDir, 'hosting-artifacts', tenant);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Keep `bytes` as `tenant`'s artifact. Returns `{ changed }`; the same sha twice writes nothing. */
export function keepArtifact(stateDir, tenant, bytes, { by, nowIso }) {
	const dir = dirOf(stateDir, tenant);
	const want = sha256(bytes);
	const prev = readArtifact(stateDir, tenant);
	if (prev?.ok && prev.sha256 === want) return { changed: false };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `.${process.pid}.tmp`;
	writeFileSync(join(dir, `run${tmp}`), bytes, { mode: 0o600 });
	renameSync(join(dir, `run${tmp}`), join(dir, 'run'));
	writeFileSync(
		join(dir, `artifact.json${tmp}`),
		`${JSON.stringify({ sha256: want, size: bytes.length, at: nowIso, by }, null, 2)}\n`
	);
	renameSync(join(dir, `artifact.json${tmp}`), join(dir, 'artifact.json'));
	return { changed: true };
}

/**
 * `tenant`'s kept artifact as `{ ok: true, path, sha256 }`, or null when none
 * was ever kept, or `{ ok: false, why }` when it is unreadable or no longer
 * matches its record.
 */
export function readArtifact(stateDir, tenant) {
	const dir = dirOf(stateDir, tenant);
	const meta = join(dir, 'artifact.json');
	if (!existsSync(meta)) return null;
	try {
		const rec = JSON.parse(readFileSync(meta, 'utf8'));
		const path = join(dir, 'run');
		const got = sha256(readFileSync(path));
		if (got !== rec.sha256)
			return { ok: false, why: `${path} hashes to ${got}, its record says ${rec.sha256}` };
		return { ok: true, path, sha256: got };
	} catch (err) {
		return { ok: false, why: `${dir}: ${err.message}` };
	}
}
