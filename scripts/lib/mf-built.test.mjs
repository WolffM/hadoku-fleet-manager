/**
 * #111 — the built half of `fleet mf-externals`. Fixtures are shaped like the
 * live bundles measured 2026-10-20: an externalized app keeps a bare
 * `from "react/jsx-runtime"`; React's element factory carries
 * `Symbol.for("react.transitional.element")`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlBundle, fetchText, judgeBuilt, relativeImports, siteOrigin } from './mf-built.mjs';

const EXTERNAL =
	'import{jsx as e}from"react/jsx-runtime";import{useState as t}from"react";export{e,t};';
const INLINED =
	'var e=Symbol.for("react.transitional.element");function j(t,n){return{$$typeof:e,type:t,props:n}}export{j};';
// react-is: the same key, in an app whose React IS external.
const REACT_IS =
	'import{jsx as x}from"react/jsx-runtime";var a=Symbol.for("react.transitional.element");export{a,x};';

test('an externalized bundle is clean', () => {
	assert.equal(judgeBuilt({ 'https://s/mf/a/index.js': EXTERNAL }), null);
});

test('the element key with NO jsx-runtime import is an inlined runtime, and names the file', () => {
	// MUTATION: drop the import half of the rule and the react-is test below fails;
	// drop the key half and this one does.
	const v = judgeBuilt({
		'https://s/mf/a/index.js?v=1': 'import"./c.js";',
		'https://s/mf/a/c.js': INLINED,
	});
	assert.match(v, /inlines React's element runtime/);
	assert.match(v, /https:\/\/s\/mf\/a\/c\.js/);
	assert.doesNotMatch(v, /index\.js/, 'only the file that carries the key is named');
});

test('React 18 spelling of the key counts too', () => {
	assert.ok(judgeBuilt({ u: 'var e=Symbol.for("react.element");' }));
});

test('the key beside a bare jsx-runtime import is react-is, not a second React', () => {
	assert.equal(judgeBuilt({ u: REACT_IS }), null);
});

test('relativeImports finds static, side-effect and dynamic chunk imports, and nothing bare', () => {
	const src =
		'import{a}from"./chunk-A.js";import"./side.js";const m=import("../up.js");import{b}from"react";';
	assert.deepEqual(relativeImports(src).sort(), ['../up.js', './chunk-A.js', './side.js']);
});

test("siteOrigin reads astro.config's site, without a trailing slash; absent is null", () => {
	assert.equal(
		siteOrigin("export default defineConfig({\n\tsite: 'https://example.test/',\n});"),
		'https://example.test'
	);
	assert.equal(siteOrigin('export default {}'), null);
});

/** A fetch over a `{ url: body | status }` table, counting calls. */
function fakeFetch(table) {
	const calls = [];
	const f = async (url) => {
		calls.push(url);
		const v = table[url];
		if (v === undefined || typeof v === 'number')
			return { ok: false, status: v ?? 404, text: async () => '' };
		if (v instanceof Error) throw v;
		return { ok: true, status: 200, text: async () => v };
	};
	f.calls = calls;
	return f;
}

test('crawlBundle follows chunks inside the app, and reads each once', async () => {
	const f = fakeFetch({
		'https://s/mf/a/index.js?v=2': 'import"./c1.js";import"./c2.js";',
		'https://s/mf/a/c1.js': 'import"./c2.js";' + EXTERNAL,
		'https://s/mf/a/c2.js': 'export{};',
	});
	const r = await crawlBundle('https://s/mf/a/index.js?v=2', f);
	assert.deepEqual(Object.keys(r.files).sort(), [
		'https://s/mf/a/c1.js',
		'https://s/mf/a/c2.js',
		'https://s/mf/a/index.js?v=2',
	]);
	assert.equal(f.calls.length, 3);
});

test('a chunk that cannot be fetched is "not fully read", never a clean bundle', async () => {
	const f = fakeFetch({ 'https://s/mf/a/index.js': 'import"./gone.js";' });
	const r = await crawlBundle('https://s/mf/a/index.js', f);
	assert.equal(r.files, undefined);
	assert.match(r.reason, /gone\.js: HTTP 404/);
	assert.equal(f.calls.length, 2, 'a 404 is an answer and is not retried');
});

test('fetchText retries a thrown failure once and keeps the reason', async () => {
	let n = 0;
	const r = await fetchText('https://s/x', async () => {
		n++;
		throw Object.assign(new Error('socket hang up'), { status: undefined });
	});
	assert.equal(n, 2);
	assert.equal(r.ok, false);
	assert.match(r.reason, /socket hang up \(attempt 2\/2\)/);
});
