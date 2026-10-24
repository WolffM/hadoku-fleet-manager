#!/usr/bin/env node
/**
 * check-runner-var — every repo that ASKS for `vars.CI_RUNNER` must actually
 * have it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/ci-runner-fallback.ts` has said since 2026-08-30 that a repo where the
 * variable was never written "is what the seeding pass and `fleet
 * check-runner-var` exist to catch". Measured 2026-08-31: neither existed. There
 * was no such subcommand, and no seeding pass — `syncHostedFallback` is the only
 * writer of this variable anywhere, and it iterates `coveredRepos()`, so it
 * structurally cannot reach a repo that is not in the roster yet. A comment
 * standing in for a guard, which is the fourth time in this fleet.
 *
 * WHAT AN UNSET VARIABLE COSTS depends on the form, and the fleet moved to the
 * one with no safety net: `runs-on: ${{ fromJSON(vars.CI_RUNNER) }}` with nothing
 * set resolves to NOTHING, and every workflow in that repo fails to start. Not
 * queues — fails. The `|| '[...]'` form still schedules, which is why the
 * templates keep it and why this reports the two cases differently.
 *
 * THE POPULATION IS "REFERENCES IT", NOT "IS IN COVERAGE"
 * ------------------------------------------------------
 * Deliberately wider than `fleet-runner-coverage.json`, and this is the whole
 * point of the check rather than a detail. A repo that LEAVES coverage keeps its
 * workflows and loses its writer: mgmt-api stops maintaining a variable those
 * workflows still read. hadoku-games-host is exactly that today — bare form,
 * dropped from the roster on 2026-08-29, still healthy only because the last
 * value it was ever written is persistent. A roster-scoped audit would skip the
 * one repo it exists for.
 *
 * TWO READERS, DELIBERATELY DIFFERENT SOURCES
 * -------------------------------------------
 * Workflow FORMS come from each repo's SHIPPED default branch, through
 * `lib/fleet-source.mjs` — the same reader check-label-floor uses, never a
 * sibling working tree (fleet-manager#7). The population is the owner's
 * non-archived repo list plus the roster, not "whatever is checked out on this
 * disk": a cron host need not hold any checkout at all. The VARIABLE comes from the GitHub API, never from a
 * manifest or a local record — "the reader for a facet may not read what the
 * writer wrote". A checker that read our own idea of what we set would pass by
 * construction.
 *
 * A repo we could not look at — unreadable source, unreadable variable — is a
 * FINDING, never a pass.
 *
 * @guards src/ci-runner-fallback.ts
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { manifest as manifestFile } from './lib/paths.mjs';
import { tryShipped, UnreadableRepo } from './lib/fleet-source.mjs';
import { READ_ATTEMPTS } from './lib/queue-health.mjs';
import { fleetOwner } from '../dist/lib/fleet-config.js';
import { readRunnerVar, runnerVarForm, repoVerdict } from './lib/runner-var.mjs';
import { createEmitter } from './lib/emit.mjs';

const JSON_OUT = process.argv.includes('--json');
// One stdout discipline, shared — see lib/emit.mjs. `emit` is the ONLY write
// to stdout below, which is what makes "print before the JSON" unreachable
// rather than merely absent.
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass; check-queue-health uses the same. */
const RETRY_DELAY_MS = 1_000;

/** Synchronous sleep. The sweep is serial and sync; a promise cannot help here. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One read, unretried — the retry, the 404 rule and the diagnosis live in lib/runner-var. */
function readVarOnce(repo) {
	return execFileSync('gh', ['api', `repos/${repo}/actions/variables/CI_RUNNER`, '-q', '.value'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: READ_TIMEOUT_MS,
	}).trim();
}

/** Every shipped workflow that references CI_RUNNER, with its form. */
function usesIn(source) {
	const uses = [];
	for (const { file, text } of source.workflows()) {
		const form = runnerVarForm(text);
		if (form) uses.push({ file, form });
	}
	return uses;
}

