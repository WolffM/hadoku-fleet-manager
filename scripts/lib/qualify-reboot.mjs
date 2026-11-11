/**
 * `reboot-requalify` — reboot the node inside its qualification window and
 * re-qualify what must survive a reboot (wave bootcamp2 Q3).
 *
 * WHY. Three incidents in the 10-11..11-11 retrospective were only visible
 * after a boot, and the fleet reboots a claw rarely enough that each sat
 * unnoticed for days to weeks:
 *
 *   - claw-5 and claw-6 failed systemd-networkd-wait-online on EVERY boot from
 *     install until 10-27: two minutes added to each boot, a failed unit
 *     nobody turned into a finding for ~8 weeks.
 *   - claw-1 rebooted onto 6.12.113 on 10-25 without its headers, so DKMS
 *     never built nvidia for it, and it went on offering `nvenc-h264` for
 *     hours with no driver.
 *   - hokon's runner PATH lacked `gh` for three days (10-13..10-15). A job's
 *     PATH is the ci user's systemd --user manager environment at unit start,
 *     not a login shell's, so only reading THAT environment sees it.
 *
 * NEVER A TENANT HOST. A node with an active `pm2-*-svc.service` is
 * could-not-look before anything is rebooted; `fleet reboot-claws` owns those.
 *
 * SHAPE. Read the node (`REBOOT_PROBE`, the same read `fleet reboot-claws`
 * takes, so the before/after comparison is `verifyAfter`'s and not a second
 * copy). Schedule `sudo -n systemctl reboot` detached, so the ssh returns
 * before the box goes down. Poll the boot id with short per-call timeouts: an
 * ssh failure while it is down is expected, not a result. On a new boot id,
 * wait for systemd to finish starting and judge:
 *
 *   - zero failed system units                       (FAILED_UNITS_BAR)
 *   - systemd finished starting (a boot still `starting` after SETTLE_SEC is
 *     a hang); the boot TIME is recorded, never judged (operator 11-11)
 *   - an NVIDIA GPU whose driver the node carries or whose capability it earns
 *     has the nvidia module loaded, or DKMS-ready, for the RUNNING kernel
 *   - the ci user's systemd --user manager is running, and its PATH runs
 *     every tool in RUNNER_PATH_TOOLS
 *   - `verifyAfter`: the expected kernel, the reboot flag gone, runner units
 *     and pm2 apps back (they get SERVICES_TIMEOUT_MS to come up, as in the
 *     reboot cycle)
 *
 * NEVER BACK is could-not-look, LOUDLY: the node may be down, and it is still
 * drained by the window, which is the right place for it to stay.
 *
 * A REAL REBOOT. The unit tests drive this against fakes only.
 */
import { ciIsSeparate, nodeHome, nodeUser } from '../../dist/lib/node-users.js';
import {
	BOOT_TIMEOUT_MS,
	REBOOT_PROBE,
	SERVICES_TIMEOUT_MS,
	VERIFY_POLL_MS,
	parseRebootProbe,
	verifyAfter,
} from './reboot-cycle.mjs';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

/*
 * Boot TIME is a metric, not a bar (operator, 2026-11-11: claw-5's 129 s and
 * claw-6's 94 s are firmware/network waits they do not want to chase). Healthy
 * claws boot in 6–19 s, so `metrics.bootSeconds` and the slowest units are
 * still recorded; what a slow boot used to catch that matters (claw-10's
 * smartd on a dead disk) also leaves a failed unit, which FAILED_UNITS_BAR fails.
 */

/** Failed system units allowed after a reboot. claw-5/claw-6 carried one for ~8 weeks. */
export const FAILED_UNITS_BAR = 0;

/** What a job reaches through the runner PATH, run as ci (hokon's gh, 10-13..10-15). */
export const RUNNER_PATH_TOOLS = Object.freeze(['gh', 'node', 'pnpm', 'python3']);

/** Earned capabilities that need the nvidia driver (bootcamp's probe ids). */
export const NVIDIA_CAPABILITY = /^(nvenc|nvdec|cuda)/;

/**
 * Active fleet-hosted pm2 tenant units (`pm2-<app>-svc.service`, system units),
 * read on the node itself. A node carrying one is never rebooted here: the
 * reboot cycle (`fleet reboot-claws`) owns rebooting tenant hosts, with its
 * notice and lease handling. Admin's own `pm2-<user>.service` is not a tenant
 * and does not match. A listing that cannot be read prints no end marker.
 */
