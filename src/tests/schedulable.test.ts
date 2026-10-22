import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	isSchedulable,
	setUnschedulableNodes,
	unschedulableNodes,
} from '../runners/schedulable.js';

test('a node nobody has reported on is schedulable', () => {
	// Silence is not evidence against a node. A restarted process has seen
	// nothing, so treating the empty set as "all unschedulable" would zero the
	// whole fleet's capacity on the first tick.
	setUnschedulableNodes([]);
	assert.equal(isSchedulable('claw-1'), true);
	assert.equal(isSchedulable('a-node-that-does-not-exist'), true);
});

test('a reported node is not schedulable', () => {
	setUnschedulableNodes(['claw-4']);
	assert.equal(isSchedulable('claw-4'), false);
	assert.equal(isSchedulable('claw-2'), true);
});

test('the set is replaced wholesale, so recovery takes one pass', () => {
	// A node that comes back must stop being penalised immediately. Merging
	// instead of replacing would make the penalty permanent — the shape that made
	// a stale backstop hold pin hokon eligible forever.
	setUnschedulableNodes(['claw-4', 'claw-6']);
	assert.deepEqual(unschedulableNodes(), ['claw-4', 'claw-6']);
	setUnschedulableNodes(['claw-4']);
	assert.deepEqual(unschedulableNodes(), ['claw-4']);
	assert.equal(isSchedulable('claw-6'), true, 'claw-6 recovered on the next pass');
});

test('the accessor cannot be used to mutate the set', () => {
	setUnschedulableNodes(['claw-4']);
	unschedulableNodes().push('claw-2');
	assert.equal(isSchedulable('claw-2'), true);
	assert.deepEqual(unschedulableNodes(), ['claw-4']);
});
