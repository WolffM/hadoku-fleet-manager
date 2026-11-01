/**
 * The `surface: 'toolchain'` capability entries — wave 5r lane D split of
 * `capability-registry.ts` (pure move, data only).
 *
 * Declared once in `toolchain.capabilities` and required of EVERY managed
 * node — never a label, because there is nothing to route to. See
 * `CapabilitySurface` in `capability-registry.ts` for the full doc.
 */

import type { Capability } from './capability-registry.js';

export const FFMPEG_CAPABILITY: Capability = {
	id: 'ffmpeg',
	label: 'ffmpeg',
	kind: 'identity',
	surface: 'toolchain',
	verify: 'probe',
	description: 'A working ffmpeg binary. Required of every managed node.',
};
export const GH_CAPABILITY: Capability = {
	id: 'gh',
	label: 'GitHub CLI',
	kind: 'identity',
	surface: 'toolchain',
	verify: 'probe',
	description:
		'A working `gh` that can REACH the API. Required of every managed node. Workflow ' +
		'steps across the fleet shell out to it — the alert-issue open/close pair on every ' +
		'update-wolffm job is the widest user — and a node without it fails those steps ' +
		'with exit 127 AFTER the real work has already succeeded. It was absent on ' +
		'claw-4/5/6 from their 2026-09-02 enrolment until 2026-09-05, and nothing noticed: ' +
		'no gate named gh, so which node a job drew decided whether it passed. Four repos ' +
		'failed in one fan-out and the same jobs had been green for days on claw-1/2/3.',
};
export const RUST_CAPABILITY: Capability = {
	id: 'rust',
	label: 'Rust toolchain',
	kind: 'identity',
	surface: 'toolchain',
	verify: 'probe',
	description:
		'A Rust toolchain that BUILDS, reachable from the stock PATH. TOOLCHAIN rather ' +
		'than a routing label: brave-quartet runs on fromJSON(vars.CI_RUNNER) — the ' +
		'GENERAL POOL — so any claw can draw its jobs, which makes rustc a requirement of ' +
		'every managed node rather than a differentiator between them. Modelling it as a ' +
		'label would make the fleet route around a hole instead of closing it, the same ' +
		'mistake the first draft of `playwright` made. The probe is PATH-SENSITIVE on ' +
		'purpose: on 2026-09-10 all seven claws were given rustup and a hand-check over ' +
		'ssh passed on all seven, because that check exported ~/.cargo/bin first the way ' +
		'a login shell does. A workflow `run:` step gets the stock PATH and sources no ' +
		'profile, so the first fleet run died on `rustup: command not found` against ' +
		'seven boxes that all "had" rustup. Fixed by symlinking the rustup proxies into ' +
		'/usr/local/bin; this capability is what keeps that true.',
};
export const PYTHON_VENV_CAPABILITY: Capability = {
	id: 'python-venv',
	label: 'Python venv',
	kind: 'identity',
	surface: 'toolchain',
	verify: 'probe',
	description:
		'`python3 -m venv` can CREATE a usable venv. Required of every managed node. The ' +
		'probe creates one rather than asking, because `venv --help` succeeds on a box where ' +
		'creation then fails for want of ensurepip — the claw-1/claw-2 drift of 2026-08-25, ' +
		'which read as a flaky test rather than as fleet drift.',
};
export const PYTHON_TOOLCACHE_CAPABILITY: Capability = {
	id: 'python-toolcache',
	label: 'Python 3.11 + 3.12 cache',
	kind: 'identity',
	surface: 'toolchain',
	verify: 'probe',
	description:
		'A cached Python 3.11 AND 3.12 under /opt/hostedtoolcache that EXECUTES. Required of ' +
		'every managed node, because 5 of the 26 covered repos use `actions/setup-python` on ' +
		"the general pool as of 2026-09-07 (measured by `fleet tool-inventory --write`'s demand " +
		'ledger — re-run it rather than trusting this number, it already moved once: 3 on ' +
		'2026-09-03, then hadoku-pygmalion reverted a workaround and hadoku-games-host joined ' +
		'coverage) and the claws run trixie, for which actions/python-versions publishes NO build — so the ' +
		'cache is not an optimisation here, it is the only way that action can succeed. ' +
		'toolchain rather than label: every node must have it, so routing on it would say ' +
		'nothing. The probe RUNS the interpreter because the directory is the presence-check ' +
		'trap in miniature: on claw-1 it lists 3.11.15 and 3.12.13, du reports 20K, and both ' +
		'are symlinks into uv store. Measured 2026-09-02: claw-5 and claw-6 were registered, ' +
		'online and carrying hadoku-builder with the cache entirely absent.',
};
export const PLAYWRIGHT_CAPABILITY: Capability = {
	id: 'playwright',
	label: 'Playwright browser',
	kind: 'identity',
	surface: 'toolchain',
	verify: 'probe',
	description:
		'A Playwright browser that LAUNCHES. TOOLCHAIN, not a routing label, and the first ' +
		'draft had that wrong. hadoku_site e2e-canary.yml runs on fromJSON(vars.CI_RUNNER) — ' +
		'the GENERAL POOL — so any claw can receive it, which makes a browser a requirement ' +
		'of every managed node rather than a differentiator between them. Measured 2026-09-02: ' +
		'claw-1, claw-2, claw-3 and hokon launch one; claw-5 and claw-6 have no binary. That ' +
		'gap is DRIFT TO FIX, not a routing fact to encode - and modelling it as a label ' +
		'would have made the fleet route around a hole instead of closing it. The probe ' +
		'launches a browser rather than running `playwright --version`, which answers about ' +
		'the npm package: ~/.cache/ms-playwright can hold 631MB and still lack the binary a ' +
		'spec needs, and e2e-canary carries NO `playwright install` step deliberately.',
};
