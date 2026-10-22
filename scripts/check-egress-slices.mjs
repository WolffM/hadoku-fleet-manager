#!/usr/bin/env node
/**
 * check-egress-slices — every PM2 app is either a hadoku ecosystem service or a
 * NAMED hokon-local exception, and the cgroups the split tunnel routes on are
 * actually populated.
 *
 * WHOSE HALF THIS IS
 * ------------------
 * The split tunnel is the one item in local-hawk's 2026-09-05 handoff filed
 * under "needs both of us". The boundary the operator drew:
 *
 *   fleet-manager SPECIFIES the taxonomy — which cgroups carry fleet work and
 *   must egress direct, and what happens when a new PM2 app appears.
 *
 *   local-hawk OWNS the policy — the nftables / `ip rule` changes that send
 *   everything else through the tunnel, and the before/after verification.
 *
 * So this file declares and audits `manifests/egress-slices.json` and stops
 * there. It installs no rule, reads no firewall and touches no interface. Do not
 * grow it into one: `/etc/suricata/suricata.yaml`, `zeek/*` and the NordVPN
 * allowlist are local-hawk's instruments, and it asked — reasonably — to be sent
 * requirements rather than edits, because those are how it reads the box.
 *
 * WHY A GATE AND NOT A LIST
 * -------------------------
 * `service-identity-split-2026-09-03.md` §9 catalogued 21 PM2 apps by hand and
 * said plainly: "This does not need a hand-maintained list — it needs a GATE."
 * A catalogue is true on the day it is written. The policy it feeds is a PREFIX
 * match on `system.slice/pm2-hadoku.service`, so a PM2 app added tomorrow
 * inherits fleet egress with no edit anywhere and no one deciding that it should
 * — which is the drift this exists to catch, and the reason the failure mode is
 * "unclassified app" rather than "unknown app is fine".
 *
 * TWO SOURCES, DELIBERATELY DIFFERENT — the CLAUDE.md rule, applied here
 * ---------------------------------------------------------------------
 * "The reader for a facet may not read what the writer wrote." This check has
 * two facets and reads each from the side that cannot be self-confirming:
 *
 *   WHAT AN APP IS      -> `pm_cwd` from `pm2 jlist`. A declaration.
 *   WHAT EGRESS IT GETS -> `/proc/<pid>/cgroup`. The kernel. An observation.
 *
 * A finding is where those two DISAGREE. That matters because the interesting
 * failure is not "an app is unlisted" — it is an app whose class says
 * hokon-local while the kernel has it sitting in the direct-egress cgroup, and
 * no reading of either source alone can see that.
 *
 * This repo has already paid for the general version of this lesson once:
 * `slice-placement-guard.test.mjs` records that 24 misplaced hokon units all
 * compared EQUAL because the check read the declared `Slice=` instead of the
 * effective `ControlGroup`. `Slice=` is true the moment it is written; systemd
 * only moves a unit when it restarts. Same trap, same answer — read the kernel.
 *
 * PREFIX, NOT EQUALITY, ON pm_cwd
 * -------------------------------
 * `mgmt-api` runs from `~/srv/hadoku_site/services/mgmt-api`, not from
 * `~/srv/hadoku_site`. The §9 catalogue lists it as ecosystem — correctly — but
 * an equality test on `pm_cwd` would score the single most important service on
 * the box as unclassified and fail a clean fleet. Measured 2026-09-05.
 *
 * `--json` is a contract in this package, and this subcommand IS in
 * `lib/json-contract.mjs` — `ci:egress-slices` parses this stdout, and its
 * consumer reads `findings`, `deferred` and `acceptedLeaks` as three different
 * answers. That separation exists only in the JSON shape, so renaming the
 * subcommand or collapsing those arrays is a CROSS-REPO change; the gate beside
 * that file names the mgmt-api file to fix in the same pass. (This header said
 * the opposite until 2026-09-14, having been written before the cron existed —
 * a comment standing in for the code, which is a thing this repo keeps paying
 * for.)
 *
 * A RESTART IS NOT AN OUTAGE, AND AN OUTAGE IS NOT A RESTART
 * ---------------------------------------------------------
 * See `TRANSIENT_STATES` and `SETTLE_ATTEMPTS` below. The short version: an app
 * caught between `stopping` and `online` is deferred only after this gate has
 * SEEN it return to `online` within a bounded window, and an app that does not
 * return is still a finding. Issue #23.
 *
 * ...AND A DEPLOY IS NEITHER (issue #31)
 * --------------------------------------
 * The settle window is 9 seconds and a deploy is ~19 at its fastest, so this
 * gate paged `@here` for pygmalion in the middle of an ordinary, successful
 * deploy. The obvious fix — a longer wait — is the one thing that must not
 * happen: the bound is what stops a crash loop buying tolerance by
 * manufacturing `launching` forever, and a gate may never get easier to pass
 * the worse the failure gets. So the wait is UNCHANGED. What changed is that
 * mgmt-api now publishes the one fact this gate cannot observe — that IT is the
 * reason the service is down — in `~/.hadoku-mgmt/deploys-in-flight.json`, and
 * `createMarkerReader` below reads it.
 *
 * THE MARKER MAY ONLY DEFER, NEVER PASS. Every hard rule in this repo says a
 * reader must not take a writer's word for a facet the writer controls, and
 * that rule is honoured here by the marker's POSITION rather than by not
 * reading it: it is consulted only after this gate has already decided, from
 * observed state, that the app is a finding — and it can only downgrade that
 * finding to a deferral, which is itself reported on every run and is not a
 * pass. It cannot classify an app, it cannot put one in `ok`, it cannot rescue
 * an `errored` app or one PM2 has scored as flapping, and it cannot empty the
 * run (`nothing-observed` still fires). If an edit ever lets the marker make
 * something green, that edit is wrong.
 *
 * ...AND A hokon-local APP THAT IS SIMPLY NOT RUNNING IS NONE OF THIS GATE'S
 * BUSINESS (issue #68)
 * -------------------------------------------------------------------------
 * `valheim` and `valheim-panel` are the operator's game server. They are named
 * `class: hokon-local` in the taxonomy, whose own header defines that class as
 * apps that "run under PM2 but are NOT hadoku ecosystem services" — "the
 * operator's desktop tooling, no fleet role". The operator stopped them, and
 * this gate paged `@here` about it, every day, because the `not-running` branch
 * made no distinction by class.
 *
 * Its reasoning — "a service that is not running has no egress to classify, and
 * an audit that skipped it would report a clean box" — is exactly right for an
 * ECOSYSTEM service, whose being down IS a fleet fact. It does not transfer to a
 * class the taxonomy defines as having no fleet role, and the taxonomy header
 * forbids both documented escapes: "the fix is to move it out of PM2 or give it
 * its own slice — not to delete its line here". Move it out of PM2 and it leaves
 * the register; delete the line and it fails as `unclassified`. There is no
 * operator workaround, which is what makes this a code fix.
 *
 * THE COVERAGE THIS COSTS IS ZERO, and that is checkable rather than asserted.
 * Walk the branches below for `declared === 'hokon-local'`: `unclassified`
 * cannot fire (it is classified), `ecosystem-outside-direct` cannot fire (it is
 * not ecosystem), and the cgroup cross-check resolves to `ok` either way — in a
 * direct-egress cgroup it is an `acceptedLeak`, outside one it is on the tunnel,
 * and neither is a finding. So `no-cwd` and `not-running` are the ONLY findings
 * a hokon-local app can produce, and `not-running` was the only false positive
 * among them. Exempting it removes a page and no coverage.
 *
 * SO IT IS `dormant`, WHICH IS A THIRD ANSWER AND NOT A PASS. A dormant app
 * never reaches `ok`, it counts toward the `nothing-observed` bound exactly as a
 * deferral does, and it is printed on every run WITH the accepted-leak reason
 * from the register — because the register shrinking from five entries to three
 * when two apps stop is the "we decided this" ages into "nobody noticed" failure
 * this file already worries about. It is NOT folded into `deferred`: a deferral
 * says "re-read on the next tick", and a game server the operator stopped in
 * March is not going to resolve next tick. Printing it as a partial scan forever
 * is the noise that teaches an operator to skip the line that matters.
 *
 * THE EXEMPTION KEYS ON THE `class` FIELD, NEVER ON MEMBERSHIP OF THE
 * `hokonLocal` ARRAY. That array is not uniformly hokon-local — `pm2-logrotate`
 * sits in it as `class: platform`, which is PM2's own module maintaining the
 * process manager, and a stopped one is a real finding. `class` also cannot be
 * reached by a fault: a missing or misspelled class reads as `null`, i.e.
 * `unclassified`, and `declaredOf` resolves the ecosystem PREFIX first, so
 * naming an ecosystem service in `hokonLocal` cannot buy it this exemption.
 *
 * AND THIS READER OWNS THE CEILING, not the writer. The file names a
 * `staleAfterMs`; this gate clamps it to `MAX_DEPLOY_DEFER_MS`. A writer that
 * asked for a day would get fifteen minutes, because an exemption whose length
 * the excused party chooses is the unbounded wait again by another route.
 *
 * A MISSING FILE IS "NO DEPLOY IN FLIGHT", NEVER AN ERROR. That is deliberate
 * and it is what makes the landing order safe in both directions: this half can
 * ship before mgmt-api ever writes a marker, and mgmt-api can stop writing them
 * without breaking the gate. An unreadable or malformed file is REPORTED — with
 * its reason, in `markerFile` — and grants no exemption, which is the strict
 * direction.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmitter } from './lib/emit.mjs';
import { manifest, stateDir } from './lib/paths.mjs';

const JSON_OUT = process.argv.includes('--json');
const emitter = createEmitter({ argv: process.argv });
const log = emitter.log;

/**
 * THE PM2 STATES AN APP PASSES THROUGH ON ITS WAY BACK TO `online`.
 *
 * A PM2 restart is `stopping` -> `stopped` -> `launching` -> `online`; `status`
 * does NOT stay `online` across one. This file used to reject every one of
 * those before it reached the deferral written for exactly this case, so the
 * deferral was unreachable for the only failure it existed to absorb — issue
 * #23, observed at 13:07 UTC on 2026-09-11 and again on 2026-09-12, both in the
 * wave after the 13:00 repo-sync deploy, both naming `tenhands-temporal` with
 * `unstable_restarts: 0` and a start timestamp within 300ms of its sibling.
 * Lockstep, which is a deploy. (2026-09-14 13:08 on this box: the same pair,
 * 17s apart, same shape.)
 *
 * `errored` and `waiting restart` are deliberately NOT here. `waiting restart`
 * is PM2's backoff BETWEEN crashes — it is the crash loop, not the path out of
 * one — and `errored` is PM2 having given up entirely. Both stay findings, on
 * every run, with no wait.
 */
