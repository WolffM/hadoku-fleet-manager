/**
 * preflight — the nightly checks that catch a slow-motion failure before it
 * becomes an incident: an expiring credential, a runner GitHub is about to
 * stop accepting, a node one apt-get away from needing a reboot it never got.
 *
 * FOUR SIGNALS, EACH ALREADY REAL AND EACH ALREADY BITTEN THIS FLEET ONCE
 * ------------------------------------------------------------------------
 * - **Node-key expiry.** `tailscale-fleet-tagging` (2026-09-01): claw-1 lapsed
 *   silently on 2026-08-31, nothing noticed because every gate reaches the
 *   claws over LAN and none of them reads the tailnet. Fixed by tagging every
 *   claw `tag:claw` (Tailscale then omits `KeyExpiry` entirely — confirmed
 *   live) and disabling hokon's key expiry via the per-machine console toggle
 *   (same effect, no tag — `Self.KeyExpiry` is likewise absent). Both are
 *   OPERATOR ACTIONS outside this repo's git history, so nothing stops either
 *   one being reverted by a re-enrol or a console change nobody remembers to
 *   redo. A fleet node reporting a real `KeyExpiry` again is exactly that
 *   drift, whatever the date says.
 * - **`HADOKU_SITE_TOKEN` expiry.** `CREDENTIAL_ROTATION.md`: this PAT expired
 *   UNREGISTERED on 2026-08-13 with no warning. hadoku_site's own
 *   `secrets:expiry-scan` now watches its tracked registry daily — this reads
 *   the same signal GitHub itself reports (`GET /user`'s
 *   `github-authentication-token-expiration` response header) directly against
 *   the credential this repo's OWN `gh` calls depend on, so the fleet's health
 *   sweep does not have a blind spot shaped like "hadoku_site's tracker is
 *   itself down".
 * - **Runner version drift.** The STANDING registrations this repo's
 *   `residentRepos` keeps on claw-4/claw-6 (plus hokon's own) are never
 *   re-minted, and `GET /actions/runners` reports each one's `version`.
 *   GitHub does force old runner versions offline eventually; this is the
 *   early warning, not an authoritative deprecation feed GitHub does not
 *   publish over the API.
 * - **JIT payload drift.** This file used to say a JIT registration "cannot go
 *   stale — it is reborn current every job". It is reborn from the NODE's
 *   payload, `~/.hadoku/jit/payload`, which `jit-provision.sh` built once
 *   and never rebuilt (a mint now rebuilds one behind the release it is
 *   handed; this finding is the backstop). Measured 2026-10-24: five nodes' payloads were
 *   2.336.0, built 2026-07-20, against a 2.338.1 release. The listing showed it
 *   on 10-23 as a `jit-*` runner at 2.336.0, and preflight called that a
 *   STANDING registration (fleet-manager#1). So minted names are excluded from
 *   the standing check, and the payload is read on each node instead. A
 *   minted runner is in the listing only while its job runs, so sampling the
 *   listing would see one node one night and none the next.
 * - **Pending reboots.** No incident yet on this fleet specifically, but the
 *   standard Debian signal (`/var/run/reboot-required`) costs one `ssh` line
 *   already paid for by every other fleet-exec probe, and a kernel security
 *   update sitting unapplied for weeks on a CI box is the same shape of
 *   silent risk as the other three.
 *
 * - **Security updates not installing.** 2026-10-25: every claw's
 *   unattended-upgrades origin pattern matched nothing from first boot, and
 *   29-70 Debian security updates sat pending per claw while the daily timer
 *   logged "No packages found" — a line that reads exactly like a patched box.
 *   `fleet apt-security` (the provisioning converger's third facet) now checks
 *   the POLICY by running the dry run; this checks the OUTCOME, on the node:
 *   are security updates pending, and has anything from Debian-Security been
 *   installed lately. See {@link securityUpdateFinding}.
 *
 * EVERY FUNCTION HERE IS PURE. The I/O — `tailscale status --json`, `gh api`,
 * `ssh`, `pm2` — lives in `check-fleet-preflight.mjs`; this file only judges
 * data already fetched, so it can be tested without a tailnet, a token or a
 * fleet.
 *
 * CLASS: WHICH FINDINGS MAY FAIL THE JOB (#14)
 * --------------------------------------------
 * A failed cron job is an unconditional `@here` on the other side — monitoring
 * has no severity field on a job outcome at all — so "is this a finding?" and
 * "should this wake somebody?" were the same question until 2026-09-09, and
 * hokon's staged kernel paged every morning from 2026-08-30. Nine days of an
 * identical page is how a channel gets tuned out, which costs the REAL finding
 * its audience.
 *
 * So every finding carries a `class`, and only {@link BLOCKING} ones drive the
 * exit code. Three properties hold that line, and each is a test:
 *
 *   1. BLOCKING IS THE DEFAULT. {@link blockingFindings} asks whether a finding
 *      is EXPLICITLY advisory, never whether it is explicitly blocking — so a
 *      finding with a missing, misspelled or newly-invented class fails the
 *      gate. A classifier that has to opt IN to silence cannot silence anything
 *      by accident.
 *   2. ONLY A CLEAN READ MAY BE ADVISORY. `rebootFinding` returns a finding for
 *      `ok: false` too, and that one stays BLOCKING: "I could not look" is not
 *      "nothing is wrong", and muting an unreachable node is the exact
 *      inversion this class field could most easily introduce.
 *   3. TIME MAKES IT STRICTER, NEVER MORE FORGIVING. An advisory that never
 *      escalates is a silencer with extra steps. Past
 *      {@link REBOOT_ESCALATE_DAYS} a staged kernel is BLOCKING again — the
 *      same shape as `expected-down`'s `DEFER_DAYS` and `queue-health`'s
 *      `ZOMBIE_SECONDS`, and for the same reason CLAUDE.md gives: no gate may
 *      get easier to pass the worse the failure gets.
 *
 * There is exactly one more way a finding becomes advisory, and it is a
 * DECLARED SCOPE rather than a severity judgement: {@link guestAdvisory}. A
 * machine the manifest marks `role: "guest"` is out of the fleet chain by the
 * operator's decision, so its node health does not fail this run. It does not
 * weaken property (3), because it is not a function of how bad the reading is —
 * and it does not weaken property (2) either, because
 * {@link GUEST_BLOCKING_CATEGORIES} keeps "could not look at it" blocking.
 */

