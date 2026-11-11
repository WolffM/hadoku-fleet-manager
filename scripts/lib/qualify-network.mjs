/**
 * `network-soak` — ten minutes of PASSIVELY watching a node's network
 * (wave bootcamp2 Q4).
 *
 * PASSIVE IS THE WHOLE DESIGN. The operator ruled out a link-loss test
 * ("not doing a cable pull ever", 2026-11-11), so nothing in this module downs,
 * flaps or reconfigures an interface, a route, a resolver or a service. It
 * reads `ip`, `getent` and one HTTPS fetch, and that is all.
 *
 * Every 60 s for 10 minutes the node records:
 *
 *   - name resolution of github.com, api.github.com and the data endpoint's
 *     host (`getent ahosts`, the resolver every job uses). ANY failure fails.
 *     On 10-16 claw-9 (and claw-4) lost public DNS for two hours while ssh
 *     kept working — dhcpcd and Tailscale racing on resolv.conf — so every
 *     gate read the node as healthy while every job on it failed.
 *   - HTTPS to https://github.com, three fetches a sample, judged on failures
 *     and p95 time_total. NOT the REST API: unauthenticated API calls share
 *     the house's one public IP at 60 an hour.
 *   - on a DUAL-HOMED node (a wired and a wireless interface both holding an
 *     address), the wired interface keeps its IPv4 address and the default
 *     route for the whole soak. claw-8 on 10-31 lost its wired lease for two
 *     hours through ARP flux (wired and wifi on one subnet) and kept running
 *     on the radio. A single-homed node is judged on DNS and HTTPS only, and
 *     the result says so.
 *   - the DHCP lease's remaining time, from the kernel's `valid_lft` on the
 *     address (no root needed). A renewal rarely falls inside ten minutes;
 *     one that does is reported, and one that does not is never a pass.
 *
 * ONE NODE-SIDE LOOP, NOT ELEVEN SSH ROUND-TRIPS. The loop is started once,
 * detached (setsid), bounded by `timeout`, and writes only into its own
 * mktemp directory. A soak whose evidence travelled over one long ssh session
 * would lose all of it to the very blip it exists to catch; this one is read
 * back by short polls, so a dropped poll costs a poll, not the soak.
 */
import { INTERFACE_PROBE, parseInterfaces } from './node-interfaces.mjs';
import { dataEndpointUrl } from './probe-script.mjs';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

/** Samples in a soak: t = 0, 60, …, 600 s, so the window spans the full ten minutes. */
export const SOAK_SAMPLES = 11;
/** Seconds between samples. */
export const SAMPLE_EVERY_SEC = 60;
/** HTTPS fetches per sample: 33 in a soak, so p95 is the second-worst rather than the worst. */
export const HTTPS_PER_SAMPLE = 3;
/** The page fetched. The HTML front page, not the REST API (60/hour per public IP, shared). */
export const HTTPS_URL = 'https://github.com';
/** Names resolved every sample, beside the data endpoint's host. */
export const DNS_HOSTS = Object.freeze(['github.com', 'api.github.com']);

/**
 * The bars. Measured 2026-11-11 from every claw as `ci`, 40 fetches each of
 * https://github.com (10 back to back, then 30 at 2 s):
 *
 *   wired  claw-4 p95 0.20 s, claw-5 0.23, claw-6 0.22, claw-8 0.22,
 *          claw-9 0.17, claw-10 0.21 (worst single fetch 0.42 s)
 *   wifi   claw-1 0.19 s, claw-2 0.45, claw-3 0.90 (worst single 1.08 s)
 *   0 failures in 360 fetches; getent 10–28 ms for both public names.
 */
export const NETWORK_BARS = Object.freeze({
	/**
	 * p95 of a soak's successful fetches, seconds. 2.2x the worst p95 measured
	 * on any claw (claw-3's radio, 0.90 s) and ten times a wired claw's, so a
	 * node that crosses it is not having an ordinary wifi day.
	 */
	httpsP95Sec: 2.0,
	/**
	 * Failed fetches tolerated in a soak. One: a single blip is the 0.13%
	 * transient rate that once paged `@here` and recovered untouched on the
	 * next run (AGENTS.md, READ_ATTEMPTS); two in ten minutes is a pattern.
	 */
	httpsFailures: 1,
	/** Failed name resolutions tolerated. None (operator brief, from the 10-16 outage). */
	dnsFailures: 0,
});