export const TENANT_SCRIPT = String.raw`if L=$(systemctl list-units 'pm2-*-svc.service' --state=active --no-legend --no-pager --plain 2>/dev/null); then
  printf '%s\n' "$L" | awk 'NF{print "QR-TENANT " $1}'
  echo QR-TENANTS-END
else echo "QR-TENANTS-ERR systemctl could not list this node's pm2 service units"; fi
`;

/** PURE. The tenant units, or null when the listing could not be read. */
export function parseTenants(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.trim());
	if (!lines.includes('QR-TENANTS-END')) return null;
	return lines.filter((l) => l.startsWith('QR-TENANT ')).map((l) => l.slice('QR-TENANT '.length));
}

/** The one thing polled while the node is down. */
export const BOOT_ID_SCRIPT = 'cat /proc/sys/kernel/random/boot_id\n';
/** One boot-id poll's ssh budget: a box that is down must not eat the window in one call. */
const POLL_TIMEOUT_MS = 20_000;
/** How long the after-boot read waits for systemd to finish starting. */
const SETTLE_SEC = 300;

const errOf = (r) =>
	String(r?.error || r?.stderr || r?.stdout || 'no output')
		.trim()
		.slice(-300);
const round1 = (n) => Math.round(n * 10) / 10;

/** `2min 9.102s`, `945ms`, `1h 2min 3s` → seconds. */
function spanSeconds(s) {
	const unit = { h: 3600, min: 60, s: 1, ms: 1e-3, us: 1e-6 };
	let total = 0;
	let seen = false;
	for (const m of String(s).matchAll(/(\d+(?:\.\d+)?)(h|min|ms|us|s)\b/g)) {
		total += Number(m[1]) * unit[m[2]];
		seen = true;
	}
	return seen ? total : null;
}

/**
 * PURE. `systemd-analyze`'s first line → seconds from kernel start to the
 * default target, and each part; null when the boot has not finished.
 */
export function parseStartup(line) {
	const m = /^Startup finished in (.*?)\s*=\s*.*$/.exec(String(line ?? '').trim());
	if (!m) return null;
	const parts = {};
	for (const seg of m[1].split(' + ')) {
		const p = /^(.*)\((\w+)\)$/.exec(seg.trim());
		const sec = p ? spanSeconds(p[1]) : null;
		if (sec !== null) parts[p[2]] = sec;
	}
	const os = ['kernel', 'initrd', 'userspace'].filter((k) => k in parts);
	if (!('userspace' in parts)) return null;
	const seconds = Math.round(os.reduce((a, k) => a + parts[k], 0) * 1000) / 1000;
	return { seconds, parts };
}

/** The reboot, detached so the ssh returns first. Root is checked before anything is scheduled. */
export function rebootScript(node) {
	const msg =
		`fleet qualify reboot-requalify on ${node}: qualification window, node drained`.replace(
			/[^\w .,:;()/+=@-]/g,
			'_'
		);
	return [
		'sudo -n true 2>/dev/null || { echo SUDO-REFUSED; exit 1; }',
		`nohup sh -c "sleep 2; sudo -n systemctl reboot --message='${msg}'" >/dev/null 2>&1 &`,
		'echo SCHEDULED',
		'',
	].join('\n');
}

/**
 * The after-boot read, run as ADMIN. The ci user's manager is reached the way
 * the docker repair reaches it (toolchain-floor.mjs): `sudo -n -u <ci>` with
 * that user's XDG_RUNTIME_DIR, and only where ci is a separate user. The
 * name comes from node-users, never from here.
 */
