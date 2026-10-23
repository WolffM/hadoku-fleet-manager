import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { hubRepoFull } from '../../dist/lib/fleet-config.js';
import { devvaultRefs, holders, repoFindings, SITE_TOKEN, workflowRefs } from './site-token.mjs';

test('workflowRefs: a secret, an env read and a vault-fetch key all count', () => {
	const body = [
		'jobs:',
		'  a:',
		'    steps:',
		'      - uses: actions/checkout@v6',
		'        with:',
		'          token: ${{ secrets.HADOKU_SITE_TOKEN }}',
		'      - run: curl -H "Authorization: Bearer $HADOKU_SITE_TOKEN" x',
		'      - uses: WolffM/hadoku-actions/vault-fetch@v1',
		'        with:',
		'          keys: HADOKU_NPM_READ_TOKEN,HADOKU_SITE_TOKEN',
	].join('\n');
	assert.deepEqual(workflowRefs(body), [6, 7, 10]);
});

test('workflowRefs: prose about the token in a comment is not a reference', () => {
	const body = [
		'# NODE_AUTH_TOKEN must be HADOKU_NPM_READ_TOKEN — never HADOKU_SITE_TOKEN',
		'jobs:',
		'  a:',
		'    steps:',
		'      - run: echo hi   # not HADOKU_SITE_TOKEN either',
	].join('\n');
	assert.deepEqual(workflowRefs(body), []);
});

test('workflowRefs: a longer name that merely contains it is not a reference', () => {
	assert.deepEqual(workflowRefs('env:\n  X: ${{ secrets.AGGREGATOR_HADOKU_SITE_TOKEN_OLD }}'), []);
});

test('devvaultRefs: a local name mapped to the vault item is a grant request', () => {
	assert.deepEqual(
		devvaultRefs(
			JSON.stringify({
				'//': 'note',
				GH: SITE_TOKEN,
				HADOKU_NPM_READ_TOKEN: 'HADOKU_NPM_READ_TOKEN',
			})
		),
		['GH']
	);
	assert.deepEqual(devvaultRefs('{"HADOKU_NPM_READ_TOKEN":"HADOKU_NPM_READ_TOKEN"}'), []);
	assert.throws(() => devvaultRefs('{not json'));
});

test('repoFindings: each way of holding it is its own finding', () => {
	const f = repoFindings('WolffM/x', {
		secret: true,
		workflows: { 'publish.yml': [12, 40], 'ci.yml': [] },
		devvault: ['HADOKU_SITE_TOKEN'],
	});
	assert.deepEqual(
		f.map((x) => x.kind),
		['secret', 'workflow', 'devvault']
	);
	assert.match(f[1].detail, /publish\.yml.*12, 40/);
});

test('repoFindings: a repo that could not be read is a finding, never clean', () => {
	const f = repoFindings('WolffM/x', { secret: 'HTTP 502', devvault: 'Unexpected token' });
	assert.deepEqual(
		f.map((x) => x.kind),
		['unreadable', 'unreadable']
	);
	assert.match(f[0].detail, /HTTP 502/);
});

test('repoFindings: a clean repo yields nothing', () => {
	assert.deepEqual(
		repoFindings('WolffM/x', { secret: false, workflows: { 'ci.yml': [] }, devvault: [] }),
		[]
	);
});

test('holders: the hub always, plus each declared repo with its reason', () => {
	const h = holders({ $comment: 'x', 'some-repo': 'it sets Actions secrets' });
	assert.ok(h.has(hubRepoFull()));
	assert.ok([...h.keys()].some((r) => r.endsWith('/some-repo')));
	assert.equal(h.size, 2);
});

test('holders: a declared holder with no reason is refused, not admitted', () => {
	assert.throws(() => holders({ 'some-repo': '' }), /must say why/);
	assert.throws(() => holders({ 'some-repo': true }), /must say why/);
});

test('repoFindings: a holder yields nothing whatever it holds', () => {
	const allowed = holders({ 'some-repo': 'it sets Actions secrets' });
	for (const repo of allowed.keys()) {
		assert.deepEqual(
			repoFindings(repo, { secret: true, workflows: { 'a.yml': [1] }, devvault: ['X'] }, allowed),
			[]
		);
	}
});