import { JIT_PREFIX, WARM_PREFIX } from '../../dist/runners/ephemeral.js';
import { isIpv4 } from './node-interfaces.mjs';

/** Fails the gate. The default for anything not deliberately marked otherwise. */
export const BLOCKING = 'blocking';

/** Prints, rides in `--json`, reaches the digest — and does NOT fail the gate. */
export const ADVISORY = 'advisory';

/**
 * How long a staged reboot may stay advisory.
 *
 * A pending reboot is a MAINTENANCE item by construction — nothing is broken
 * right now, and the fix is a restart somebody has to schedule. Thirty days is
 * the longest such an item can honestly still be called "pending" rather than
 * "ignored", and it is a month precisely so that it lines up with a monthly
 * patch window rather than with any one node's current age.
 *
 * Stated plainly because it is load-bearing: hokon's `/var/run/reboot-required`
 * is dated 2026-08-30, so this gate is GREEN on it today and turns BLOCKING on
 * 2026-09-29 if nobody reboots. That is the design — the finding stops paging
 * daily and starts again once ignoring it is the actual story — not a number
 * chosen to make today pass.
 */
export const REBOOT_ESCALATE_DAYS = 30;

/**
 * The findings that fail the run. THE ONE PLACE the exit code is decided.
 *
 * Deliberately `!== ADVISORY` rather than `=== BLOCKING`: an unrecognised class
 * must fail, not slip through. See property (1) in the file header.
 */
export function blockingFindings(findings) {
	return (findings ?? []).filter((f) => f?.class !== ADVISORY);
}

/** The complement — findings that print and report but never fail the run. */
export function advisoryFindings(findings) {
	return (findings ?? []).filter((f) => f?.class === ADVISORY);
}

/**
 * Finding categories that stay BLOCKING even on a guest.
 *
 * A guest is in scope for exactly ONE question — is its registration online
 * with its labels — and that question cannot be answered about a box nothing
 * can reach. So "could not look at it at all" keeps its teeth; everything else
 * about a guest is advisory. Keeping this narrow is what stops the role from
 * becoming property (2)'s inverse: an unreachable node muted by config.
 *
 * `check-label-floor` is the gate that actually asks the in-scope question, and
 * it asks the GITHUB API, not the box — CLAUDE.md's "the reader for a facet may
 * not read what the writer wrote". Nothing here weakens it.
 */
export const GUEST_BLOCKING_CATEGORIES = new Set(['unreachable']);

/**
 * Re-class a GUEST's findings as advisory — the one place the role changes an
 * outcome in this file.
 *
 * WHY A ROLE AND NOT A PER-GATE EXCEPTION. hokon is the production host and a
 * guest (operator, 2026-09-14): it lends the fleet a backstop registration and
 * is otherwise none of the fleet's business. Its staged kernel paged `@here`
 * every morning from 2026-08-30, and `REBOOT_ESCALATE_DAYS` only postpones that
 * to 2026-09-29 — the escalation is right for a claw the fleet may reboot and
 * wrong for a box the fleet may not touch. Three gates needed the same
 * exemption; one manifest key gives it to all three.
 *
 * THE FINDING IS NOT DROPPED. It keeps its `why`, gains `role: 'guest'` and
 * `wasBlocking`, and still prints, still rides in `--json`, still reaches the
 * digest. Advisory means "does not fail the run", never "was not observed" —
 * dropping it would make an operator's deliberate scoping look like a clean box.
 *
 * @param findings  every finding from the sweep.
 * @param guests    guest node names (`guestNodeNames` over the manifest).
 */
