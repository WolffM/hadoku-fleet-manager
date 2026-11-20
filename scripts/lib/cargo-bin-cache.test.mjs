/**
 * lib/cargo-bin-cache.mjs: which Rust cache steps would clean the node's
 * `~/.cargo/bin`, read through the actions a workflow calls. The fixtures are
 * the shapes the fleet's own workflows had on 2026-11-19.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DEPTH, cargoBinCheck, classifyUses, refKey, stepsOf } from './cargo-bin-cache.mjs';

const OWNER = 'WolffM';
const wf = (steps) => `jobs:\n  check:\n    runs-on: x\n    steps:\n${steps}`;
const bodiesOf = (files) =>
	new Map(
		Object.entries(files).map(([repo, byName]) => [
			repo,
			{ ok: true, files: Object.entries(byName).map(([name, text]) => ({ name, text })) },
		])
	);
/** A `readActions` over `{ refKey: text | { reason } }`, recording what it was asked. */
const actionsOf = (table, asked = []) => {
	return (refs) => {
		asked.push(refs.map(refKey));
		return new Map(
			refs.map((r) => {
				const v = table[refKey(r)];
				if (typeof v === 'string') return [refKey(r), { ok: true, text: v }];
				return [refKey(r), { ok: false, reason: v?.reason ?? 'no action.yml' }];
			})
		);
	};
};
const check = (files, actions = {}, asked) =>
	cargoBinCheck(Object.keys(files), {
		bodies: bodiesOf(files),
		owner: OWNER,
		readActions: actionsOf(actions, asked),
	});

const UNSAFE_WRAPPER =
	'runs:\n  using: composite\n  steps:\n' +
	'    - name: Setup Rust (if needed)\n' +
	"      if: steps.detect-rust.outputs.has_rust == 'true'\n" +
	'      uses: actions-rust-lang/setup-rust-toolchain@a188e68 # v2.0.1\n' +
	'      with:\n        components: clippy\n';

test('stepsOf: a step keeps its own with, never the previous step’s', () => {
	const steps = stepsOf(
		wf(
			'      - uses: actions/checkout@v6\n        with:\n          fetch-depth: 0\n' +
				'      # cache-bin: false in a comment proves nothing\n' +
				'      - uses: Swatinem/rust-cache@d1527c8 # v2.9.3\n' +
				'        with:\n          key: wasm\n          cache-bin: false\n' +
				'      - name: named first\n        with: { cache: "false", toolchain: stable }\n' +
				'        uses: actions-rust-lang/setup-rust-toolchain@v2\n' +
				'      - uses: Swatinem/rust-cache@v2\n'
		)
	);
	assert.deepEqual(
		steps.map((s) => [s.uses, s.with]),
		[
			['actions/checkout@v6', { 'fetch-depth': '0' }],
			['Swatinem/rust-cache@d1527c8', { key: 'wasm', 'cache-bin': 'false' }],
			['actions-rust-lang/setup-rust-toolchain@v2', { cache: 'false', toolchain: 'stable' }],
			['Swatinem/rust-cache@v2', {}],
		]
	);
	assert.equal(steps[1].line, 9);
});

test('classifyUses: hazards, the owner’s actions, local paths, everything else', () => {
	const kind = (u) => classifyUses(u, 'WolffM/app', OWNER).kind;
	assert.equal(kind('swatinem/Rust-Cache@v2'), 'hazard');
	assert.equal(kind('actions/checkout@v6'), 'third-party');
	assert.equal(kind('docker://alpine:3'), 'third-party');
	assert.equal(kind('./.github/workflows/build.yml'), 'local-workflow');
	assert.deepEqual(classifyUses('wolffm/hadoku-actions/report-job@v1', 'WolffM/app', OWNER).ref, {
		repo: 'wolffm/hadoku-actions',
		ref: 'v1',
		path: 'report-job',
	});
	assert.deepEqual(classifyUses('./', 'WolffM/app', OWNER).ref, {
		repo: 'WolffM/app',
		ref: 'HEAD',
		path: '',
	});
});

test('the cache named directly: only a literal cache-bin: false is safe', () => {
	const res = check({
		'WolffM/a': {
			'ok.yml': wf(
				'      - uses: Swatinem/rust-cache@v2\n        with:\n          cache-bin: false\n'
			),
			'bare.yml': wf('      - uses: Swatinem/rust-cache@v2\n'),
			'expr.yml': wf(
				'      - uses: Swatinem/rust-cache@v2\n        with:\n          cache-bin: ${{ inputs.bin }}\n'
			),
			'commented.yml': wf(
				'      - uses: Swatinem/rust-cache@v2\n        # with:\n        #   cache-bin: false\n'
			),
		},
	});
	assert.equal(res.ok, false);
	assert.deepEqual(
		res.findings.map((f) => [f.file, f.status]),
		[
			['.github/workflows/bare.yml', 'deletes-bin'],
			['.github/workflows/expr.yml', 'deletes-bin'],
			['.github/workflows/commented.yml', 'deletes-bin'],
		]
	);
	assert.match(res.findings[1].reason, /cache-bin: \$\{\{ inputs\.bin \}\} is not a literal false/);
});

