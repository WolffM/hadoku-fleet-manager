import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	BACKSTOP_LABEL,
	BUILDER_LABEL,
	PM2_HOST_LABEL,
	HOSTED_NODE,
	nodeOf,
	runnerCensus,
	type CensusInput,
	type CensusRunner,
} from '../runners/census.js';

const runner = (
	name: string,
	opts: { status?: string; busy?: boolean; labels?: string[] } = {}
): CensusRunner => ({
	name,
	status: opts.status ?? 'online',
	busy: opts.busy ?? false,
	labels: (opts.labels ?? [BUILDER_LABEL]).map((n) => ({ name: n })),
});

const census = (runners: CensusRunner[], over: Partial<CensusInput> = {}) =>
	runnerCensus({
		runners,
		clawNodes: new Set(['claw-1', 'claw-2', 'claw-3']),
		ephemeralNodes: new Set(),
		probe: null,
		...over,
	});

// ---- nodeOf ------------------------------------------------------------

const FLEET = ['claw-1', 'claw-2', 'claw-3', 'hokon'];

test('nodeOf folds an instance suffix onto its node', () => {
	// The rule is longest declared-name prefix, not a suffix regex. The version
	// this replaced stripped a trailing `-b` — a convention retired 2026-08-24 —
	// so it folded nothing that exists and left hokon-tenhands as its own node.
	assert.equal(nodeOf('hokon-tenhands', FLEET), 'hokon');
	assert.equal(nodeOf('claw-3-b', FLEET), 'claw-3');
	assert.equal(nodeOf('claw-3', FLEET), 'claw-3');
});

test('nodeOf folds a JIT runner onto the node that minted it', () => {
	// Named per JOB, so grouping by raw name gave the fleet panel a new row for
	// every job claw-3 served: 70 node rows for a four-node fleet.
	assert.equal(nodeOf('jit-claw-3-hadoku_site-r33269108875-1788030270', FLEET), 'claw-3');
});

test('nodeOf folds a hand-named runner that names its node as an inner segment', () => {
	// `w3p-claw-8-tenhands-taskauto-proof` showed up as its own machine row.
	const nodes = [...FLEET, 'claw-8', 'claw-10'];
	assert.equal(nodeOf('w3p-claw-8-tenhands-taskauto-proof', nodes), 'claw-8');
	assert.equal(nodeOf('w3p-claw-10-x', nodes), 'claw-10', 'claw-1 must not capture claw-10');
	assert.equal(nodeOf('probe-on-claw-2', nodes), 'claw-2');
	assert.equal(
		nodeOf('w3p-nowhere-x', nodes),
		'w3p-nowhere-x',
		'an unknown runner still looks unknown'
	);
});

test('nodeOf folds every GitHub-hosted runner into one pool', () => {
	// Also named per job. 58 of those 70 rows were one hosted job each.
	assert.equal(nodeOf('GitHub Actions 1000024103', FLEET), HOSTED_NODE);
	assert.equal(nodeOf('GitHub Actions 1', FLEET), HOSTED_NODE);
	// Not a blanket "starts with GitHub Actions" match.
	assert.equal(nodeOf('GitHub Actions runner', FLEET), 'GitHub Actions runner');
});

test('nodeOf prefers the LONGEST prefix, so a new node cannot be captured', () => {
	assert.equal(nodeOf('claw-1x-b', [...FLEET, 'claw-1x']), 'claw-1x');
});

test('nodeOf returns an unknown runner unchanged rather than guessing', () => {
	// An unknown runner should LOOK unknown. Attributing it to a node would
	// put someone else's jobs on that node's row.
	assert.equal(nodeOf('mystery-box', FLEET), 'mystery-box');
	assert.equal(nodeOf('claw-b-1', FLEET), 'claw-b-1');
	// With no node list at all, nothing can be folded.
	assert.equal(nodeOf('hokon-tenhands'), 'hokon-tenhands');
});

// ---- identity vs eligibility (the P2 of 2026-08-27) -----------------------