export function guestAdvisory(findings, guests = new Set()) {
	const set = guests instanceof Set ? guests : new Set(guests ?? []);
	if (!set.size) return findings ?? [];
	return (findings ?? []).map((f) => {
		// A finding with no `node` is not ABOUT a node — token expiry, a runner
		// version keyed by repo. A role cannot speak for it.
		if (!f?.node || !set.has(f.node)) return f;
		if (f.class === ADVISORY || GUEST_BLOCKING_CATEGORIES.has(f.category)) return f;
		return {
			...f,
			class: ADVISORY,
			role: 'guest',
			wasBlocking: true,
			why:
				`${f.why} [advisory: ${f.node} is a GUEST — it lends the fleet a registration and ` +
				"nothing else, so its node health is not the fleet chain's to page on. " +
				'`check-label-floor` still requires its registration online with its labels.]',
		};
	});
}

/**
 * A fleet node's Tailscale node-key drift, or `null` if it looks right.
 *
 * `tsStatus` is `tailscale status --json`'s parsed body. `fleetNodeNames` is
 * the manifest's machine list (`hokon`, `claw-1` .. `claw-N`) — the population
 * this check is FOR, not every device on the tailnet. A personal phone or
 * desktop with a real, ordinary 180-day key is not this check's business, and
 * treating the whole tailnet as in-scope would flag devices this repo has no
 * opinion about (and, measured live, at least one already-expired one).
 */
export function nodeKeyFinding(tsStatus, node, nowMs = Date.now()) {
	const self = tsStatus.Self;
	const peers = Object.values(tsStatus.Peer ?? {});
	const entry = [self, ...peers].find(
		(e) => e?.HostName && e.HostName.toLowerCase() === node.toLowerCase()
	);
	if (!entry) {
		return {
			node,
			category: 'node-key',
			class: BLOCKING,
			status: 'not-on-tailnet',
			why: `${node} is not visible in \`tailscale status\` at all — its node key could not be checked.`,
		};
	}
	// ABSENCE of the field is the healthy case for a fleet node: `tag:claw` and
	// hokon's console toggle both make Tailscale omit `KeyExpiry` rather than
	// set it to a sentinel — confirmed live against the real tailnet 2026-09-07.
	if (!entry.KeyExpiry) return null;

	const expiresMs = Date.parse(entry.KeyExpiry);
	const daysLeft = Number.isNaN(expiresMs) ? null : (expiresMs - nowMs) / 86_400_000;
	return {
		node,
		category: 'node-key',
		class: BLOCKING,
		status: entry.Expired || (daysLeft !== null && daysLeft < 0) ? 'expired' : 'expiring',
		keyExpiry: entry.KeyExpiry,
		daysLeft: daysLeft === null ? null : Math.round(daysLeft),
		why:
			`${node} reports a real Tailscale key expiry (${entry.KeyExpiry}). Fleet nodes are ` +
			'supposed to carry a non-expiring key (tag:claw, or the console toggle for hokon) — ' +
			'this means the tag or toggle is missing, or was reverted.',
	};
}

/** {@link nodeKeyFinding} over every fleet node, findings only. */
export function nodeKeyFindings(tsStatus, fleetNodeNames, nowMs = Date.now()) {
	return fleetNodeNames.map((n) => nodeKeyFinding(tsStatus, n, nowMs)).filter(Boolean);
}

/**
 * `HADOKU_SITE_TOKEN`'s expiry, from `GET /user`'s response header.
 *
 * `headerValue` is `github-authentication-token-expiration` verbatim, or
 * `undefined` if GitHub did not send it — which is the NORMAL case for a
 * classic PAT or an OAuth app token (measured live against this box's own
 * `gh` auth) and is read as healthy, per `CREDENTIAL_ROTATION.md`: "a
 * credential reporting no expiry gets its tracking row cleared — a
 * non-expiring token is healthy, not untracked-by-accident." A token that
 * expired unregistered once (2026-08-13) is the reason this exists at all, not
 * a reason to treat every silent header as suspicious.
 */
