/**
 * The tunnel half of a service tenant's observation reads the RUNNING
 * cloudflared's config, and nothing that merely mentions cloudflared.
 *
 * On 2026-11-02 the probe picked the config path with a pattern over `ps` args,
 * and the pipeline's own `grep` carried that pattern in its argv. It sorted
 * ahead of the root cloudflared on claw-4 and claw-6, the path read `[^`, and
 * every service tenant's slice went `not-guaranteed` ("the node's tunnel rule
 * for … could not be read") while each tunnel routed its hostname correctly.
 *
 * The probe runs here under bash with `ps` and `sudo` stubbed: `ps` lists a
 * decoy grep and a decoy shell AHEAD of cloudflared, as the node did, and
 * `sudo` answers only for the config path cloudflared was started with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ingressProbe } from './hosting-service-check.mjs';

const CFG = '/etc/cloudflared/config.yml';

/** Run the probe against a stub `ps` listing `procs` (`comm args` lines) and a stub `sudo`. */
function probe(procs) {
	const dir = mkdtempSync(join(tmpdir(), 'ingress-probe-'));
	try {
		const stub = (name, body) => {
			writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(dir, name), 0o755);
		};
		stub('ps', `cat <<'PS'\n${procs.join('\n')}\nPS`);
		// `sudo -n cloudflared tunnel --config <path> ingress rule <url>`
		stub(
			'sudo',
			`[ "$5" = '${CFG}' ] || { echo "open $5: no such file or directory" >&2; exit 1; }
printf 'Using rules from %s\\nMatched rule #0\\n\\tservice: http://127.0.0.1:9002\\n' "$5"`
		);
		return execFileSync('bash', ['-c', `HOSTNAME_WANT=pygmalion.hadoku.me\n${ingressProbe()}`], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
		}).trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("reads the running cloudflared's config even when its own grep sorts first", () => {
	assert.equal(
		probe([
			'grep grep -o cloudflared.*--config [^ ]*',
			'bash bash -c cfg=$(ps -eo args | grep cloudflared --config x)',
			`cloudflared /usr/bin/cloudflared --no-autoupdate --config ${CFG} tunnel run`,
		]),
		'ingressService=http://127.0.0.1:9002'
	);
});

test('with no cloudflared running it falls back to the system config', () => {
	assert.equal(probe(['bash bash -s']), 'ingressService=http://127.0.0.1:9002');
});

test('a cloudflared started on another config is asked with that one, not the default', () => {
	assert.equal(
		probe(['cloudflared /usr/bin/cloudflared --config /srv/other.yml tunnel run']),
		'ingressService='
	);
});
