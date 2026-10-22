/**
 * The one gate that decides whether a new box gets ASKED for its name.
 *
 * `infer_hostname` is load-bearing twice over: once when bootstrap reads the
 * name the installer left behind, and again when it validates a name typed at
 * the console. Both call sites are this function, so a hole in it is a hole in
 * the whole naming path — and a hole is exactly what claw-9 fell through on
 * 2026-09-20. The Ventoy image boots d-i at priority=critical, so the hostname
 * question is never asked; with no hostname from DHCP, d-i synthesises
 * `unknown` + the boot NIC's MAC. `unknown020000005cc5` is not `debian` and is
 * not `localhost`, so it read as a deliberate choice, the console prompt never
 * fired, and the box bootstrapped under its own MAC address.
 *
 * The function is extracted from the SHIPPED script rather than copied here.
 * A copy would let the two drift and still pass, which is the failure mode this
 * repo keeps writing down: a verifier that reads its own writer's artifact
 * cannot fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'node-bootstrap.sh');

/** The real function, lifted verbatim out of the real script. */
function extract(name) {
	const src = readFileSync(SCRIPT, 'utf8');
	const start = src.indexOf(`${name}() {`);
	assert.notEqual(start, -1, `${name}() not found in node-bootstrap.sh — was it renamed?`);
	const end = src.indexOf('\n}\n', start);
	assert.notEqual(end, -1, `${name}() has no closing brace`);
	return src.slice(start, end + 3);
}

const FN = extract('infer_hostname');

/** true = this name is a real choice; false = the function refused it. */
function accepts(name) {
	const script = `err() { :; }\n${FN}\nif infer_hostname "$1" >/dev/null 2>&1; then exit 0; else exit 1; fi\n`;
	try {
		execFileSync('bash', ['-c', script, 'bash', name], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

test('the installer defaults are refused', () => {
	for (const name of ['', 'debian', 'localhost', 'localhost.localdomain']) {
		assert.equal(accepts(name), false, `accepted the placeholder ${JSON.stringify(name)}`);
	}
});

test("d-i's unknown<mac> fallback is refused", () => {
	// claw-9, verbatim: `unknown` + enp8s0's 02:00:00:00:5c:c5, colons stripped.
	assert.equal(accepts('unknown020000005cc5'), false);
	// Uppercase, and a bare `unknown`, are the same absence of a name.
	assert.equal(accepts('unknown020000005CC5'), false);
	assert.equal(accepts('unknown'), false);
	// A longer link-layer address must not slip past a 12-hex assumption.
	assert.equal(accepts('unknown020000000055667788990200000000aa00'), false);
});

test('real node names are still accepted', () => {
	for (const name of ['claw-9', 'claw-10', 'hokon', 'builder1']) {
		assert.equal(accepts(name), true, `refused the legitimate name ${name}`);
	}
});

test('a name that merely starts with the word unknown is not a MAC', () => {
	// The pattern keys on hex following `unknown`; a hyphen is not hex, so a
	// deliberately odd but hand-chosen name is still the operator's to make.
	assert.equal(accepts('unknown-lab-box'), true);
});

test('infer_hostname echoes the name it accepts, unchanged', () => {
	const script = `err() { :; }\n${FN}\ninfer_hostname "$1"\n`;
	const out = execFileSync('bash', ['-c', script, 'bash', 'claw-9'], { encoding: 'utf8' });
	assert.equal(out, 'claw-9');
});