export function tokenExpiryFinding(headerValue, { nowMs = Date.now(), warnDays = 14 } = {}) {
	if (!headerValue) return null;
	const expiresMs = Date.parse(headerValue);
	if (Number.isNaN(expiresMs)) {
		return {
			category: 'token-expiry',
			class: BLOCKING,
			status: 'unparseable',
			why: `HADOKU_SITE_TOKEN's expiry header could not be parsed: "${headerValue}".`,
		};
	}
	const daysLeft = (expiresMs - nowMs) / 86_400_000;
	if (daysLeft > warnDays) return null;
	return {
		category: 'token-expiry',
		class: BLOCKING,
		status: daysLeft < 0 ? 'expired' : 'expiring',
		expiresAt: headerValue,
		daysLeft: Math.round(daysLeft),
		why:
			`HADOKU_SITE_TOKEN ${daysLeft < 0 ? 'expired' : `expires in ${Math.round(daysLeft)}d`} ` +
			`(${headerValue}). This is the credential every gh call in this fleet depends on — the ` +
			'2026-08-13 outage was exactly this token lapsing with no warning.',
	};
}

/** Parse `"2.337.0"` or `"v2.337.0"` into `[major, minor, patch]`, or `null`. */
function parseSemver(v) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Behind by a major, or by `minMinorsBehind` minors within one. */
function isBehind(have, latest, minMinorsBehind) {
	return have[0] < latest[0] || (have[0] === latest[0] && latest[1] - have[1] >= minMinorsBehind);
}

/**
 * A `jit-*` or `warm-*` registration: minted per job (or per warm fill) from
 * the node's payload, never a standing install. The prefixes are the minter's
 * own constants, so a rename there cannot leave this reading the old name.
 */
export function isMintedRunnerName(name) {
	const n = String(name ?? '');
	return n.startsWith(JIT_PREFIX) || n.startsWith(WARM_PREFIX);
}

/**
 * Runner-version drift for one STANDING registration.
 *
 * {@link runnerVersionFindings} drops minted names before this is reached —
 * the caller passes the repo's whole listing, which is how a `jit-*` runner
 * was called "a STANDING registration that is never re-minted" on 2026-10-23.
 * A minted runner's version is its node's payload version, judged by
 * {@link jitPayloadFinding}. Behind by `minMinorsBehind` minor versions is a
 * PROXY for GitHub's periodic forced deprecation, not an official notice —
 * GitHub does not publish one over the API — so the finding says so rather
 * than claiming more certainty than it has.
 */
export function runnerVersionFinding(runner, latestVersion, { minMinorsBehind = 2 } = {}) {
	const latest = parseSemver(latestVersion);
	const have = parseSemver(runner.version);
	if (!have) {
		return {
			category: 'runner-version',
			class: BLOCKING,
			repo: runner.repo,
			runner: runner.name,
			status: 'unknown',
			why: `${runner.name} (${runner.repo}) reported no parseable runner version ("${runner.version}").`,
		};
	}
	if (!latest) return null; // could not resolve "latest" — reported once by the caller, not per-runner
	if (!isBehind(have, latest, minMinorsBehind)) return null;
	return {
		category: 'runner-version',
		class: BLOCKING,
		repo: runner.repo,
		runner: runner.name,
		status: 'behind',
		version: runner.version,
		latestVersion,
		why:
			`${runner.name} (${runner.repo}) reports runner v${runner.version} against a latest ` +
			`release of v${latestVersion} — a STANDING registration that is never re-minted, so ` +
			'nothing refreshes it on its own. GitHub periodically stops accepting old runner ' +
			'versions; this is the early proxy for that, not an official deprecation feed.',
	};
}

/** {@link runnerVersionFinding} over the STANDING runners in a listing, findings only. */
export function runnerVersionFindings(runners, latestVersion, opts = {}) {
	return runners
		.filter((r) => !isMintedRunnerName(r.name))
		.map((r) => runnerVersionFinding(r, latestVersion, opts))
		.filter(Boolean);
}

/**
 * Where `jit-provision.sh` keeps a node's payload, relative to the node's
 * $HOME. Spelled once here: the probe and every finding are built from it.
 */
export const JIT_PAYLOAD_DIR = '.hadoku/jit/payload';

/**
 * Ask a node which runner version its JIT payload is. One line, always:
 * `PAYLOAD ABSENT`, `PAYLOAD UNRUNNABLE`, or `PAYLOAD <version>`.
 */
export const JIT_PAYLOAD_PROBE = `
P="$HOME/${JIT_PAYLOAD_DIR}/bin/Runner.Listener"
if [ ! -e "$P" ]; then
	echo "PAYLOAD ABSENT"
else
	v=$("$P" --version 2>/dev/null | head -1)
	echo "PAYLOAD \${v:-UNRUNNABLE}"
fi
`;

/** The probe's stdout -> `{ present, version }`, or `null` when it is not the probe's line. */
export function parseJitPayloadProbe(stdout) {
	const line = String(stdout ?? '')
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.startsWith('PAYLOAD '));
	if (!line) return null;
	const v = line.slice('PAYLOAD '.length).trim();
	if (v === 'ABSENT') return { present: false, version: null };
	return { present: true, version: v === 'UNRUNNABLE' ? null : v };
}

