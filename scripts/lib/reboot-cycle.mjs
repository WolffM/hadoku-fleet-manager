/**
 * reboot-cycle — reboot ONE claw that needs it, safely, and prove it came back.
 *
 * WHY. Unattended-upgrades installs security updates with Automatic-Reboot
 * false, deliberately: a node that reboots itself mid-job turns a security
 * update into a CI failure with no visible cause. That left nothing that
 * reboots a claw at all — on 2026-10-25 every claw was still on its boot
 * kernel, most up since 2026-09-01..09-07, and the kernel updates that
 * started installing that day would have sat staged forever. preflight's
 * `pending-reboot` finding SAID so; nothing acted on it.
 *
 * SHAPE (one pass, at most one node):
 *
 *   resume     a reboot a previous pass started and did not finish (mgmt-api
 *              restarts many times a day) is verified first, and nothing new
 *              starts in the same pass
 *   probe      every claw: boot id, running vs newest installed kernel,
 *              /var/run/reboot-required, runner units, pm2 apps
 *   pick       a claw that needs it and that NOBODY ELSE holds: not drained
 *              by anyone, no drain planned on it. The least busy first.
 *   drain      a LEASE that lapses by itself (REBOOT_LEASE_MS), so a cycle
 *              that dies outright gives the node back on the clock
 *   wait       until zero jobs have held for the settle window (the same
 *              `waitUntilDrained` the toolchain cadence uses); a timeout
 *              undrains and reboots nothing
 *   reboot     re-probed first: still needs it, still idle, boot id taken
 *   verify     a NEW boot id, the expected kernel running, the flag gone,
 *              every enabled runner unit active, every pm2 app that was
 *              online before online again
 *   undrain    only what this cycle drained (the record's reason says so)
 *
 * A node that fails verification STAYS OUT: it is re-held as `maintenance`, a
 * human lifts it, and the cycle halts. The controller pages on that.
 *
 * NEVER A GUEST, NEVER THIS BOX. hokon is a guest (the operator's rule: no
 * routine automation there) and is also where this runs; both are refused by
 * role AND by `isLocalNode`, before any dependency is called for it.
 *
 * Every side effect is an injected dependency, so the safety properties are
 * tested against fixtures (reboot-cycle.test.mjs) and never against a claw.
 */

/** Every drain this cycle writes starts with this, and it undoes only those. */
export const REASON_PREFIX = 'automated reboot';
/** The drain is a lease: if the cycle dies outright, the node comes back by itself. */
export const REBOOT_LEASE = '2h';
/** From the reboot command to a reachable node on a new boot id. */
export const BOOT_TIMEOUT_MS = 12 * 60_000;
/** From a new boot to every runner unit and pm2 app back. */
export const SERVICES_TIMEOUT_MS = 6 * 60_000;
export const VERIFY_POLL_MS = 15_000;

const END = 'END reboot-probe';

/**
 * The node half. Read-only and unprivileged. `NEWEST` is the highest
 * `/boot/vmlinuz-*` by version sort, which is what GRUB's default entry boots
 * on these images; a node that boots something else fails verification and is
 * held, which is the right outcome for a box whose boot order nobody declared.
 */
export const REBOOT_PROBE = `set -u
echo "BOOTID $(cat /proc/sys/kernel/random/boot_id)"
echo "RUNNING $(uname -r)"
echo "NEWEST $(ls /boot/vmlinuz-* 2>/dev/null | sed 's|^/boot/vmlinuz-||' | sort -V | tail -n 1)"
if [ -f /var/run/reboot-required ]; then echo "FLAG REQUIRED"; else echo "FLAG CLEAN"; fi
echo "PKGS $(cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\\n' ' ')"
echo "BUSY $(pgrep -c -f '[R]unner\\.Worker' || true)"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
en=$(systemctl --user list-unit-files 'actions-runner-*.service' --state=enabled --no-legend 2>/dev/null | awk '{print $1}' | sort)
act=$(systemctl --user list-units 'actions-runner-*.service' --state=active --no-legend --plain 2>/dev/null | awk '{print $1}' | sort)
echo "UNITS-ENABLED $(echo $en)"
echo "UNITS-ACTIVE $(echo $act)"
if command -v pm2 >/dev/null 2>&1; then
	echo "PM2 $(pm2 jlist 2>/dev/null | python3 -c 'import json,sys
try:
    print(" ".join(sorted(p["name"] for p in json.load(sys.stdin) if p.get("pm2_env",{}).get("status")=="online")))
except Exception:
    print("UNREADABLE")' 2>/dev/null)"
else
	echo "PM2 NONE"
fi
echo "${END}"
`;

