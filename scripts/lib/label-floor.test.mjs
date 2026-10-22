/**
 * check-label-floor's two 2026-09-09 properties, driven end to end.
 *
 * THE GATE IS A SCRIPT, NOT A MODULE — it runs at import — so this spawns it
 * against a FIXTURE fleet (`FLEET_MANIFEST_DIR`, `HADOKU_SITE_ROOT`,
 * `HADOKU_STATE_DIR`) rather than importing a helper. That is deliberate as
 * well as necessary: what is being asserted is the gate's VERDICT, and a test
 * that exercised a helper the script also happens to call could pass while the
 * script's own wiring was wrong. Nothing here touches the real fleet, the real
 * manifest or the operator's state directory, and the fixture declares no
 * `residentRepos`, so no `gh` call is made.
 *
 * WHAT IT PINS
 * ------------
 *   1. The routing-dependency set is what workflows REQUEST, never
 *      `requested ∩ declared`. Emptying a `labels` array must not be able to
 *      shrink the gate's scope — that is how the cleanup would have disarmed
 *      the check it was cleaning up.
 *   2. A requested label NOTHING offers FAILS, rather than quietly dropping
 *      out. No gate may get easier to pass the worse the fleet gets.
 *   3. The transition log names the node, the label, the direction and the
 *      bootcamp finding that caused it — the whole point of "demotion is
 *      OBSERVED, not forced".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelCapabilities } from '../../dist/capabilities.js';

const GATE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'check-label-floor.mjs');

/**
 * A bootcamp finding that PASSES: no blocked, no unprobed.
 *
 * `earned` LISTS WHAT WAS PROVED, as of 2026-09-10. It was `[]` here, matching
 * the pre-2026-09-10 producer, which promoted only `proven ∩ declared` among
 * probeable LABEL capabilities — and that is precisely the state the gate's
 * derivation check now FAILS on, because the field the claw floor ranks on is
 * empty on a node that passed every probe.
 */
const passes = (at = '2026-09-08T05:00:00.000Z') => ({
	at,
	by: 'fleet bootcamp',
	declared: [],
	earned: ['ffmpeg'],
	blocked: [],
	unprobed: [],
	prereqs: [{ id: 'ffmpeg', detail: '7.1.5' }],
});

/** A bootcamp finding that DISQUALIFIES, naming what broke. */
const blockedOn = (id, at = '2026-09-09T05:00:00.000Z') => ({
	...passes(at),
	blocked: [{ id, detail: 'probe failed' }],
});

/**
 * A throwaway fleet on disk.
 *
 * `hokon` is non-ephemeral on purpose: several of the gate's checks turn on
 * whether a standing machine offers a label, so a fixture of ephemeral nodes
 * alone would answer a different question than the fleet does.
 */
function fixture(
	machines,
	{
		requests = ['self-hosted', 'hadoku-builder'],
		// ONE COVERED REPO, under a fixture REPOS_DIR. It used to be an empty
		// roster, and an empty roster now FAILS (#98): it read only the site.
		covered = { 'ci.yml': 'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n' },
		// ONE OBSERVED JOB, anchored to now: the observed half of the demand.
		history = [
			{
				repo: 'WolffM/fixture-repo',
				runner: 'claw-1',
				labels: ['self-hosted', 'hadoku-builder'],
				startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
			},
		],
	} = {}
) {
	const root = mkdtempSync(join(tmpdir(), 'label-floor-'));
	const manifestDir = join(root, 'admin');
	const siteRoot = join(root, 'site');
	const stateDir = join(root, 'state');
	const reposDir = join(root, 'repos');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(join(siteRoot, '.github', 'workflows'), { recursive: true });
	mkdirSync(join(siteRoot, 'scripts', 'admin'), { recursive: true });
	mkdirSync(stateDir, { recursive: true });

	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines }, null, 2)
	);
	const repoDir = join(reposDir, 'fixture-repo');
	mkdirSync(repoDir, { recursive: true });
	if (covered) {
		mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true });
		for (const [f, body] of Object.entries(covered)) {
			writeFileSync(join(repoDir, '.github', 'workflows', f), body);
		}
	}
	writeFileSync(
		join(manifestDir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: ['WolffM/fixture-repo'] })
	);
	writeFileSync(
		join(siteRoot, '.github', 'workflows', 'ci.yml'),
		`jobs:\n  build:\n    runs-on: [${requests.map((r) => `'${r}'`).join(', ')}]\n`
	);
	if (history) {
		writeFileSync(
			join(stateDir, 'job-history.jsonl'),
			history.map((r) => JSON.stringify(r)).join('\n') + '\n'
		);
	}
	// ONE CI DEMAND ROW, asking for the capability every fixture node proves.
	//
	// It used to be an EMPTY file, on the reasoning that a MISSING ledger is its
	// own (correct) failure and would mask everything this file is about. That
	// reasoning is unchanged and now covers emptiness too: since wave 3c §G an
	// empty required set is its own failure as well, because every node clears a
	// bar of zero (3a). So the fixture states a bar the nodes meet, which leaves
	// the label-floor questions below the only ones being asked.
	writeFileSync(
		join(stateDir, 'demand-ledger.jsonl'),
		JSON.stringify({
			class: 'ci',
			repo: 'WolffM/fixture',
			job: 'check',
			fleetForm: true,
			selfHosted: true,
			hosted: false,
			capabilities: ['ffmpeg'],
		}) + '\n'
	);

	return {
		root,
		manifestDir,
		repoDir,
		stateDir,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_SITE_ROOT: siteRoot,
			HADOKU_STATE_DIR: stateDir,
			REPOS_DIR: reposDir,
		},
	};
}

