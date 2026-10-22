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
 * Workflow FORMS come from sibling checkouts on disk (cheap, and the same source
 * check-label-floor uses). The VARIABLE comes from the GitHub API, never from a
 * manifest or a local record — "the reader for a facet may not read what the
 * writer wrote". A checker that read our own idea of what we set would pass by
 * construction.
 *
 * A repo we could not look at — no checkout, unreadable variable — is a FINDING,
 * never a pass.
 *
 * @guards src/ci-runner-fallback.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { reposDir } from './lib/sibling-repos.mjs';
import { manifest as manifestFile } from './lib/paths.mjs';
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

/** Every workflow in a checkout that references CI_RUNNER, with its form. */
function usesIn(dir) {
	const wf = join(dir, '.github', 'workflows');
	if (!existsSync(wf)) return [];
	const uses = [];
	for (const file of readdirSync(wf)) {
		if (!/\.ya?ml$/.test(file)) continue;
		const form = runnerVarForm(readFileSync(join(wf, file), 'utf8'));
		if (form) uses.push({ file, form });
	}
	return uses;
}

function main() {
	const REPOS = reposDir();
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

	// Every sibling checkout on disk, plus every roster repo — so a covered repo
	// with NO checkout is reported as unlooked-at rather than silently skipped.
	const dirs = existsSync(REPOS)
		? readdirSync(REPOS).filter((d) => existsSync(join(REPOS, d, '.git')))
		: [];
	const byName = new Map(dirs.map((d) => [`WolffM/${d}`, join(REPOS, d)]));
	for (const r of roster) if (!byName.has(r)) byName.set(r, null);

	const findings = [];
	const ok = [];
	for (const [repo, dir] of [...byName].sort()) {
		if (dir === null) {
			findings.push({
				repo,
				status: 'no-checkout',
				why:
					'in fleet-runner-coverage.json but not checked out here, so its workflows ' +
					'could not be read. Unknown is not healthy.',
			});
			continue;
		}
		const uses = usesIn(dir);
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

	// SCANNING NOTHING IS A FAILURE. Zero repos examined means the checkout
	// directory was wrong, and an empty report reads exactly like a clean one.
	const examined = findings.length + ok.length;
	if (examined === 0) {
		const msg =
			`check-runner-var: examined ZERO repos under ${REPOS}. That is a broken scan, ` +
			'not a clean fleet — set REPOS_DIR to the directory holding the sibling checkouts.';
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
