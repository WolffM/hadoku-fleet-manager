/**
 * seed-node-cache — copy the big caches a fresh node cannot build for itself.
 *
 * WHY THIS EXISTS. Two capabilities in the toolchain floor have no producer:
 * `playwright` (a 5.2 GB browser cache) and the JIT payload (684 MB of runner
 * binary). `python-toolcache` has `fleet seed-python`; these had nothing. So a
 * node could be fully converged, pass every gate, and still be BLOCKED —
 * bootcamp refuses a node that cannot launch a browser, and the label it is
 * blocked from is the one that lets it take work at all.
 *
 * claw-7, 2026-09-08, is the worked example: it reached `PASSES` only after
 * both were moved by hand, and the manual `rsync` for the first of them died
 * with "Permission denied" AFTER transferring 5.5 GB because nothing had
 * checked the destination was writable. Every one of those steps is
 * mechanical, which is the definition of something that should not be an
 * operator's job.
 *
 * WHAT IT DOES NOT DO. It does not download from the internet. Both artefacts
 * already exist, correct and proven, on every healthy claw — and a node that
 * PASSES its probe is a better source than a release URL, because it is the
 * exact bytes the fleet is currently running. `jit-provision.sh` can self-heal
 * from `RUNNER_TARBALL_URL`, and that path stays as the fallback for a fleet
 * with no healthy peer; this is the fast path for a fleet that has six.
 *
 * THE SOURCE MUST PASS ITS OWN PROBE. Seeding from a node whose playwright is
 * broken propagates the breakage and then reports success — the copy would
 * succeed, which is the wrong question. Same rule as everywhere else here: the
 * reader for a facet may not read what the writer wrote, so the target is
 * verified by RUNNING the probe afterwards, never by trusting rsync's exit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { loadManifest, machineArg, runOn, selectNodes } from './lib/fleet-exec.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const ARGV = process.argv.slice(2);
const CONFIRM = ARGV.includes('--confirm');
const JSON_OUT = ARGV.includes('--json');
const ONLY = machineArg(ARGV, { valueFlags: ['--what'] });
const WHAT = ARGV.includes('--what') ? ARGV[ARGV.indexOf('--what') + 1] : 'all';

if (ARGV.includes('-h') || ARGV.includes('--help')) {
	console.log(`usage: fleet seed-cache [--machine <node>] [--what playwright|payload|all] [--confirm]

  Copies the caches a fresh node cannot build for itself, from a peer that
  PASSES the matching probe. Dry run without --confirm.

  --machine <node>  one node (default: every managed claw)
  --what <id>       playwright | payload | all   (default: all)
  --confirm         actually copy. Without it, nothing is written.`);
	process.exit(0);
}

/**
 * The artefacts, as data.
 *
 * `probe` is the capability that PROVES the artefact works, and it is what both
 * source selection and post-copy verification run. `path` is relative to the
 * fleet user's home so nothing here needs to know where that is.
 */
const SEEDS = {
	playwright: {
		path: '.cache/ms-playwright',
		probe: 'playwright',
		why: 'browser binaries; e2e-canary.yml carries no `playwright install` step deliberately, so every claw must be able to launch one',
	},
	payload: {
		path: '.hadoku/jit/payload',
		// CHECKED BY PATH, NOT BY PROBE. `jitconfig` passes when ANY
		// Runner.Listener accepts the flag, and capability-probe.sh searches
		// `~/actions-runner*/` as well as the payload — so a node holding a
		// STANDING install passes it while having no payload at all. claw-8 did
		// exactly that: "payload SKIP (already passes jitconfig)" on a box whose
		// payload directory was empty. Flip that node to `ephemeral: true` and the
		// standing install goes away with it, leaving nothing to mint from — the
		// ordering trap, reintroduced by a check that could not tell the two
		// apart.
		probe: null,
		presentPath: '.hadoku/jit/payload/bin/Runner.Listener',
		why: 'the runner binary every JIT mint hardlinks from; without it the first mint pays a ~200MB download, or fails if RUNNER_TARBALL_URL cannot resolve',
	},
};