/** Per-fetch and per-lookup ceilings inside the loop, seconds. */
const CURL_MAX_SEC = 10;
const DNS_MAX_SEC = 10;
/** valid_lft rising by more than this between two samples is a renewal, not clock jitter. */
const RENEWAL_JUMP_SEC = 120;
/** Slack past the last sample before an unfinished soak is given up on. */
const POLL_GRACE_SEC = 180;
const POLL_EVERY_SEC = 30;

export const SOAK_BEGIN = 'NETSOAK_BEGIN';
export const SOAK_DONE = 'NETSOAK_DONE';
const DIR_PREFIX = 'qualify-net';
const SAFE_HOST = /^[A-Za-z0-9.-]+$/;
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:/-]+$/;
const DIR_RE = new RegExp(`^/[A-Za-z0-9._/-]*/${DIR_PREFIX}\\.[A-Za-z0-9]+$`);

/**
 * The node-side loop. Prints `SAMPLE i epoch`, the interface probe, the
 * default routes, one DNS line per host and one HTTPS line per fetch, then
 * `SAMPLE_END i`; `NETSOAK_DONE` once every sample is taken. It writes
 * nothing but curl's stderr, into `$NETSOAK_DIR`.
 */
export function soakLoopScript({
	hosts,
	url = HTTPS_URL,
	samples = SOAK_SAMPLES,
	everySec = SAMPLE_EVERY_SEC,
	perSample = HTTPS_PER_SAMPLE,
}) {
	for (const h of hosts) if (!SAFE_HOST.test(h)) throw new TypeError(`bad host ${h}`);
	if (!SAFE_URL.test(url)) throw new TypeError(`bad url ${url}`);
	for (const [k, v] of Object.entries({ samples, everySec, perSample }))
		if (!Number.isInteger(v) || v < 1) throw new TypeError(`bad ${k} ${v}`);
	// Every variable is `q`-prefixed and the interface probe runs in a subshell:
	// the probe assigns its own `i`, `d` and `w`, and sharing them ended the
	// first version after one sample.
	return [
		'set -u',
		`echo "${SOAK_BEGIN} $(date +%s)"`,
		'qt0=$(date +%s)',
		`for qi in $(seq 1 ${samples}); do`,
		'  echo "SAMPLE $qi $(date +%s)"',
		`  ( ${INTERFACE_PROBE} )`,
		'  ip -4 route show default 2>&1 | sed "s/^/ROUTE /"',
		`  for qh in ${hosts.join(' ')}; do`,
		'    qs=$(date +%s%N)',
		`    if qa=$(timeout ${DNS_MAX_SEC} getent ahosts "$qh"); then qrc=0; else qrc=$?; fi`,
		'    qms=$(( ($(date +%s%N) - qs) / 1000000 ))',
		'    qfirst=$(printf "%s\\n" "$qa" | awk "NR==1{print \\$1}")',
		'    echo "DNS $qh $qrc $qms ${qfirst:--}"',
		'  done',
		`  for qj in $(seq 1 ${perSample}); do`,
		`    if qr=$(curl -sS -o /dev/null -m ${CURL_MAX_SEC} -w "%{http_code} %{time_total}" '${url}' 2>"$NETSOAK_DIR/curl.err"); then qrc=0; else qrc=$?; fi`,
		'    echo "HTTPS $qrc ${qr:-000 0} $(head -c 160 "$NETSOAK_DIR/curl.err" | tr "\\n" " ")"',
		'  done',
		'  echo "SAMPLE_END $qi"',
		`  [ "$qi" -lt ${samples} ] || break`,
		`  qwait=$(( qt0 + qi * ${everySec} - $(date +%s) ))`,
		'  [ "$qwait" -gt 0 ] && sleep "$qwait"',
		'done',
		`echo "${SOAK_DONE} $(date +%s)"`,
	].join('\n');
}