const words = (s) =>
	String(s ?? '')
		.split(/\s+/)
		.filter(Boolean);

/** The probe's answer, or `{ ok: false, reason }`. Cut off before its end marker is "could not look". */
export function parseRebootProbe(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.replace(/\s+$/, ''));
	if (!lines.includes(END))
		return { ok: false, reason: 'probe output ended before its end marker' };
	const get = (tag) => {
		const l = lines.find((x) => x === tag || x.startsWith(`${tag} `));
		return l === undefined ? null : l.slice(tag.length + 1).trim();
	};
	const bootId = get('BOOTID');
	const running = get('RUNNING');
	if (!bootId || !running) return { ok: false, reason: 'probe printed no boot id or kernel' };
	const pm2 = get('PM2');
	return {
		ok: true,
		bootId,
		running,
		newest: get('NEWEST') || null,
		flag: get('FLAG') === 'REQUIRED',
		packages: words(get('PKGS')),
		busy: /^\d+$/.test(get('BUSY') ?? '') ? Number(get('BUSY')) : null,
		unitsEnabled: words(get('UNITS-ENABLED')),
		unitsActive: words(get('UNITS-ACTIVE')),
		// null: no pm2 on the node. 'unreadable': pm2 is there and would not say.
		pm2: pm2 === 'NONE' ? null : pm2 === 'UNREADABLE' || pm2 === null ? 'unreadable' : words(pm2),
	};
}

/** Why this node needs a reboot, or null. */
export function rebootReason(p) {
	const why = [];
	if (p.newest && p.newest !== p.running)
		why.push(`running ${p.running}, newest installed ${p.newest}`);
	if (p.flag) {
		why.push(`/var/run/reboot-required${p.packages.length ? ` (${p.packages.join(', ')})` : ''}`);
	}
	return why.length ? why.join('; ') : null;
}

/**
 * What is still wrong with a node after its reboot, against what was true
 * before it. Empty means it came back whole. `before` is the probe taken
 * immediately before the reboot command.
 */
export function verifyAfter(before, after) {
	const problems = [];
	if (after.bootId === before.bootId)
		problems.push('the boot id did not change: it never rebooted');
	const expected = before.newest ?? before.running;
	if (after.running !== expected) problems.push(`booted ${after.running}, expected ${expected}`);
	if (after.flag) problems.push('/var/run/reboot-required is still set after the reboot');
	const down = after.unitsEnabled.filter((u) => !after.unitsActive.includes(u));
	if (down.length) problems.push(`runner unit(s) not active: ${down.join(', ')}`);
	const lost = before.unitsEnabled.filter((u) => !after.unitsEnabled.includes(u));
	if (lost.length) problems.push(`runner unit(s) no longer enabled: ${lost.join(', ')}`);
	if (Array.isArray(before.pm2)) {
		if (!Array.isArray(after.pm2)) problems.push(`pm2 is ${after.pm2 ?? 'gone'} after the reboot`);
		else {
			const missing = before.pm2.filter((a) => !after.pm2.includes(a));
			if (missing.length) problems.push(`pm2 app(s) not back online: ${missing.join(', ')}`);
		}
	}
	return problems;
}

const errText = (e) => (e instanceof Error ? e.message : String(e));
async function attempt(fn) {
	try {
		return { ok: true, value: await fn() };
	} catch (e) {
		return { ok: false, reason: errText(e) };
	}
}

/** Is the node's CURRENT drain record this cycle's own? */
export function oursOn(doc, node) {
	return String(doc?.nodes?.[node]?.reason ?? '').startsWith(REASON_PREFIX);
}

