import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RUNNER_SLICE } from '../runners/ci-unit-properties.js';
import {
	GITHUB_JOB_CEILING_SEC,
	JIT_UNIT_MAX_SEC,
	backstopUnitMemoryMaxMb,
} from '../runners/ephemeral-slice.js';
import { JOB_RESERVE_DEFAULT_MB } from '../lib/job-reserve.js';
import { buildSpawnPlan, buildWarmSpawnPlan } from '../runners/ephemeral-mint.js';

// --- spawn plan -------------------------------------------------------------

test('the spawn plan is a transient unit with a backstop and its own memory cap', () => {
	const p = buildSpawnPlan({
		unit: 'jit-hokon-meet-1787797008',
		slot: '/home/hadoku/.hadoku/jit/slot0',
		jitConfig: 'CFG',
		memoryMaxMb: 3000,
		ttlSeconds: JIT_UNIT_MAX_SEC,
	});
	assert.deepEqual(p.argv.slice(0, 4), [
		'systemd-run',
		'--user',
		'--unit=jit-hokon-meet-1787797008',
		'--collect',
	]);
	// --user: no sudo, and hokon has none. --collect: a finished unit reaps
	// itself. RuntimeMaxSec: a backstop against a WEDGED unit, above GitHub's own
	// job ceiling. MemorySwapMax=0: swap is `infinity` on every runner unit today.
	assert.ok(p.argv.includes(`--property=RuntimeMaxSec=${JIT_UNIT_MAX_SEC}`));
	assert.ok(p.argv.includes('--property=MemoryMax=3000M'));
	assert.ok(p.argv.includes('--property=MemorySwapMax=0'));
	// THE SECRET IS NOT IN THE COMMAND LINE. A jitconfig carries a real OAuth
	// token; as an argv token it lands in /proc/<pid>/cmdline — world-readable,
	// and `openclaw` has a login on these boxes — and in the systemd journal,
	// which keeps it long after the runner is gone. The unit reads it from a
	// 0600 file at exec time instead.
	assert.ok(
		!p.argv.some((a) => a.includes('CFG')),
		`the jitconfig must not appear in argv: ${JSON.stringify(p.argv)}`
	);
	assert.equal(p.configContent, 'CFG', 'it is carried out-of-band for the caller to stage');
	assert.equal(p.configPath, '/home/hadoku/.hadoku/jit/slot0/.jitconfig');
	// Not even as `--jitconfig "$C"`: the shell expands it, and the listener's
	// own argv is world-readable in /proc for the life of the job.
	assert.match(
		p.argv.at(-1) ?? '',
		/export ACTIONS_RUNNER_INPUT_JITCONFIG; .*Runner\.Listener run$/
	);
	assert.ok(
		!(p.argv.at(-1) ?? '').includes('--jitconfig'),
		'the listener reads its config from its environment'
	);
	assert.match(
		p.argv.at(-1) ?? '',
		/rm -f .*\.jitconfig; exec /,
		'the staged credential is removed before the listener starts, not left for the job'
	);
	assert.match(p.argv.at(-1) ?? '', /slot0\/bin/);
});

/**
 * ISSUE #22 — the fleet killed every job at one hour.
 *
 * `ttlSeconds: 3600` was minted onto every JIT unit as `RuntimeMaxSec`, and the
 * comment beside it called it an ORPHAN timeout. systemd cannot tell an orphan
 * from a build at minute 59: brave-quartet's `check` (run 34543150470) died at
 * 3,601 s in `Post Run Swatinem/rust-cache@v2` with every substantive step
 * green.
 *
 * The property being pinned is not "the call site passes a bigger number" —
 * that is one path, and the call site is where the bug lived. It is that NO
 * input to this function can produce a `RuntimeMaxSec` below GitHub's own job
 * ceiling. The old value is in the table because it is the literal regression,
 * and the tiny ones because an orphan timeout is exactly the shape of number a
 * future reader would reach for.
 */
test('no ttlSeconds can put RuntimeMaxSec below GitHub’s own job ceiling', () => {
	assert.ok(
		JIT_UNIT_MAX_SEC > GITHUB_JOB_CEILING_SEC,
		'the backstop must sit ABOVE the ceiling GitHub enforces, or it fires first'
	);
	for (const ttlSeconds of [0, 1, 300, 900, 3600, GITHUB_JOB_CEILING_SEC - 1]) {
		const p = buildSpawnPlan({
			unit: 'jit-claw-3-brave-quartet-1787797008',
			slot: '/home/hadoku/.hadoku/jit/slot0',
			jitConfig: 'CFG',
			memoryMaxMb: 3000,
			ttlSeconds,
		});
		const prop = p.argv.find((a) => a.startsWith('--property=RuntimeMaxSec='));
		assert.ok(prop, `no RuntimeMaxSec emitted for ttlSeconds=${ttlSeconds}`);
		const emitted = Number(prop.split('=').at(-1));
		assert.ok(
			emitted >= GITHUB_JOB_CEILING_SEC,
			`ttlSeconds=${ttlSeconds} produced RuntimeMaxSec=${emitted}, which kills a running job ` +
				`before GitHub's own ${GITHUB_JOB_CEILING_SEC}s timeout can cancel it cleanly`
		);
	}
});