/**
 * Starts the loop detached, in its own session, under `timeout`, in a fresh
 * mktemp directory. Prints `NETSOAK_DIR <dir>`.
 */
export function startScript(loop, boundSec) {
	if (!Number.isInteger(boundSec) || boundSec < 1) throw new TypeError(`bad bound ${boundSec}`);
	return [
		'set -eu',
		`d=$(mktemp -d -t ${DIR_PREFIX}.XXXXXXXX)`,
		'cat > "$d/loop.sh" <<\'NETSOAK_EOF\'',
		loop,
		'NETSOAK_EOF',
		`NETSOAK_DIR="$d" setsid nohup timeout ${boundSec} bash "$d/loop.sh" > "$d/out" 2>&1 < /dev/null &`,
		'echo $! > "$d/pid"',
		'echo "NETSOAK_DIR $d"',
	].join('\n');
}

function assertDir(dir) {
	if (!DIR_RE.test(String(dir))) throw new TypeError(`not a soak directory: ${dir}`);
}

/** Prints the soak's output so far. */
export function readScript(dir) {
	assertDir(dir);
	return `cat '${dir}/out'`;
}

/**
 * Stops the loop's process group if it is still running and removes its
 * directory. Nothing outside that directory is touched.
 */
export function cleanupScript(dir) {
	assertDir(dir);
	return [
		`d='${dir}'`,
		'p=$(cat "$d/pid" 2>/dev/null || echo "")',
		'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill -- "-$p"; echo "NETSOAK_KILLED $p"; fi',
		'rm -rf "$d"',
		'[ ! -e "$d" ] && echo NETSOAK_CLEAN',
	].join('\n');
}

const ADDR_LFT =
	/^ADDR \d+:\s+(\S+)\s+inet\s+\d+\.\d+\.\d+\.\d+\/\d+.*?valid_lft (?:(\d+)sec|(forever))/gm;

/**
 * PURE. The loop's output as samples.
 *
 * @param {string} out
 */
export function parseSoak(out) {
	const text = String(out ?? '');
	const begun = new RegExp(`^${SOAK_BEGIN} \\d+$`, 'm').test(text);
	const done = new RegExp(`^${SOAK_DONE} \\d+$`, 'm').test(text);
	const samples = [];
	for (const block of text.split(/^(?=SAMPLE \d+ \d+$)/m)) {
		const head = block.match(/^SAMPLE (\d+) (\d+)$/m);
		if (!head || !block.startsWith('SAMPLE ')) continue;
		const i = Number(head[1]);
		const complete = new RegExp(`^SAMPLE_END ${i}$`, 'm').test(block);
		const lft = {};
		for (const m of block.matchAll(ADDR_LFT)) {
			if (!(m[1] in lft)) lft[m[1]] = m[3] ? null : Number(m[2]);
		}
		const routes = [...block.matchAll(/^ROUTE default .*$/gm)].map((m) => ({
			dev: m[0].match(/ dev (\S+)/)?.[1] ?? null,
			metric: Number(m[0].match(/ metric (\d+)/)?.[1] ?? 0),
		}));
		const dns = [...block.matchAll(/^DNS (\S+) (\d+) (\d+) (\S+)$/gm)].map((m) => ({
			host: m[1],
			ok: m[2] === '0' && m[4] !== '-',
			rc: Number(m[2]),
			ms: Number(m[3]),
			addr: m[4] === '-' ? null : m[4],
		}));
		const https = [...block.matchAll(/^HTTPS (\d+) (\d{3}) ([\d.]+) ?(.*)$/gm)].map((m) => {
			const code = Number(m[2]);
			return {
				ok: m[1] === '0' && code >= 200 && code < 400,
				rc: Number(m[1]),
				code,
				sec: Number(m[3]),
				err: m[4].trim() || null,
			};
		});
		samples.push({
			i,
			at: Number(head[2]),
			complete,
			ifaces: parseInterfaces(block),
			lft,
			routes,
			dns,
			https,
		});
	}
	return { begun, done, samples };
}

const p95 = (xs) => {
	const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
	return a.length ? a[Math.max(0, Math.ceil(0.95 * a.length) - 1)] : null;
};

