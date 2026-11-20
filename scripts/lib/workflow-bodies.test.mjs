import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	BATCH,
	actionQuery,
	parseWorkflowBatch,
	readActionFiles,
	readWorkflowBodies,
	workflowQuery,
} from './workflow-bodies.mjs';

const blob = (name, text, extra = {}) => ({ name, type: 'blob', object: { text, ...extra } });

void test('the query aliases each repo by position, owner and name as string literals', () => {
	const q = workflowQuery(['o/a', 'o/b']);
	assert.match(q, /r0: repository\(owner: "o", name: "a"\)/);
	assert.match(q, /r1: repository\(owner: "o", name: "b"\)/);
	assert.match(q, /HEAD:\.github\/workflows/);
});

void test('a batch: bodies, no directory, an unresolvable repo, and an unreadable blob each say so', () => {
	const doc = {
		data: {
			r0: {
				object: {
					entries: [
						blob('ci.yml', 'jobs: {}'),
						blob('README.md', 'not a workflow'),
						{ name: 'sub', type: 'tree', object: {} },
						blob('big.yaml', 'cut', { isTruncated: true }),
						{ name: 'bin.yml', type: 'blob', object: { text: null } },
					],
				},
			},
			r1: { object: null },
			r2: null,
		},
		errors: [{ type: 'NOT_FOUND', path: ['r2'], message: 'Could not resolve' }],
	};
	const out = parseWorkflowBatch(doc, ['o/a', 'o/empty', 'o/gone']);
	assert.deepEqual(out.get('o/a'), {
		ok: true,
		files: [
			{ name: 'ci.yml', text: 'jobs: {}' },
			{ name: 'big.yaml', text: null, reason: 'its body was truncated' },
			{ name: 'bin.yml', text: null, reason: 'its body carried no text' },
		],
	});
	assert.deepEqual(out.get('o/empty'), { ok: true, files: [] });
	assert.equal(out.get('o/gone').ok, false);
	assert.match(out.get('o/gone').reason, /NOT_FOUND: Could not resolve/);
});

void test('gh exits non-zero on one alias NOT_FOUND; the rest of the batch is still read', () => {
	const runGh = () => {
		const err = new Error('Command failed');
		err.stdout = JSON.stringify({
			data: { r0: { object: { entries: [blob('ci.yml', 'x')] } }, r1: null },
			errors: [{ type: 'NOT_FOUND', path: ['r1'], message: 'gone' }],
		});
		throw err;
	};
	const out = readWorkflowBodies(['o/a', 'o/b'], { runGh });
	assert.deepEqual(out.get('o/a'), { ok: true, files: [{ name: 'ci.yml', text: 'x' }] });
	assert.equal(out.get('o/b').ok, false);
});

void test('a batch that fails every attempt marks each of its repos unreadable, with the reason', () => {
	let calls = 0;
	const runGh = () => {
		calls++;
		const err = new Error('Command failed');
		err.stderr = 'gh: ETIMEDOUT';
		throw err;
	};
	const out = readWorkflowBodies(['o/a', 'o/b'], { runGh, attempts: 2, sleep: () => {} });
	assert.equal(calls, 2);
	for (const r of ['o/a', 'o/b']) {
		assert.equal(out.get(r).ok, false);
		assert.match(out.get(r).reason, /ETIMEDOUT.*attempt 2\/2/);
	}
});

void test(`repos are read ${BATCH} per query, and a transient failure is retried`, () => {
	const repos = Array.from({ length: BATCH * 2 + 1 }, (_, i) => `o/r${i}`);
	const seen = [];
	let failed = false;
	const runGh = (args) => {
		const q = args.at(-1);
		const n = q.match(/r\d+: repository/g).length;
		seen.push(n);
		if (!failed) {
			failed = true;
			throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 502' });
		}
		return JSON.stringify({
			data: Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, { object: null }])),
		});
	};
	const out = readWorkflowBodies(repos, { runGh, sleep: () => {} });
	assert.deepEqual(seen, [BATCH, BATCH, BATCH, 1]);
	assert.equal(out.size, repos.length);
	assert.ok([...out.values()].every((r) => r.ok && r.files.length === 0));
});

test('readActionFiles: an action at its pinned ref, either spelling, or the reason it is not there', () => {
	const refs = [
		{ repo: 'o/act', ref: 'v1', path: '' },
		{ repo: 'o/mono', ref: 'abc123', path: 'tools/setup' },
		{ repo: 'o/flows', ref: 'main', path: '.github/workflows/build.yml' },
		{ repo: 'o/none', ref: 'v2', path: '' },
		{ repo: 'o/gone', ref: 'v1', path: '' },
	];
	const query = actionQuery(refs);
	assert.match(query, /expression: "v1:action\.yml"/);
	assert.match(query, /expression: "abc123:tools\/setup\/action\.yaml"/);
	assert.match(query, /a2: [^}]*expression: "main:\.github\/workflows\/build\.yml"/);

	const runGh = () => {
		const err = new Error('gh: Could not resolve to a Repository');
		err.stdout = JSON.stringify({
			data: {
				a0: { f0: { text: 'runs: {}', isTruncated: false }, f1: null },
				a1: { f0: null, f1: { text: 'yaml spelling', isTruncated: false } },
				a2: { f0: { text: 'on: workflow_call', isTruncated: false } },
				a3: { f0: null, f1: null },
				a4: null,
			},
			errors: [{ path: ['a4'], type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }],
		});
		throw err;
	};
	const out = readActionFiles(refs, { runGh });
	assert.deepEqual(out.get('o/act@v1:'), { ok: true, text: 'runs: {}' });
	assert.deepEqual(out.get('o/mono@abc123:tools/setup'), { ok: true, text: 'yaml spelling' });
	assert.deepEqual(out.get('o/flows@main:.github/workflows/build.yml'), {
		ok: true,
		text: 'on: workflow_call',
	});
	assert.deepEqual(out.get('o/none@v2:'), {
		ok: false,
		reason: 'no action.yml or action.yaml at v2',
	});
	assert.match(out.get('o/gone@v1:').reason, /no repository: Could not resolve/);
});

test('readActionFiles: a batch that fails every attempt names why for each ref', () => {
	let calls = 0;
	const runGh = () => {
		calls++;
		throw Object.assign(new Error('boom'), { stderr: 'gh: HTTP 502' });
	};
	const out = readActionFiles([{ repo: 'o/a', ref: 'v1', path: '' }], {
		runGh,
		attempts: 2,
		sleep: () => {},
	});
	assert.equal(calls, 2);
	assert.equal(out.get('o/a@v1:').ok, false);
	assert.match(out.get('o/a@v1:').reason, /attempt 2\/2/);
});