export function afterBootScript({ machine }) {
	const ci = nodeUser(machine, 'ci');
	const home = nodeHome(machine, 'ci');
	const as = ciIsSeparate(machine) ? `sudo -n -u ${ci} ` : '';
	// `cd /` first: under `sudo -u` the ci user inherits admin's working
	// directory, which it cannot read, and node-based tools (pnpm) then fail on
	// their own cwd. Measured on claw-1/2/3 2026-11-11 before this line.
	return String.raw`cd /
timeout ${SETTLE_SEC} systemctl is-system-running --wait >/dev/null 2>&1
echo "QR-STATE $(systemctl is-system-running 2>/dev/null)"
if SA=$(systemd-analyze 2>&1); then echo "QR-STARTUP $(printf '%s\n' "$SA" | head -n 1)"
else echo "QR-STARTUP-ERR $(printf '%s\n' "$SA" | head -n 1)"; fi
systemd-analyze blame --no-pager 2>/dev/null | head -n 3 | sed 's/^ */QR-BLAME /'
if FU=$(systemctl list-units --state=failed --no-legend --no-pager --plain 2>/dev/null); then
  echo "QR-FAILED-COUNT $(printf '%s\n' "$FU" | grep -c .)"
  printf '%s\n' "$FU" | awk 'NF{print "QR-FAILED " $1}'
else echo "QR-FAILED-ERR systemctl could not list this node's units"; fi
LSPCI=$(command -v lspci || echo /usr/bin/lspci)
if PCI=$("$LSPCI" -n 2>/dev/null); then
  echo "QR-GPU $(printf '%s\n' "$PCI" | awk '$2 ~ /^03/ && $3 ~ /^10de:/' | grep -c .)"
else echo "QR-GPU-ERR lspci could not list PCI devices"; fi
echo "QR-NV-DKMS $(ls -d /var/lib/dkms/nvidia* 2>/dev/null | grep -c .)"
if grep -q '^nvidia ' /proc/modules; then echo "QR-NV-LOADED yes"; else echo "QR-NV-LOADED no"; fi
if ! uid=$(id -u ${ci} 2>/dev/null); then echo "QR-CI-UID-ERR the ci user ${ci} does not exist"
else
  echo "QR-CI-MGR $(systemctl is-active "user@$uid.service" 2>/dev/null)"
  JP=$(${as}env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user show-environment 2>/dev/null | sed -n 's/^PATH=//p')
  if [ -z "$JP" ]; then echo "QR-CI-PATH-ERR the ci user's systemd manager gave no PATH"
  else
    echo "QR-CI-PATH $JP"
    for t in ${RUNNER_PATH_TOOLS.join(' ')}; do
      if ${as}env -i HOME=${home} PATH="$JP" "$t" --version >/dev/null 2>&1; then echo "QR-CI-TOOL $t OK"
      else echo "QR-CI-TOOL $t MISSING"; fi
    done
  fi
fi
echo QR-END
`;
}

/** PURE. The after-boot read's lines. A read without `QR-END` is `complete: false`. */
export function parseAfterBoot(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.replace(/\s+$/, ''));
	const get = (tag) => {
		const l = lines.find((x) => x === tag || x.startsWith(`${tag} `));
		return l === undefined ? null : l.slice(tag.length + 1).trim();
	};
	const all = (tag) =>
		lines.filter((x) => x.startsWith(`${tag} `)).map((x) => x.slice(tag.length + 1).trim());
	const num = (tag) => {
		const v = get(tag);
		return v !== null && /^\d+$/.test(v) ? Number(v) : null;
	};
	const tools = {};
	for (const t of all('QR-CI-TOOL')) {
		const [name, verdict] = t.split(/\s+/);
		tools[name] = verdict === 'OK';
	}
	return {
		complete: lines.includes('QR-END'),
		state: get('QR-STATE'),
		startupLine: get('QR-STARTUP'),
		startupErr: get('QR-STARTUP-ERR'),
		blame: all('QR-BLAME'),
		failedCount: num('QR-FAILED-COUNT'),
		failed: all('QR-FAILED'),
		failedErr: get('QR-FAILED-ERR'),
		gpu: num('QR-GPU'),
		gpuErr: get('QR-GPU-ERR'),
		nvDkms: num('QR-NV-DKMS'),
		nvLoaded: get('QR-NV-LOADED') === 'yes',
		ciUidErr: get('QR-CI-UID-ERR'),
		ciMgr: get('QR-CI-MGR'),
		ciPath: get('QR-CI-PATH'),
		ciPathErr: get('QR-CI-PATH-ERR'),
		tools,
	};
}

/**
 * PURE. What the after-boot read says, as crossed bars (`fails`) and things
 * that could not be read (`unknown`).
 *
 * @param {object} a
 * @param {ReturnType<typeof parseAfterBoot>} a.qr
 * @param {ReturnType<typeof parseRebootProbe>} a.rp REBOOT_PROBE after the boot
 * @param {ReturnType<typeof parseRebootProbe>} a.before REBOOT_PROBE before it
 * @param {object} a.machine the manifest entry
 */