/** The owner's non-archived repos, `owner/name` — or a string saying why not. */
function ownerRepos() {
	let last = '';
	for (let i = 0; i < READ_ATTEMPTS; i++) {
		try {
			const out = execFileSync(
				'gh',
				[
					'repo',
					'list',
					fleetOwner(),
					'--limit',
					'1000',
					'--no-archived',
					'--json',
					'nameWithOwner',
				],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: READ_TIMEOUT_MS }
			);
			return JSON.parse(out).map((r) => r.nameWithOwner);
		} catch (err) {
			last = String(err?.stderr || err?.message || err)
				.trim()
				.split('\n')
				.pop();
			if (i + 1 < READ_ATTEMPTS) sleepSync(RETRY_DELAY_MS);
		}
	}
	return last || 'gh repo list failed';
}

function main() {
	// The roster is the list of repos we EXPECT to be maintained, used only to
	// say which findings are inside it. It is never the population.
	let roster = [];
	try {
		roster =
			JSON.parse(readFileSync(manifestFile('fleet-runner-coverage.json'), 'utf8')).repos ?? [];
	} catch {
		/* reported per-repo below; a missing roster does not narrow the scan */
	}
	const inRoster = new Set(roster);

	// The owner's repos, plus every roster repo — so a covered repo the listing
	// somehow missed is still read, or reported as unlooked-at.
	const listed = ownerRepos();
	if (typeof listed === 'string') {
		const msg = `check-runner-var: could not list ${fleetOwner()}'s repos: ${listed}`;
		if (JSON_OUT) emitter.emit({ error: msg, examined: 0, findings: [] });
		else console.error(msg);
		process.exit(1);
	}
	const population = [...new Set([...listed, ...roster])].sort();

	const findings = [];
	const ok = [];
	for (const repo of population) {
		const source = tryShipped(repo);
		// Blobs are fetched on first read, so reading the workflows can fail too.
		let uses;
		let unreadable = 'unreadable' in source ? source.unreadable : null;
		if (!unreadable) {
			try {
				uses = usesIn(source);
			} catch (err) {
				if (!(err instanceof UnreadableRepo)) throw err;
				unreadable = err.reason;
			}
		}
		if (unreadable) {
			findings.push({
				repo,
				status: 'no-checkout',
				why:
					`its shipped workflows could not be read (${unreadable}), so whether it ` +
					'asks for CI_RUNNER is unknown. Unknown is not healthy.',
			});
			continue;
		}
		if (!uses.length) continue;
		const read = readRunnerVar(repo, readVarOnce, {
			sleep: () => sleepSync(RETRY_DELAY_MS),
			timeoutMs: READ_TIMEOUT_MS,
		});
		const verdict = repoVerdict(repo, uses, read.value, read.reason);
		if (!verdict) continue;
		verdict.covered = inRoster.has(repo);
		(verdict.status === 'ok' || verdict.status === 'unset-but-safe' ? ok : findings).push(verdict);
	}

	// SCANNING NOTHING IS A FAILURE. Zero repos examined means the listing or the
	// reader broke, and an empty report reads exactly like a clean one.
	const examined = findings.length + ok.length;
	if (examined === 0) {
		const msg =
			`check-runner-var: examined ZERO repos of ${population.length} listed. That is a ` +
			'broken scan, not a clean fleet.';
		if (JSON_OUT) emitter.emit({ error: msg, examined: 0, findings: [] });
		else console.error(msg);
		process.exit(1);
	}

	if (JSON_OUT) {
		emitter.emit({ examined, findings, ok });
	} else {
		log(`Examined ${examined} repo(s) that reference vars.CI_RUNNER.\n`);
		for (const f of findings) log(`  ${f.status.toUpperCase().padEnd(14)} ${f.repo}\n    ${f.why}`);
		for (const o of ok.filter((o) => o.status === 'unset-but-safe'))
			log(`  ${'unset-but-safe'.toUpperCase().padEnd(14)} ${o.repo}\n    ${o.why}`);
		if (!findings.length) log('\nEvery repo that asks for CI_RUNNER has it.');
	}
	process.exit(findings.length ? 1 : 0);
}

main();
