/**
 * runner-unit-audit — the pure half of `check-runner-units`.
 *
 * Separated so the classification can be asserted without a fleet, an ssh
 * connection or a GitHub token. The script keeps the probing and the API calls;
 * everything that DECIDES lives here.
 *
 * The rule these functions encode, stated once: a runner install is legitimate
 * only if the repo it was registered against still answers to that exact name,
 * is not archived, and is on the roster BY ID. Every clause has cost a real
 * incident — see the script's header.
 */

/** `https://github.com/<owner>/<repo>` -> `<owner>/<repo>`, or null. */
export function repoFromUrl(url) {
	const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url ?? '');
	return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * What one `gh api repos/<path>` answered: `{ status: 'found', repo }`,
 * `{ status: 'gone' }` for a 404, or `{ status: 'error', why }` for anything
 * else.
 *
 * GONE AND "COULD NOT ASK" ARE DIFFERENT FINDINGS. `classifyInstall` reads a
 * null `resolved` as "the repo does not resolve", so a rate limit, an expired
 * login or a network blip used to arrive as GONE for every install at once —
 * and the roster read failed with no reason at all. Only GitHub's own 404 means
 * gone; every other failure keeps its reason so the finding is actionable.
 */
export function lookupOutcome({ ok, stdout = '', stderr = '' }) {
	if (!ok) {
		if (/\(HTTP 404\)/.test(stderr)) return { status: 'gone' };
		const why = stderr.trim().split('\n').pop() || 'gh api failed with no message';
		return { status: 'error', why: why.slice(0, 200) };
	}
	let j;
	try {
		j = JSON.parse(stdout);
	} catch {
		return { status: 'error', why: 'gh api answered with something that is not JSON' };
	}
	if (typeof j?.id !== 'number' || typeof j?.full_name !== 'string')
		return { status: 'error', why: 'gh api answered without a repo id and full_name' };
	return {
		status: 'found',
		repo: { fullName: j.full_name, id: j.id, archived: Boolean(j.archived) },
	};
}

/**
 * Classify one install.
 *
 * `resolved` is what the API returned for `requested` — `null` for a 404, and
 * otherwise `{ fullName, id, archived }`. The ORDER matters: a renamed repo can
 * also be archived and off-roster, and reporting it as OFF-ROSTER would send the
 * reader to the coverage file instead of to the rename that actually killed it.
 */
export function classifyInstall({
	requested,
	resolved,
	rosterIds,
	ignored = false,
	running = false,
}) {
	if (!requested) return { kind: 'GONE', why: 'no readable gitHubUrl in .runner' };
	if (!resolved) return { kind: 'GONE', why: `${requested} does not resolve` };
	if (resolved.fullName !== requested) {
		// A RENAME DOES NOT ALWAYS KILL THE REGISTRATION, and asserting that it
		// does would have this gate recommend deleting a working runner.
		//
		// A runner authenticates against the repo's numeric ID, so a rename is
		// invisible to it — the stale name is in the DIRECTORY and in `.runner`'s
		// cached `gitHubUrl`, not in anything the listener uses. hokon's
		// `actions-runner-hadoku-printtool` is WolffM/hadoku-craft's runner: its
		// worker log served `github.com/WolffM/hadoku-craft` job `update` at
		// 2026-09-03T13:00Z, matching craft's own run list exactly. 2.2 GB of
		// perfectly good runner wearing an old name.
		//
		// The six installs on claw-1 and claw-2 that shared those names WERE dead,
		// and the difference is observable without asking GitHub anything: theirs
		// were `activating (auto-restart)` over a WorkingDirectory that no longer
		// existed. So `running` is the discriminator.
		//
		// REJECTED: matching `.runner`'s `agentId` against the resolved repo's
		// live runner ids. It looks decisive and is not — `agentId` is per-repo,
		// and 24 appears on 21 of hokon's 28 installs, so the "match" is a
		// coincidence of registration order. Checked 2026-09-03, before it shipped.
		if (running) {
			return {
				kind: 'STALE-NAME',
				note: true,
				why:
					`directory and .runner still say ${requested}, which now redirects to ` +
					`${resolved.fullName} — but this install is running and serving jobs, so ` +
					`the registration followed the rename. Cosmetic: the name is stale, not the runner.`,
			};
		}
		return {
			kind: 'RENAMED',
			why:
				`registered against ${requested}, which now redirects to ` +
				`${resolved.fullName} (id ${resolved.id}), and this install is not ` +
				`running — the registration did not survive the rename`,
		};
	}
	if (resolved.archived) {
		return { kind: 'ARCHIVED', why: `${resolved.fullName} is archived and must hold no runners` };
	}
	if (!rosterIds.has(resolved.id)) {
		const why = `${resolved.fullName} (id ${resolved.id}) is not in fleet-runner-coverage.json`;
		// `ignore: true` may quiet the coverage question. It may NOT quiet a repo
		// that is archived, renamed or gone — those are above this line on purpose.
		return { kind: 'OFF-ROSTER', why, note: ignored };
	}
	return null;
}

/**
 * Classify one supervising unit.
 *
 * `installDirs` is the set of directory basenames that actually exist on the
 * box. A unit whose WorkingDirectory is not among them is respawning against
 * nothing — the shape six units held on claw-1 and claw-2 for months, at 11,126
 * restarts, while every repo-first gate reported the fleet clean.
 */
export function classifyUnit({ active, sub, restarts = 0, workingDir = '', installDirs }) {
	const wdName = workingDir ? workingDir.replace(/\/+$/, '').split('/').pop() : '';
	if (wdName && !installDirs.has(wdName)) {
		return {
			kind: 'STRAY',
			why: `WorkingDirectory ${workingDir} does not exist — respawned ${restarts} times against nothing`,
		};
	}
	if (active !== 'active' || sub !== 'running') {
		return {
			kind: 'SICK',
			why: `unit is ${active}/${sub} after ${restarts} restarts — a serving runner is active/running`,
		};
	}
	return null;
}

/** Findings that a manifest `ignore: true` is allowed to downgrade to a note. */
export const IGNORABLE = new Set(['OFF-ROSTER', 'STALE-NAME']);
