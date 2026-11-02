/**
 * Static fixture data for runner-health's tests — fake runner listings,
 * label sets, and the two relative-clock helpers every suite uses. Split out
 * of `runner-health-rig.ts` (wave shrink-1 lane C, pure move) to bring that
 * file under the 600-line target.
 */

export const FAKE_WEBHOOK = 'https://discord.test/webhook';

// Fresh array per call: the monitor mutates runner.labels in place.
//
// `self-hosted` is here because GitHub STAMPS it on every registration — no
// runner anywhere lacks it. Leaving it out is what let the queued-coverage
// check ship broken: `vars.CI_RUNNER` is `["self-hosted","hadoku-builder"]`, so
// every real fleet job asks for a label these fixtures said nothing carried,
// and the busy-pool branch was unreachable in production while its test passed
// against a bare `['hadoku-builder']` that `runs-on` never produces.
export const clawLabels = () => [{ name: 'self-hosted' }, { name: 'hadoku-builder' }];
// hokon mid-backstop: pm2-host PLUS the builder label, which is what a successful
// promotion leaves behind. Also the "covers every required label" stub in tests
// that only care about queued/hung alerting.
// Every capability hokon DECLARES in fleet-runner-manifest.json, which is what
// makes this a truthful "covers every required label" stub. taskauto and
// av1-nvenc joined REQUIRED_LABELS on 2026-08-27 — they are real routing
// dependencies (2 jobs and 1 job request them) and their absence from the floor
// is why taskauto could queue 6h45m unalerted on 2026-08-26.
// hokon at REST: every capability it declares, and no builder label. That is
// what the manifest says the node offers, and what the label floor watches.
export const hokonLabels = () => [
	{ name: 'self-hosted' },
	{ name: 'pm2-host' },
	{ name: 'taskauto' },
	{ name: 'av1-nvenc' },
];

export const hokonPromotedLabels = () => [
	...hokonLabels(),
	...clawLabels().filter((l) => l.name !== 'self-hosted'),
];

/**
 * A fleet where every claw is ONLINE — so nothing here is a runner drop.
 *
 * It says nothing about OOM kills (2026-08-24): the offline-runner failover
 * cannot see those either, because the kernel OOM killer reaps the JOB, not
 * the listener, so the runner is still online at the next tick and every gate
 * the drop-failover uses reports a perfectly healthy fleet — the run just
 * stays red and pages @here as if the build were broken. Real event: the
 * 13:00 UTC @wolffm fan-out dispatched 14 repos inside 4 seconds, 11 landed on
 * claw-2 (7.8GB, smallest box in the fleet, tier1 so never demoted), and the
 * kernel killed hadoku-craft and hadoku-resume-bot 82 seconds apart.
 */
export const FLEET_ALL_UP = {
	runners: [
		{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
		{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
		{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
	],
};

/**
 * THE LIVE hadoku_site RUNNER LISTING, `gh api repos/WolffM/hadoku_site/actions/runners`
 * on 2026-09-14 — ids, names, statuses and labels exactly as GitHub returned
 * them, including the `X64`/`Linux` labels GitHub stamps and the `jit-canary`
 * one the dispatcher writes. It is the listing issue #24 quotes.
 *
 * Fresh objects per call: the monitor mutates `runner.labels` in place.
 */
export const LIVE_LISTING = () => ({
	total_count: 7,
	runners: [
		{
			id: 2491,
			name: 'claw-8',
			status: 'offline',
			busy: false,
			labels: [{ name: 'self-hosted' }, { name: 'X64' }, { name: 'Linux' }],
		},
		{
			id: 69,
			name: 'hokon',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'pm2-host' },
				{ name: 'taskauto' },
				{ name: 'av1-nvenc' },
			],
		},
		{
			id: 2998,
			name: 'warm-claw-5-hadoku_site',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
		{
			id: 3057,
			name: 'warm-claw-3-hadoku_site',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
		{
			id: 3143,
			name: 'jit-claw-3-hadoku_site-j104143747556-r34894126603-1789418307',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
				{ name: 'jit-canary' },
			],
		},
		{
			id: 3145,
			name: 'jit-claw-5-hadoku_site-j104143747283-r34894126507-1789418307',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
		{
			id: 2884,
			name: 'warm-claw-7-hadoku_site',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
	],
});

export function minutesAgo(min: number): string {
	return new Date(Date.now() - min * 60_000).toISOString();
}

/**
 * RELATIVE, like every other clock in this suite.
 *
 * The zombie cases below are about runs that have been queued since 2026-08-17
 * and 2026-08-19, and writing those dates in as literals is how a fixture goes
 * red on a calendar rather than a commit — twice already in this repo, against
 * the 14-day job-history window. What matters is the age, not the date.
 */
export function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}
