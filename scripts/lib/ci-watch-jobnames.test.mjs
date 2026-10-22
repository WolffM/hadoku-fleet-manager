/**
 * The handoff contract's parser.
 *
 * Every name this returns is one monitoring-api will go SILENT about, so a
 * false positive here is a workflow that alerts nobody — the exact regression
 * this file exists to repair. The templated case matters for the same reason
 * in reverse: claiming a name that can never be matched at alert time would
 * silence nothing and hide the fact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobNamesIn } from './ci-watch-jobnames.mjs';

test('picks the job-name out of a report-job step', () => {
	assert.deepEqual(
		jobNamesIn(`
      - name: Report the outcome so a silent failure can't hide
        if: always()
        uses: WolffM/hadoku-actions/report-job@v1
        with:
          job-name: fleet-manager:ci
          service-key: \${{ secrets.KEY_SERVICE_FLEET_MANAGER }}
`),
		['fleet-manager:ci']
	);
});

test('a workflow with several reporting jobs yields all of them', () => {
	assert.deepEqual(
		jobNamesIn('  job-name: site:deploy\n  job-name: site:deploy-workers:detect-changes\n'),
		['site:deploy', 'site:deploy-workers:detect-changes']
	);
});

test('quotes are stripped', () => {
	assert.deepEqual(jobNamesIn(`  job-name: "craft:ci"\n  job-name: 'meet:publish'\n`), [
		'craft:ci',
		'meet:publish',
	]);
});

test('a TEMPLATED name is not claimed — it could never be matched at alert time', () => {
	// Claiming it would silence nothing (no literal match) while making the list
	// look like it covers that workflow.
	assert.deepEqual(jobNamesIn('  job-name: site:deploy-worker:${{ matrix.worker }}\n'), []);
});

test('a workflow that does not report yields nothing', () => {
	assert.deepEqual(jobNamesIn('jobs:\n  build:\n    steps:\n      - run: echo hi\n'), []);
});

test('a similarly-named key is not mistaken for job-name', () => {
	assert.deepEqual(jobNamesIn('  name: job-name: not this\n  my-job-name: nope\n'), []);
});
