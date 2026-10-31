/**
 * manifest-edit — the one transactional writer of `fleet-runner-manifest.json`
 * (refactor plan §4.1 F4, wave 5c lane B).
 *
 * WHY THIS EXISTS
 * ----------------
 * Before this file, FOUR scripts each re-implemented the same six steps by
 * hand — `bootcamp.mjs` (1208-1371), `provision-fleet.mjs` (447-650, inside
 * `applyPlacementWrite`), `enroll-node.mjs` (849-979) and `lan-reserve.mjs`
 * (131-149) — and the four copies had already drifted (see the divergence
 * table below): two wrote with a bare `writeFileSync` and no atomicity at
 * all (`provision-fleet.mjs:482`, `lan-reserve.mjs:132` — `F3-non-atomic`
 * debt), one restored a `.bak` on a read-back mismatch and the others did
 * not, and the refusal/landing prose differed line by line though the
 * manifest is the same file. This is the fleet's HIGHEST-RISK write path
 * (plan §4.1 F4, "tag bug"), so drift here is not a style question.
 *
 * THE SIX STEPS, IN ONE PLACE
 * ---------------------------
 *   1. `writeTarget(target)` — the deploy-tree / not-a-checkout / dirty
 *      refusal, asked BEFORE anything is read or written (manifest-target.mjs:
 *      a write into `~/srv/hadoku_site` would succeed, read back true, and be
 *      erased at the next publish with nothing said).
 *   2. A FRESH read through `readManifestState` (`dist/lib/manifest.js`, F1's
 *      TS-side canonical) — never the caller's own stale copy. `tx` always
 *      mutates the manifest as it is RIGHT NOW, closing the TOCTOU window
 *      every one of the four writers left open (each read once at the top of
 *      its script and mutated that same in-memory copy, however much ssh
 *      traffic happened in between).
 *   3. `tx(doc)` — the caller's own mutation, in place. Returns `true` when it
 *      changed something that needs writing, `false` when there is nothing
 *      to do (lan-reserve's `same`, bootcamp's `recorded && !changed`,
 *      provision's `wrote.length === 0`), and MAY THROW to refuse the edit for
 *      a business reason (enroll's "the manifest changed since this run
 *      started") — the throw becomes `{ok:false, reason:'tx-refused', why}`,
 *      never an uncaught exception.
 *   4. `renderJson(doc, target)` — the owning repo's own prettier (#12).
 *      Never thrown: an unresolvable prettier degrades to plain
 *      `JSON.stringify` output and the caller is told via `formatter: null`.
 *   5. `writeFileAtomic(target, rendered.text)` (`dist/lib/atomic-json.js`,
 *      since wave 5b) — temp file in the same directory, fsync'd, renamed
 *      over the target, directory fsync'd after. A crash between the write
 *      and the rename leaves the OLD manifest intact; see
 *      `manifest-edit.test.mjs`'s fault-injection proof, 5b's technique.
 *      This is the one change that makes EVERY writer atomic: three of the
 *      four previously wrote with a bare `writeFileSync` straight to the
 *      live path (F3-non-atomic debt), and the fourth (enroll-node.mjs) did
 *      not either.
 *   6. Read back through `readManifestState` again, and compare it against
 *      the document `tx` produced. A mismatch REFUSES to land — nothing is
 *      committed — rather than trusting that what was written is what is on
 *      disk, which is the exact "a verifier that reads its own writer's
 *      artifact cannot fail" shape CLAUDE.md names. The mismatched bytes are
 *      also RESTORED to the original (pre-edit) text, atomically, rather than
 *      left sitting uncommitted in the checkout for the next writer's
 *      `landWrite` to fold in under its own subject. Then `landWrite` (commit
 *      + push, with the ancestor-test guard `manifest-target.mjs` already
 *      has).
 *
 * THE CONTRACT: exactly one of
 *   `{changed: false}`                        — `tx` found nothing to change;
 *                                                nothing was read a second
 *                                                time, rendered, written or
 *                                                landed.
 *   `{changed: true, landed, formatter}`      — written, read back
 *                                                byte-identical to what `tx`
 *                                                produced, and handed to
 *                                                `landWrite`. `landed.ok` may
 *                                                still be `false` (a push
 *                                                race, a detached checkout) —
 *                                                the caller must check it,
 *                                                the same as every writer
 *                                                already did.
 *   `{ok: false, reason, why}`                — refused before landing.
 *                                                `reason` is one of
 *                                                `writeTarget`'s own
 *                                                (`deploy-tree`|
 *                                                `not-a-checkout`|`dirty`|
 *                                                `split-repo`), or
 *                                                `read-failed` (the manifest
 *                                                could not be read before
 *                                                editing — F1's "I could not
 *                                                look" never becomes "it is
 *                                                empty"), `tx-refused` (`tx`
 *                                                threw), `write-failed` (the
 *                                                atomic write itself threw —
 *                                                propagated here rather than
 *                                                out of this function, so
 *                                                every caller has ONE branch
 *                                                for "this did not happen"),
 *                                                or `readback-mismatch` (the
 *                                                file on disk after writing
 *                                                is not the document `tx`
 *                                                produced — the original is
 *                                                restored before returning,
 *                                                and `why` says whether that
 *                                                restore itself succeeded).
 *
 * "NOTHING TO CHANGE" IS NEVER "REFUSED" (done-when, wave 5c §B). The two are
 * both callers of this function, never a single return shape: `changed:
 * false` carries no `why` at all, and `ok:false` is never returned when `tx`
 * simply had nothing to do.
 *
 * WHY `readManifestState`, NOT `scripts/lib/fleet-exec.mjs`'s `loadManifest`
 * -----------------------------------------------------------------------
 * Both are canonical readers (F1 names exactly these two files as allowed to
 * spell `fleet-runner-manifest.json`). `loadManifest` returns the parsed
 * document or THROWS raw — it carries no distinction between "the directory
 * could not be resolved", "the file could not be read" and "the file is not
 * valid JSON", which is exactly the collapse CLAUDE.md forbids ("a rate
 * limit, a timeout and a deleted repo are three different jobs"). This is
 * the write path CLAUDE.md names as the highest-risk one in the fleet, so it
 * takes the reader that already keeps those three apart
 * (`ManifestReadResult`, `src/lib/manifest.ts`) and carries `why` all the way
 * out to `manifestEdit`'s own `{ok:false, why}` — never silently re-collapsed
 * back into one string the way a bare `catch` would. `readManifestState`'s
 * `dir` parameter is the escape hatch written for exactly this caller: a
 * standalone script has not called `createFleetManager`/`installHost`, so it
 * cannot ask the host-layer `manifestDir()` `readManifestState()` defaults to
 * — it resolves its own directory (`scripts/lib/paths.mjs`, which already
 * honours `FLEET_MANIFEST_DIR`) and hands it in.
 *
 * `target` IS A PARAMETER, NOT RESOLVED HERE. This is deliberately the
 * opposite of `loadManifest`/`readManifestState`'s own zero-argument default:
 * every caller already computes the path once (`manifestPath()` from
 * `fleet-exec.mjs`) to pass to `writeTarget`/`landWrite` today, and handing
 * the SAME value in here is one fewer place that path could diverge. It also
 * keeps this module free of the literal filename — `scripts/lib/f-guards/
 * f1-guard.test.mjs`'s allowlist names exactly two files, and this is not
 * one of them on purpose: a transactional editor that happened to also
 * re-derive "which manifest" would be a third place that answer could rot.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { readManifestState } from '../../dist/lib/manifest.js';
import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { MANIFEST_FILE } from './fleet-exec.mjs';
import { landWrite, refusalLine, writeTarget } from './manifest-target.mjs';
import { renderJson } from './prettier-json.mjs';

/*
 * `MANIFEST_FILE` comes from the canonical resolver (`fleet-exec.mjs`), never
 * spelled here. `readManifestState(dir)` always resolves exactly that basename
 * inside `dir` — it is not told `target`, only the directory `target` sits in —
 * so a `target` under any OTHER name would let STEP 2 and STEP 6 silently read
 * a DIFFERENT file than the one STEP 5 wrote. Asserted once, at the top of
 * {@link manifestEdit}.
 */