/**
 * One node's JIT payload -> a finding, or `null`.
 *
 * `probe` is `{ node, ok, present, version, error }`. No payload is not a
 * finding: a node that has never minted builds one fresh on its first mint.
 * A payload that will not run IS one: `jit-provision.sh` answers
 * `SLOT-FAIL payload will not execute` to every mint on that node.
 */
export function jitPayloadFinding(probe, latestVersion, { minMinorsBehind = 2 } = {}) {
	const base = { category: 'jit-payload', node: probe.node, class: BLOCKING };
	if (!probe.ok) {
		return {
			...base,
			status: 'unreachable',
			why: `${probe.node}'s JIT payload version could not be read: ${probe.error}.`,
		};
	}
	if (!probe.present) return null;
	const have = parseSemver(probe.version);
	if (!have) {
		return {
			...base,
			status: 'unrunnable',
			why:
				`${probe.node}'s JIT payload (~/${JIT_PAYLOAD_DIR}) did not report a version` +
				`${probe.version ? ` ("${probe.version}")` : ''} — jit-provision.sh refuses every ` +
				'mint on this node while its Runner.Listener will not run.',
		};
	}
	const latest = parseSemver(latestVersion);
	if (!latest || !isBehind(have, latest, minMinorsBehind)) return null;
	return {
		...base,
		status: 'behind',
		version: probe.version,
		latestVersion,
		why:
			`${probe.node}'s JIT payload (~/${JIT_PAYLOAD_DIR}) is runner v${probe.version} against a ` +
			`latest release of v${latestVersion}. Every jit-* and warm-* runner minted on ` +
			`${probe.node} is copied from it. A mint rebuilds a payload behind the release it is ` +
			"handed, so one still behind means the node's jit-provision.sh predates that rule, its " +
			'release fetch is failing (PAYLOAD-REFRESH-FAILED in the mint output), or nothing has ' +
			'minted there since the release. GitHub periodically stops accepting old runner ' +
			'versions, and past that point every mint on this node fails; this is the early proxy ' +
			'for that, not an official deprecation feed.',
	};
}

/** {@link jitPayloadFinding} over every probed node, findings only. */
export function jitPayloadFindings(probes, latestVersion, opts = {}) {
	return probes.map((p) => jitPayloadFinding(p, latestVersion, opts)).filter(Boolean);
}

/**
 * One node's pending-reboot probe result -> a finding, or `null`.
 *
 * `probe` is `{ node, ok, rebootRequired, packages, stagedAtMs, error }` —
 * `ok: false` means the node could not be reached or the file could not be
 * read, which is a finding in its own right ("I could not look" is never
 * "nothing is wrong"), distinct from `rebootRequired: false` which is an
 * actual clean read.
 *
 * THIS IS THE ONLY ADVISORY FINDING IN THE SWEEP, and only in its narrowest
 * case: a node that ANSWERED, said a reboot is staged, and dated the flag
 * within {@link REBOOT_ESCALATE_DAYS}. Each of those three is load-bearing, so
 * each is a separate test:
 *
 *   - `ok: false` is BLOCKING. Muting a node that did not answer would invert
 *     the check into "unreachable is fine", which is worse than the daily page
 *     this change exists to stop.
 *   - `stagedAtMs: null` is BLOCKING. The node said REQUIRED but the flag could
 *     not be dated, so nothing bounds how long it has been staged — and an
 *     unbounded advisory is a permanent mute. Unknown resolves STRICT, the same
 *     direction `expected-down` takes for a drain with no parseable `since`.
 *   - Past the escalation window it is BLOCKING, and the `why` says how long,
 *     so the page that returns carries the reason it returned.
 */
export function rebootFinding(
	probe,
	{ nowMs = Date.now(), escalateDays = REBOOT_ESCALATE_DAYS } = {}
) {
	if (!probe.ok) {
		return {
			category: 'pending-reboot',
			node: probe.node,
			class: BLOCKING,
			status: 'unreachable',
			why: `${probe.node} could not be checked for a pending reboot: ${probe.error}.`,
		};
	}
	if (!probe.rebootRequired) return null;

	const stagedAtMs = Number.isFinite(probe.stagedAtMs) ? probe.stagedAtMs : null;
	const ageDays = stagedAtMs === null ? null : (nowMs - stagedAtMs) / 86_400_000;
	const overdue = ageDays === null || ageDays > escalateDays;
	const pkgs = probe.packages?.length ? ` (${probe.packages.join(', ')})` : '';

	return {
		category: 'pending-reboot',
		node: probe.node,
		class: overdue ? BLOCKING : ADVISORY,
		status: 'reboot-required',
		packages: probe.packages ?? [],
		stagedAt: stagedAtMs === null ? null : new Date(stagedAtMs).toISOString(),
		ageDays: ageDays === null ? null : Math.round(ageDays),
		why:
			`${probe.node} has \`/var/run/reboot-required\` set${pkgs} — an update is staged and ` +
			(ageDays === null
				? 'waiting for a restart, and the flag file could not be DATED, so nothing bounds ' +
					'how long it has been staged. Reported as blocking because an advisory nobody can ' +
					'age out of is a permanent mute.'
				: overdue
					? `has been waiting ${Math.round(ageDays)} days for a restart — past the ` +
						`${escalateDays}-day window in which this is maintenance rather than neglect.`
					: `waiting for a restart (staged ${Math.round(ageDays)}d ago). Advisory until ` +
						`${escalateDays}d: it is a scheduled maintenance item, not an outage.`),
	};
}