test('a DEMOTED but healthy claw still counts as online', () => {
	// The exact regression: hadoku-builder is rewritten by the fast loop, so
	// a demoted claw carries no label at all. It is still a claw.
	const c = census([
		runner('claw-1', { labels: [] }),
		runner('claw-2', { labels: [BUILDER_LABEL] }),
	]);
	assert.equal(c.clawsOnline, 2);
	assert.equal(c.clawsRegistered, 2);
});

test('a demoted claw is NOT free — free is eligibility, not identity', () => {
	const c = census([
		runner('claw-1', { labels: [] }),
		runner('claw-2', { labels: [BUILDER_LABEL] }),
	]);
	assert.equal(c.clawsFree, 1);
});

test('an offline claw is registered but not online', () => {
	const c = census([runner('claw-1', { status: 'offline' }), runner('claw-2')]);
	assert.equal(c.clawsRegistered, 2);
	assert.equal(c.clawsOnline, 1);
});

test('a busy claw is online but not free', () => {
	const c = census([runner('claw-1', { busy: true }), runner('claw-2')]);
	assert.equal(c.clawsOnline, 2);
	assert.equal(c.clawsFree, 1);
});

test('two instances on one node count as two registrations', () => {
	// Deliberate: the count is of INSTANCES, which is what a queued job sees.
	const c = census([runner('claw-1'), runner('claw-1-b')]);
	assert.equal(c.clawsOnline, 2);
});

// ---- the hokon pool is never a claw ---------------------------------------

test('the pm2-host and its backstops are excluded from the claw counts', () => {
	const c = census([
		runner('claw-1'),
		runner('hokon', { labels: [PM2_HOST_LABEL] }),
		runner('hokon-b', { labels: [BACKSTOP_LABEL] }),
	]);
	assert.equal(c.clawsOnline, 1);
	assert.deepEqual(
		c.hokonPool.map((r) => r.name),
		['hokon', 'hokon-b']
	);
	assert.equal(c.backstopOnline, 2);
});

test('a PROMOTED backstop carrying hadoku-builder is still not a claw', () => {
	// If it were, the next tick would read "claws are back" and demote the pool
	// it had just promoted — a flap, every tick, during an outage.
	const c = census([runner('hokon-b', { labels: [BACKSTOP_LABEL, BUILDER_LABEL] })]);
	assert.equal(c.clawsOnline, 0);
	assert.equal(c.clawsFree, 0);
});

test('an offline backstop is in the pool but not counted online', () => {
	const c = census([runner('hokon', { status: 'offline', labels: [PM2_HOST_LABEL] })]);
	assert.equal(c.hokonPool.length, 1);
	assert.equal(c.backstopOnline, 0);
});

// ---- ephemeral nodes (the P2 of 2026-08-28) ----------------------------

const EPHEMERAL = { ephemeralNodes: new Set(['claw-3']) };

test('a reachable mintable node counts despite holding no registrations', () => {
	const c = census([runner('claw-1'), runner('claw-2')], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: true } } },
	});
	assert.equal(c.clawsOnline, 3);
	assert.equal(c.clawsRegistered, 3);
});

test('a QUARANTINED mintable node does not count', () => {
	const c = census([runner('claw-1')], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: true, sick: true } } },
	});
	assert.equal(c.clawsOnline, 1);
});

test('an UNREACHABLE mintable node does not count', () => {
	const c = census([runner('claw-1')], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: false } } },
	});
	assert.equal(c.clawsOnline, 1);
});

test('a MISSING probe counts as down, never as up', () => {
	// Guessing upward here is how a real outage stays invisible.
	assert.equal(census([runner('claw-1')], { ...EPHEMERAL, probe: null }).clawsOnline, 1);
	assert.equal(census([runner('claw-1')], { ...EPHEMERAL, probe: { nodes: {} } }).clawsOnline, 1);
});

test('a mintable node contributes its FREE SLOTS, not a runner count', () => {
	// The third instance of the counting bug this module exists to prevent.
	// clawsFree asks "can a job start right now"; an ephemeral node holds no
	// standing registration, so counting runner instances finds nothing on it
	// however much room it has. isAtCapacity is `clawsFree === 0` and gates a
	// saturation promote of the PRODUCTION HOST, so missing this reaches for
	// hokon over an idle fleet.
	const c = census([], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: true, free: 2 } } },
	});
	assert.equal(c.clawsOnline, 1, 'one node');
	assert.equal(c.clawsFree, 2, 'but two slots');
});