const wanted = WHAT === 'all' ? Object.keys(SEEDS) : [WHAT];
for (const w of wanted) {
	if (!SEEDS[w]) {
		console.error(
			`seed-node-cache: unknown --what '${w}'. Known: ${Object.keys(SEEDS).join(', ')}, all`
		);
		process.exit(1);
	}
}

const PROBE = readFileSync(new URL('capability-probe.sh', import.meta.url), 'utf8');

/**
 * Run the capability probe on a node and return `{id: ok}`, or null.
 *
 * `runOn` NEVER REJECTS — an unreachable node is a result, not an exception —
 * and it resolves to `{ok, stdout, out, ...}`, not a string. A first version
 * here wrote `.catch(() => null)` and split the return value: the catch was dead
 * code and the split threw on an object. Both mistakes come from assuming a
 * transport that throws, which this one deliberately is not.
 *
 * The probe itself never exits non-zero, ON PURPOSE — "a probe that fails a job
 * it was only meant to describe is worse than the drift it was looking for" — so
 * a failed capability still exits 0. What distinguishes "could not look" is the
 * absence of any CAP line at all, and that must return null rather than an empty
 * set: an empty set reads as "this node has nothing", which would make an
 * unreachable box look like one needing every seed.
 */
async function probeOf(node) {
	const r = await runOn(node, PROBE, { timeoutMs: 180_000 });
	const caps = {};
	for (const line of (r.out ?? '').split('\n')) {
		const m = /^CAP\s+(\S+)\s+(\S+)/.exec(line.trim());
		if (m) caps[m[1]] = m[2] === 'ok';
	}
	return Object.keys(caps).length ? caps : null;
}

const manifest = loadManifest();
/**
 * A GUEST IS NEITHER SEEDED NOR READ FROM, AND THE SKIP IS PRINTED.
 *
 * This copies gigabytes into another machine's home. A guest lends the fleet a
 * registration and is otherwise none of the fleet chain's business (operator,
 * 2026-09-14) — "never seeded" is one of the words in that decision — and its
 * caches are not the fleet's to fill or to harvest.
 *
 * BY ROLE, NOT BY LABEL. The exclusion here used to be `pm2-host`, which was
 * exact only while one machine carried that label and stopped being exact the
 * day Wave 3d made `pm2-host` an EARNED capability a claw can probe into: a claw
 * that earned it would have silently stopped being seeded, and stopped being
 * eligible as a source, for a reason that has nothing to do with caches. The
 * thing that filter was standing in for is the role, so the role is what is
 * asked. `--machine <the guest>` still reaches it, which is how an operator
 * seeds one deliberately.
 */
const { nodes: selectedTargets, skippedByRole } = selectNodes(manifest, {
	only: ONLY,
	where: (m) => m.placement !== 'excluded',
});
const targets = selectedTargets.map(([name]) => name);

// SAID OUT LOUD. A node that stops being seeded without anyone noticing is the
// failure the skip exists to prevent.
// Held out of `--json` mode only because the payload below carries the same
// facts in `skippedByRole`; in human mode it is the only place they appear.
if (!JSON_OUT) {
	for (const s of skippedByRole) console.log(`  ${s.node.padEnd(8)} [skipped: guest] — ${s.why}`);
}

if (!targets.length) {
	console.error(
		`seed-node-cache: no node matches${ONLY ? ` --machine ${ONLY}` : ''}.\n` +
			'  A run that matched nothing must not report a clean pass over zero nodes.' +
			(skippedByRole.length
				? `\n  The only match is a guest (${skippedByRole.map((s) => s.node).join(', ')}), ` +
					'whose caches the fleet does not fill.'
				: '')
	);
	process.exit(1);
}