/** {@link rebootFinding} over every probed node, findings only. */
export function rebootFindings(probes, opts = {}) {
	return probes.map((p) => rebootFinding(p, opts)).filter(Boolean);
}

/**
 * A node whose LAN address is not pinned by a gateway reservation, or `null`.
 *
 * WHY THIS IS A PREFLIGHT SIGNAL. hokon reaches every claw by a LAN IP in
 * `~/.ssh/config`, and that IP is a DHCP lease. The gateway's own "auto
 * reservation" is not durable: claw-1 moved .68 -> .122 between 2026-09-07 and
 * 2026-10-11 with it switched on (#65). A moved lease reads as a dead node in
 * every gate at once, and a node hosting a service is stranded until someone
 * re-enrols it. Manual reservations were set for every claw on 2026-10-11; the
 * failure left is a NEW node nobody reserved, which is why a missing record is
 * blocking rather than advisory — the operator's words were "we cannot forget".
 *
 * WHAT IT CAN AND CANNOT SEE. The reservation table is behind the gateway's
 * admin login, which nothing here holds. So the record (`machines[node].lan`,
 * written by `fleet lan-reserve --write`) is the operator's DECLARATION that the
 * reservation exists, and this reads the BOX to check the declaration still
 * describes it: the recorded MAC is present, holds the recorded IP, and ssh
 * reaches the node there. A reservation that was never made shows up as
 * `drifted` the first time the lease moves — late, but never silent.
 *
 * @param probe          `{node, ok, error?, ifaces?}` — `parseInterfaces` output.
 * @param record         `machines[node].lan`, or undefined.
 * @param sshResolvesTo  `ssh -G <node>`'s hostname, or null.
 * @param suggestion     `proposeLanRecord` over the same probe, for the fix line.
 */
export function lanReservationFinding(probe, record, sshResolvesTo, suggestion = null) {
	const node = probe.node;
	const base = { category: 'lan-reservation', node, class: BLOCKING };
	if (!probe.ok) {
		return {
			...base,
			status: 'unreachable',
			why: `${node}'s interfaces could not be read to check its LAN reservation: ${probe.error}.`,
		};
	}
	const reserveHint = suggestion
		? ` Reserve ${suggestion.mac} -> ${suggestion.ip} on the gateway (Advanced -> DHCP ` +
			`Reservation; delete any Auto row for that MAC first), then run ` +
			`\`fleet lan-reserve --machine ${node} --write\`.`
		: ' No interface on it holds an IPv4 address, so there is nothing to reserve yet.';
	if (!record?.mac || !record?.ip) {
		return {
			...base,
			status: 'unrecorded',
			why: `${node} has no gateway reservation on record (machines.${node}.lan), so its LAN address is a DHCP lease that can move.${reserveHint}`,
		};
	}
	const mac = String(record.mac).toLowerCase();
	const iface = (probe.ifaces ?? []).find((i) => i.mac?.toLowerCase() === mac);
	if (!iface) {
		return {
			...base,
			status: 'nic-missing',
			why: `${node}'s reservation names ${mac}, and no interface on the box has that MAC — the NIC was replaced or the record is wrong.${reserveHint}`,
		};
	}
	if (!iface.ipv4) {
		return {
			...base,
			status: 'no-address',
			why: `${node}'s reserved interface ${iface.name} (${mac}) holds no IPv4 address — cable out or radio down — so the node is not on its address of record ${record.ip}.`,
		};
	}
	if (iface.ipv4 !== record.ip) {
		return {
			...base,
			status: 'drifted',
			why: `${node}'s ${iface.name} (${mac}) holds ${iface.ipv4}, not its reserved ${record.ip}: the gateway reservation is missing or names another address. Fix the row on the gateway, or re-record with \`fleet lan-reserve --machine ${node} --write\` if the new address is intended.`,
		};
	}
	if (isIpv4(sshResolvesTo) && sshResolvesTo !== record.ip) {
		return {
			...base,
			status: 'ssh-mismatch',
			why: `ssh resolves ${node} to ${sshResolvesTo}, but its reserved address is ${record.ip} — the fleet is reaching it on an address nothing pins. Point its ~/.ssh/config HostName at ${record.ip}.`,
		};
	}
	return null;
}