test('a mintable node with no room contributes no free slots', () => {
	const c = census([], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: true, free: 0 } } },
	});
	assert.equal(c.clawsOnline, 1, 'still online — it is reachable');
	assert.equal(c.clawsFree, 0, 'but full');
});

test('a QUARANTINED mintable node contributes no free slots however much room it reports', () => {
	const c = census([], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: true, sick: true, free: 8 } } },
	});
	assert.equal(c.clawsFree, 0);
	assert.equal(c.clawsOnline, 0);
});

test('a probe with no free field contributes 0, never a guess', () => {
	const c = census([], { ...EPHEMERAL, probe: { nodes: { 'claw-3': { reachable: true } } } });
	assert.equal(c.clawsOnline, 1);
	assert.equal(c.clawsFree, 0, 'absent capacity is not assumed capacity');
});

test('standing and mintable free slots ADD', () => {
	const c = census([runner('claw-1'), runner('claw-2', { busy: true })], {
		...EPHEMERAL,
		probe: { nodes: { 'claw-3': { reachable: true, free: 2 } } },
	});
	assert.equal(c.clawsFree, 3, 'one idle standing claw plus two mintable slots');
});

// ---- degraded inputs ------------------------------------------------------

test('an unreadable manifest falls back to labels rather than declaring an outage', () => {
	const c = census([runner('claw-1'), runner('hokon', { labels: [PM2_HOST_LABEL] })], {
		clawNodes: new Set(),
	});
	assert.equal(c.clawsOnline, 1);
});

test('pm2Busy is true only when the pm2-host runner itself is busy', () => {
	assert.equal(census([runner('hokon', { labels: [PM2_HOST_LABEL], busy: true })]).pm2Busy, true);
	assert.equal(census([runner('hokon', { labels: [PM2_HOST_LABEL] })]).pm2Busy, false);
	// A busy CLAW is not the pm2 host being busy.
	assert.equal(census([runner('claw-1', { busy: true })]).pm2Busy, false);
});

test('an empty fleet reports zeros rather than throwing', () => {
	const c = census([]);
	assert.equal(c.clawsOnline, 0);
	assert.equal(c.clawsRegistered, 0);
	assert.equal(c.clawsFree, 0);
	assert.equal(c.backstopOnline, 0);
	assert.equal(c.pm2Busy, false);
	assert.deepEqual(c.online, []);
	assert.deepEqual(c.hokonPool, []);
});

test('an ephemeral node contributes its mintable slots to clawsFree', () => {
	const c = census([], {
		ephemeralNodes: new Set(['claw-3']),
		probe: { nodes: { 'claw-3': { reachable: true, free: 2 } } },
	});
	assert.equal(c.clawsFree, 2);
});

/**
 * The 2026-09-01 outage, expressed as a test.
 *
 * `clawsFree` alone cannot distinguish "six idle runners GitHub can assign to
 * right now" from "six slots a dispatcher must mint into first". With three of
 * four nodes ephemeral, the fleet reported healthy with free capacity while
 * ZERO online runners carried hadoku-builder — the backstop stayed suppressed
 * and jobs queued 11-19 minutes.
 *
 * The manifest's own note says re-converting claw-2 "needs the phantom-capacity
 * fix FIRST — census and backstop must count ephemeral nodes as zero STANDING
 * capacity". These assert the census can now say that.
 */
test('an all-ephemeral fleet reports free capacity but ZERO standing', () => {
	const c = runnerCensus({
		runners: [],
		clawNodes: new Set(['claw-1', 'claw-2', 'claw-3', 'claw-4']),
		ephemeralNodes: new Set(['claw-1', 'claw-3']),
		probe: {
			nodes: {
				'claw-1': { reachable: true, free: 2, sick: false },
				'claw-3': { reachable: true, free: 1, sick: false },
			},
		},
	});
	assert.equal(c.clawsFree, 3, 'mintable capacity is still real capacity');
	assert.equal(c.clawsFreeStanding, 0, 'nothing can answer without the dispatcher');
	assert.equal(c.clawsFreeMintable, 3);
});