test('the 2026-11-18 shape: the cache arrives through the owner’s composite action', () => {
	const files = {
		'WolffM/vibecheck': {
			'vibecheck.yml': wf('      - name: Run vibeCheck\n        uses: WolffM/vibecheck@main\n'),
		},
	};
	const res = check(files, { 'WolffM/vibecheck@main:': UNSAFE_WRAPPER });
	assert.equal(res.findings.length, 1);
	const [f] = res.findings;
	assert.equal(f.status, 'deletes-bin');
	assert.equal(f.line, 6, 'the line in the WORKFLOW, where the operator can act');
	assert.deepEqual(f.via, [
		'WolffM/vibecheck@main',
		'actions-rust-lang/setup-rust-toolchain@a188e68',
	]);

	const fixed = UNSAFE_WRAPPER + '        cache-bin: false\n';
	const clean = check(files, { 'WolffM/vibecheck@main:': fixed });
	assert.deepEqual(clean, {
		ok: true,
		findings: [],
		examined: { repos: 1, files: 1, ownedActions: 1, thirdParty: 0 },
	});
});

test('a caller pinned to a pre-fix sha is still a finding; one read per distinct ref', () => {
	const asked = [];
	const res = check(
		{
			'WolffM/a': { 'v.yml': wf('      - uses: WolffM/vibecheck@old\n') },
			'WolffM/b': { 'v.yml': wf('      - uses: WolffM/vibecheck@old\n') },
			'WolffM/c': { 'v.yml': wf('      - uses: WolffM/vibecheck@new\n') },
		},
		{ 'WolffM/vibecheck@old:': UNSAFE_WRAPPER, 'WolffM/vibecheck@new:': 'runs:\n  steps: []\n' },
		asked
	);
	assert.deepEqual(
		res.findings.map((f) => f.repo),
		['WolffM/a', 'WolffM/b']
	);
	assert.deepEqual(asked, [['WolffM/vibecheck@old:', 'WolffM/vibecheck@new:']]);
});

test('an action another checkout put in the workspace is read from THAT repo', () => {
	const asked = [];
	const res = check(
		{
			'WolffM/site': {
				'release.yml': wf(
					'      - uses: actions/checkout@v6\n        with:\n' +
						'          repository: WolffM/hadoku-actions\n          ref: ${{ inputs.sha }}\n          path: actions\n' +
						'      - uses: ./actions/setup-pnpm\n'
				),
			},
		},
		{ 'WolffM/hadoku-actions@HEAD:setup-pnpm': 'runs:\n  steps: []\n' },
		asked
	);
	assert.equal(res.ok, true);
	assert.deepEqual(asked, [['WolffM/hadoku-actions@HEAD:setup-pnpm']]);
});

test('unreadable is a finding, never a pass', () => {
	const res = cargoBinCheck(['WolffM/a', 'WolffM/b', 'WolffM/c'], {
		bodies: new Map([
			['WolffM/a', { ok: false, reason: 'ETIMEDOUT (attempt 2/2)' }],
			[
				'WolffM/b',
				{ ok: true, files: [{ name: 'big.yml', text: null, reason: 'its body was truncated' }] },
			],
			[
				'WolffM/c',
				{ ok: true, files: [{ name: 'v.yml', text: wf('      - uses: WolffM/gone@v1\n') }] },
			],
		]),
		owner: OWNER,
		readActions: actionsOf({ 'WolffM/gone@v1:': { reason: 'no action.yml or action.yaml at v1' } }),
	});
	assert.equal(res.ok, false);
	assert.deepEqual(
		res.findings.map((f) => [f.repo, f.status]),
		[
			['WolffM/a', 'unreadable'],
			['WolffM/b', 'unreadable'],
			['WolffM/c', 'unreadable'],
		]
	);
	assert.match(res.findings[0].reason, /ETIMEDOUT/);
	assert.match(res.findings[2].reason, /WolffM\/gone@v1:.*no action\.yml/);
});

test('a scan that read no workflow file is an error, not a clean fleet', () => {
	const none = cargoBinCheck([], { bodies: new Map(), owner: OWNER, readActions: actionsOf({}) });
	assert.equal(none.ok, false);
	assert.match(none.error, /read no workflow file in 0 repo/);
	const empty = check({ 'WolffM/a': {} });
	assert.equal(empty.ok, false);
	assert.match(empty.error, /read no workflow file in 1 repo/);
});

test('actions that call each other end; a chain past MAX_DEPTH says it stopped', () => {
	const loop = check(
		{ 'WolffM/a': { 'v.yml': wf('      - uses: WolffM/x@v1\n') } },
		{
			'WolffM/x@v1:': 'runs:\n  steps:\n    - uses: WolffM/y@v1\n',
			'WolffM/y@v1:': 'runs:\n  steps:\n    - uses: WolffM/x@v1\n',
		}
	);
	assert.equal(loop.ok, true);

	const table = {};
	for (let i = 0; i <= MAX_DEPTH; i++) {
		table[`WolffM/d${i}@v1:`] = `runs:\n  steps:\n    - uses: WolffM/d${i + 1}@v1\n`;
	}
	const deep = check({ 'WolffM/a': { 'v.yml': wf('      - uses: WolffM/d0@v1\n') } }, table);
	assert.deepEqual(
		deep.findings.map((f) => f.status),
		['too-deep']
	);
	assert.equal(deep.findings[0].via.length, MAX_DEPTH + 1);
});