const TRANSIENT_STATES = new Set(['stopping', 'stopped', 'launching']);

/**
 * THE ONE CLASS WHOSE RUNNING STATE THIS GATE HAS NO CLAIM ON. Issue #68.
 *
 * Spelled as a constant and compared with `===` so the exemption is one exact
 * string and not a family. `hokonLocal` in the manifest is the accepted-leak
 * REGISTER, not a list of hokon-local apps: `pm2-logrotate` is in it under
 * `class: platform`, and a gate that exempted everything in the array would
 * exempt the process manager's own module going down. The register's membership
 * is "somebody decided about this app"; the `class` field is what they decided.
 */
const DORMANT_EXEMPT_CLASS = 'hokon-local';

/**
 * HOW LONG A RESTART MAY TAKE BEFORE IT IS JUST A SERVICE THAT IS NOT RUNNING.
 *
 * The bound is the entire point. "Tolerate a restart" with no bound is
 * "tolerate anything that is not currently running", and the states above are
 * exactly the states a CRASH LOOP manufactures — a process dying on boot sits
 * in `launching` on and off indefinitely. An unbounded deferral would therefore
 * make this gate easier to pass the worse the failure got, which is the one
 * thing CLAUDE.md says a gate may never do.
 *
 * So a deferral has to be EARNED: this gate re-reads PM2 and must SEE the app
 * back at `online`. Three later samples, three seconds apart, against a
 * graceful restart measured at ~6s on this box. Samples are SHARED across apps
 * (`createSettler`), so the ceiling is 9 seconds and three `pm2 jlist` calls for
 * the whole run however many apps are moving at once — which matters, because
 * the cron on the other end of this JSON allows the run 60 seconds total and a
 * per-app wait would blow that precisely when the box is at its worst.
 */
