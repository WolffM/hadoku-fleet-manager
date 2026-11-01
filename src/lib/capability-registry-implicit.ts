/**
 * The `surface: 'implicit'` capability entries — wave 5r lane D split of
 * `capability-registry.ts` (pure move, data only).
 *
 * PROBED, DECLARED BY NOBODY, ROUTABLE BY NOTHING — see `CapabilitySurface`
 * in `capability-registry.ts` for the full doc of what that means and why it
 * is distinct from a label.
 */

import type { Capability } from './capability-registry.js';

export const PM2_CAPABLE_CAPABILITY: Capability = {
	/*
	 * COULD this box host the pm2 role — asked separately from whether it IS
	 * the host, and deliberately held one step short of being a routing lever.
	 *
	 * `surface: 'implicit'` is the documented shape for exactly this, and the
	 * GPU family above is the precedent: "the measurement, held one step short
	 * of being a routing lever … promoting one of these to `surface: 'label'`
	 * is a deliberate, reviewed, one-line change made against probe output that
	 * already exists". It lands in `$capabilities.earned` — which is what
	 * `resident-placement-2026-09-10.md` filter 1 reads — and `nodeOffer` skips
	 * it because it is not a label, so no workflow can route on it and
	 * `census.clawPool` is unaffected. That separation is the whole point of
	 * wave 3o lane C; the `pm2-host` entry above carries what merging the two
	 * would have cost.
	 *
	 * PROVED BY PROVISIONING, AND NOTHING IS LEFT BEHIND. The probe installs
	 * pm2 into a throwaway prefix under $HOME, starts a real process, reads it
	 * back `online`, `save`s, `kill`s the daemon, `resurrect`s it, requires the
	 * process online again WITH A DIFFERENT PID, and then removes the lot. A
	 * permanent pm2 on nine boxes is ~540 MB of node/pm2 footprint per box and
	 * is precisely what issue #6 wants moved OFF a machine, not onto eight
	 * more. Measured on claw-9 2026-09-26: 2 s to install, 5 s end to end,
	 * 41 MB under $HOME, `~/.npm` byte-identical before and after.
	 *
	 * SURVIVING A RESTART IS THE POINT, not starting. A pm2 that cannot write
	 * its dump starts everything perfectly and loses the lot the first time the
	 * daemon restarts, which is the failure a resident service actually meets.
	 * And the pid must CHANGE: `resurrect` returning 0 against a process the
	 * kill never reached proves nothing.
	 */
	id: 'pm2-capable',
	label: 'Could host PM2',
	kind: 'identity',
	surface: 'implicit',
	verify: 'probe',
	description:
		'This box could host the pm2 role: a supervisor installs, starts a process, reports ' +
		'it online, SURVIVES the supervisor being killed and resurrected (with a new pid), ' +
		'and is then removed without trace. Probed, declared by nobody, routable by nothing ' +
		'— `pm2-host` is the routing label and this is deliberately not it. Read by ' +
		'`resident-placement-2026-09-10.md` filter 1 out of `$capabilities.earned`.',
	measure: {
		metric: 'installed memory',
		unit: 'MiB',
		atLeast: 9784,
		why:
			'`resident-placement-2026-09-10.md` §1.6, measured on the role at its current ' +
			'home (`/sys/fs/cgroup/system.slice/pm2-hadoku.service`, `memory.current` ' +
			'10,259,140,608 B = 9,784 MiB steady; `memory.peak` 20,482 MiB is an upper bound ' +
			'because it includes reclaimable page cache). THE ROLE, NOT ITS FIRST TENANT: ' +
			'§1.6 rules that a placement establishing a ROLE is sized against the role, and ' +
			'issue #6’s one bot is only its first tenant — cron (47 jobs across 9 profiles) ' +
			'and the deploy trees are behind it. ' +
			'A FLOOR ON THE HARDWARE, NOT THE FIT. A node whose ENTIRE installed memory is ' +
			'below the role’s steady demand can never host it under any policy, which is a ' +
			'fact about the box and does not move; whether it has ROOM today is filters 2-4 ' +
			'(`slack = usable − ciCommitment`, margin `slack / ram >= 2.0`) and is NOT ' +
			're-derived here. Two homes for that arithmetic would disagree, because free ' +
			'memory moves with whatever CI is running — and a capability that flickers with ' +
			'load is an ELIGIBILITY lever wearing an IDENTITY’s clothes, the P2 collapse ' +
			'this file opens with. Measured 2026-09-26: claw-1 11,885, claw-3 15,918, ' +
			'claw-4 15,936, claw-5 15,877, claw-8 15,915, claw-9 32,003 clear it; claw-2 ' +
			'7,872 and claw-6 7,849 do not, and their `no` says the number.',
		loadInvariant:
			'`MemTotal` is the INSTALLED memory the kernel found at boot, not free memory: a ' +
			'running job moves `MemAvailable` and leaves this number exactly where it was, ' +
			'so draining a node to read it would buy nothing.',
	},
};
export const NVENC_HEVC_CAPABILITY: Capability = {
	id: 'nvenc-hevc',
	label: 'NVENC HEVC encode',
	kind: 'identity',
	surface: 'implicit',
	verify: 'probe',
	description:
		'Hardware HEVC/H.265 encoding through NVENC. Maxwell 2nd-gen and later, so ' +
		'it separates a genuinely old card from a merely old one.',
};
export const NVDEC_CAPABILITY: Capability = {
	id: 'nvdec',
	label: 'NVDEC video decode',
	kind: 'identity',
	surface: 'implicit',
	verify: 'probe',
	description:
		'Hardware video DECODE on the GPU. Separate silicon and a separate driver ' +
		'path from NVENC — a card can lose one and keep the other.',
};
export const CUDA_CAPABILITY: Capability = {
	id: 'cuda',
	label: 'CUDA kernels',
	kind: 'identity',
	surface: 'implicit',
	verify: 'probe',
	description:
		'A usable CUDA context on the device, proven by running a kernel — not by ' +
		'nvidia-smi answering, which only proves the driver is alive.',
};
export const JAVA21_CAPABILITY: Capability = {
	/*
	 * java21 (2026-10-24, hadoku-cardtable's FLEET_MANAGER_FORGE_HOSTING
	 * request §2): a Java 21 runtime that RUNS, which is what a node needs to
	 * host Forge matches — and nothing else. Not `jdk21`, on purpose: that
	 * label routes forge-e2e CI jobs (p95 5.5 GB, max 10 GB), so it keeps its
	 * 12 GiB floor, Maven, and its workload canary. A hosting node runs no CI
	 * at all, and an idle JDK costs disk, not RAM, so claw-1/2/6 can hold this
	 * one without being offered the other.
	 *
	 * `surface: 'implicit'`: PROBED, ROUTABLE BY NOTHING. Cardtable reads it
	 * from `$capabilities.earned` to decide where it can place; no workflow
	 * may ask for it, which is what keeps it from becoming a backdoor onto
	 * the jdk21 workload.
	 *
	 * The probe compiles and runs a class and checks the MAJOR version, so a
	 * Java 17 on the stock PATH reads `no`, not `ok`.
	 */
	id: 'java21',
	label: 'Java 21 runtime',
	kind: 'identity',
	surface: 'implicit',
	verify: 'probe',
	description:
		'A Java 21 JDK that compiles and runs a class from a non-login shell. What a node ' +
		'needs to host Forge matches; carries no CI routing, unlike `jdk21`.',
};
export const JITCONFIG_CAPABILITY: Capability = {
	id: 'jitconfig',
	label: 'JIT runner config',
	kind: 'identity',
	surface: 'implicit',
	verify: 'probe',
	description:
		'`Runner.Listener` accepts `--jitconfig`. An UNDOCUMENTED flag the entire ephemeral ' +
		'dispatcher depends on, so a runner self-update is the expected way to lose it. ' +
		'Declared by nobody and routable by nothing; probed on every node that could mint.',
};