/** The default route the kernel uses: lowest metric. */
const primaryRoute = (routes) =>
	routes.length ? routes.reduce((a, b) => (b.metric < a.metric ? b : a)) : null;

/**
 * PURE. Which interface, if any, is the wired one this node must keep.
 *
 * Dual-homed means a wired interface and a wireless one each held an address
 * in SOME sample — not just the first, because a node that starts the soak
 * already in the claw-8 state (wired lease gone, running on the radio) must
 * not read as wifi-only. The gateway reservation (`machine.lan`) names the
 * wired interface of record when it is wired; it counts even if that
 * interface held no address at all, which is exactly the incident. Without a
 * reservation, the wired interface is one that carried a default route: a
 * VPN or bridge device is not wireless either, and holds an address.
 */
export function wiredOfRecord(samples, lan) {
	const wireless = new Set();
	const wired = new Set();
	let radioUp = false;
	for (const s of samples)
		for (const f of s.ifaces) {
			(f.wireless ? wireless : wired).add(f.name);
			if (f.wireless && f.ipv4) radioUp = true;
		}
	const lanIface = typeof lan?.iface === 'string' ? lan.iface : null;
	let iface = null;
	if (lanIface && wired.has(lanIface)) iface = lanIface;
	else iface = samples.flatMap((s) => s.routes).find((r) => r.dev && wired.has(r.dev))?.dev ?? null;
	if (!radioUp || !iface) return { dualHomed: false, iface: null, expectIp: null };
	const expectIp =
		lanIface === iface && typeof lan?.ip === 'string'
			? lan.ip
			: (samples.flatMap((s) => s.ifaces).find((f) => f.name === iface && f.ipv4)?.ipv4 ?? null);
	return { dualHomed: true, iface, expectIp };
}

/**
 * PURE. The lease on `iface` across the soak: remaining seconds at the first
 * and last sample, and whether a renewal was SEEN (valid_lft jumped up).
 */
export function leaseOf(samples, iface) {
	const seen = samples.filter((s) => iface && iface in s.lft).map((s) => s.lft[iface]);
	if (!iface || !seen.length) return { iface, startSec: null, endSec: null, renewed: null };
	if (seen.every((v) => v === null))
		return { iface, startSec: null, endSec: null, renewed: null, permanent: true };
	let renewed = false;
	for (let k = 1; k < seen.length; k++)
		if (seen[k] !== null && seen[k - 1] !== null && seen[k] - seen[k - 1] > RENEWAL_JUMP_SEC)
			renewed = true;
	return { iface, startSec: seen[0], endSec: seen.at(-1), renewed };
}

function leaseSentence(lease) {
	if (!lease.iface) return 'lease: no interface to read';
	if (lease.permanent) return `lease on ${lease.iface}: address is not leased (valid_lft forever)`;
	if (lease.startSec === null) return `lease on ${lease.iface}: unreadable`;
	return lease.renewed
		? `lease on ${lease.iface} renewed inside the window (${lease.startSec} s → ${lease.endSec} s left)`
		: `lease on ${lease.iface}: ${lease.startSec} s left at start, ${lease.endSec} s at end; no renewal fell inside the window, so renewal is not judged`;
}

/**
 * PURE. The soak's verdict.
 *
 * @param {object} a
 * @param {ReturnType<typeof parseSoak>} a.soak
 * @param {string[]} a.hosts every host the loop was told to resolve
 * @param {number} [a.expected] samples the loop should have taken
 * @param {{iface?: string, ip?: string}|undefined} [a.lan] machine.lan
 * @param {number} [a.perSample]
 */