export function judgeAfterBoot({ qr, rp, before, machine }) {
	const fails = [];
	const unknown = [];
	if (!qr.complete) unknown.push('the after-boot read ended before its end marker');

	const startup = parseStartup(qr.startupLine);
	if (!startup && (qr.state === 'starting' || /not yet finished/i.test(qr.startupErr ?? '')))
		fails.push(
			`boot had not finished ${SETTLE_SEC} s after ssh answered (state ${qr.state ?? 'unknown'})`
		);

	if (qr.failedCount === null) unknown.push(qr.failedErr ?? 'failed units unreadable');
	else if (qr.failedCount > FAILED_UNITS_BAR)
		fails.push(
			`${qr.failedCount} failed system unit(s) after the reboot: ${qr.failed.join(', ')} (bar ${FAILED_UNITS_BAR})`
		);

	const earned = (machine?.$capabilities?.earned ?? []).filter((c) => NVIDIA_CAPABILITY.test(c));
	let nvidia = 'no NVIDIA GPU';
	if (qr.gpu === null) unknown.push(qr.gpuErr ?? 'lspci printed nothing');
	else if (qr.gpu > 0) {
		const needs = [
			...(qr.nvDkms > 0 ? ['the nvidia driver is installed (DKMS)'] : []),
			...(earned.length ? [`it earns ${earned.join(', ')}`] : []),
		];
		const ready = new Set([...(rp?.dkmsLoaded ?? []), ...(rp?.dkmsReady ?? [])]);
		const up = qr.nvLoaded || ready.has('nvidia');
		if (!needs.length)
			nvidia = 'NVIDIA GPU, no NVIDIA driver installed and no NVIDIA capability earned';
		else if (up)
			nvidia = `nvidia ${qr.nvLoaded ? 'loaded' : 'ready'} for ${rp?.running ?? 'the running kernel'}`;
		else
			fails.push(
				`NVIDIA GPU present and ${needs.join(' and ')}, but no nvidia module is loaded or built for the running kernel ${rp?.running ?? '(unknown)'}`
			);
	}

	if (qr.ciUidErr) fails.push(qr.ciUidErr);
	else if (qr.ciMgr !== 'active')
		fails.push(
			`the ci user's systemd --user manager is ${qr.ciMgr || 'not running'} after the reboot`
		);
	else if (qr.ciPathErr) unknown.push(qr.ciPathErr);
	else {
		const missing = RUNNER_PATH_TOOLS.filter((t) => qr.tools[t] !== true);
		if (missing.length)
			fails.push(`the runner PATH (${qr.ciPath}) does not run ${missing.join(', ')} as ci`);
	}

	if (!rp?.ok) unknown.push(`the reboot probe after boot: ${rp?.reason ?? 'no answer'}`);
	else fails.push(...verifyAfter(before, rp));

	return {
		fails,
		unknown,
		nvidia,
		metrics: {
			bootSeconds: startup?.seconds ?? null,
			slowest: qr.blame,
			startup: startup?.parts ?? null,
			failedUnits: qr.failedCount,
			failed: qr.failed,
			gpu: qr.gpu,
			nvidia,
			ciPath: qr.ciPath,
			tools: qr.tools,
			kernel: { from: before?.running ?? null, to: rp?.running ?? null },
		},
	};
}

/**
 * The test, with its clock injectable for tests.
 *
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number }} [o]
 */