/**
 * One pass.
 *
 * @param {object} p
 * @param {Array<[string, object]>} p.machines  manifest `[name, entry]` pairs
 * @param {object} p.deps  isGuest, isLocal, probe, expectedDown, drainDoc, drain, hold, undrain,
 *                         waitDrained, queuePressure, reboot, sleep, now,
 *                         readState, writeState
 * @param {boolean} [p.plan]  probe and pick only; drain and reboot nothing
 * @param {string|null} [p.only]  restrict the pick to this node
 * @param {(line: string) => void} [p.log]
 */
export async function runRebootCycle({
	machines,
	deps,
	plan = false,
	only = null,
	log = () => {},
}) {
	const nodes = [];
	const findings = [];
	const finding = (node, kind, reason) => findings.push({ node, kind, reason });
	const state = { inFlight: null, last: {}, ...(deps.readState() ?? {}) };
	const save = () => deps.writeState(state);
	const done = (extra = {}) => ({
		ok: findings.length === 0,
		plan,
		nodes,
		findings,
		rebooted: nodes.filter((n) => n.status === 'rebooted').map((n) => n.node),
		...extra,
	});

	// RESUME. A reboot in flight is finished before anything new starts.
	if (state.inFlight) {
		const f = state.inFlight;
		if (plan) {
			log(`── ${f.node}  [in flight: ${f.phase}] a previous pass has not finished it`);
			nodes.push({ node: f.node, status: 'in-flight', phase: f.phase });
			return done();
		}
		log(`── ${f.node}  [resuming: ${f.phase}]`);
		const rec = { node: f.node, resumed: true, reason: f.reason };
		nodes.push(rec);
		if (f.phase === 'draining') {
			// Drained, never rebooted. Put it back and stop; the next pass starts over.
			await putBack(f.node, rec, deps, finding, log);
			rec.status = 'abandoned';
		} else {
			await verifyAndReturn(f.node, f.before, f.rebootAt, rec, deps, finding, log, state);
		}
		state.inFlight = null;
		save();
		return done();
	}

	// PROBE every claw this cycle may touch.
	const doc = deps.drainDoc();
	const candidates = [];
	for (const [name, entry] of machines) {
		if (only && name !== only) continue;
		if (deps.isGuest(entry) || deps.isLocal(name)) {
			log(`── ${name}  [skipped: ${deps.isGuest(entry) ? 'guest' : 'this box'}]`);
			nodes.push({ node: name, status: 'skipped', why: deps.isGuest(entry) ? 'guest' : 'local' });
			continue;
		}
		const p = await attempt(() => deps.probe(name));
		const probe = p.ok ? p.value : { ok: false, reason: p.reason };
		if (!probe.ok && deps.expectedDown?.(name)) {
			// Somebody took it out for maintenance: unreachable is what they expect.
			log(`── ${name}  [expected down] ${probe.reason}`);
			nodes.push({ node: name, status: 'expected-down', reason: probe.reason });
			continue;
		}
		if (!probe.ok) {
			log(`── ${name}  [UNREADABLE] ${probe.reason}`);
			nodes.push({ node: name, status: 'unreadable', reason: probe.reason });
			finding(name, 'unreadable', probe.reason);
			continue;
		}
		const why = rebootReason(probe);
		if (!why) {
			log(`── ${name}  [current] ${probe.running}`);
			nodes.push({ node: name, status: 'current', kernel: probe.running });
			continue;
		}
		const held = doc.nodes?.[name];
		const planned = (doc.planned ?? []).find((d) => d.node === name);
		if (held || planned) {
			const by = held
				? `drained (${held.kind ?? 'maintenance'}: ${held.reason})`
				: `a drain is planned for ${planned.from}`;
			log(`── ${name}  [deferred] needs a reboot (${why}), but ${by}; not ours to touch`);
			nodes.push({
				node: name,
				status: 'deferred',
				reason: why,
				why: `held by someone else: ${by}`,
			});
			continue;
		}
		// A SERVICE HOST IS NOT A CI NODE TO CYCLE. Draining stops CI, not pm2, so
		// rebooting one takes its services down with it — and on 2026-10-25 the
		// only copy of pygmalion's state lived on claw-4. Read from the node's
		// own pm2, not from a placement file: what is RUNNING is what goes down.
		// An unreadable pm2 is "could not look", which is held, never "none".
		// Until a service has a standby to move to first, a human reboots it.
		if (probe.pm2 === 'unreadable' || (Array.isArray(probe.pm2) && probe.pm2.length)) {
			const serves =
				probe.pm2 === 'unreadable'
					? 'its pm2 could not be read'
					: `it serves ${probe.pm2.join(', ')} under pm2 with no standby`;
			log(`── ${name}  [deferred] needs a reboot (${why}), but ${serves}; reboot it by hand`);
			nodes.push({ node: name, status: 'deferred', reason: why, why: `service host: ${serves}` });
			continue;
		}
		candidates.push({ name, probe, why });
	}

	if (!candidates.length) return done();
	// The least busy first: the shortest drain wait, and the fewest jobs moved.
	candidates.sort((a, b) => (a.probe.busy ?? Infinity) - (b.probe.busy ?? Infinity));
	const [pick, ...rest] = candidates;
	for (const c of rest) {
		log(`── ${c.name}  [deferred] needs a reboot (${c.why}); one node per pass`);
		nodes.push({ node: c.name, status: 'deferred', reason: c.why, why: 'one node per pass' });
	}
	const rec = { node: pick.name, reason: pick.why };
	nodes.push(rec);
	if (plan) {
		rec.status = 'planned';
		log(`── ${pick.name}  [would reboot] ${pick.why}`);
		return done();
	}

	const pressure = await attempt(() => deps.queuePressure());
	const pr = pressure.ok
		? pressure.value
		: { pressured: true, unknown: true, reason: pressure.reason };
	if (pr.pressured) {
		rec.status = 'deferred';
		rec.why = pr.unknown
			? `could not read the queue: ${pr.reason}`
			: `queue under pressure: ${pr.reason}`;
		if (pr.unknown) finding(pick.name, 'queue-unreadable', rec.why);
		log(`── ${pick.name}  [deferred] ${rec.why}`);
		return done();
	}

	// DRAIN, as a lease. From here every path ends in undrain, or hold-and-halt.
	const reason = `${REASON_PREFIX}: ${pick.why}`.slice(0, 300);
	const d = await attempt(() => deps.drain(pick.name, reason));
	if (!d.ok || d.value?.ok === false) {
		rec.status = 'finding';
		finding(pick.name, 'drain-failed', d.ok ? d.value.reason : d.reason);
		if (oursOn(deps.drainDoc(), pick.name)) await putBack(pick.name, rec, deps, finding, log);
		return done();
	}
	state.inFlight = { node: pick.name, phase: 'draining', reason: pick.why, since: iso(deps.now()) };
	save();

	const w = await attempt(() => deps.waitDrained(pick.name));
	if (!w.ok || !w.value?.drained) {
		rec.status = 'deferred';
		rec.why = `never went idle: ${w.ok ? w.value?.reason : w.reason}; nothing was rebooted`;
		log(`── ${pick.name}  [deferred] ${rec.why}`);
		await putBack(pick.name, rec, deps, finding, log);
		state.inFlight = null;
		save();
		return done();
	}

	// RE-PROBE at the last moment: the reason may have gone, and a job may have landed.
	const again = await attempt(() => deps.probe(pick.name));
	const before = again.ok ? again.value : { ok: false, reason: again.reason };
	if (!before.ok || before.busy !== 0 || !rebootReason(before)) {
		rec.status = before.ok && !rebootReason(before) ? 'current' : 'deferred';
		rec.why = !before.ok
			? `could not re-read it before the reboot: ${before.reason}`
			: before.busy !== 0
				? `${before.busy ?? 'an unknown number of'} job(s) running at the last check; nothing was rebooted`
				: 'no longer needs a reboot';
		log(`── ${pick.name}  [${rec.status}] ${rec.why}`);
		await putBack(pick.name, rec, deps, finding, log);
		state.inFlight = null;
		save();
		return done();
	}

	const rebootAt = deps.now();
	state.inFlight = { ...state.inFlight, phase: 'rebooting', before, rebootAt };
	save();
	log(`── ${pick.name}  [rebooting] ${pick.why}`);
	const r = await attempt(() => deps.reboot(pick.name));
	if (!r.ok || r.value?.ok === false) {
		// Not conclusive: an ssh cut by the reboot itself looks like this. The
		// boot id decides.
		log(`   reboot command reported: ${r.ok ? r.value.reason : r.reason} (the boot id decides)`);
	}
	await verifyAndReturn(pick.name, before, rebootAt, rec, deps, finding, log, state);
	state.inFlight = null;
	save();
	return done();
}