export function judgeSoak({
	soak,
	hosts,
	expected = SOAK_SAMPLES,
	lan,
	perSample = HTTPS_PER_SAMPLE,
}) {
	const crossed = [];
	const unknown = [];
	const samples = soak.samples.filter((s) => s.complete);
	if (!soak.begun) unknown.push('the soak never started on the node');
	if (!soak.done || samples.length < expected)
		unknown.push(
			`the soak did not finish: ${samples.length}/${expected} complete samples${soak.done ? '' : ', no end sentinel'}`
		);

	// DNS: every host, every sample.
	const dnsFail = {};
	for (const s of samples)
		for (const h of hosts) {
			const r = s.dns.find((d) => d.host === h);
			if (!r) unknown.push(`sample ${s.i} has no resolution line for ${h}`);
			else if (!r.ok) dnsFail[h] = (dnsFail[h] ?? 0) + 1;
		}
	const dnsFailures = Object.values(dnsFail).reduce((a, b) => a + b, 0);
	if (dnsFailures > NETWORK_BARS.dnsFailures)
		crossed.push(
			`DNS: ${Object.entries(dnsFail)
				.map(([h, n]) => `${h} failed in ${n}/${samples.length} samples`)
				.join(', ')} (bar: ${NETWORK_BARS.dnsFailures} failures)`
		);

	// HTTPS.
	const fetches = samples.flatMap((s) => s.https);
	for (const s of samples)
		if (s.https.length !== perSample)
			unknown.push(`sample ${s.i} recorded ${s.https.length}/${perSample} HTTPS fetches`);
	const failed = fetches.filter((f) => !f.ok);
	const httpsP95 = p95(fetches.filter((f) => f.ok).map((f) => f.sec));
	if (failed.length > NETWORK_BARS.httpsFailures)
		crossed.push(
			`HTTPS: ${failed.length}/${fetches.length} fetches of ${HTTPS_URL} failed (bar: ${NETWORK_BARS.httpsFailures}); first: ${failed[0].err ?? `curl ${failed[0].rc}, HTTP ${failed[0].code}`}`
		);
	if (httpsP95 !== null && httpsP95 > NETWORK_BARS.httpsP95Sec)
		crossed.push(`HTTPS: p95 ${httpsP95} s > ${NETWORK_BARS.httpsP95Sec} s`);
	if (samples.length && httpsP95 === null && failed.length <= NETWORK_BARS.httpsFailures)
		unknown.push('no HTTPS fetch succeeded or was recorded');

	// Dual-homed: the wired interface keeps its address and the default route.
	const wired = wiredOfRecord(samples, lan);
	let lostAddr = 0;
	let lostRoute = 0;
	if (wired.dualHomed) {
		for (const s of samples) {
			const f = s.ifaces.find((x) => x.name === wired.iface);
			if (!f || !f.ipv4 || (wired.expectIp && f.ipv4 !== wired.expectIp)) lostAddr++;
			if (primaryRoute(s.routes)?.dev !== wired.iface) lostRoute++;
		}
		if (lostAddr)
			crossed.push(
				`dual-homed: wired ${wired.iface} did not hold ${wired.expectIp ?? 'an IPv4 address'} in ${lostAddr}/${samples.length} samples`
			);
		if (lostRoute)
			crossed.push(
				`dual-homed: the default route was not on wired ${wired.iface} in ${lostRoute}/${samples.length} samples`
			);
	}

	const routeIface = samples.length ? (primaryRoute(samples[0].routes)?.dev ?? null) : null;
	const lease = leaseOf(samples, wired.iface ?? routeIface);
	const metrics = {
		samples: samples.length,
		expected,
		dnsFailures: dnsFail,
		dnsMaxMs: Math.max(0, ...samples.flatMap((s) => s.dns.map((d) => d.ms))),
		https: { fetches: fetches.length, failed: failed.length, p95Sec: httpsP95 },
		dualHomed: wired.dualHomed,
		wiredIface: wired.iface,
		lostAddrSamples: wired.dualHomed ? lostAddr : null,
		lostRouteSamples: wired.dualHomed ? lostRoute : null,
		routeIface,
		lease,
		bars: NETWORK_BARS,
	};
	const scope = wired.dualHomed
		? `dual-homed (wired ${wired.iface} judged on address and route)`
		: `single-homed on ${routeIface ?? 'no default route'}: judged on DNS and HTTPS only`;
	const tail = `${scope}; ${leaseSentence(lease)}`;

	// A crossed bar is a verdict even when something else was unreadable.
	if (crossed.length)
		return { status: 'fail', reason: [...crossed, ...unknown, tail].join('; '), metrics };
	if (unknown.length)
		return { status: 'could-not-look', reason: [...unknown, tail].join('; '), metrics };
	return {
		status: 'pass',
		reason: `${samples.length} samples over ${samples.at(-1).at - samples[0].at} s: ${hosts.length} names resolved every time, ${fetches.length - failed.length}/${fetches.length} fetches ok at p95 ${httpsP95} s; ${tail}`,
		metrics,
	};
}