const SETTLE_ATTEMPTS = 3;

/**
 * The gap between those samples.
 *
 * Overridable, and the direction it can be abused in is the safe one: a shorter
 * wait turns a real restart into a `not-running` finding, never the reverse, so
 * this knob can only make the gate stricter. The tests set it to a few
 * milliseconds so a suite does not pay nine seconds to prove a bound; nothing in
 * production sets it at all.
 */
const SETTLE_WAIT_MS = Number(process.env.FLEET_EGRESS_SETTLE_MS ?? 3000);

/**
 * THE FILE mgmt-api WRITES WHILE IT IS DEPLOYING. Issue #31.
 *
 * `stateDir()` is the same answer mgmt-api's own `deployMarkerPath()` resolves
 * (`HADOKU_STATE_DIR`, else `~/.hadoku-mgmt`) — one question, one answer, the
 * `isLocalNode` rule applied to a path. If the two ever disagree the writer
 * writes into the void, this gate finds nothing, and the fix reads as landed
 * while paging through every deploy.
 */
const DEPLOY_MARKER_FILE = 'deploys-in-flight.json';

/**
 * THE LONGEST A MARKER MAY EXCUSE A STOPPED SERVICE, whatever the file says.
 *
 * mgmt-api's own bound is the same fifteen minutes and is sized to its
 * configured caps — the service is down from `pm2 stop` until `pm2 start`,
 * which spans the build (15 min cap) and the migration (5 min cap). The number
 * is duplicated here ON PURPOSE rather than taken from the file, because this
 * is the half that must not be talked up: `staleAfterMs` in the document is
 * read, but only ever to make the window SHORTER (`Math.min`). Past this, a
 * deploy is not slow, it is stuck — and a stuck deploy leaving a service down
 * is the finding, not the excuse.
 */
const MAX_DEPLOY_DEFER_MS = 15 * 60_000;

/**
 * How far into the future a `startedAt` may sit before the entry is junk.
 *
 * Without this a clock that jumped forward writes an entry whose age is always
 * negative — never past the bound, i.e. a permanent exemption. Exactly the
 * failure the staleness field exists to prevent, arriving through the field
 * itself.
 */
const MARKER_SKEW_TOLERANCE_MS = 60_000;

/**
 * Read `deploys-in-flight.json`, once, lazily.
 *
 * LAZY because a healthy run never needs it: the marker is consulted only for
 * an app this gate has already decided is a finding, so a box with nothing
 * moving does no file IO and reports `status: 'unread'` — which is honest, and
 * says plainly that no app needed an exemption.
 *
 * Every failure mode returns an EMPTY entry set with its reason attached, and
 * an empty set means the unmodified 9s rule applies. That is the strict
 * direction in all four cases, and `catch {}` would have made three of them
 * indistinguishable: a state dir nobody can read, a half-written document and a
 * document of the wrong shape are three different jobs.
 */
function createMarkerReader() {
	let state = null;
	const blank = (status, reason) => ({
		path: join(stateDir(), DEPLOY_MARKER_FILE),
		status,
		...(reason ? { reason } : {}),
		staleAfterMs: MAX_DEPLOY_DEFER_MS,
		entries: new Map(),
	});
	const read = () => {
		const file = join(stateDir(), DEPLOY_MARKER_FILE);
		let raw;
		try {
			raw = readFileSync(file, 'utf8');
		} catch (err) {
			// ABSENT IS NOT A FAILURE. mgmt-api has simply not deployed anything
			// since the state dir was last cleared, which is also what a box where
			// this half shipped first looks like.
			if (err.code === 'ENOENT') return blank('absent');
			return blank('unreadable', `${err.code ?? err.message}`);
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			return blank('malformed', `not parseable JSON (${err.message})`);
		}
		if (!parsed || !Array.isArray(parsed.deploys)) {
			return blank('malformed', 'no `deploys` array — a marker file of the wrong shape');
		}
		// THE CEILING IS OURS. A file asking for longer gets our number.
		const asked = Number(parsed.staleAfterMs);
		const staleAfterMs =
			Number.isFinite(asked) && asked > 0
				? Math.min(asked, MAX_DEPLOY_DEFER_MS)
				: MAX_DEPLOY_DEFER_MS;
		const entries = new Map();
		let dropped = 0;
		for (const e of parsed.deploys) {
			if (!e || typeof e.service !== 'string' || typeof e.startedAt !== 'string') {
				dropped++;
				continue;
			}
			const startedAt = Date.parse(e.startedAt);
			if (!Number.isFinite(startedAt)) {
				dropped++;
				continue;
			}
			entries.set(e.service, {
				service: e.service,
				startedAt,
				startedAtText: e.startedAt,
				deployId: typeof e.deployId === 'string' ? e.deployId : null,
			});
		}
		return {
			path: file,
			status: 'ok',
			staleAfterMs,
			entries,
			...(dropped ? { reason: `${dropped} entr(ies) ignored: no usable service/startedAt` } : {}),
		};
	};
	return {
		/** The live, non-stale entry for `name`, or null. Never throws. */
		exemption: (name, now) => {
			state ??= read();
			const entry = state.entries.get(name);
			if (!entry) return null;
			const ageMs = now - entry.startedAt;
			// A start time in the future is a broken clock, not a young deploy.
			if (ageMs < -MARKER_SKEW_TOLERANCE_MS) return null;
			// STALE. The whole point of the field: a crashed executor cannot deposit
			// a permanent exemption, because nothing here trusts an entry forever.
			if (ageMs > state.staleAfterMs) return null;
			return { ...entry, ageMs, staleAfterMs: state.staleAfterMs };
		},
		/** What to put in the report. `unread` when no app ever needed one. */
		report: () =>
			state === null
				? { path: join(stateDir(), DEPLOY_MARKER_FILE), status: 'unread' }
				: {
						path: state.path,
						status: state.status,
						...(state.reason ? { reason: state.reason } : {}),
						staleAfterMs: state.staleAfterMs,
						entries: state.entries.size,
					},
		/** True once an app has actually asked. Keeps a clean run's output clean. */
		consulted: () => state !== null,
	};
}