const result = { at: new Date().toISOString(), confirm: CONFIRM, seeds: [] };
let failures = 0;

// PROBED ONCE, for the whole run. The first version re-probed every node per
// ARTEFACT, so `--what all` ssh'd to seven boxes twice and asked each the same
// question — and each probe launches a browser and creates a venv, so it is not
// a cheap question to ask twice.
//
// WHO NEEDS IT and WHO CAN GIVE IT are both answered from this one pass.
// The DONOR pool, filtered the same way and for the same reason: reading a
// guest's cache to size it, and then tarring it across the network, is the fleet
// chain on that box just as much as writing to it is.
const all = selectNodes(manifest, {
	where: (m) => m.placement !== 'excluded',
}).nodes.map(([name]) => name);
const probes = {};
for (const n of all) probes[n] = await probeOf(n);

for (const what of wanted) {
	const spec = SEEDS[what];

	// THE RICHEST SOURCE, not the first one that passes.
	//
	// A first version took `find(passes)`, which picked claw-1 for playwright —
	// and claw-1 carries chromium-1217 ALONE where claw-4/5/6 carry seven builds.
	// claw-8 was duly seeded with 631MB of a 5.2GB cache: it PASSED the probe,
	// because the probe launches one browser, and it would then fail any repo
	// pinning a version it did not receive. That is the drift
	// `garage-network-constraint` already records — "a repo pinning anything but
	// the one version a node has fails THERE and passes on its neighbour, which
	// reads as a flaky test rather than as fleet drift" — manufactured by the
	// tool meant to prevent it.
	//
	// So candidates are ranked by how much they actually hold. The probe decides
	// WHO IS ELIGIBLE to be a source; size decides which eligible one to use.
	const candidates = spec.probe
		? all.filter((n) => probes[n] && probes[n][spec.probe] === true)
		: all.slice();
	const sized = [];
	for (const n of candidates) {
		if (targets.includes(n)) continue;
		const r = await runOn(n, `du -sk "$HOME/${spec.path}" 2>/dev/null | cut -f1`, {
			timeoutMs: 60_000,
		});
		const kb = Number.parseInt((r.out ?? '').trim(), 10);
		sized.push({ node: n, kb: Number.isFinite(kb) ? kb : 0 });
	}
	sized.sort((a, b) => b.kb - a.kb);
	const source = sized[0]?.node ?? candidates[0];
	if (sized.length > 1) {
		console.log(
			`  source for ${what}: ${source} (${Math.round((sized[0].kb || 0) / 1024)}MB) — richest of ${sized.map((x) => `${x.node}:${Math.round(x.kb / 1024)}MB`).join(', ')}`
		);
	}

	for (const node of targets) {
		// A seed with no probe is checked by asking the node for the file. The
		// probe remains the verifier where one exists, because "the reader for a
		// facet may not read what the writer wrote" — but a payload has no
		// capability of its own that a standing install cannot also satisfy.
		let present = null;
		if (!spec.probe) {
			const r = await runOn(node, `test -x "$HOME/${spec.presentPath}" && echo YES || echo NO`, {
				timeoutMs: 60_000,
			});
			present = (r.out ?? '').includes('YES') ? true : (r.out ?? '').includes('NO') ? false : null;
		}
		const p = probes[node];
		if (spec.probe && p === null) {
			// Unreachable is a FINDING. Skipping it silently would let a dead node
			// look like a seeded one.
			console.error(`✗ ${node}: could not probe — not seeding ${what} blind`);
			result.seeds.push({ node, what, state: 'unreachable' });
			failures++;
			continue;
		}
		if (spec.probe ? p[spec.probe] : present === true) {
			console.log(`  ${node.padEnd(8)} ${what.padEnd(11)} SKIP (already passes ${spec.probe})`);
			result.seeds.push({ node, what, state: 'already' });
			continue;
		}
		if (!source) {
			console.error(
				`✗ ${node}: needs ${what} and NO node in the fleet passes ${spec.probe} — nothing to copy from.`
			);
			result.seeds.push({ node, what, state: 'no-source' });
			failures++;
			continue;
		}
		if (!CONFIRM) {
			console.log(`  ${node.padEnd(8)} ${what.padEnd(11)} would seed from ${source} (${spec.why})`);
			result.seeds.push({ node, what, state: 'would-seed', source });
			continue;
		}

		// THE DESTINATION IS MADE WRITABLE FIRST. claw-7's manual copy died with
		// "mkdir: Permission denied" after 5.5GB because ~/.cache was root-owned
		// (a `sudo -E` bootstrap). Checking the cheap thing before the expensive
		// one is the whole lesson.
		try {
			execFileSync(
				'ssh',
				[
					'-o',
					'BatchMode=yes',
					'-o',
					'ConnectTimeout=10',
					node,
					`set -e; d="$HOME/${spec.path}"; mkdir -p "$d" 2>/dev/null || { sudo -n mkdir -p "$d"; sudo -n chown -R "$USER:$USER" "$d"; }; [ -w "$d" ]`,
				],
				{ stdio: 'pipe', timeout: 60_000 }
			);
		} catch {
			console.error(
				`✗ ${node}: ${spec.path} is not writable and could not be made so — refusing to start a large copy that will fail at the end`
			);
			result.seeds.push({ node, what, state: 'not-writable' });
			failures++;
			continue;
		}

		console.log(`  ${node.padEnd(8)} ${what.padEnd(11)} copying from ${source} …`);
		try {
			// Via the control host, not claw-to-claw: the claws hold no trust in
			// each other and adding some for a cache copy would be a new standing
			// permission for a one-off need.
			const tmp = `/tmp/fleet-seed-${what}`;
			execFileSync('rsync', ['-a', '--delete', `${source}:${spec.path}/`, `${tmp}/`], {
				stdio: 'pipe',
				timeout: 1_800_000,
			});
			execFileSync('rsync', ['-a', `${tmp}/`, `${node}:${spec.path}/`], {
				stdio: 'pipe',
				timeout: 1_800_000,
			});
		} catch (err) {
			console.error(`✗ ${node}: copy of ${what} failed: ${String(err.message).slice(0, 160)}`);
			result.seeds.push({ node, what, state: 'copy-failed' });
			failures++;
			continue;
		}

		// VERIFIED BY RUNNING THE PROBE, never by rsync's exit code. A copy can
		// succeed and still leave a cache the node cannot use — that is exactly
		// what `playwright` measures and why its probe launches a browser.
		let ok;
		if (spec.probe) {
			const after = await probeOf(node);
			ok = Boolean(after && after[spec.probe]);
		} else {
			const r = await runOn(node, `test -x "$HOME/${spec.presentPath}" && echo YES || echo NO`, {
				timeoutMs: 60_000,
			});
			ok = (r.out ?? '').includes('YES');
		}
		if (ok) {
			console.log(
				`  ${node.padEnd(8)} ${what.padEnd(11)} SEEDED and ${spec.probe ?? spec.presentPath} now present`
			);
			result.seeds.push({ node, what, state: 'seeded', source });
		} else {
			console.error(`✗ ${node}: ${what} copied but ${spec.probe} still does NOT pass`);
			result.seeds.push({ node, what, state: 'copied-but-unproven' });
			failures++;
		}
	}
}

// Alongside `seeds` rather than inside it: `seeds` means "nodes this run acted
// on", and a guest is precisely one it did not.
if (JSON_OUT) console.log(JSON.stringify({ ...result, skippedByRole }, null, 2));
if (!CONFIRM) console.log('\nDry run only. Re-run with --confirm to copy.');
if (failures) {
	console.error(`\n✗ ${failures} seeding problem(s)`);
	process.exit(1);
}