/**
 * The test, with its outside reads injectable for tests.
 *
 * `samples`, `everySec`, `url` and `hosts` exist so the unit tests can run the
 * real loop against a local server in seconds; production uses the defaults.
 *
 * @param {{ dataEndpoint?: () => {url: string|null, why?: string}, sleep?: (ms: number) => Promise<void>,
 *   samples?: number, everySec?: number, url?: string, hosts?: readonly string[] }} [o]
 */
export function makeNetworkSoakTest({
	dataEndpoint = dataEndpointUrl,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	samples = SOAK_SAMPLES,
	everySec = SAMPLE_EVERY_SEC,
	url = HTTPS_URL,
	hosts: baseHosts = DNS_HOSTS,
} = {}) {
	return {
		id: 'network-soak',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'ci',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: 12,
		async run(ctx) {
			const data = dataEndpoint();
			const dataHost = URL.canParse(data.url ?? '') ? new URL(data.url).hostname : null;
			if (!dataHost || !SAFE_HOST.test(dataHost))
				return {
					status: 'could-not-look',
					reason: `the data endpoint's host could not be named (${data.why ?? `${data.url} is not a URL with a plain host`})`,
					metrics: {},
				};
			const hosts = [...baseHosts, dataHost];
			const loop = soakLoopScript({ hosts, url, samples, everySec });
			const soakSec = (samples - 1) * everySec;
			const bound =
				soakSec + samples * (DNS_MAX_SEC * hosts.length + CURL_MAX_SEC * HTTPS_PER_SAMPLE) + 60;

			const started = await ctx.exec(startScript(loop, bound), { timeoutMs: 60_000 });
			const dir = String(started.stdout ?? '').match(/^NETSOAK_DIR (\S+)$/m)?.[1];
			if (!dir || !DIR_RE.test(dir))
				return {
					status: 'could-not-look',
					reason: `the soak did not start on the node: ${(started.stderr || started.error || 'no NETSOAK_DIR line').trim().slice(-200)}`,
					metrics: {},
				};
			ctx.log(`   soaking ${samples} samples ${everySec} s apart in ${dir}`);

			let out = '';
			const pollFailures = [];
			try {
				await sleep(soakSec * 1000);
				// Counted, not clocked: the loop's own `timeout` ends it by `bound`.
				const polls = Math.ceil((bound - soakSec + POLL_GRACE_SEC) / POLL_EVERY_SEC);
				for (let n = 0; n < polls; n++) {
					if (n) await sleep(POLL_EVERY_SEC * 1000);
					const r = await ctx.exec(readScript(dir), { timeoutMs: 30_000 });
					if (r.ok) out = String(r.stdout ?? '');
					else pollFailures.push((r.stderr || r.error || 'poll failed').trim().slice(-160));
					if (parseSoak(out).done) break;
				}
			} finally {
				const c = await ctx.exec(cleanupScript(dir), { timeoutMs: 30_000 });
				if (!String(c.stdout ?? '').includes('NETSOAK_CLEAN'))
					ctx.log(`   could not remove ${dir}: ${(c.stderr || c.error || '').trim().slice(-160)}`);
			}

			const result = judgeSoak({
				soak: parseSoak(out),
				hosts,
				expected: samples,
				lan: ctx.machine?.lan,
			});
			result.metrics.dataHost = dataHost;
			// An address literal resolves without asking a resolver; say so rather than count it as DNS.
			result.metrics.dataHostIsLiteral = /^[\d.]+$/.test(dataHost);
			result.metrics.pollFailures = pollFailures;
			if (pollFailures.length)
				result.reason += `; ${pollFailures.length} poll(s) could not reach the node (first: ${pollFailures[0]})`;
			return result;
		},
	};
}

export const test = makeNetworkSoakTest();