const iso = (ms) => new Date(ms).toISOString();

/** Poll until the node is back on a new boot with everything up, then undrain — or hold. */
async function verifyAndReturn(node, before, rebootAt, rec, deps, finding, log, state) {
	let after = null;
	let last = 'no answer yet';
	// Probe BEFORE judging the clock: a pass resuming long after the reboot
	// (mgmt-api restarted mid-cycle) must look once, not time out unseen.
	for (;;) {
		await deps.sleep(VERIFY_POLL_MS);
		const p = await attempt(() => deps.probe(node));
		const v = p.ok ? p.value : { ok: false, reason: p.reason };
		if (v.ok && v.bootId !== before.bootId) {
			after = v;
			break;
		}
		last = v.ok ? 'reachable, same boot id' : v.reason;
		if (deps.now() - rebootAt >= BOOT_TIMEOUT_MS) break;
	}
	if (!after) {
		return hold(
			node,
			rec,
			deps,
			finding,
			log,
			`not back on a new boot after ${BOOT_TIMEOUT_MS / 60_000} min (${last})`
		);
	}
	let problems = verifyAfter(before, after);
	const booted = deps.now();
	// Runner units and pm2 come up after sshd; give them their window.
	while (problems.length && deps.now() - booted < SERVICES_TIMEOUT_MS) {
		await deps.sleep(VERIFY_POLL_MS);
		const p = await attempt(() => deps.probe(node));
		if (p.ok && p.value.ok) {
			after = p.value;
			problems = verifyAfter(before, after);
		}
	}
	if (problems.length) return hold(node, rec, deps, finding, log, problems.join('; '));
	rec.kernel = { from: before.running, to: after.running };
	await putBack(node, rec, deps, finding, log);
	rec.status = rec.undrained ? 'rebooted' : 'finding';
	if (rec.undrained) {
		state.last[node] = iso(deps.now());
		log(
			`── ${node}  [rebooted] ${before.running} -> ${after.running}, runners and services back, undrained`
		);
	}
}