// The 2026-09-02 alert-noise fix. `clawsMintableOnline` counts NODES, so a fleet
// whose every slot is busy still reports capacity that exists — the label floor
// keys on this rather than on free slots, and paging for a full fleet would trade
// one false alarm for another.
test('a fully BUSY ephemeral fleet still reports mintable nodes online', () => {
	const c = runnerCensus({
		runners: [],
		clawNodes: new Set(['claw-1', 'claw-3']),
		ephemeralNodes: new Set(['claw-1', 'claw-3']),
		probe: {
			nodes: {
				'claw-1': { reachable: true, free: 0, sick: false },
				'claw-3': { reachable: true, free: 0, sick: false },
			},
		},
	});
	assert.equal(c.clawsFreeMintable, 0, 'no slot is free right this second');
	assert.equal(c.clawsMintableOnline, 2, 'but two nodes can still mint — a queue, not an outage');
});

test('a sick or unreachable ephemeral node is NOT counted as mintable-online', () => {
	// This is the branch that must still page: nothing can produce a runner.
	const c = runnerCensus({
		runners: [],
		clawNodes: new Set(['claw-1', 'claw-3']),
		ephemeralNodes: new Set(['claw-1', 'claw-3']),
		probe: {
			nodes: {
				'claw-1': { reachable: false, free: 0, sick: false },
				'claw-3': { reachable: true, free: 3, sick: true },
			},
		},
	});
	assert.equal(c.clawsMintableOnline, 0, 'unreachable and sick both count as down');
	assert.equal(c.clawsFreeMintable, 0);
});

test('the two halves always sum to clawsFree', () => {
	// If they ever drift, a reader reconciling them against clawsFree will trust
	// whichever they looked at first.
	const c = runnerCensus({
		runners: [runner('claw-2', { busy: false }), runner('claw-4', { busy: true })],
		clawNodes: new Set(['claw-1', 'claw-2', 'claw-4']),
		ephemeralNodes: new Set(['claw-1']),
		probe: { nodes: { 'claw-1': { reachable: true, free: 4, sick: false } } },
	});
	assert.equal(c.clawsFreeStanding + c.clawsFreeMintable, c.clawsFree);
	assert.equal(c.clawsFreeStanding, 1, 'claw-2 is idle and labelled; claw-4 is busy');
	assert.equal(c.clawsFreeMintable, 4);
});

test('an UNREACHABLE ephemeral node contributes no mintable capacity', () => {
	// A promise from a node nobody can reach is not capacity.
	const c = runnerCensus({
		runners: [],
		clawNodes: new Set(['claw-1']),
		ephemeralNodes: new Set(['claw-1']),
		probe: { nodes: { 'claw-1': { reachable: false, free: 9, sick: false } } },
	});
	assert.equal(c.clawsFreeMintable, 0);
	assert.equal(c.clawsFree, 0);
});

// ---- the ladder is a LABEL, not a hostname (#6) ----------------------------

test('a CLAW that earns pm2-host is read exactly as the production host is', () => {
	// `pm2-host` became a PROBED capability on 2026-09-15, so migration one's box
	// will be a claw carrying it. Everything here already keys on the LABEL —
	// `hokonPool`, `isEligibleBuilder` and `pm2Busy` all ask `has(r, …)` and none
	// of them asks a name — and this is the assertion that says so, because the
	// day that stops being true the census quietly counts the fleet's own
	// production host as spare CI capacity.
	const c = census([runner('claw-7', { labels: [PM2_HOST_LABEL], busy: true }), runner('claw-1')]);
	assert.deepEqual(
		c.hokonPool.map((r) => r.name),
		['claw-7'],
		'the pool is whoever carries the label'
	);
	assert.equal(c.pm2Busy, true, 'a busy pm2-host is a busy pm2-host wherever it runs');
	assert.equal(c.clawsFree, 1, 'and it is not counted as a free builder');
});

test('an idle claw carrying pm2-host is not counted as a free builder', () => {
	const c = census([runner('claw-7', { labels: [PM2_HOST_LABEL] })]);
	assert.equal(c.clawsFree, 0);
});
