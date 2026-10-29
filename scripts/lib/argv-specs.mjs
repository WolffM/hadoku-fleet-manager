/**
 * ONE DECLARATION PER MIGRATED SCRIPT (plan §4.1 F8, wave 5b §D step 2).
 *
 * Pure DATA — config layer, placement rule 1 ("fleet-manager's own
 * declarative inputs... → config"). No side effects on import, so BOTH sides
 * of the door can read it:
 *
 *   - the script itself imports its own entry and parses its own argv with it
 *     (`scripts/lib/argv.mjs`'s `parseStrict`);
 *   - `src/cli.ts` imports this same object (never a script module — scripts
 *     run on import) to derive `Command.flags` for a migrated subcommand,
 *     so the door's unknown-flag refusal and the script's own are the same
 *     check, read from the same place, rather than a hand-kept copy that can
 *     drift from what the script actually parses.
 *
 * Keyed by SCRIPT FILENAME (relative to `scripts/`), not by the operator's
 * subcommand name — `src/cli.ts`'s `Command.script` is the join key, and a
 * script having no fixed 1:1 subcommand (none of these six are shared the
 * way `benchmark-fleet.mjs` is between `benchmark` and `scan`) makes this the
 * stable key either way.
 *
 * A script not listed here is NOT YET STRICT — debt in the F8 guard
 * (`scripts/lib/f-guards/f8-guard.test.mjs`) until it migrates too. The door
 * keeps a hand-kept `flags:` for those, same as before this file existed.
 */

/** @typedef {import('./argv.mjs').ArgvSpec} ArgvSpec */

/** @type {Record<string, ArgvSpec>} */
export const ARGV_SPECS = {
	'reboot-claws.mjs': {
		usage: [
			'fleet reboot-claws [--plan] [--machine <claw>] [--force] [--json]',
			'  --plan     what would be rebooted, and why; touches nothing',
			"  --force    skip the notice a hosting node's tenant is owed",
			'  (no flag)  one REAL pass: drain one claw, reboot it, verify, undrain',
		].join('\n'),
		booleans: ['--plan', '--force', '--json'],
		valued: ['--machine'],
		positionals: false,
		// Pre-existing wording (`scripts/reboot-claws.test.mjs`, not on this F8
		// migration's file list): a reboot "touches" the node, and that test
		// already asserts the literal phrase.
		nothingDoneText: 'nothing was touched',
	},

	'drain-node.mjs': {
		usage: [
			'fleet drain <node> --reason "why" [--kind training|maintenance|lease]',
			'                  [--for 48h | --until <iso>] [--in 30m | --at <iso>] [--force]',
			'fleet drain <node> --undo           put it back (and cancel anything planned for it)',
			'',
			'  --kind training     the node is earning its labels; it comes back when it',
			'                      passes. Bootcamp sets this.',
			'  --kind maintenance  (default) a human took it out and a human puts it back.',
			'  --kind lease        lent to a tenant for a window; pair it with --for/--until.',
			'  --for / --until     the drain lapses by itself at that time.',
			'  --in / --at         schedule it instead of starting it now. A HOSTING node',
			'                      (fleet hosting) is owed 15 min notice; --force skips it.',
			'fleet drain --status                what is held, and has it gone quiet',
			'fleet drain-check [--json]          is each drain actually being ENFORCED',
			'',
			'  --include-guests    a GUEST is not drained by the fleet chain. It lends a',
			"                      registration and is otherwise none of the fleet's",
			'                      business; pass this to hold one anyway, or to count',
			'                      running jobs on one under --status.',
			'',
			'Running jobs are never killed. New assignment stops; current work finishes.',
		].join('\n'),
		booleans: ['--status', '--undo', '--force', '--include-guests'],
		valued: ['--reason', '--kind', '--for', '--until', '--in', '--at'],
		positionals: true,
	},

	'backstop-switch.mjs': {
		usage: [
			'fleet backstop --force <node> [--for 60m] [--reason "why"]',
			'                                hold the node ELIGIBLE for builder work, time-boxed',
			// `{CEILING_H}` is filled in by the script, which already imports the
			// real constant for its own logic — see the matching note on
			// job-rollups.mjs's entry above.
			'                                (default 60m, ceiling {CEILING_H}h; set again if the queue outlives it)',
			'fleet backstop --off <node>     end a force early',
			'fleet backstop --status [--json]',
			'                                the switch, the live gates on this box, and the',
			"                                controller's last verdict",
			'',
			'A force beats the saturation decision and the idle gate. It does NOT beat a',
			'drain, a quarantine, the pm2-host rung, or the dispatcher’s admission',
			'(memory, /tmp floor, maxConcurrent). Runner-health reads it on its next tick.',
		].join('\n'),
		booleans: ['--status', '--json'],
		valued: ['--force', '--off', '--for', '--reason'],
		positionals: false,
	},

	'toolpack.mjs': {
		usage: [
			'fleet toolpack [node...] [--confirm] [--json]',
			'',
			'  no nodes    every machine in the fleet manifest, GUESTS EXCLUDED',
			'  --confirm   install what is missing (default is report only)',
			'  --json      machine-readable',
			'',
			'  A guest is skipped unless you name it: the fleet chain does not apt-get',
			'  on a box that only lends it a registration. Naming one reaches it.',
			'',
			'Derives each node’s packs from what the box IS, then checks the',
			'binaries are actually there. Run it after enrollment and before the',
			'first benchmark: the scan chooses the pack, so the scan must run first.',
		].join('\n'),
		booleans: ['--confirm', '--json'],
		valued: [],
		positionals: true,
	},

	'traffic-status.mjs': {
		usage: [
			'fleet traffic [--labels a,b] [--live] [--json]',
			'',
			'  (no args)   current routing state: order, speed factor, admission, every node',
			'  --labels    simulate a job asking for these labels',
			'  --live      ssh each node for its actual running-job count',
			'',
			'Order: fewest busy, then fastest measured, then idle longest, then name.',
			'Admission is read live from MGMT_API_URL (default http://127.0.0.1:4000),',
			"and reads 'unknown' rather than 'admitted' when that cannot be reached.",
			'Simulates only. Nothing here places, labels or writes.',
		].join('\n'),
		booleans: ['--live', '--json'],
		valued: ['--labels'],
		positionals: false,
	},

	'job-rollups.mjs': {
		usage: [
			'fleet job-rollups — the daily CI rollups mgmt-api writes from job-history',
			'',
			'  --days <n>     closed days to show, counted back from today (default 14)',
			'  --node <name>  only this node, plus the fleet row for the same repo+kind',
			'  --repo <name>  only this repo (owner/name, or just name)',
			'  --json         the rows themselves',
			'',
			// `{SETTLE_HOURS}` is filled in by the script, which already imports the
			// real constant from `dist/job-rollups.js` for its own logic — this data
			// module stays a pure string table and does not import a build artifact
			// just to interpolate one number into its own help text.
			'A day is written {SETTLE_HOURS}h after it ends, so the newest two days are',
			'never here yet. Reads the state dir only; writes nothing.',
		].join('\n'),
		booleans: ['--json'],
		valued: ['--days', '--node', '--repo'],
		positionals: false,
	},
};