/** {@link lanReservationFinding} over every probed node, findings only. */
export function lanReservationFindings(probes, records, resolved, suggestions = {}) {
	return probes
		.map((p) =>
			lanReservationFinding(
				p,
				records[p.node],
				resolved[p.node] ?? null,
				suggestions[p.node] ?? null
			)
		)
		.filter(Boolean);
}

/**
 * How many days a claw may go without the outcome unattended-upgrades exists for.
 *
 * apt-daily-upgrade fires daily (06:00 + up to 60 min jitter), so a healthy
 * claw installs a Debian security update within about a day of its lists
 * seeing it. Seven days is that cadence with room for a node out of service
 * over a long weekend (a drained node is deferred anyway) — and short enough
 * that the 2026-10-25 breakage, which ran from first boot for about seven
 * weeks, would have failed this gate in its first week. Debian publishes
 * several security updates for the stable release in any ordinary week, so
 * "pending, and nothing from Debian-Security installed for 7 days" is never
 * the normal state of a working node.
 */
export const SECURITY_STALE_DAYS = 7;

/**
 * How old apt's last successful list refresh may be. apt-daily refreshes about
 * twice a day; three days is six missed refreshes. Past it the node cannot SEE
 * new security updates, so "nothing pending" from it means nothing.
 */
export const LISTS_STALE_DAYS = 3;

/**
 * The node half: apt's own cache, read through python3-apt (unattended-
 * upgrades' own dependency, so present wherever the thing being checked is).
 * Read-only and unprivileged. The last security install is the newest
 * `upgrade` line in dpkg's own log (world-readable, rotated, gzipped past .1)
 * whose NEW version apt still knows from a Debian-Security index. An UPGRADE,
 * deliberately: a fresh `apt-get install` of a new package also lands the
 * security archive's version, and on 10-25 claw-5/6/8 read as "installed from
 * security this week" on an `unzip` the toolchain converger installed, while
 * not one pending update had been applied. dpkg logs the node's local time,
 * converted to epoch on the node. Every upgradable package whose
 * CANDIDATE comes from Debian-Security is pending. `update-stamp` is what
 * apt.systemd.daily touches after a list refresh.
 */
export const SECURITY_PROBE = `python3 - <<'PY'
import glob, gzip, os, time
try:
    import apt
except Exception as e:
    print('ERROR python3-apt unavailable: %s' % e)
    raise SystemExit(0)
SEC = 'Debian-Security'
c = apt.Cache()
def from_security(name, version):
    for key in (name, name.split(':')[0]):
        if key in c:
            v = c[key].versions.get(version)
            return v is not None and any(o.label == SEC for o in v.origins)
    return False
logs = sorted(glob.glob('/var/log/dpkg.log*'), key=lambda f: os.stat(f).st_mtime, reverse=True)
last, lastpkg = None, ''
for f in logs:
    opener = gzip.open if f.endswith('.gz') else open
    try:
        with opener(f, 'rt', errors='replace') as fh:
            rows = [l.split() for l in fh if ' upgrade ' in l]
    except OSError:
        continue
    for r in reversed(rows):
        if len(r) >= 6 and r[2] == 'upgrade' and from_security(r[3], r[5]):
            last = int(time.mktime(time.strptime('%s %s' % (r[0], r[1]), '%Y-%m-%d %H:%M:%S')))
            lastpkg = '%s=%s' % (r[3].split(':')[0], r[5])
            break
    if last:
        break
pending = []
for p in c:
    cand = p.candidate
    if p.is_upgradable and cand is not None and any(o.label == SEC for o in cand.origins):
        pending.append('%s=%s' % (p.shortname, cand.version))
try:
    lists = str(int(os.stat('/var/lib/apt/periodic/update-stamp').st_mtime))
except OSError:
    lists = 'NONE'
print('LISTS %s' % lists)
print('LAST %s %s' % (last or 'NONE', lastpkg))
for x in sorted(pending):
    print('PKG %s' % x)
print('END security-probe')
PY
`;

/** {@link SECURITY_PROBE}'s answer, or `null` when it is not one. */
export function parseSecurityProbe(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const err = lines.find((l) => l.startsWith('ERROR '));
	if (err) return { error: err.slice(6) };
	if (!lines.includes('END security-probe')) return null;
	const word = (tag) => lines.find((l) => l.startsWith(`${tag} `))?.split(/\s+/)[1] ?? '';
	const epochMs = (v) => (/^\d+$/.test(v) ? Number(v) * 1000 : null);
	return {
		listsAtMs: epochMs(word('LISTS')),
		lastInstallAtMs: epochMs(word('LAST')),
		lastPackage: lines.find((l) => l.startsWith('LAST '))?.split(/\s+/)[2] ?? null,
		pending: lines.filter((l) => l.startsWith('PKG ')).map((l) => l.slice(4)),
	};
}