/**
 * THE CONTAINMENT, not the per-unit cap.
 *
 * `MemoryMax` bounds ONE runner; the slice bounds their SUM, and only the sum is
 * what the 2026-08-04 outage was about (~51 GB anon-RSS, OOM took
 * pm2-hadoku.service and 23 services with it, host unreachable ~11 minutes).
 * All-JIT handed that back without anyone deciding to: a `systemd-run --user`
 * unit with no `Slice=` lands in `app.slice`, which is `MemoryMax=infinity`.
 *
 * Measured, not inferred. On claw-3 2026-09-14 20:20Z every live unit — two
 * `jit-*` and one `warm-*` — read `Slice=app.slice`, while `runners.slice` was
 * loaded at 14,543,749,120 bytes and held nothing. The kernel side is #26: the
 * `wasm-size` job of brave-quartet run 34543150470 was OOM-killed on claw-2 with
 * `oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/jit-claw-2-…`
 * — the unit's own cgroup, one level below `app.slice`, never `runners.slice`.
 *
 * The property pinned is NOT "the call site passes a slice". It is that no input
 * to these builders can produce a unit with no `Slice=` at all, which is exactly
 * the failure that shipped: nobody passed one because there was nothing to pass.
 */
test('no input can mint a unit without a Slice= — JIT and warm alike', () => {
	const bases = {
		jit: (sliceName?: string | null) =>
			buildSpawnPlan({
				unit: 'jit-claw-3-brave-quartet-1787797008',
				slot: '/home/hadoku/.hadoku/jit/slot0',
				jitConfig: 'CFG',
				memoryMaxMb: 3000,
				ttlSeconds: JIT_UNIT_MAX_SEC,
				sliceName,
			}),
		warm: (sliceName?: string | null) =>
			buildWarmSpawnPlan({
				unit: 'warm-claw-3-hadoku_site',
				slot: '/home/hadoku/.hadoku/warm/listener',
				memoryMaxMb: 3000,
				sliceName,
			}),
	};
	// undefined is the live call today: neither `mintEphemeralRunner` nor
	// `mintWarmListener` carries a slice name, so the default is the whole
	// mechanism rather than a fallback nothing reaches.
	for (const [kind, build] of Object.entries(bases)) {
		for (const bad of [undefined, null, '', '   ', 'app.slice-but-not', 'runners', '../evil']) {
			const p = build(bad);
			const prop = p.argv.find((a) => a.startsWith('--property=Slice='));
			assert.ok(prop, `${kind}: no Slice= emitted for sliceName=${JSON.stringify(bad)}`);
			assert.equal(
				prop,
				`--property=Slice=${DEFAULT_RUNNER_SLICE}`,
				`${kind}: sliceName=${JSON.stringify(bad)} must fall back to the fleet slice, ` +
					'never to app.slice by omission and never to a name systemd would refuse'
			);
		}
		// A real override is honoured — hokon's `ci-runner.slice` is the one in the
		// manifest, and the whole point of resolving rather than hardcoding is that
		// threading it later needs no second mechanism.
		const over = build('ci-runner.slice');
		assert.ok(over.argv.includes('--property=Slice=ci-runner.slice'), `${kind}: override ignored`);
	}
});

test('Slice= is emitted BEFORE the payload, so it is a systemd-run property and not a job argument', () => {
	// `systemd-run` parses its own flags up to the command; a --property after the
	// binary is an argument TO the runner and silently does nothing — which would
	// reproduce the exact uncontained state this change fixes, while the argv read
	// as correct to anyone grepping for the string.
	const p = buildSpawnPlan({
		unit: 'jit-claw-3-x-1787797008',
		slot: '/s',
		jitConfig: 'CFG',
		memoryMaxMb: 3000,
		ttlSeconds: JIT_UNIT_MAX_SEC,
	});
	const slice = p.argv.findIndex((a) => a.startsWith('--property=Slice='));
	assert.ok(slice > 0);
	assert.ok(
		slice < p.argv.indexOf('/bin/sh'),
		`Slice= must precede the command: ${JSON.stringify(p.argv)}`
	);
	const w = buildWarmSpawnPlan({ unit: 'warm-claw-3-x', slot: '/s', memoryMaxMb: 3000 });
	const wSlice = w.argv.findIndex((a) => a.startsWith('--property=Slice='));
	assert.ok(wSlice > 0 && wSlice < w.argv.length - 2, `Slice= must precede the binary: ${w.argv}`);
});

test('a ttlSeconds ABOVE the floor is honoured — the floor widens, it does not pin', () => {
	// Clamping in both directions would make the argument a lie and silently cap
	// a repo that legitimately raised its own `timeout-minutes`.
	const wide = JIT_UNIT_MAX_SEC * 2;
	const p = buildSpawnPlan({
		unit: 'jit-claw-3-brave-quartet-1787797008',
		slot: '/home/hadoku/.hadoku/jit/slot0',
		jitConfig: 'CFG',
		memoryMaxMb: 3000,
		ttlSeconds: wide,
	});
	assert.ok(p.argv.includes(`--property=RuntimeMaxSec=${wide}`));
});

test('backstopUnitMemoryMaxMb: the declared cap, clamped to the allowance, never zero', () => {
	assert.equal(backstopUnitMemoryMaxMb({ requestedMb: 8192, sliceMaxMb: 16384 }), 8192);
	assert.equal(backstopUnitMemoryMaxMb({ requestedMb: 32768, sliceMaxMb: 16384 }), 16384);
	assert.equal(backstopUnitMemoryMaxMb({ sliceMaxMb: 16384 }), JOB_RESERVE_DEFAULT_MB);
	assert.equal(
		backstopUnitMemoryMaxMb({ requestedMb: 0, sliceMaxMb: null }),
		JOB_RESERVE_DEFAULT_MB
	);
});
