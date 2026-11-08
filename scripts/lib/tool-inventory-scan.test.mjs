/**
 * tool-inventory-scan — the missing-tool scan, pure (no ssh, no checkout).
 *
 * Split out of check-tool-inventory.mjs (wave gates2 lane F1a) so
 * `fleet converge-toolchain --refresh` can fold the same finding into its
 * own report. This pins the part of the scan that decides whether a job's
 * invocation of a tool is a finding — `invokes`, `providesTool` and
 * `scanWorkflows`'s per-job loop over them — against fixtures, never a real
 * fleet or checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { invokes, providesTool, scanWorkflows } from './tool-inventory-scan.mjs';

test('invokes: a bare command word is an invocation; a quoted echo/printf argument is not', () => {
	assert.equal(invokes('run: pm2 restart x', 'pm2'), true);
	assert.equal(invokes('run: echo "pm2 reset watchparty"', 'pm2'), false);
	// Anything AFTER the quoted prose on the same line is still scanned.
	assert.equal(invokes('run: echo "status" && pm2 restart x', 'pm2'), true);
});

test('providesTool: a guard, an install, or a matching release download all count', () => {
	assert.equal(providesTool('run: command -v gh || exit 1', 'gh'), true);
	assert.equal(providesTool('run: npm install -g pnpm', 'pnpm'), true);
	assert.equal(
		providesTool('run: curl -L .../releases/download/v1/trunk-x86 -o trunk', 'trunk'),
		true
	);
	// A download that does not name the tool provides nothing for it.
	assert.equal(
		providesTool('run: curl -L .../releases/download/v1/trunk-x86 -o trunk', 'jq'),
		false
	);
	// rustup installs cargo.
	assert.equal(providesTool('run: command -v rustup || curl rustup.rs | sh', 'cargo'), true);
});

/** A minimal fetchShipped stub: one repo, one workflow file, given text. */
const fakeShipped = (workflowText) => (_slug) => ({
	workflows: () => [{ file: 'ci.yml', text: workflowText }],
});

const FLEET_FORM_RUNS_ON = 'runs-on: ${{ fromJSON(vars.CI_RUNNER) }}';

test('a job invoking a tool missing on a claw, neither guarded nor installed, is a finding', () => {
	const text = `jobs:\n  build:\n    ${FLEET_FORM_RUNS_ON}\n    steps:\n      - run: trunk check\n`;
	const { findings, examined, examinedJobs } = scanWorkflows({
		repos: ['WolffM/fixture'],
		clawSet: ['claw-1', 'claw-2'],
		present: { 'claw-1': new Set(), 'claw-2': new Set() },
		tools: ['trunk'],
		fetchShipped: fakeShipped(text),
	});
	assert.equal(examined, 1);
	assert.equal(examinedJobs, 1);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /invokes "trunk"/);
	assert.match(findings[0], /claw-1, claw-2/);
});

test('MUTATION: the SAME job is clean once every claw actually has the tool', () => {
	const text = `jobs:\n  build:\n    ${FLEET_FORM_RUNS_ON}\n    steps:\n      - run: trunk check\n`;
	const { findings } = scanWorkflows({
		repos: ['WolffM/fixture'],
		clawSet: ['claw-1', 'claw-2'],
		present: { 'claw-1': new Set(['trunk']), 'claw-2': new Set(['trunk']) },
		tools: ['trunk'],
		fetchShipped: fakeShipped(text),
	});
	assert.deepEqual(findings, [], 'every claw has the tool — nothing to find');
});

test('MUTATION: a guard in the SAME job clears the finding even though the tool is missing', () => {
	const text =
		`jobs:\n  build:\n    ${FLEET_FORM_RUNS_ON}\n    steps:\n` +
		`      - run: command -v trunk || cargo install trunk\n` +
		`      - run: trunk check\n`;
	const { findings } = scanWorkflows({
		repos: ['WolffM/fixture'],
		clawSet: ['claw-1'],
		present: { 'claw-1': new Set() },
		tools: ['trunk'],
		fetchShipped: fakeShipped(text),
	});
	assert.deepEqual(findings, [], 'the job provides its own guard — not a finding');
});

test('a job pinned to pm2-host is exempt — it lands on production, never a claw', () => {
	const text = `jobs:\n  deploy:\n    runs-on: [self-hosted, pm2-host]\n    steps:\n      - run: trunk check\n`;
	const { findings, examinedJobs } = scanWorkflows({
		repos: ['WolffM/fixture'],
		clawSet: ['claw-1'],
		present: { 'claw-1': new Set() },
		tools: ['trunk'],
		fetchShipped: fakeShipped(text),
	});
	assert.equal(examinedJobs, 1, 'the job is still counted as inspected');
	assert.deepEqual(findings, []);
});

test('a hosted job is exempt — the runner image supplies the tool', () => {
	const text = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: trunk check\n`;
	const { findings, examinedJobs } = scanWorkflows({
		repos: ['WolffM/fixture'],
		clawSet: ['claw-1'],
		present: { 'claw-1': new Set() },
		tools: ['trunk'],
		fetchShipped: fakeShipped(text),
	});
	assert.equal(examinedJobs, 0, 'a hosted job is never inspected for claw tool coverage');
	assert.deepEqual(findings, []);
});

test('an UNREACHABLE node is excluded from onAllClaws, never read as missing every tool', () => {
	const text = `jobs:\n  build:\n    ${FLEET_FORM_RUNS_ON}\n    steps:\n      - run: trunk check\n`;
	// claw-1 is unreachable (absent from `present`); claw-2 HAS the tool. Only
	// readable nodes decide onAllClaws, so this must be clean, not a finding
	// about claw-1 "missing every tool".
	const { findings } = scanWorkflows({
		repos: ['WolffM/fixture'],
		clawSet: ['claw-1', 'claw-2'],
		present: { 'claw-2': new Set(['trunk']) },
		tools: ['trunk'],
		fetchShipped: fakeShipped(text),
	});
	assert.deepEqual(findings, []);
});

test('an unreadable checkout is its own finding, counted in noCheckoutCount, never "nothing to invoke"', () => {
	const { findings, noCheckoutCount, examined } = scanWorkflows({
		repos: ['WolffM/unreadable'],
		clawSet: ['claw-1'],
		present: { 'claw-1': new Set() },
		fetchShipped: () => ({ unreadable: 'ENOENT' }),
	});
	assert.equal(noCheckoutCount, 1);
	assert.equal(examined, 0);
	assert.match(findings[0], /shipped workflows unreadable/);
});