/**
 * Block for `ms`, synchronously.
 *
 * Every read in this script is synchronous — `pm2 jlist`, `/proc`, the cgroup
 * walk — and making one path `await` would restructure all of them for no gain.
 * `Atomics.wait` costs no child process.
 */
function sleepSync(ms) {
	if (!(ms > 0)) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The cgroup a PID is actually in, from the kernel.
 *
 * cgroup v2 writes one line, `0::<path>`. A PID that vanished between `pm2
 * jlist` and this read returns null, and the caller treats that as "could not
 * look" rather than as a pass — an app whose egress class cannot be observed is
 * exactly the case that must not render as healthy.
 */
function observedCgroup(pid) {
	if (!pid || pid <= 0) return null;
	try {
		const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
		const line = raw.split('\n').find((l) => l.startsWith('0::'));
		return line ? line.slice(3).trim() : null;
	} catch {
		return null; // exited, or not ours to read
	}
}

/**
 * How many processes the kernel actually has under a cgroup path, counted
 * recursively.
 *
 * NOT derived from the PM2 list, and that distinction is the whole reason this
 * function exists rather than a tally over `apps`. The first draft counted PM2
 * processes per prefix and duly reported `ci-runner.slice` as EMPTY — which is
 * true of PM2 and false of the box: the 27 runner units are systemd services, so
 * PM2 has never heard of them and a count sourced from it can only ever be zero.
 * A gate whose "is this slice populated" question is answered by a source that
 * structurally cannot see the population is not a weak gate, it is a wrong one.
 *
 * Returns null when the path is not there at all, which is a different finding
 * from a path that exists and holds nothing.
 */
function cgroupPopulation(cgroupPath) {
	const root = join('/sys/fs/cgroup', cgroupPath);
	if (!existsSync(root)) return null;
	let total = 0;
	/** @param {string} dir */
	const walk = (dir) => {
		try {
			const procs = readFileSync(join(dir, 'cgroup.procs'), 'utf8').trim();
			if (procs) total += procs.split('\n').length;
		} catch {
			// A cgroup can disappear mid-walk; the other branches still count.
		}
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// Leaf cgroups hold the processes: a slice's own `cgroup.procs` is empty
		// while its child scopes and services carry every PID.
		for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name));
	};
	walk(root);
	return total;
}

/**
 * The pid PM2 reports for one app RIGHT NOW.
 *
 * Deliberately a fresh `jlist` rather than a cached one: the point is to get a
 * later sample than the one that went stale, and reusing the first read would
 * return the same stale pid and prove nothing.
 */
function freshPid(name) {
	const apps = pm2Apps();
	if (!apps) return null;
	const found = apps.find((a) => a.name === name);
	return found?.pid && found.pid > 0 ? found.pid : null;
}

/**
 * Later samples of `pm2 jlist`, taken lazily and SHARED by every app that needs
 * one.
 *
 * The sharing is what keeps the bound affordable. A rolling deploy can have
 * several apps in flight at once, and a per-app sleep would multiply the wait by
 * the number of casualties — i.e. the wait would grow with the size of the
 * failure, and the cron's 60s ceiling would be hit first by the worst boxes.
 * Snapshot `i` is taken once, on demand, and reused: because apps are walked in
 * a tight loop, a snapshot taken when the FIRST moving app asked for it is still
 * strictly later than every subsequent app's first sample.
 *
 * Returns whether the app came back, and — either way — what was seen, because
 * "stopped, then stopped again 9s later" and "stopped, then gone from PM2
 * entirely" are two different jobs for whoever reads the finding.
 */
function createSettler() {
	/** @type {Array<Map<string, object> | null>} */
	const snapshots = [];
	const snapshotAt = (i) => {
		while (snapshots.length <= i) {
			sleepSync(SETTLE_WAIT_MS);
			const apps = pm2Apps();
			snapshots.push(apps ? new Map(apps.map((a) => [a.name, a])) : null);
		}
		return snapshots[i];
	};
	return (name, firstStatus) => {
		let last = firstStatus;
		for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
			const snap = snapshotAt(i);
			const waitedMs = (i + 1) * SETTLE_WAIT_MS;
			// PM2 GOING AWAY MID-WAIT IS NOT "IT CAME BACK". Reported as its own
			// reason so it cannot be read as either a restart or a stopped app.
			if (snap === null) return { online: false, reason: 'pm2-unreadable', last, waitedMs };
			const later = snap.get(name);
			if (!later) return { online: false, reason: 'gone', last, waitedMs };
			last = later.pm2_env?.status ?? 'unknown';
			if (last === 'online') return { online: true, app: later, waitedMs };
		}
		return {
			online: false,
			reason: 'still-down',
			last,
			waitedMs: SETTLE_ATTEMPTS * SETTLE_WAIT_MS,
		};
	};
}

