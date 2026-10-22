import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packsRequired } from './toolpack-rules.mjs';

const PACKS = {
	base: { when: 'always', apt: ['curl'], bins: ['curl'] },
	wifi: { when: 'wireless', apt: ['iw'], bins: ['iw'] },
	nvmeTools: { when: 'nvme', apt: ['nvme-cli'], bins: ['nvme'] },
	pip: { when: 'ciClaw', apt: ['python3-pip'], bins: ['pip3'] },
};

test('always: required on every shape, wired or not', () => {
	const names = packsRequired(PACKS, { wireless: '0', nvme: '0' }, false).map(([n]) => n);
	assert.ok(names.includes('base'));
});

test('wireless: only required when the shape actually reports a radio', () => {
	assert.ok(packsRequired(PACKS, { wireless: '1' }, false).some(([n]) => n === 'wifi'));
	assert.ok(!packsRequired(PACKS, { wireless: '0' }, false).some(([n]) => n === 'wifi'));
});

test('nvme: only required when the shape reports an nvme block device', () => {
	assert.ok(packsRequired(PACKS, { nvme: '2' }, false).some(([n]) => n === 'nvmeTools'));
	assert.ok(!packsRequired(PACKS, { nvme: '0' }, false).some(([n]) => n === 'nvmeTools'));
});

test('ciClaw: a MANIFEST fact, not read off shape at all — a pm2-host never gets it', () => {
	assert.ok(packsRequired(PACKS, {}, true).some(([n]) => n === 'pip'));
	assert.ok(!packsRequired(PACKS, {}, false).some(([n]) => n === 'pip'));
});

test('an unknown `when` requires nothing, rather than throwing', () => {
	const packs = { mystery: { when: 'never-heard-of-it', apt: [], bins: [] } };
	assert.deepEqual(packsRequired(packs, {}, true), []);
});
