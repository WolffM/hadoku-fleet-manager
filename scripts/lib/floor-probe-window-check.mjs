/**
 * §7's quiet-window CHECK — the I/O half, reading the covered repos' shipped
 * workflows and cron-worker's profiles and handing what they found to
 * `floor-probe-window.mjs`'s pure `quietWindow` predicate. Split out of
 * `scripts/floor-probe.mjs` (wave 5q lane A, ctx restructure) so that file
 * reaches the 800-line ceiling. Takes the CLI's `fail` rather than importing
 * the CLI: no lib imports it, per `docs/planning/wave5q-2026-10-31.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { manifest as manifestFile, siteRoot } from '../../dist/lib/fleet-paths.js';
import { tryShipped } from './fleet-source.mjs';
import { stripYamlComments } from './yaml-comments.mjs';
import { dailyCronMinutes, quietWindow } from './floor-probe-window.mjs';
import { nodeReservation } from '../../dist/node-reservation.js';

function readJson(path, what, fail) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		fail(`cannot read ${what} (${path}): ${err.message}`);
	}
}

/**
 * The 11 staggered daily crons, read from the covered repos' own workflows.
 *
 * DERIVED, NEVER TYPED. "A fixed window is a guess about someone else's
 * schedule, and it goes stale silently" — node-reservation.ts's own argument,
 * and it applies here unchanged: writing `06:03..06:53` into this file would be
 * correct today and wrong the first time WS-E restaggers.
 *
 * A COVERED REPO THAT CANNOT BE READ IS A FAILURE, not zero schedules. If the
 * reader cannot see a repo's workflows it cannot know whether that repo is about
 * to fan out, and probing on that basis is exactly "I could not look" rendering
 * as "nothing is wrong". `quietWindow()` refuses an empty schedule list for the
 * same reason.
 */
function fleetCronSchedules(fail) {
	const coverage = readJson(
		manifestFile('fleet-runner-coverage.json'),
		'the coverage roster',
		fail
	);
	const repos = coverage.repos ?? [];
	if (!repos.length) fail('the coverage roster is EMPTY — a fleet of zero repos is not a pass');
	const schedules = [];
	const unreadable = [];
	for (const full of repos) {
		const name = full.split('/').pop();
		// The SHIPPED workflows, through fleet-source: what GitHub will fire is the
		// default branch, never a sibling working tree (fleet-manager#7).
		const source = tryShipped(full);
		if ('unreadable' in source) {
			unreadable.push(`${full}: shipped workflows unreadable (${source.unreadable})`);
			continue;
		}
		for (const { file: f, text } of source.workflows()) {
			const body = stripYamlComments(text);
			for (const m of body.matchAll(/cron:\s*['"]([^'"]+)['"]/g)) {
				const minutes = dailyCronMinutes(m[1]);
				if (minutes !== null) schedules.push({ name: `${name}/${f}`, minutesOfDay: minutes });
			}
		}
	}
	return { schedules, unreadable };
}

/**
 * Is now a quiet window?
 *
 * `nodeReservation`'s LIVE half — `inFlightCronJobs()` — is module state inside
 * the long-lived mgmt-api process and is structurally invisible from a CLI, so
 * out here it always reads zero. That is a genuine "I could not look" and it is
 * named in the output rather than passed off as "not reserved": what this
 * command can see is the DECLARED window, which is 90 minutes wide around every
 * cron-worker profile and therefore strictly wider than the live signal it
 * cannot see. Refusing more often than mgmt-api would is the safe direction.
 */
export function checkQuietWindow(fail, now = new Date()) {
	const profilesPath = join(siteRoot(), 'services', 'cron-worker', 'profiles.json');
	if (!existsSync(profilesPath)) {
		return {
			quiet: false,
			why: 'could-not-tell',
			detail: `no cron-worker profiles at ${profilesPath}`,
			reservationSource: 'none',
		};
	}
	const profiles = readJson(profilesPath, "cron-worker's profiles", fail).profiles ?? [];
	// pm2HostBusy is `false` because it is not observable from here either: it is
	// pushed into the library by runner-health's own tick. It reports hokon
	// serving a DEPLOY, which is not the fan-out signal §7 is asking about.
	const reservation = nodeReservation(now, false, profiles);
	const { schedules, unreadable } = fleetCronSchedules(fail);
	// ANY unreadable covered repo closes the window, not just all of them.
	// `quietWindow()` refuses an EMPTY schedule list, which catches the total
	// failure; this catches the partial one, and the partial one is the dangerous
	// shape — 25 readable checkouts and one missing looks exactly like a quiet
	// fleet, and the missing repo is the one that might be fanning out. A
	// PARTIAL scan reported as clean is the same defect as an unreported failure.
	if (unreadable.length) {
		return {
			quiet: false,
			why: 'could-not-tell',
			detail: `${unreadable.length} covered repo(s) could not be read for daily crons`,
			schedulesSeen: schedules.length,
			unreadable,
			reservationSource: 'declared-only (the live cron counter lives inside mgmt-api)',
		};
	}
	const verdict = quietWindow({
		nowMinutesOfDay: now.getUTCHours() * 60 + now.getUTCMinutes(),
		reserved: reservation.reserved,
		reservationReason: reservation.detail,
		schedules,
	});
	return {
		...verdict,
		schedulesSeen: schedules.length,
		unreadable,
		reservationSource: 'declared-only (the live cron counter lives inside mgmt-api)',
	};
}
