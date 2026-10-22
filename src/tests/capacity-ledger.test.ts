import { strict as assert } from 'node:assert';
import { test, beforeEach } from 'node:test';

import {
	__resetCapacityLedgerForTesting,
	getCapacityLedger,
	judgeCapacity,
	recordCapacityLedger,
} from '../runners/capacity-ledger.js';

beforeEach(() => __resetCapacityLedgerForTesting());

const entry = (over: Partial<Parameters<typeof judgeCapacity>[0]>) => ({
	node: 'claw-1',
	liveUnits: 0,
	probeWorkers: 0,
	standingBusy: 0,
	warmHeld: 1,
	budget: 2,
	inFlight: 0,
	...over,
});

test('the 2026-10-07 double count breaks the invariant on the first running JIT job', () => {
	// claw-1 at 05:40Z: one JIT job, listener idle. The old formula charged
	// units 1 + workers 1 = 2 against max(1, 1).
	const v = judgeCapacity(entry({ liveUnits: 1, probeWorkers: 1, standingBusy: 1, inFlight: 2 }));
	assert.equal(v.ok, false);
	assert.match(
		v.why!,
		/charged 2 in flight against 1 JIT unit\(s\) and 1 running worker\(s\).*counted twice/
	);
	// claw-3: one JIT job, listener busy. Charged 3 against max(1, 2).
	const v3 = judgeCapacity(entry({ liveUnits: 1, probeWorkers: 2, standingBusy: 2, inFlight: 3 }));
	assert.equal(v3.ok, false);
});

test('correct accounting sits under max(units, workers) in every shape the fleet has', () => {
	const ok = (e: Parameters<typeof judgeCapacity>[0]) =>
		assert.deepEqual(judgeCapacity(e), { ok: true, why: null }, JSON.stringify(e));
	ok(entry({ liveUnits: 1, probeWorkers: 1, inFlight: 1 })); // one JIT job
	ok(entry({ liveUnits: 1, probeWorkers: 2, inFlight: 1 })); // JIT job + busy held listener
	ok(entry({ liveUnits: 1, probeWorkers: 0, inFlight: 1 })); // unit still registering
	ok(entry({ liveUnits: 2, probeWorkers: 0, inFlight: 2 })); // two units starting
	ok(entry({ liveUnits: 0, probeWorkers: 1, inFlight: 0 })); // only the held listener, busy
	ok(entry({ liveUnits: 1, probeWorkers: 2, standingBusy: 1, inFlight: 2, warmHeld: 0 })); // JIT + a standing deploy (hokon)
	ok(entry({ liveUnits: 0, probeWorkers: 2, standingBusy: 2, inFlight: 2, warmHeld: 0 })); // two standing jobs
	ok(entry({ liveUnits: 3, probeWorkers: 3, inFlight: 3 })); // three Forge shards
});

test('a unit charged less than once is also broken — the other direction', () => {
	const v = judgeCapacity(entry({ liveUnits: 2, probeWorkers: 2, inFlight: 1 }));
	assert.equal(v.ok, false);
	assert.match(v.why!, /counted less than once/);
});

test('the ledger is one pass, judged, stamped; a fresh process has none', () => {
	assert.equal(getCapacityLedger(), null);
	const at = Date.parse('2026-10-21T05:40:09Z');
	const l = recordCapacityLedger(
		[
			entry({ node: 'claw-1', liveUnits: 1, probeWorkers: 1, standingBusy: 1, inFlight: 2 }),
			entry({ node: 'claw-9', liveUnits: 2, probeWorkers: 2, inFlight: 2, budget: 3 }),
		],
		at
	);
	assert.equal(l.at, '2026-10-21T05:40:09.000Z');
	assert.deepEqual(
		l.nodes.map((n) => [n.node, n.ok]),
		[
			['claw-1', false],
			['claw-9', true],
		]
	);
	assert.equal(getCapacityLedger(), l);
	recordCapacityLedger([], at + 1);
	assert.deepEqual(getCapacityLedger()?.nodes, [], 'replaced wholesale, never merged');
});