/** Every live PM2 app, or null if PM2 itself could not be reached. */
function pm2Apps() {
	try {
		const raw = execFileSync('pm2', ['jlist'], {
			encoding: 'utf8',
			maxBuffer: 32 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function main() {
	// A MISSING MANIFEST THROWS — it never defaults to an empty taxonomy, for the
	// reason CLAUDE.md gives about manifests generally: a taxonomy that resolves
	// to nothing classifies nothing and reports a clean box. But it throws with a
	// PARSEABLE failure, because `--json` is a contract in this package and a raw
	// ENOENT stack on stdout reads to a cron as "the checker broke" rather than as
	// a finding.
	const specPath = manifest('egress-slices.json');
	let spec;
	try {
		spec = JSON.parse(readFileSync(specPath, 'utf8'));
	} catch (err) {
		const msg =
			`check-egress-slices: could not read the egress taxonomy at ${specPath} (${err.code ?? err.message}). ` +
			"It is authoritative in this repo's manifests/ and has no writer — copy it to the manifest " +
			'directory, or set FLEET_MANIFEST_DIR. Refusing to audit against an empty taxonomy.';
		if (JSON_OUT) emitter.emit({ error: msg, examined: 0, findings: [] });
		else console.error(msg);
		process.exit(1);
	}

	const prefixes = spec.directEgress.map((d) => d.cgroup);
	const exceptions = new Map(spec.hokonLocal.map((h) => [h.app, h]));
	// A trailing separator so `ecosystemRoot` matches the directory and anything
	// under it, and never a sibling whose name merely starts the same way.
	const ecoRoot = `/${spec.ecosystemRoot.replace(/^\/+|\/+$/g, '')}/`;

	const apps = pm2Apps();

	// "I COULD NOT LOOK" MUST NEVER RENDER AS "NOTHING IS WRONG". PM2 being
	// unreachable and PM2 running nothing are both failures: the taxonomy governs
	// what egresses direct, and an empty answer would licence the policy to route
	// on a set nobody verified.
	if (apps === null || apps.length === 0) {
		const msg =
			apps === null
				? 'check-egress-slices: could not read `pm2 jlist`. That is a broken scan, not a clean box.'
				: 'check-egress-slices: PM2 reports ZERO apps. The ecosystem does not run on nothing — treat this as unreadable, not as clean.';
		if (JSON_OUT) emitter.emit({ error: msg, examined: 0, findings: [] });
		else console.error(msg);
		process.exit(1);
	}

	/**
	 * What an app IS, from its `pm_cwd`, or null when nothing claims it.
	 *
	 * PREFIX, not equality — `mgmt-api` runs from a directory UNDER the ecosystem
	 * root and an equality test scores it unclassified. See the header.
	 */
	const declaredOf = (name, cwd) => {
		if (cwd === null) return null;
		if (`${cwd.replace(/\/+$/, '')}/`.includes(ecoRoot)) return 'ecosystem';
		return exceptions.get(name)?.class ?? null;
	};

	const findings = [];
	const ok = [];
	/** Online but restarting mid-scan: classified, egress cross-check deferred. */
	const deferred = [];
	/**
	 * Not running, and of a class with no fleet role: classified, nothing to
	 * cross-check, and nothing this gate has a claim on. Issue #68.
	 *
	 * A THIRD ANSWER, because it is neither of the other two. `ok` would claim an
	 * observed egress there is no process to observe; `deferred` would promise the
	 * next tick resolves it, and a game server the operator turned off does not
	 * resolve. It counts toward `nothing-observed` exactly as a deferral does.
	 */
	const dormant = [];

	// THE POPULATION OF EACH DIRECT-EGRESS CGROUP, FROM THE KERNEL. Counted
	// before the app loop and independently of it, because the runner slice holds
	// systemd units that PM2 cannot see — see `cgroupPopulation`.
	const population = new Map(prefixes.map((p) => [p, cgroupPopulation(p)]));

	const settle = createSettler();
	const markers = createMarkerReader();

	for (const app of [...apps].sort((a, b) => a.name.localeCompare(b.name))) {
		const name = app.name;
		const cwd = app.pm2_env?.pm_cwd ?? null;
		const firstStatus = app.pm2_env?.status ?? 'unknown';
		// PM2's OWN FLAP COUNTER. It increments when a process dies inside
		// `min_uptime`, so a non-zero value is PM2 — not this gate — having already
		// scored the app as unstable. A deploy restart leaves it at 0; every one of
		// the 23 apps on this box reads 0 while `restart_time` runs to 226.
		const unstable = Number(app.pm2_env?.unstable_restarts ?? 0);
		let pid = app.pid ?? 0;
		/** Set when this app reached `online` only after a wait — carried into the report. */
		let settledAfterMs = null;

		// PREFIX match — see the header. `mgmt-api` lives a level down.
		const declared = declaredOf(name, cwd);

		if (cwd === null) {
			findings.push({
				app,
				name,
				status: 'no-cwd',
				why: 'PM2 reports no pm_cwd, so its class cannot be decided. Unknown is not healthy.',
			});
			continue;
		}

		// A SERVICE THAT IS NOT RUNNING IS A FINDING; ONE THAT IS MID-RESTART IS
		// NOT — AND THIS GATE HAS TO EARN THE DIFFERENCE RATHER THAN ASSUME IT.
		// This branch runs BEFORE anything rejects a non-`online` status, which is
		// the whole of issue #23: the deferral below was written for a restarting
		// app and a restarting app could never reach it.
		//
		// Three bounds, in increasing cost, and the order matters — the first two
		// cost nothing and cover the cases a wait would only make slower:
		//
		//   1. the status must be ON THE PATH back to online. `errored` and
		//      `waiting restart` are not, and never wait.
		//   2. `unstable_restarts` must be 0. PM2 has its own opinion about whether
		//      this app is flapping and it is cheaper and better than ours.
		//   3. the app must be OBSERVED back at `online` inside the settle window.
		//      This is the bound that makes a crash loop fail: a loop manufactures
		//      `launching` forever, and "forever" is not "within 9 seconds, once".
		if (firstStatus !== 'online') {
			// ZEROTH, AND ONLY FOR ONE EXACT CLASS: an app the taxonomy defines as
			// having no fleet role is DORMANT, not a finding. Issue #68 — see the
			// header for why this costs no coverage and why it is not a deferral.
			//
			// FIRST, DELIBERATELY. Not because the bounds below would get it wrong,
			// but because none of them is ABOUT it: the transient-state test, the flap
			// counter and the settle window all exist to tell a restart from an outage
			// for a service whose outage matters, and for this class neither answer
			// changes anything. Placed here it also spends no `pm2 jlist` call and no
			// settle window — the two stopped game-server apps on hokon were paying
			// 9000ms of the cron's 60-second budget, every run, to be told off.
			//
			// FLAT ACROSS STATES, so there is no gradient for "a gate may never get
			// easier to pass the worse the failure gets" to exploit: `stopped`,
			// `errored` and a crash loop are all exempt for this class and all equally
			// have no egress to classify. What the rule forbids is an exemption that
			// WIDENS as a fault deepens; this one has the same width at every
			// severity, and the two facts that open it — an explicit `class` in the
			// register, and `pm_cwd` outside the ecosystem root — are both decisions
			// rather than symptoms. `cwd === null` has already fired above, so an app
			// whose class could not be decided never reaches here.
			if (declared === DORMANT_EXEMPT_CLASS) {
				const registered = exceptions.get(name);
				dormant.push({
					name,
					class: declared,
					cwd,
					pm2Status: firstStatus,
					...(unstable > 0 ? { unstableRestarts: unstable } : {}),
					// STILL ON THE REGISTER, and said so on every run. `acceptedLeaks`
					// lists what is leaking NOW, so it drops from five to three the moment
					// these stop — and an operator reading that as "two leaks closed" is
					// how a named decision ages into nobody noticing it.
					registeredAcceptedLeak: true,
					...(registered?.why ? { registeredWhy: registered.why } : {}),
					why:
						`PM2 reports status "${firstStatus}". It is named \`class: ${DORMANT_EXEMPT_CLASS}\` ` +
						`in the taxonomy, which the manifest defines as an app that runs under PM2 with ` +
						`NO fleet role, so whether it runs is not this gate's subject and a stopped one ` +
						`has no egress to classify. Its egress was NOT cross-checked on this run — while ` +
						`it is down it holds its place on the accepted-leak register and nothing else. ` +
						`An ECOSYSTEM service in this state is still a finding, and so is this one the ` +
						`moment its pm_cwd moves under the ecosystem root or its class leaves the ` +
						`manifest.`,
				});
				continue;
			}
			if (!TRANSIENT_STATES.has(firstStatus)) {
				findings.push({
					name,
					status: 'not-running',
					cwd,
					pm2Status: firstStatus,
					why:
						`PM2 reports status "${firstStatus}", which is not a state an app passes through ` +
						'on its way back to online — it is PM2 having given up, or waiting out a crash ' +
						'backoff. A service that is not running has no egress to classify, and an audit ' +
						'that skipped it would report a clean box.',
				});
				continue;
			}
			if (unstable > 0) {
				findings.push({
					name,
					status: 'not-running',
					cwd,
					pm2Status: firstStatus,
					unstableRestarts: unstable,
					why:
						`PM2 reports status "${firstStatus}" with unstable_restarts=${unstable}. A deploy ` +
						'restart leaves that counter at 0; a non-zero value is PM2 itself reporting that ' +
						'this app keeps dying inside its minimum uptime. Waiting for a crash loop to look ' +
						'like a restart is how this gate would get easier to pass the worse the fault got.',
				});
				continue;
			}
			const settled = settle(name, firstStatus);
			if (!settled.online) {
				// AND ONLY NOW, THE ONE FACT THIS GATE CANNOT OBSERVE: is mgmt-api
				// deploying this service? Issue #31.
				//
				// THE POSITION IS THE SAFETY PROPERTY. Every cheap bound above has
				// already fired — a status that is not on the path back to online, and
				// PM2's own flap counter — and the settle window has already been paid
				// and lost. So the marker cannot rescue an `errored` app, cannot rescue
				// one PM2 has scored as unstable, and cannot save this run nine
				// seconds. All it can do is turn a finding that would have paged into a
				// deferral that is reported on every tick until the deploy ends. Asking
				// EARLIER would make it a shortcut past the observed-state bounds, and
				// that is the version of this change that would be wrong.
				const deploying = markers.exemption(name, Date.now());
				if (deploying) {
					deferred.push({
						name,
						class: declared ?? 'unclassified',
						deferral: 'deploy-in-flight',
						pm2Status: settled.last,
						waitedMs: settled.waitedMs,
						deployingSince: deploying.startedAtText,
						deployAgeMs: deploying.ageMs,
						...(deploying.deployId ? { deployId: deploying.deployId } : {}),
						why:
							`deploying since ${deploying.startedAtText} ` +
							`(${Math.round(deploying.ageMs / 1000)}s ago); PM2 reports "${settled.last}" ` +
							`after ${settled.waitedMs}ms. mgmt-api holds a live entry in ` +
							`${markers.report().path}, so this is a deploy and not an outage — its egress ` +
							'was NOT cross-checked on this run and it is re-read on the next tick. The ' +
							`entry stops being honoured ${Math.round(deploying.staleAfterMs / 60_000)} ` +
							'minutes after it was written, whether or not the deploy ever finishes.',
					});
					// Classification does NOT depend on the deploy, exactly as it does
					// not depend on the cgroup read below: an app nothing claims is
					// unclassified whether or not mgmt-api is restarting it, and a
					// deferral must not be a door around that.
					if (declared === null) {
						findings.push({
							name,
							status: 'unclassified',
							cwd,
							why:
								`runs from ${cwd}, which is neither under ${spec.ecosystemRoot} nor named as ` +
								'an accepted leak. mgmt-api is deploying it, which excuses it being DOWN ' +
								'and nothing else — it is unclassified either way.',
						});
					}
					continue;
				}
				findings.push({
					name,
					status: 'not-running',
					cwd,
					pm2Status: firstStatus,
					settledStatus: settled.last,
					waitedMs: settled.waitedMs,
					...(markers.report().status === 'ok' || markers.report().status === 'unread'
						? {}
						: { deployMarkers: markers.report().status }),
					why:
						`PM2 reported status "${firstStatus}", and ${settled.waitedMs}ms and ` +
						`${SETTLE_ATTEMPTS} re-read(s) later it was ` +
						(settled.reason === 'gone'
							? 'no longer in the PM2 list at all'
							: settled.reason === 'pm2-unreadable'
								? '`pm2 jlist` that could no longer be read — which is an unreadable box, not a healthy one'
								: `still "${settled.last}"`) +
						'. A restart comes back inside that window; this did not, so it is a service that ' +
						'is not running and has no egress to classify. ' +
						// SAY THAT THE MARKER WAS CHECKED, and what it said. Otherwise a
						// deploy-time page is indistinguishable from a marker that was
						// never written, never read, or read from the wrong directory —
						// and that is the shape of failure this whole mechanism can have.
						(markers.report().status === 'ok'
							? `mgmt-api holds no live deploy entry for it in ${markers.report().path}.`
							: markers.report().status === 'absent'
								? `No deploy is in flight (${markers.report().path} does not exist).`
								: `The deploy marker at ${markers.report().path} is ${markers.report().status}` +
									`${markers.report().reason ? ` — ${markers.report().reason}` : ''}, so it ` +
									'excused nothing. Fix the file: an unreadable one cannot tell a deploy ' +
									'from an outage, and this gate refuses to guess in the lax direction.'),
				});
				continue;
			}
			// It came back, and this gate watched it come back. Re-read the pid from
			// the sample that showed it online — the one in hand is from before the
			// restart and points at a process that no longer exists.
			pid = settled.app.pid ?? 0;
			settledAfterMs = settled.waitedMs;
		}

		let cgroup = observedCgroup(pid);
		let direct = cgroup ? (prefixes.find((p) => cgroup.startsWith(p)) ?? null) : null;

		if (cgroup === null) {
			// `pm2 jlist` and the `/proc` read are two samples of a moving box, so an
			// app that restarts between them carries a stale pid. Look again at
			// whatever pid PM2 reports NOW.
			const fresh = freshPid(name);
			const retried = fresh && fresh !== pid ? observedCgroup(fresh) : null;
			if (retried) {
				cgroup = retried;
				direct = prefixes.find((p) => cgroup.startsWith(p)) ?? null;
			} else {
				// STILL UNREADABLE, BUT PM2 SAYS ONLINE — a graceful restart takes ~6s
				// on this box and a rolling deploy walks the whole ecosystem one app at
				// a time, so a scan launched during one WILL land inside that window.
				// Measured 2026-09-05: three consecutive runs each caught a different
				// app mid-restart, during a concurrent deploy sweep.
				//
				// This is reported, never silent — but it is not fatal, and the reason
				// is that it does not cost this gate its subject. The CLASSIFICATION
				// half is decided by `pm_cwd`, which is available for a restarting app
				// exactly as it is for a running one; an unclassified app still fails
				// below. What is deferred is only the cross-check of declared class
				// against observed cgroup, for this app, on this run. Failing the whole
				// audit for that would make every deploy look like a policy breach and
				// teach the operator to ignore the gate — which is how a real finding
				// gets lost.
				deferred.push({
					name,
					class: declared ?? 'unclassified',
					// NAMED, because there are now two reasons an app can be deferred and
					// they mean different things to whoever reads the JSON: this one is
					// "online, cgroup unreadable this instant", the other is "down, and
					// mgmt-api says it is deploying it". Collapsing them would make a
					// deploy that never finishes look like a busy box.
					deferral: 'egress-unobserved',
					pm2Status: 'online',
					...(settledAfterMs === null ? {} : { settledAfterMs }),
					why:
						(settledAfterMs === null
							? 'was online at both samples but its pid moved under the scan; '
							: `was mid-restart and came back to online after ${settledAfterMs}ms; `) +
						'classified from pm_cwd, but its observed cgroup could not be read on this run.',
				});
				if (declared === null) {
					findings.push({
						name,
						status: 'unclassified',
						cwd,
						why:
							`runs from ${cwd}, which is neither under ${spec.ecosystemRoot} nor named in ` +
							'hokonLocal. Its egress could not be observed on this run — but classification ' +
							'does not depend on that, and it is unclassified either way.',
					});
				}
				continue;
			}
		}

		if (declared === null) {
			findings.push({
				name,
				status: 'unclassified',
				cwd,
				cgroup,
				egress: direct ? 'direct' : 'tunnel',
				why:
					`runs from ${cwd}, which is neither under ${spec.ecosystemRoot} nor named in ` +
					'hokonLocal. It is ' +
					(direct
						? 'ALREADY RECEIVING FLEET EGRESS on the strength of nobody having looked. '
						: 'outside the direct-egress cgroups. ') +
					'Classify it in manifests/egress-slices.json — as ecosystem by moving it under ' +
					'the ecosystem root, or as an accepted leak by naming it.',
			});
			continue;
		}

		if (declared === 'ecosystem' && !direct) {
			// The policy tunnels everything it does not recognise, so an ecosystem
			// service outside these cgroups would egress through a consumer VPN once
			// local-hawk installs the rule. Wrong, and invisible until a hosted site
			// starts answering from a Netherlands exit IP.
			findings.push({
				name,
				status: 'ecosystem-outside-direct',
				cwd,
				cgroup,
				why:
					'is an ecosystem service but sits outside every direct-egress cgroup, so the ' +
					'split tunnel would route production traffic through the VPN.',
			});
			continue;
		}

		ok.push({
			name,
			class: declared,
			cgroup,
			egress: direct ? 'direct' : 'tunnel',
			// A named exception inside the direct-egress cgroup is the accepted leak
			// §3 of the design doc chose to keep. Surfaced every run rather than
			// filed away, because "we decided this" ages into "nobody noticed".
			...(declared !== 'ecosystem' && direct
				? { acceptedLeak: true, why: exceptions.get(name)?.why }
				: {}),
		});
	}

	// A DEFERRAL IS PER-APP. DEFERRING EVERY APP IS A SCAN THAT OBSERVED NOTHING.
	//
	// The per-app deferral above is sound because the rest of the run still
	// cross-checks the rest of the box. Nothing in it bounds the WHOLE run, and
	// the case that exercises that is not exotic: run this as a user who cannot
	// read the PM2 apps' /proc entries and every single app defers, findings comes
	// back empty and the gate exits 0 having observed not one cgroup. That is "I
	// could not look" rendering as "nothing is wrong", one level up from where
	// each individual branch was careful about it.
	//
	// AND IT COVERS THE DEPLOY MARKER TOO, which is the point of counting
	// `deferred` rather than counting one KIND of deferral: a marker file naming
	// every app on the box would otherwise be a way to switch this gate off from
	// outside it. It cannot be, because deferring everything is itself a finding.
	//
	// AND IT COUNTS `dormant` TOO (issue #68). A dormant app compares no observed
	// cgroup against a declared class, which is the bound's actual subject — so
	// leaving it out would mean a box whose entire PM2 list is stopped
	// hokon-local apps reports a clean fleet, and that box has lost mgmt-api.
	// An exemption that can empty the run is an off switch however narrow it is.
	const unobserved = deferred.length + dormant.length;
	if (apps.length > 0 && unobserved === apps.length) {
		findings.push({
			status: 'nothing-observed',
			why:
				`all ${apps.length} PM2 app(s) skipped their egress cross-check on this run ` +
				`(${deferred.length} deferred, ${dormant.length} dormant), so not one observed ` +
				'cgroup was compared against a declared class. A rolling deploy moves apps one at a ' +
				'time and cannot produce this; a scan that cannot read /proc can, and so would a ' +
				'deploy marker naming the whole box, or a PM2 list holding nothing but stopped ' +
				`${DORMANT_EXEMPT_CLASS} apps — which is a box that has lost the ecosystem. ` +
				'Treat it as an unreadable box, not a clean one.',
		});
	}

	// A TAXONOMY ENTRY THAT MATCHES NOTHING ROUTES NOTHING. The same shape as a
	// manifest resolving to an empty directory and reporting a healthy fleet of
	// zero machines: the policy would be installed, apply to no process, and look
	// exactly as green as a working one.
	for (const [prefix, count] of population) {
		if (count === null) {
			findings.push({
				status: 'missing-slice',
				cgroup: prefix,
				why:
					'is declared direct-egress but does not exist under /sys/fs/cgroup. The path ' +
					'moved or was never created, and a policy keyed on it matches nothing.',
			});
		} else if (count === 0) {
			findings.push({
				status: 'empty-slice',
				cgroup: prefix,
				why:
					'is declared direct-egress but the kernel has no process in it. A policy keyed ' +
					'on it would route nothing and still look exactly as green as a working one.',
			});
		}
	}

	// EXAMINED COUNTS APPS, NOT FINDINGS. The first draft summed findings and
	// `ok`, so a slice-level finding — which is not an app — reported 22 apps on a
	// box running 21.
	const examined = apps.length;
	const leaks = ok.filter((o) => o.acceptedLeak);

	const deploying = deferred.filter((d) => d.deferral === 'deploy-in-flight');

	if (JSON_OUT) {
		// `markerFile` IS ADDITIVE. `ci:egress-slices` reads `findings`, `deferred`
		// and `acceptedLeaks` and ignores the rest, so this key costs the consumer
		// nothing — but it is the only place an operator can see that the gate
		// looked for the marker, where, and what it found. Without it a marker
		// written to the wrong directory is invisible: the gate pages, the file
		// exists, and nothing connects the two.
		emitter.emit({
			examined,
			findings,
			acceptedLeaks: leaks,
			deferred,
			// ADDITIVE, exactly as `markerFile` is. `ci:egress-slices` reads
			// `findings`, `deferred` and `acceptedLeaks` and ignores the rest, so this
			// key costs the consumer nothing and needs no cross-repo change — but it
			// is the only place the register's dormant half is visible, and without it
			// `acceptedLeaks` dropping from five to three reads as two leaks closed.
			dormant,
			ok,
			markerFile: markers.report(),
		});
	} else {
		log(`Examined ${examined} PM2 app(s) against manifests/egress-slices.json.\n`);
		for (const [prefix, count] of population)
			log(`  ${(count === null ? 'n/a' : String(count)).padStart(3)} proc(s) in ${prefix}`);
		log('');
		for (const f of findings)
			// `nothing-observed` is about the RUN and names neither an app nor a
			// cgroup, so this line printed the word `undefined` where its subject
			// belongs — on the one finding that means the whole scan is worthless.
			log(
				`  ${f.status.toUpperCase().padEnd(24)} ${f.name ?? f.cgroup ?? '(this run)'}\n    ${f.why}`
			);
		if (deferred.length) {
			log(
				`\n  ${deferred.length} app(s) DEFERRED — not cross-checked on this run, which is NOT a pass:`
			);
			// SAY WHY, per app. A deferral is the one thing here that is reported and
			// not failed, so the reason it was tolerated has to be legible or the
			// operator cannot tell a deploy from a gate that stopped looking.
			for (const d of deferred)
				log(`    [${d.deferral ?? 'unspecified'}] ${d.name} (${d.class}) — ${d.why}`);
		}
		if (leaks.length) {
			log(`\n  ${leaks.length} accepted leak(s) — hokon-local apps receiving fleet egress:`);
			for (const l of leaks) log(`    ${l.name} (${l.class}) — ${l.why}`);
		}
		// PRINTED ON EVERY RUN THAT HAS ONE, and next to the leaks rather than with
		// the deferrals, because this IS the other half of the accepted-leak
		// register: the line above says what is leaking now, this one says what is
		// still on the register and currently not. Silence here is the register
		// quietly shrinking.
		if (dormant.length) {
			log(
				`\n  ${dormant.length} dormant — on the accepted-leak register, not running, and not ` +
					`this gate's subject while down:`
			);
			for (const d of dormant)
				log(`    ${d.name} (${d.class}) — PM2 reports "${d.pm2Status}". ${d.registeredWhy ?? ''}`);
		}
		// Only once something asked. A box with nothing moving never opens the file,
		// and printing "unread" on every clean run would be noise that trains the
		// operator to skip the line that matters during a deploy.
		if (markers.consulted()) {
			const m = markers.report();
			log(
				`\n  deploy markers: ${m.path} — ${m.status}` +
					`${m.reason ? ` (${m.reason})` : ''}` +
					`${m.status === 'ok' ? `, ${m.entries} entr(ies), honoured for up to ${Math.round(m.staleAfterMs / 60_000)} min` : ''}`
			);
		}
		// THE GREEN LINE MUST NOT COVER A PARTIAL SCAN. "No findings" and "every app
		// was checked" were the same sentence until issue #31 gave the gate a second
		// way to skip an app — and a deferral that reads as green is a deferral that
		// has quietly become a pass.
		if (!findings.length)
			log(
				deferred.length
					? `\nNo findings — but ${deferred.length} of ${examined} app(s) were DEFERRED` +
							`${deploying.length ? ` (${deploying.length} mid-deploy)` : ''}` +
							`${dormant.length ? ` and ${dormant.length} dormant` : ''} and not ` +
							'cross-checked. That is a partial scan, not a clean box; the next tick re-reads them.'
					: dormant.length
						? // A DORMANT APP IS NOT A PARTIAL SCAN, and must not borrow that
							// sentence: nothing is pending and the next tick re-reads nothing.
							// Every app WAS classified — the claim the green line makes — and
							// what is missing is an egress observation for apps that have no
							// egress. Said plainly rather than either hidden or dressed up as
							// a deferral.
							`\nEvery PM2 app is classified, and every direct-egress cgroup is populated. ` +
							`${dormant.length} app(s) are dormant: on the accepted-leak register, not ` +
							'running, and cross-checked again whenever the operator starts them.'
						: '\nEvery PM2 app is classified, and every direct-egress cgroup is populated.'
			);
	}
	process.exit(findings.length ? 1 : 0);
}

main();