/**
 * @param {(doc: object) => boolean} tx mutates `doc` in place; returns `true`
 *   when it changed something that needs writing. May throw to refuse the
 *   edit for a business reason.
 * @param {{ target: string, writer: string, reason: string | (() => string),
 *           push?: boolean }} opts `target` is the absolute path to
 *   `fleet-runner-manifest.json`, already resolved by the caller. `writer` is
 *   the name that goes into the commit subject and every refusal/landing
 *   line. `reason` is `landWrite`'s commit summary — a function is evaluated
 *   ONLY once `tx` has returned `true`, so it may read values `tx` computed
 *   as a side effect (a changed-record count, which node was touched).
 *   `push` defaults to `true`; `false` runs the whole chain but never
 *   pushes, same as every writer's own `--no-push`.
 * @returns {Promise<
 *   { changed: false } |
 *   { changed: true, landed: ReturnType<typeof landWrite>, formatter: string | null } |
 *   { ok: false, reason: string, why: string }
 * >}
 */
export async function manifestEdit(tx, { target, writer, reason, push = true } = {}) {
	if (!target) throw new TypeError('manifestEdit: target (the manifest file path) is required');
	if (!writer) throw new TypeError('manifestEdit: writer is required');
	if (basename(target) !== MANIFEST_FILE) {
		throw new TypeError(
			`manifestEdit: target must be a ${MANIFEST_FILE} path — readManifestState(dirname(target)) ` +
				`always reads exactly that filename regardless of what target is actually called, so ` +
				`the STEP 6 verify would silently check a DIFFERENT file than the one STEP 5 wrote. Got: ${target}`
		);
	}

	// STEP 1 — ASKED BEFORE ANYTHING IS READ OR WRITTEN. The refusal this most
	// needs to make is the deploy tree, where the write would SUCCEED, read
	// back true, and be gone at the next publish with nothing said; a read-back
	// check later in this function cannot catch that, only refusing the target
	// up front can.
	const wtarget = writeTarget(target);
	if (!wtarget.ok) {
		return {
			ok: false,
			reason: wtarget.reason,
			// NOT trimmed — bootcamp, enroll and lan-reserve all printed this
			// verbatim (leading blank line included); only provision's own copy
			// trimmed it, and that was the ODD one out among the four, not the
			// rule, so the shared helper keeps the majority's shape.
			why: refusalLine(wtarget, { writer, file: target }),
		};
	}

	// STEP 2 — A FRESH READ, every time. Never the caller's own copy from
	// earlier in its script: closing the TOCTOU window is the whole point of
	// centralising this.
	const dir = dirname(target);
	const before = readManifestState(dir);
	if (!before.ok) {
		return {
			ok: false,
			reason: 'read-failed',
			why: `cannot read ${target} before editing: ${before.why}`,
		};
	}

	// THE RAW BYTES, kept verbatim — never trusted for the edit itself (that is
	// `before.doc`, through the canonical reader above), ONLY kept in case
	// STEP 6's verify disagrees with what `tx` produced and the write needs
	// undoing. `before.ok` just proved `target` reads and parses, so this read
	// is not expected to fail; if it somehow does (a race with another
	// process), that is itself a "could not look" and is reported as one.
	let originalText;
	try {
		originalText = readFileSync(target, 'utf8');
	} catch (err) {
		return {
			ok: false,
			reason: 'read-failed',
			why: `cannot read ${target}'s raw bytes before editing: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// STEP 3 — THE CALLER'S MUTATION. A throw is a refusal, never an
	// uncaught exception reaching a script's caller.
	const doc = before.doc;
	let changed;
	try {
		changed = tx(doc);
	} catch (err) {
		return {
			ok: false,
			reason: 'tx-refused',
			why: err instanceof Error ? err.message : String(err),
		};
	}
	if (!changed) return { changed: false };

	// STEP 4 — RENDERED THE WAY THE OWNING REPO WOULD. Never throws; an
	// unresolvable prettier degrades to plain output and says so via
	// `formatter: null`, which the caller must report (every one of the four
	// old writers already did this check, just inline).
	const rendered = await renderJson(doc, target);

	// STEP 5 — WRITTEN ATOMICALLY. Every one of the four old writers used a
	// bare `writeFileSync` here (three of them with no rename at all —
	// F3-non-atomic debt); this is the one change that makes all four
	// atomic at once. A write failure is a RESULT, not an exception reaching
	// the caller — the same discipline every refusal path above already
	// follows.
	try {
		writeFileAtomic(target, rendered.text);
	} catch (err) {
		return {
			ok: false,
			reason: 'write-failed',
			why: `writing ${target} failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// STEP 6 — READ BACK, AND COMPARED AGAINST WHAT `tx` PRODUCED. A verifier
	// that only re-parses its own writer's artifact (as three of the four old
	// writers did) cannot fail; comparing the parsed document, not merely
	// confirming it parses, is what makes this catch a byte that silently
	// changed in formatting or was overwritten by a racing writer between
	// this write and this read. NOTHING IS LANDED on a mismatch, and the
	// MISMATCHED bytes are not left sitting in the checkout either — restored
	// to `originalText` (the same `writeFileAtomic` the real write used, so the
	// restore is itself crash-safe), because a dirty, uncommitted manifest sat
	// in front of `landWrite` is exactly the shape an UNRELATED later write
	// would fold in and commit under its own subject (the `dirty` refusal this
	// file's STEP 1 already guards against, reached by a different door).
	const restoreOriginal = (why) => {
		try {
			writeFileAtomic(target, originalText);
			return { ok: false, reason: 'readback-mismatch', why: `${why} Restored the original file.` };
		} catch (err) {
			return {
				ok: false,
				reason: 'readback-mismatch',
				why:
					`${why} AND restoring the original failed: ` +
					`${err instanceof Error ? err.message : String(err)}. ${target} now holds the ` +
					'MISMATCHED write, uncommitted — fix it by hand before the next edit.',
			};
		}
	};
	const after = readManifestState(dir);
	if (!after.ok) {
		return restoreOriginal(`the manifest did not read back after writing: ${after.why}.`);
	}
	if (JSON.stringify(after.doc) !== JSON.stringify(doc)) {
		return restoreOriginal(
			`${target} read back differently than what was written — refusing to land.`
		);
	}

	const summary = typeof reason === 'function' ? reason() : reason;
	const landed = landWrite(target, { writer, summary, push });
	return { changed: true, landed, formatter: rendered.formatter };
}
