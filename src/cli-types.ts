/**
 * The vocabulary `src/cli.ts`'s `COMMANDS` table is built from — split out
 * (wave 5s lane C, TypeScript long tail) so the domain modules
 * (`cli-commands-*.ts`) can import the `Command` shape without importing
 * `cli.ts` itself, which runs `process.argv` and spawns a child process at
 * module scope. Pure move: no behaviour here, just the types `cli.ts` used to
 * declare inline.
 */
/**
 * WHAT A SUBCOMMAND *IS* (plan §3.4), orthogonal to which domain it is in:
 *
 *   gate       read-only pass/fail check (observation); most are under the
 *              `--json` contract or `ci:audit-gates`.
 *   converger  brings declared state into alignment; defaults to reporting
 *              only, one flag (`--confirm`/`--write`/`--refresh`) applies it —
 *              the shape plan §3.2 rule 6 names for `reconcile --confirm`,
 *              `toolchain --refresh`. `reboot-claws` is here too even though
 *              its OWN default already acts: the controller runs it on its
 *              own timer as a scheduled repair (`src/claw-reboot.ts`), the
 *              same `scheduled-converger.ts` shape as `hosting-converge` and
 *              `converge-provisioning`.
 *   recorder   writes ONE declared record as its whole job (plan §3.2 rule 6:
 *              "`doctor --write` records a measurement").
 *   mutator    a direct, operator-initiated action that changes real state
 *              by default — reboot ONE claw by hand, drain a node, provision
 *              one from bare. Not a repair loop toward a declared shape.
 *   operator   a read-only report or diagnostic a human runs and reads; no
 *              cron or contract on the other end (unlike a gate).
 *   onboarding builds or verifies install media before a node exists in the
 *              fleet roster at all.
 *   node-side  runs ON the node itself, not from the controller.
 *
 * A JUDGMENT CALL, not a verified classification: several of the 79 entries
 * below could sit in more than one bucket (`toolpack` installs by default
 * under `--confirm` the way a mutator does, but its job is bringing a node's
 * instruments into alignment with what the box IS, so it is filed as a
 * converger). Said here rather than hidden — see the wave 5b closing note for
 * which ones were closest calls.
 */
export type Kind =
	'gate' | 'converger' | 'recorder' | 'mutator' | 'operator' | 'onboarding' | 'node-side';

export interface Command {
	script: string;
	summary: string;
	/** What this subcommand IS — see {@link Kind}. Every entry carries one. */
	kind: Kind;
	/**
	 * Arguments this subcommand always passes, before the operator's own.
	 *
	 * Exists so two subcommands can share one script when they are genuinely the
	 * same work aimed differently — `scan` is `benchmark` pointed at a box that
	 * is not in the roster. The alternative was a second orchestrator with its
	 * own copy of the parser, the renderer and the ssh handling, and this repo
	 * has already paid for a duplicated reader once: isLocalNode had five.
	 */
	args?: string[];
	/**
	 * The script answers `--help` itself, and `cli-help.test.mjs` PROVES it: run
	 * with `--help` in a sandbox where ssh, gh, sudo, apt, npm and systemctl all
	 * fail and record the attempt, it must exit 0, print usage, and call none of
	 * them. Absent, `--help` never reaches the script — see the door below.
	 */
	help?: true;
	/**
	 * Every flag the script reads from its OWN argv; a trailing `=` marks one
	 * that takes a value (`--machine=` accepts `--machine claw-3`). Declared on
	 * each subcommand whose NO-FLAG default changes something, because those
	 * scripts ignore a flag they do not know and fall through to the default:
	 * `fleet bootcamp --dryrun` installs. The door refuses anything else with
	 * exit 2 before running. Flags a script only PASSES to its children are not
	 * listed: converge-provisioning calls its children with `--check`, and
	 * accepting it here would keep its most natural typo live.
	 */
	flags?: string[];
	/**
	 * The door hands this script its own table, as `FLEET_DOOR_COMMANDS` (the
	 * subcommand names, comma-separated). Only the door knows what it serves;
	 * `fleet usage` needs the list to say which doors nobody opened.
	 */
	doorTable?: true;
}