/**
 * When each pending `pkg=version` was first seen on this node, carried from the
 * last run. Pure: the caller reads and writes the file. A package no longer
 * pending is dropped, so a version that installs and a newer one that arrives
 * later starts its own clock.
 *
 * @param {Record<string,string>} prev  `pkg=version` -> ISO first seen
 * @returns {Record<string,string>}
 */
export function pendingSince(prev, pending, nowMs = Date.now()) {
	const now = new Date(nowMs).toISOString();
	return Object.fromEntries(pending.map((p) => [p, prev?.[p] ?? now]));
}

const daysAgo = (ms, nowMs) => (nowMs - ms) / 86_400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One node's security-update outcome -> a finding, or `null`.
 *
 * `probe` is `{ node, ok, error?, listsAtMs, lastInstallAtMs, lastPackage,
 * pending }`; `firstSeen` is {@link pendingSince} for the node. BLOCKING in
 * every case, and in this order, because each one hides the next:
 *
 *   unreachable    could not look.
 *   lists-stale    apt has not refreshed in LISTS_STALE_DAYS (or never), so
 *                  an empty pending list would be blindness, not a clean box.
 *   not-installing updates are pending and nothing from Debian-Security has
 *                  been installed in SECURITY_STALE_DAYS (or ever) — the
 *                  2026-10-25 shape. Needs no history, so a lost state file
 *                  cannot soften it.
 *   stuck          some pending update was first seen more than
 *                  SECURITY_STALE_DAYS ago while others installed: one
 *                  package held back (a conffile prompt, a dependency the
 *                  security archive does not carry) behind a node that is
 *                  otherwise patching.
 */
export function securityUpdateFinding(
	probe,
	firstSeen = {},
	{ nowMs = Date.now(), staleDays = SECURITY_STALE_DAYS, listsStaleDays = LISTS_STALE_DAYS } = {}
) {
	const base = { category: 'security-updates', node: probe.node, class: BLOCKING };
	if (!probe.ok) {
		return {
			...base,
			status: 'unreachable',
			why: `${probe.node} could not be checked for pending security updates: ${probe.error}.`,
		};
	}
	if (probe.listsAtMs === null || daysAgo(probe.listsAtMs, nowMs) > listsStaleDays) {
		return {
			...base,
			status: 'lists-stale',
			why:
				`${probe.node}'s apt lists were ${probe.listsAtMs === null ? 'never refreshed by apt-daily (no update-stamp)' : `last refreshed ${day(probe.listsAtMs)}, ${Math.round(daysAgo(probe.listsAtMs, nowMs))} days ago`}` +
				` — past ${listsStaleDays} days, so it cannot see new security updates and "none pending" ` +
				'from it means nothing. Check apt-daily.timer and `apt-get update` on the node.',
		};
	}
	const pending = probe.pending ?? [];
	if (!pending.length) return null;
	const sample =
		pending.slice(0, 5).join(', ') + (pending.length > 5 ? `, +${pending.length - 5} more` : '');
	const last = probe.lastInstallAtMs;
	if (last === null || daysAgo(last, nowMs) > staleDays) {
		return {
			...base,
			status: 'not-installing',
			pending: pending.length,
			lastInstall: last === null ? null : new Date(last).toISOString(),
			why:
				`${probe.node} has ${pending.length} Debian security update(s) pending (${sample}) and ` +
				(last === null
					? 'has never installed anything from Debian-Security'
					: `has installed nothing from Debian-Security since ${day(last)} (${probe.lastPackage}), ` +
						`${Math.round(daysAgo(last, nowMs))} days`) +
				` — past ${staleDays} days, unattended-upgrades is not doing its job. ` +
				`Run \`fleet apt-security --machine ${probe.node}\` (it executes the dry run and says why).`,
		};
	}
	const stuck = pending.filter((p) => {
		const t = Date.parse(firstSeen[p] ?? '');
		return Number.isFinite(t) && daysAgo(t, nowMs) > staleDays;
	});
	if (!stuck.length) return null;
	return {
		...base,
		status: 'stuck',
		pending: pending.length,
		stuck,
		why:
			`${probe.node} has ${stuck.length} Debian security update(s) pending for more than ${staleDays} ` +
			`days (${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? ', ...' : ''}) while it installed ` +
			`others as recently as ${day(last)}: held back, not forgotten. ` +
			`\`sudo unattended-upgrade --dry-run -d\` on ${probe.node} names the reason.`,
	};
}