function run(env) {
	try {
		const stdout = execFileSync(process.execPath, [GATE, '--json'], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, report: JSON.parse(stdout) };
	} catch (err) {
		const out = err.stdout ?? '';
		return {
			code: err.status ?? 1,
			report: out.trim().startsWith('{') ? JSON.parse(out) : null,
			stderr: err.stderr ?? '',
		};
	}
}

test('the dependency set is what workflows REQUEST — an empty `labels` array cannot shrink it', () => {
	// The bug this replaces: `requested ∩ declared`. Under it, a machine list
	// with no `labels` at all yields ZERO dependencies and a green gate.
	const { root, env } = fixture({
		hokon: { $capabilities: passes() },
		'claw-1': { ephemeral: true, $capabilities: passes() },
	});
	try {
		const { code, report } = run(env);
		assert.ok(report, 'the gate did not produce parseable JSON');
		assert.deepEqual(report.dependencies, ['hadoku-builder']);
		assert.equal(code, 0, `expected a pass, got ${code}: ${JSON.stringify(report.missing)}`);
		// AND the derived offer is what covers it: nobody declared anything.
		assert.deepEqual(report.holdings.hokon, ['hadoku-builder']);
		assert.deepEqual(report.unoffered, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a requested label NOTHING offers FAILS, instead of dropping out of scope', () => {
	// Every machine disqualified, no declarations: `hadoku-builder` is requested
	// and unplaceable. The old intersection made this the QUIETEST possible
	// state — the gate would have had nothing left to check.
	const { root, env } = fixture({
		hokon: { $capabilities: blockedOn('gh') },
		'claw-1': { ephemeral: true, $capabilities: blockedOn('gh') },
	});
	try {
		const { code, report, stderr } = run(env);
		assert.equal(code, 1, 'an unplaceable routing label must fail the gate');
		assert.ok(report, 'a failing gate must still emit parseable JSON');
		assert.equal(report.verdict, 'unoffered');
		assert.deepEqual(report.unoffered, ['hadoku-builder']);
		assert.match(stderr, /NOTHING in the fleet offers/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#120: a routing label served only by minting is REPORTED, and does not fail the gate', () => {
	// From 2026-09-01 this state failed as "stranded on ephemeral", pointing at
	// hokon's standing runners as the answer. The operator retired those on
	// 2026-10-19, so every routing label is mint-only by decision; the runtime
	// floor's minting arm is what watches it now. Still computed off the
	// DERIVED offer, so the declaration strip cannot empty the report.
	const { root, env } = fixture({
		hokon: { $capabilities: blockedOn('gh') },
		'claw-1': { ephemeral: true, $capabilities: passes() },
		'claw-2': { ephemeral: true, $capabilities: passes() },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0);
		assert.deepEqual(report.servedByMintOnly, ['hadoku-builder']);
		assert.equal('strandedOnEphemeral' in report, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#120: an on-demand guest counts as a MINTING offerer, not a standing one', () => {
	const { root, env } = fixture({
		hokon: { role: 'guest', mint: 'on-demand', $capabilities: passes() },
		'claw-1': { ephemeral: true, $capabilities: passes() },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0);
		assert.deepEqual(report.servedByMintOnly, ['hadoku-builder']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a node with NO bootcamp finding offers nothing — "no evidence" is not evidence', () => {
	const { root, env } = fixture({
		hokon: { $capabilities: passes() },
		'claw-9': { ephemeral: true },
	});
	try {
		const { report } = run(env);
		assert.deepEqual(report.holdings['claw-9'], []);
		assert.deepEqual(report.unverified, ['claw-9']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the transition log names node, label, direction and the finding that caused it', () => {
	const { root, env } = fixture({
		hokon: { $capabilities: passes() },
		'claw-1': { ephemeral: true, $capabilities: passes() },
	});
	try {
		// FIRST RUN IS A BASELINE, not a hundred transitions.
		const first = run(env);
		assert.equal(first.code, 0);
		assert.deepEqual(first.report.transitions, []);

		// Nothing moved.
		assert.deepEqual(run(env).report.transitions, []);

		// claw-1 fails a probe. hokon still offers the label, so the fleet is
		// fine and the gate stays GREEN — the demotion is OBSERVED, not enforced.
		writeFileSync(
			join(env.FLEET_MANIFEST_DIR, 'fleet-runner-manifest.json'),
			JSON.stringify(
				{
					machines: {
						hokon: { $capabilities: passes() },
						'claw-1': { ephemeral: true, $capabilities: blockedOn('playwright') },
					},
				},
				null,
				2
			)
		);
		const { code, report } = run(env);
		assert.equal(code, 0, 'a demotion must not fail the gate while capacity remains');
		assert.equal(report.transitions.length, 1);
		const [t] = report.transitions;
		assert.equal(t.node, 'claw-1');
		assert.equal(t.label, 'hadoku-builder');
		assert.equal(t.change, 'lost');
		assert.equal(t.cause.kind, 'bootcamp');
		assert.deepEqual(t.cause.blocked, ['playwright']);
		assert.equal(t.cause.at, '2026-09-09T05:00:00.000Z');
		assert.match(t.cause.why, /blocked playwright/);

		// REPORTED ONCE. The next run compares against the state this one wrote.
		assert.deepEqual(run(env).report.transitions, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a GAINED label is reported too, with the finding that earned it', () => {
	const { root, env } = fixture({
		hokon: { $capabilities: passes() },
		'claw-1': { ephemeral: true, $capabilities: blockedOn('playwright') },
	});
	try {
		run(env);
		writeFileSync(
			join(env.FLEET_MANIFEST_DIR, 'fleet-runner-manifest.json'),
			JSON.stringify(
				{
					machines: {
						hokon: { $capabilities: passes() },
						'claw-1': { ephemeral: true, $capabilities: passes('2026-09-10T05:00:00.000Z') },
					},
				},
				null,
				2
			)
		);
		const { report } = run(env);
		assert.equal(report.transitions.length, 1);
		assert.equal(report.transitions[0].change, 'gained');
		assert.equal(report.transitions[0].cause.at, '2026-09-10T05:00:00.000Z');
		assert.match(report.transitions[0].cause.why, /proves ffmpeg/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an UNREADABLE holdings file is a new baseline and SAYS SO — never "nothing changed"', () => {
	const { root, env } = fixture({ hokon: { $capabilities: passes() } });
	try {
		run(env);
		writeFileSync(join(env.HADOKU_STATE_DIR, 'label-floor-holdings.json'), '{ not json');
		const { report, code } = run(env);
		assert.equal(code, 0);
		assert.ok(report.holdingsError, 'a corrupt snapshot must be reported, not read as empty');
		assert.deepEqual(report.transitions, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── issue #19: the derivation and the mint must AGREE ───────────────────────
//
// The half the issue calls "arguably the more urgent". With `hadoku-builder`
// stripped from all nine machine entries, this gate exited 0 and printed "label
// floor covers every routing dependency" on a manifest where nothing declared
// the fleet's primary routing label, because `holdings` and `offerersOf` re-added
// it for every eligible node. A gate that gets easier to pass the worse the
// failure gets.

/** What bootcamp writes once it has run under the 2026-09-10 semantics. */
const promoted = (ids, at = '2026-09-08T05:00:00.000Z') => ({
	at,
	by: 'fleet bootcamp',
	declared: [],
	earned: [...ids].sort(),
	blocked: [],
	unprobed: [],
	prereqs: [...ids].filter((i) => i === 'ffmpeg').map((id) => ({ id, detail: '7.1.5' })),
});

test('#19: a node whose `earned` is empty while it PROVED things fails the gate, by name', () => {
	// The live state of all seven claws on 2026-09-10: `earned: []`, five
	// capabilities in `prereqs`. The derivation still works (provenCapabilities
	// reads the union as a bridge) and the field the claw floor RANKS on is
	// empty, and before this check nothing said so.
	const { root, env } = fixture({
		hokon: { $capabilities: passes() },
		'claw-1': {
			ephemeral: true,
			$capabilities: { ...passes(), earned: [] },
		},
	});
	try {
		const { code, report, stderr } = run(env);
		assert.equal(code, 1, 'a stale `earned` producer must fail the gate');
		assert.equal(report.verdict, 'derivation-disagreement');
		assert.equal(report.derivationFailures.length, 1);
		assert.match(report.derivationFailures[0], /^claw-1 —/, 'the finding must name the node');
		assert.match(report.derivationFailures[0], /PROVED ffmpeg/);
		assert.match(stderr, /the derived label offer and the manifest disagree/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#19: a node with NO bootcamp record fails — "I could not look" is not "nothing is wrong"', () => {
	// `nodeOffer` falls back to the declaration there, which is the only safe
	// direction (the alternative strips av1-nvenc off hokon on a missing record).
	// Safe is not silent.
	const { root, env } = fixture({
		hokon: { $capabilities: passes() },
		'claw-9': { ephemeral: true },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'derivation-disagreement');
		assert.match(report.derivationFailures[0], /claw-9 — cannot derive its label offer/);
		assert.match(report.derivationFailures[0], /no `\$capabilities` record at all/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#19: a DECLARED probe-verified label the record does not earn fails — the mint would lie', () => {
	// av1-nvenc is the registry's own example of a claim that lies: Debian's
	// ffmpeg reports the encoder whether or not the GPU can use it. A mint from
	// the declared array would project it; the derivation refuses it; GitHub
	// would then route encode work to a node that cannot do it.
	const { root, env } = fixture({
		hokon: { labels: ['av1-nvenc'], $capabilities: promoted(['ffmpeg']) },
		'claw-1': { ephemeral: true, $capabilities: promoted(['ffmpeg']) },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'derivation-disagreement');
		assert.match(report.derivationFailures[0], /hokon — declares "av1-nvenc"/);
		assert.match(report.derivationFailures[0], /derived offer does NOT carry it/);
		// And it really is absent from the offer, not just reported.
		assert.ok(!report.holdings.hokon.includes('av1-nvenc'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#19: the END STATE is green — declarations stripped, `earned` promoted', () => {
	// What the live runbook produces: no machine declares `hadoku-builder`, every
	// node's `earned` lists what it proved, `jit-canary` and hokon's non-CI labels
	// stay because no probe can settle them.
	const { root, env } = fixture({
		hokon: {
			// `role: 'guest'` because the live manifest has carried it since wave 3c
			// §G, and because since #6 made `pm2-host` probe-verified it is the ROLE,
			// not the NAME, that keeps a declared non-CI label in the offer. The
			// comment above already said "no probe can settle them"; this is that
			// sentence as a manifest key.
			role: 'guest',
			labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
			$capabilities: promoted(['ffmpeg', 'av1-nvenc']),
		},
		'claw-1': { ephemeral: true, $capabilities: promoted(['ffmpeg']) },
		'claw-3': { ephemeral: true, labels: ['jit-canary'], $capabilities: promoted(['ffmpeg']) },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0, `expected green, got ${JSON.stringify(report?.derivationFailures)}`);
		assert.deepEqual(report.derivationFailures, []);
		// The label nothing declares is still offered, and still floored.
		assert.deepEqual(report.unoffered, []);
		assert.ok(report.holdings['claw-1'].includes('hadoku-builder'));
		assert.deepEqual(report.holdings['claw-3'], ['hadoku-builder', 'jit-canary']);
		assert.deepEqual(report.holdings.hokon.sort(), [
			'av1-nvenc',
			'hadoku-builder',
			'pm2-host',
			'taskauto',
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── the two places a DECLARATION is right, and the one place it is not ──────
//
// Capabilities are DERIVED (operator, 2026-09-09) and the check above compares
// the derivation against the declaration. Two kinds of label are not supposed to
// appear on both sides of that comparison, and reporting them as disagreements
// is the gate calling the intended end state a fault:
//
//   EARNED       `cargo-bevy` — probed, promoted into `earned`, deliberately
//                absent from `labels`. Four claws earned it on 2026-09-14 and
//                this gate produced four findings for it.
//   MINT-ONLY    `jit-canary` — proven by MINTING, so no probe can ever put it
//                in `earned`, so the manifest is the only thing that can carry
//                it. Marked `mintOnly` in the registry.
//
// Neither exemption may be a blanket. The tests below pin both halves: the
// intended state is green, and the failure each check exists for is still red.

test('a probe-EARNED label the manifest does not declare is the design, not a disagreement', () => {
	// `av1-nvenc` stands in for `cargo-bevy`: label surface, verify: 'probe'. It
	// is in `earned` and absent from `labels`, which is exactly the end state the
	// 2026-09-09 decision asks for.
	const { root, env } = fixture({
		hokon: { $capabilities: promoted(['ffmpeg', 'av1-nvenc']) },
		'claw-1': { ephemeral: true, $capabilities: promoted(['ffmpeg']) },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0, `expected green, got ${JSON.stringify(report?.derivationFailures)}`);
		assert.deepEqual(report.derivationFailures, []);
		// And it really is offered — exempt from the COMPARISON, not from the gate.
		assert.ok(report.holdings.hokon.includes('av1-nvenc'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the earned exemption is NOT a blanket — an added label nothing earned still fails', () => {
	// The same shape, minus the proof: `av1-nvenc` reaches the offer because the
	// node DECLARES it, `earned` does not contain it, and a probe record exists.
	// `nodeOffer` refuses it, the declaration keeps it in `labels`, and the
	// dangerous direction is reported exactly as before.
	const { root, env } = fixture({
		hokon: { labels: ['av1-nvenc'], $capabilities: promoted(['ffmpeg']) },
		'claw-1': { ephemeral: true, $capabilities: promoted(['ffmpeg']) },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 1, 'an unearned declared label must still fail');
		assert.equal(report.verdict, 'derivation-disagreement');
		assert.match(report.derivationFailures[0], /hokon — declares "av1-nvenc"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a MINT-ONLY label is declared on purpose, and the gate says so by staying green', () => {
	// claw-3's live shape. `jit-canary` is in `labels`, never in `earned`, and
	// `ephemeral: true` is what `check-capability-schema` holds it to — not this
	// gate, which is why exempting it here loses no coverage.
	const { root, env } = fixture({
		hokon: { $capabilities: promoted(['ffmpeg']) },
		'claw-3': { ephemeral: true, labels: ['jit-canary'], $capabilities: promoted(['ffmpeg']) },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0, `expected green, got ${JSON.stringify(report?.derivationFailures)}`);
		assert.deepEqual(report.holdings['claw-3'], ['hadoku-builder', 'jit-canary']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a MINT-ONLY label inside `earned` FAILS — no probe can prove what minting proves', () => {
	// THE CHECK THE MARKER EXISTS FOR, and the one an exemption could have
	// swallowed. A record carrying `jit-canary` was not written by a probe: the
	// one label that proves the dispatcher works would be resting on a
	// declaration again, which is the 2026-09-08/09 warm-listener failure with a
	// different writer.
	const { root, env } = fixture({
		hokon: { $capabilities: promoted(['ffmpeg']) },
		'claw-3': {
			ephemeral: true,
			labels: ['jit-canary'],
			$capabilities: promoted(['ffmpeg', 'jit-canary']),
		},
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 1, 'a mint-only label in `earned` must fail the gate');
		assert.equal(report.verdict, 'derivation-disagreement');
		assert.match(report.derivationFailures[0], /^claw-3 —/, 'the finding must name the node');
		assert.match(report.derivationFailures[0], /which is MINT-ONLY/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('`mintOnly` and `verify: mint` agree — one question asked two ways, checked', () => {
	// `verify` says how a capability is PROVEN; `mintOnly` says who may DECLARE
	// it. They coincide today for every label-surface capability, and the
	// coincidence is asserted rather than assumed: the day a mint-proven label
	// must not be declared, this is where the two answers part company on
	// purpose instead of by drift.
	const disagree = labelCapabilities()
		.filter((c) => (c.verify === 'mint') !== (c.mintOnly === true))
		.map((c) => `${c.id} (verify=${c.verify}, mintOnly=${c.mintOnly ?? false})`);
	assert.deepEqual(disagree, []);
	// And the marker is actually carried by something, or every exemption above
	// is vacuous and these tests pass on an empty set.
	assert.deepEqual(
		labelCapabilities()
			.filter((c) => c.mintOnly === true)
			.map((c) => c.id),
		['jit-canary']
	);
});

test('#19: the consumer-contract verdict is reported per node', () => {
	const { root, env } = fixture({
		hokon: { $capabilities: promoted(['ffmpeg']) },
		'claw-1': { ephemeral: true, $capabilities: promoted(['ffmpeg']) },
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0);
		// The fixture's ledger demands `ffmpeg` and both nodes prove it — what is
		// pinned here is that the predicate runs per node and reaches the report
		// at all.
		assert.deepEqual(
			report.contractVerdicts.map((v) => [v.name, v.ok]),
			[
				['claw-1', true],
				['hokon', true],
			]
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── #98: the demand is read per job, from two sources, and never shrinks ────
//
// The old reader was three regexes over the whole file. Each test below is a
// shape it read as "asks for nothing", or a sweep that silently went to zero.

/** Standing hokon AND minting claw-1 both earn `jdk21`; hokon alone earns `cargo-bevy`. */
const mixedOffer = () => ({
	hokon: { $capabilities: promoted(['ffmpeg', 'jdk21', 'cargo-bevy']) },
	'claw-1': { ephemeral: true, $capabilities: promoted(['ffmpeg', 'jdk21']) },
});

const FORGE_YML =
	"jobs:\n  forge-e2e:\n    runs-on: ${{ inputs.runs_on != '' && fromJSON(inputs.runs_on) || " +
	'fromJSON(\'["self-hosted","hadoku-builder","jdk21"]\') }}\n';

test('#98: the cardtable forge shape puts jdk21 in scope, and the unified floor COVERS it', () => {
	// Until 2026-10-10 this landed in `missing`: jdk21 was `floor: false` and
	// offered by minting AND standing nodes, which the standing-only floor could
	// not express. One rule for every label covers it — through the persisted
	// static demand the runtime floor reads, not through any allowlist.
	const { root, env, stateDir } = fixture(mixedOffer(), { covered: { 'forge.yml': FORGE_YML } });
	try {
		const { code, report } = run(env);
		assert.ok(report.dependencies.includes('jdk21'), JSON.stringify(report.dependencies));
		assert.deepEqual(report.demandSources.jdk21.static, ['fixture-repo/forge.yml:forge-e2e']);
		assert.deepEqual(report.missing, []);
		assert.equal(code, 0, `expected green, got ${report.verdict}`);
		assert.ok(report.runtimeWatched.includes('jdk21'), 'the runtime floor sees it');
		// ...and it sees it through the FILE runner-health reads, since no job in
		// history ever asked for jdk21 here.
		const persisted = JSON.parse(readFileSync(join(stateDir, 'label-floor-demand.json'), 'utf8'));
		assert.deepEqual(persisted.labels, ['hadoku-builder', 'jdk21']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: a static-only label the runtime cannot SEE is `missing` — a failed persist is not coverage', () => {
	// The non-vacuous half of the new `missing`: the floor covers every demanded
	// label only if runner-health can read the demand. A state file that cannot
	// be written (here: a directory where the file should be) leaves jdk21 —
	// demanded only by a workflow, never observed — invisible to it.
	const { root, env, stateDir } = fixture(mixedOffer(), { covered: { 'forge.yml': FORGE_YML } });
	try {
		mkdirSync(join(stateDir, 'label-floor-demand.json'));
		const { code, report, stderr } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'missing');
		assert.deepEqual(report.missing, ['jdk21']);
		assert.ok(report.floorDemandWriteError, 'the write failure is carried, not swallowed');
		assert.match(stderr, /runtime label floor will not see/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: an INCOMPLETE static read never replaces the persisted demand with a shorter one', () => {
	const { root, env, stateDir } = fixture(mixedOffer(), {
		covered: {
			'forge.yml': FORGE_YML,
			'x.yml': 'jobs:\n  odd:\n    runs-on: ${{ inputs.runner }}\n',
		},
	});
	try {
		const previous = { at: '2026-10-09T00:00:00.000Z', labels: ['cargo-bevy', 'jdk21'] };
		writeFileSync(join(stateDir, 'label-floor-demand.json'), JSON.stringify(previous));
		const { code, report } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'unresolvable-runs-on');
		assert.deepEqual(
			JSON.parse(readFileSync(join(stateDir, 'label-floor-demand.json'), 'utf8')),
			previous,
			'a partial read must leave the last complete one in place'
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: a comment is not demand, and a hosted image is not a capability', () => {
	const { root, env } = fixture(mixedOffer(), {
		covered: {
			'ci.yml':
				'jobs:\n  check:\n    # runs-on: [self-hosted, jdk21]\n' +
				// A TRAILING comment, too: it names a JSON array, which is exactly
				// what the resolver collects from an expression.
				'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }} # was \'["self-hosted","jdk21"]\'\n' +
				'  pages:\n    runs-on: ubuntu-24.04\n',
		},
	});
	try {
		const { code, report } = run(env);
		assert.equal(code, 0, `expected green, got ${report?.verdict}`);
		assert.deepEqual(report.dependencies, ['hadoku-builder']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: OBSERVED demand counts — a label only job history carries is in scope', () => {
	const { root, env } = fixture(mixedOffer(), {
		history: [
			{
				runner: 'claw-1',
				labels: ['self-hosted', 'hadoku-builder', 'cargo-bevy'],
				startedAt: new Date(Date.now() - 60_000).toISOString(),
			},
			// A proof run's label is the prover's aim, not demand.
			{
				runner: 'jit-claw-1-proof-fixture-repo-j0-r0-1791485830',
				labels: ['self-hosted', 'proof-abc123'],
				startedAt: new Date(Date.now() - 60_000).toISOString(),
			},
		],
	});
	try {
		const { report } = run(env);
		assert.ok(report.dependencies.includes('cargo-bevy'), JSON.stringify(report.dependencies));
		assert.equal(report.demandSources['cargo-bevy'].observed, 1);
		assert.ok(!report.dependencies.includes('proof-abc123'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: no job history, or none in the window, FAILS — the observed half could not look', () => {
	const stale = [{ runner: 'claw-1', labels: ['x'], startedAt: '2020-01-01T00:00:00Z' }];
	for (const history of [null, stale]) {
		const { root, env } = fixture({ hokon: { $capabilities: passes() } }, { history });
		try {
			const { code, report } = run(env);
			assert.equal(code, 1);
			assert.equal(report.verdict, 'observed-unreadable');
			assert.match(report.observedError, history ? /holds no job/ : /no job history/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test('#98: a runs-on that resolves to no label FAILS, naming file and job', () => {
	const { root, env } = fixture(
		{ hokon: { $capabilities: passes() } },
		{ covered: { 'x.yml': 'jobs:\n  odd:\n    runs-on: ${{ inputs.runner }}\n' } }
	);
	try {
		const { code, report, stderr } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'unresolvable-runs-on');
		assert.match(stderr, /unresolvable runs-on in fixture-repo\/x\.yml: odd:/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: a covered checkout with no workflows directory FAILS instead of contributing nothing', () => {
	const { root, env } = fixture({ hokon: { $capabilities: passes() } }, { covered: null });
	try {
		const { code, report } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'no-workflows');
		assert.deepEqual(report.noWorkflows, ['fixture-repo']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('#98: an EMPTY roster FAILS — it read only the site', () => {
	const { root, env, manifestDir } = fixture({ hokon: { $capabilities: passes() } });
	try {
		writeFileSync(join(manifestDir, 'fleet-runner-coverage.json'), JSON.stringify({ repos: [] }));
		const { code, report } = run(env);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'empty-roster');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
