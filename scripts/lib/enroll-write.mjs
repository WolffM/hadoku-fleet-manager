/**
 * `fleet enroll`'s manifest commit — split out of scripts/enroll-node.mjs
 * (wave 5p lane D) so the CLI stays under the 800-line ceiling. Takes the
 * CLI's flags and helpers through `ctx`; never imports the CLI.
 */
import { manifestPath } from './fleet-exec.mjs';
import { landingLine } from './manifest-target.mjs';
import { manifestEdit } from './manifest-edit.mjs';

/**
 * Commit `measured` as `name`'s manifest entry (or refresh its measured
 * fields, if `exists`), mutating `result` with `landed` — the same shape the
 * CLI built inline. Dies on a writer refusal, exactly as the CLI did inline.
 */
export async function commitManifestEntry(
	ctx,
	result,
	{ measured, name, exists, hardwareChanges }
) {
	const { NO_PUSH, log, warn, die } = ctx;
	const MANIFEST = manifestPath();
	// `manifestEdit` (scripts/lib/manifest-edit.mjs, wave 5c F4) owns asking
	// `writeTarget` BEFORE anything is written — the refusal this most needs to
	// make is the deploy tree, where the write SUCCEEDS, reads back true, and is
	// erased at the next publish — plus the fresh read, the atomic write, the
	// read-back comparison and `landWrite`. This closure only decides what the
	// entry should become.
	const editResult = await manifestEdit(
		(freshDoc) => {
			freshDoc.machines ??= {};
			// A FRESH TRUTH, not the copy read at the top of this script's preview:
			// `manifestEdit` always re-reads right before mutating, closing the
			// window between this script printing its proposal (which may have
			// walked the node over ssh) and actually writing it.
			const exists = Object.prototype.hasOwnProperty.call(freshDoc.machines, name);
			// A hardware change is history: every accepted one is kept, newest last,
			// and rides in $measured so the surgical assignment below stays one line.
			const priorChanges = freshDoc.machines[name]?.$measured?.hardwareChanges ?? [];
			if (priorChanges.length || hardwareChanges.length)
				measured.$measured.hardwareChanges = [...priorChanges, ...hardwareChanges];
			if (exists) {
				// SURGICAL, AND THAT NOW COVERS THE OTHER SUPPLY FACETS TOO.
				//
				// `machines[node]` carries four independently provenanced `{at, by, ...}`
				// siblings — `$measured` (here), `$benchmark` (`fleet benchmark --write`),
				// `$capabilities` (`fleet bootcamp --write`) and `$health` (`fleet doctor
				// --write`, added 2026-09-10). This branch assigns THREE NAMED FIELDS rather
				// than replacing the entry, so each of the other three facets survives a
				// re-enroll untouched: a `--update` run re-measures cores and RAM and has
				// nothing to say about whether the box is hot, what it has proved, or how
				// fast it is. Replacing the entry here would silently delete a thermal and
				// SMART record nothing else can reconstruct — `fleet doctor` would have to
				// load the box for another minute to get it back, and until it did the
				// inventory page would show a node with no health at all, which reads as
				// "nothing is wrong" for the exact reason CLAUDE.md forbids.
				//
				// Pinned by `doctor-write.test.mjs`'s source guard, so a later rewrite of
				// this branch into a spread cannot quietly drop a facet.
				const current = freshDoc.machines[name];
				current.cores = measured.cores;
				current.ramGb = measured.ramGb;
				current.$measured = measured.$measured;
			} else {
				freshDoc.machines[name] = measured;
			}
			// `--write`/`--update` always has something to record: the measurement
			// itself, even when every value is unchanged from last time.
			return true;
		},
		{
			target: MANIFEST,
			writer: 'enroll',
			reason: `${exists ? 'refresh' : 'declare'} ${name}`,
			push: !NO_PUSH,
		}
	);

	if ('ok' in editResult && editResult.ok === false) {
		die(editResult.why, { refusal: editResult.reason });
	}
	if (editResult.formatter === null) {
		warn(
			`the manifest was written UNFORMATTED: no prettier could be resolved from ` +
				`${MANIFEST}'s own tree, so this is plain JSON.stringify output. The entry is ` +
				`correct and saved; the owning repo's format:check will very likely reject the ` +
				`file until it is run through prettier there.`
		);
	}

	// AND NOW MAKE IT SURVIVE. A declaration that is not on main is a declaration
	// the deployed fleet cannot see, and every step this command tells the operator
	// to run next resolves the node through that file.
	const landed = editResult.landed;
	result.landed = landed;
	if (!landed.ok) {
		warn(`the manifest entry for ${name} is NOT on main — ${landed.why}`);
	} else {
		log(landingLine(landed, { writer: 'enroll' }));
	}
}