async function hold(node, rec, deps, finding, log, why) {
	rec.status = 'held';
	rec.why = why;
	finding(node, 'verify-failed', `${why}. The node STAYS DRAINED — a human puts it back.`);
	const h = await attempt(() =>
		deps.hold(node, `${REASON_PREFIX} FAILED verification: ${why}`.slice(0, 300))
	);
	if (!h.ok || h.value?.ok === false) {
		finding(
			node,
			'hold-failed',
			`could not re-hold it as maintenance: ${h.ok ? h.value.reason : h.reason}`
		);
	}
	log(`── ${node}  [HELD] ${why}`);
}

/** Undrain — only a drain that is still this cycle's own. */
async function putBack(node, rec, deps, finding, log) {
	if (!oursOn(deps.drainDoc(), node)) {
		rec.undrained = false;
		log(`   ${node}'s drain is no longer this cycle's; left as it is`);
		return;
	}
	const u = await attempt(() => deps.undrain(node));
	if (!u.ok || u.value?.ok === false) {
		rec.undrained = false;
		finding(
			node,
			'undrain-failed',
			`the node is STILL DRAINED: ${u.ok ? u.value.reason : u.reason}`
		);
		log(`── ${node}  [FINDING] undrain failed`);
		return;
	}
	rec.undrained = true;
}
