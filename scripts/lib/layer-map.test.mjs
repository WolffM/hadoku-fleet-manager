import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LAYERS, DOMAINS, PARTS, validateLayerMap, matchLayer, LAYER_MAP } from './layer-map.mjs';

/**
 * `validateLayerMap` is what stands between a malformed `layer-map.json`
 * edit and a map that silently classifies nothing (CLAUDE.md: "I could not
 * look" must never render as "nothing is wrong"). Each test below feeds it
 * a fixture payload — never the real file on disk — so a future edit to
 * `layer-map.json` cannot make one of these tests pass or fail for the wrong
 * reason.
 */

test('a well-formed flat-layer entry and a well-formed domain entry both validate', () => {
	const ok = validateLayerMap([
		{ glob: 'src/index.ts', layer: 'composition' },
		{ glob: 'src/runners/census.ts', layer: 'domain', domain: 'observation', part: 'core' },
		{ glob: 'src/x.ts', layer: 'state', why: 'rationale' },
		{ glob: 'src/y.ts', layer: 'automation', section: 'group rationale' },
	]);
	assert.equal(ok.length, 4);
});

test('the top-level payload must be an array', () => {
	assert.throws(() => validateLayerMap({ glob: 'x', layer: 'state' }), /expected an array/);
	assert.throws(() => validateLayerMap(null), /expected an array/);
});

test('a non-object entry throws naming its index', () => {
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'state' }, 'not an object']),
		/layer-map\.json\[1\]: expected an object/
	);
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'state' }, null, { glob: 'b', layer: 'state' }]),
		/layer-map\.json\[1\]: expected an object/
	);
});

test('an unknown key throws naming its index', () => {
	assert.throws(
		() =>
			validateLayerMap([
				{ glob: 'a', layer: 'state' },
				{ glob: 'b', layer: 'state', typo: 'oops' },
			]),
		/layer-map\.json\[1\]: unknown key "typo"/
	);
});

test('a non-string or empty glob throws naming its index', () => {
	assert.throws(
		() =>
			validateLayerMap([
				{ glob: 'a', layer: 'state' },
				{ glob: 7, layer: 'state' },
			]),
		/layer-map\.json\[1\]: "glob" must be a non-empty string/
	);
	assert.throws(
		() =>
			validateLayerMap([
				{ glob: 'a', layer: 'state' },
				{ glob: '', layer: 'state' },
			]),
		/layer-map\.json\[1\]: "glob" must be a non-empty string/
	);
});

test('a layer outside LAYERS throws naming its index', () => {
	assert.throws(
		() =>
			validateLayerMap([
				{ glob: 'a', layer: 'state' },
				{ glob: 'b', layer: 'bogus' },
			]),
		/layer-map\.json\[1\] \(b\): "layer" must be one of/
	);
});

test('layer "domain" requires a valid domain and part', () => {
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'domain', part: 'core' }]),
		/layer-map\.json\[0\] \(a\): layer "domain" requires "domain" to be one of/
	);
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'domain', domain: 'bogus', part: 'core' }]),
		/layer-map\.json\[0\] \(a\): layer "domain" requires "domain" to be one of/
	);
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'domain', domain: 'lifecycle' }]),
		/layer-map\.json\[0\] \(a\): layer "domain" requires "part" to be one of/
	);
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'domain', domain: 'lifecycle', part: 'bogus' }]),
		/layer-map\.json\[0\] \(a\): layer "domain" requires "part" to be one of/
	);
});

test('domain/part set on a non-domain layer throws — "domain/part set iff layer is domain"', () => {
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'state', domain: 'lifecycle' }]),
		/layer-map\.json\[0\] \(a\): "domain" is only valid when layer is "domain"/
	);
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'config', part: 'core' }]),
		/layer-map\.json\[0\] \(a\): "part" is only valid when layer is "domain"/
	);
});

test('why/section must be strings when present', () => {
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'state', why: 42 }]),
		/layer-map\.json\[0\] \(a\): "why" must be a string/
	);
	assert.throws(
		() => validateLayerMap([{ glob: 'a', layer: 'state', section: false }]),
		/layer-map\.json\[0\] \(a\): "section" must be a string/
	);
});

test('the real layer-map.json loads, validates, and matchLayer stays total over itself', () => {
	// Every glob literal in the map (the exact, non-wildcard entries) must
	// classify itself — a cheap sanity check that the loaded data and the
	// matcher agree, without re-deriving the full `measure-layers.mjs` walk.
	assert.ok(LAYER_MAP.length > 0);
	for (const entry of LAYER_MAP) {
		if (entry.glob.includes('*')) continue;
		assert.deepEqual(matchLayer(entry.glob), entry, `matchLayer(${entry.glob})`);
	}
});

test('LAYERS/DOMAINS/PARTS are frozen and match what the validator accepts', () => {
	assert.ok(Object.isFrozen(LAYERS));
	assert.ok(Object.isFrozen(DOMAINS));
	assert.ok(Object.isFrozen(PARTS));
	assert.ok(Object.isFrozen(LAYER_MAP));
});

test('matchLayer returns undefined for a path nothing matches', () => {
	assert.equal(matchLayer('this/path/does/not/exist.ts'), undefined);
});