export function makeRebootTest({
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	now = () => Date.now(),
} = {}) {
	return {
		id: 'reboot-requalify',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		// The boot wait and the services wait, plus the reads either side.
		minutes: Math.ceil((BOOT_TIMEOUT_MS + SERVICES_TIMEOUT_MS) / 60_000) + 7,
		async run(ctx) {
			const cnl = (reason, metrics = {}) => ({ status: 'could-not-look', reason, metrics });
			// TENANT HOSTS FIRST, before anything is rebooted (coordinator, 2026-11-11).
			const ten = await ctx.exec(TENANT_SCRIPT, { timeoutMs: 60_000 });
			const tenants = parseTenants(ten.stdout);
			if (tenants === null)
				return cnl(
					`could not list ${ctx.node}'s pm2 service units, so it was not rebooted: ` +
						(/^QR-TENANTS-ERR (.*)$/m.exec(ten.stdout ?? '')?.[1] ?? errOf(ten))
				);
			if (tenants.length)
				return cnl(
					`${ctx.node} hosts pm2 service tenant(s) ${tenants.join(', ')}, so it was not rebooted: ` +
						'the reboot cycle (fleet reboot-claws) owns rebooting tenant hosts',
					{ tenants }
				);
			const pre = await ctx.exec(REBOOT_PROBE, { timeoutMs: 60_000 });
			const before = pre.ok ? parseRebootProbe(pre.stdout) : { ok: false, reason: errOf(pre) };
			if (!before.ok)
				return cnl(
					`could not read the node before rebooting, so it was not rebooted: ${before.reason}`
				);

			// Throws on a malformed users.ci before anything is rebooted.
			const readScript = `${afterBootScript({ machine: ctx.machine })}${REBOOT_PROBE}`;

			const sched = await ctx.exec(rebootScript(ctx.node), { timeoutMs: 30_000 });
			if (/SUDO-REFUSED/.test(sched.stdout ?? ''))
				return cnl("admin's sudo -n was refused, so nothing was rebooted");
			if (!/SCHEDULED/.test(sched.stdout ?? ''))
				return cnl(`the reboot was not scheduled: ${errOf(sched)}`);
			const rebootAt = now();
			ctx.log(`   reboot scheduled on ${ctx.node} (boot id ${before.bootId})`);

			let bootId = null;
			let last = 'no answer yet';
			let sawDown = false;
			while (now() - rebootAt < BOOT_TIMEOUT_MS) {
				await sleep(VERIFY_POLL_MS);
				const b = await ctx.exec(BOOT_ID_SCRIPT, { timeoutMs: POLL_TIMEOUT_MS });
				const id = b.ok ? String(b.stdout).trim() : '';
				if (b.ok && /^[0-9a-f-]{36}$/.test(id) && id !== before.bootId) {
					bootId = id;
					break;
				}
				if (b.ok)
					last =
						id === before.bootId
							? 'reachable, same boot id'
							: `answered ${JSON.stringify(id.slice(0, 60))}`;
				else {
					sawDown = true;
					last = errOf(b);
				}
			}
			const downSec = Math.round((now() - rebootAt) / 1000);
			if (!bootId) {
				const min = BOOT_TIMEOUT_MS / 60_000;
				return cnl(
					sawDown
						? `NODE MAY BE DOWN: ${ctx.node} was rebooted and has not answered on a new boot within ${min} min (last: ${last}). It stays drained by the window; look at its console.`
						: `${ctx.node} never rebooted: it answered on the same boot id for ${min} min after \`systemctl reboot\` was scheduled`,
					{ downSec }
				);
			}
			ctx.log(`   ${ctx.node} back on boot ${bootId} after ${downSec} s`);

			// Runner units and pm2 come up after sshd: give them the cycle's window.
			const upAt = now();
			let j = null;
			for (;;) {
				const r = await ctx.exec(readScript, { timeoutMs: (SETTLE_SEC + 120) * 1000 });
				const qr = parseAfterBoot(r.stdout);
				const rp = parseRebootProbe(r.stdout);
				j = judgeAfterBoot({ qr, rp, before, machine: ctx.machine });
				if (!r.ok && !qr.complete) j.unknown.push(`the after-boot read failed: ${errOf(r)}`);
				const settled = !j.fails.length && !j.unknown.length;
				if (settled || now() - upAt >= SERVICES_TIMEOUT_MS) break;
				await sleep(VERIFY_POLL_MS);
			}
			const metrics = { ...j.metrics, downSec, bootId };
			if (j.fails.length)
				return { status: 'fail', reason: [...j.fails, ...j.unknown].join('; '), metrics };
			if (j.unknown.length) return cnl(j.unknown.join('; '), metrics);
			return {
				status: 'pass',
				reason:
					`rebooted ${before.running} -> ${j.metrics.kernel.to}, back in ${downSec} s; ` +
					`booted in ${j.metrics.bootSeconds === null ? 'unknown' : `${round1(j.metrics.bootSeconds)} s`}, 0 failed units, ` +
					`${j.nvidia}; the runner PATH runs ${RUNNER_PATH_TOOLS.join(', ')} as ci`,
				metrics,
			};
		},
	};
}

export const test = makeRebootTest();
