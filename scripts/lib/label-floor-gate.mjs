/**
 * check-label-floor's derivation check, JSON document builder and
 * exit-branch guards (scripts/check-label-floor.mjs, wave 5m lane D split
 * #21, extended past the first pass to clear the operator's 800-line
 * file-size ceiling). Each guard is the SAME `if (condition) { diagnose;
 * emit the doc; process.exit(1); }` body the CLI ran inline, wrapped in a
 * function so it can live here; `ctx.finish(verdict, extra)` — built in the
 * CLI, see its own header — is what actually emits and exits, so the
 * `if (JSON_OUT)` branch `json-contract.mjs` scans for is real code in the
 * CLI file, not here. `process.exit()` is a global call and works
 * identically from inside a function, so nothing about the exit sequence
 * changes. The CLI calls each of these, in the same order, in place of the
 * `if` it used to run directly.
 *
 * Everything these need from the CLI's run — `manifest`, `holdings`,
 * `demandSources`, every computed array and the mutable `gateFindings`/
 * `gateUnreadable` ledgers — is passed in explicitly as ONE context object
 * (`ctx`) the CLI builds once, after every value it holds has been computed
 * and before the first guard is called. This module never imports anything
 * out of `check-label-floor.mjs`: that reverse import used to work only by
 * load order (the CLI's top-level bindings are assigned once and never
 * reassigned, so the live binding each guard closed over happened to be
 * correct by the time the CLI actually called it) and pointed the dependency
 * the wrong way — a lib importing the CLI that imports the lib. `ctx` is the
 * explicit version of the same data flow, with the CLI as the one place that
 * assembles it.
 */
import { join } from 'node:path';
import { stateDir } from './paths.mjs';
import { buildGateDoc } from './gate-doc.mjs';
import { mintsJitRunners } from '../../dist/lib/node-role.js';
import { BUILDER_LABEL } from '../../dist/runners/census.js';
import { RETENTION_DAYS } from '../../dist/job-history-store.js';
import { eligibilityLabels } from '../../dist/lib/capability-labels.js';
import { offerersOf, declarationIsRight, derivedByEarning } from './label-floor-check.mjs';

/**
 * THE DERIVATION AND THE MINT MUST AGREE — issue #19, as a gate.
 *
 * This is the half the issue calls "arguably the more urgent". With
 * `hadoku-builder` stripped from all nine machine entries, `fleet label-floor`
 * exited 0 and printed "label floor covers every routing dependency" on a
 * manifest where nothing declared the fleet's primary routing label — because
 * `holdings` and `offerersOf` re-added it for every eligible node. Demand
 * derivation made the declarations inert TO THE GATE and left them load-bearing
 * to the FLEET, and removed the only signal that would have caught it. That is
 * CLAUDE.md's rule inverted: a gate that gets easier to pass the worse the
 * failure gets.
 *
 * So three questions, each of which FAILS the gate and names the node:
 *
 *  1. CAN THE DERIVATION LOOK AT ALL? No `$capabilities`, or a facet with no
 *     `earned` array, means `nodeOffer` falls back to the declaration — the only
 *     safe direction, since the alternative strips `av1-nvenc` off hokon on an
 *     unreadable record. Safe is not silent: "I could not look" must never
 *     render as "nothing is wrong".
 *  2. HAS THE PRODUCER RUN? `earned` is the proof set as of 2026-09-10; a node
 *     whose `earned` does not contain every `prereqs` id is carrying a record
 *     written under the OLD semantics (`proven ∩ declared` among probeable label
 *     capabilities, which for this fleet meant `[]` on every claw). The
 *     derivation still works — `provenCapabilities` reads the union as a bridge —
 *     but the field the claw floor ranks on is empty, and nothing else would say
 *     so. Clears itself on the next `fleet bootcamp --write`.
 *  3. DOES THE DERIVED OFFER MATCH WHAT A MINT WOULD PROJECT FROM THE MANIFEST?
 *     A label the manifest declares and the derivation does NOT project is the
 *     dangerous direction: `mintLabels()` would put it on a runner that has not
 *     proven it, or — read the other way — the derivation is about to stop
 *     projecting a label the fleet still routes on. The reverse direction is
 *     reported too, EXCEPT for the labels a declaration was never supposed to
 *     carry — see `declarationIsRight` and `derivedByEarning`.
 *
 * Takes `manifest`/`holdings` explicitly rather than through `ctx`: this is
 * called in the CLI BEFORE `ctx` exists — its result (`derivationFailures`) is
 * itself one of `ctx`'s fields.
 */
export function computeDerivationFailures(manifest, holdings) {
	const ELIGIBILITY = new Set(eligibilityLabels());

	const derivationFailures = [];
	for (const [name, m] of Object.entries(manifest.machines ?? {})) {
		const rec = m.$capabilities;
		if (!rec || !Array.isArray(rec.earned)) {
			derivationFailures.push(
				`${name} — cannot derive its label offer: ${
					rec ? '`$capabilities` carries no `earned` array' : 'no `$capabilities` record at all'
				}. ` +
					`\`nodeOffer\` fell back to the manifest's declared labels ` +
					`(${(m.labels ?? []).join(', ') || '(none)'}), which is the safe direction and not an ` +
					`answer. Run \`fleet bootcamp --write\` against it.`
			);
			continue;
		}
		const earned = new Set(rec.earned);
		const staleProof = (rec.prereqs ?? []).map((p) => p.id ?? p).filter((id) => !earned.has(id));
		if (staleProof.length) {
			derivationFailures.push(
				`${name} — \`$capabilities.earned\` is [${rec.earned.join(', ')}] but the node PROVED ` +
					`${staleProof.join(', ')}. That record was written by the pre-2026-09-10 producer, which ` +
					`promoted only \`proven ∩ declared\` among probeable LABEL capabilities — so the field the ` +
					`claw floor's eligibility input reads is empty on a node that passed every probe. Re-run ` +
					`\`fleet bootcamp --write\`.`
			);
		}
		// A MINT-ONLY LABEL IN `earned` IS THE RECORD LYING.
		//
		// `jit-canary` is proven by MINTING, so bootcamp has no probe that can put it
		// there — a record that carries it was written by something that is not this
		// bootcamp, or by one that promoted a declaration it read. Either way the
		// field the claw floor ranks on now contains a capability nothing executed,
		// and the fleet's one guarantee that the dispatcher works starts resting on a
		// declaration again. This is the direction the marker EXISTS to catch; the
		// declared-but-not-derived side it merely keeps quiet.
		for (const l of rec.earned) {
			if (!declarationIsRight(l)) continue;
			derivationFailures.push(
				`${name} — \`$capabilities.earned\` carries "${l}", which is MINT-ONLY: no probe can ` +
					`prove it, so bootcamp cannot have earned it. A record that claims it turns the one ` +
					`label that proves the dispatcher works back into a declaration. Re-run ` +
					`\`fleet bootcamp --write\` against it and find out what wrote that record.`
			);
		}
		const declared = m.labels ?? [];
		const derived = holdings[name];
		const lost = declared.filter((l) => !derived.includes(l) && !declarationIsRight(l));
		// A mint-only label (`jit-canary`) is DERIVED from the node's facts by
		// `nodeOffer` since 2026-10-09 — undeclared is the design, not a reader
		// still reading `labels`.
		const added = derived.filter(
			(l) =>
				!declared.includes(l) &&
				!ELIGIBILITY.has(l) &&
				!derivedByEarning(l, earned) &&
				!declarationIsRight(l)
		);
		for (const l of lost) {
			derivationFailures.push(
				`${name} — declares "${l}" and its derived offer does NOT carry it. A mint from the ` +
					`manifest would project a label the node has not proven; the derivation refuses it. ` +
					`bootcamp ${rec.at ?? '(undated)'} earned [${rec.earned.join(', ') || 'nothing'}].`
			);
		}
		for (const l of added) {
			derivationFailures.push(
				`${name} — its derived offer carries "${l}" and the manifest does not declare it, so a ` +
					`mint taken from the declared array alone would be missing it. Either the declaration ` +
					`was removed without this package being deployed, or a reader still reads \`labels\`.`
			);
		}
	}
	return derivationFailures;
}

/**
 * THE `--json` DOCUMENT, as a pure builder — no side effect, no exit.
 *
 * `verdict` is what the gate concluded, `transitions` and `holdings` ride on
 * EVERY outcome — a demotion is exactly as worth reviewing on a run that
 * failed for some other reason. Emitting it, and deciding the exit code, is
 * `ctx.finish`'s job (built in the CLI): this stays a builder so the CLI's own
 * `if (JSON_OUT) emitter.emit(buildJsonDoc(...))` is the literal, functioning
 * branch `json-contract.mjs`'s `emitsJson` structural check scans the CLI
 * file for — a check that reads one file and cannot see through a call into
 * this lib, so the branch has to be real and present THERE, not just here.
 */
export function buildJsonDoc(ctx, verdict, extra = {}) {
	return {
		ok: verdict === 'ok',
		verdict,
		dependencies: ctx.dependencies,
		unoffered: ctx.unoffered,
		missing: ctx.missing,
		servedByMintOnly: [...ctx.servedByMintOnly],
		runtimeWatched: [...ctx.runtimeWatched],
		floorDemandPath: ctx.FLOOR_DEMAND_PATH,
		floorDemandWriteError: ctx.floorDemandWriteError,
		persistedStaticError: ctx.persistedStaticError,
		unread: ctx.unread,
		noWorkflows: ctx.noWorkflows,
		unresolvable: ctx.unresolvable,
		demandSources: ctx.demandSources,
		historical: ctx.historical.map((l) => ({
			label: l,
			observed: ctx.demandSources[l].observed,
			lastObserved: ctx.observed?.last.get(l) ?? null,
		})),
		observedRows: ctx.observed?.rows ?? null,
		observedMalformed: ctx.observed?.malformed ?? null,
		observedError: ctx.observedError,
		transitions: ctx.transitions,
		holdings: ctx.holdings,
		holdingsPath: ctx.HOLDINGS_PATH,
		holdingsError: ctx.holdingsError,
		requiredSet: [...ctx.requiredSet].sort(),
		derivationFailures: ctx.derivationFailures,
		contractVerdicts: ctx.contractVerdicts,
		eligible: ctx.eligibleNodes,
		disqualified: ctx.disqualifiedNodes,
		unverified: ctx.unverifiedNodes,
		held: ctx.emitter.held(),
		...extra,
		// GateDoc (wave 5i lane B). `ok` is pinned to `verdict` explicitly —
		// the SAME source of truth every branch below already used for its
		// exit code — rather than left to `buildGateDoc`'s own array-emptiness
		// default, so a branch that pushed nothing into either array (there is
		// none today) could never silently read as a clean pass.
		...buildGateDoc({
			findings: ctx.gateFindings,
			unreadable: ctx.gateUnreadable,
			ok: verdict === 'ok',
		}),
	};
}

// A repo not on disk is a repo whose labels were NOT READ, and a gate that could
// not look must never report success — that is how this one passed on its first
// run having examined a single repository. Reported as a failure, with the
// resolved path, so the cause is visible rather than inferred.
export function checkUnread(ctx) {
	if (ctx.unread.length) {
		console.error(
			`✗ ${ctx.unread.length} fleet repo(s) whose shipped workflows could not be read:`
		);
		for (const name of ctx.unread) console.error(`  ${name}: ${ctx.unreadWhy.get(name)}`);
		console.error(
			`\n  This gate reads workflow labels from each repo's default branch. Unreadable ones\n` +
				`  mean their labels were not examined, so a pass here would be meaningless.`
		);
		for (const name of ctx.unread)
			ctx.gateUnreadable.push({ node: name, why: ctx.unreadWhy.get(name) });
		ctx.finish('unread');
	}
}

// AN EMPTY ROSTER READ ONLY THE SITE, and passed. The coverage file is
// generated; one that lists no repo is a failed generation, not a fleet with
// one repo in it.
export function checkEmptyRoster(ctx) {
	if (!ctx.coveredRepos.length) {
		console.error(
			`✗ ${ctx.COVERAGE} lists no covered repos — this gate would have read only the site checkout\n` +
				`  and called that the fleet's demand. Regenerate it with \`fleet reconcile --write-coverage\`.`
		);
		ctx.gateFindings.push({
			node: null,
			kind: 'empty-roster',
			reason: `${ctx.COVERAGE} lists no covered repos`,
		});
		ctx.finish('empty-roster');
	}
}

export function checkNoWorkflows(ctx) {
	if (ctx.noWorkflows.length) {
		console.error(
			`✗ ${ctx.noWorkflows.length} covered repo(s) ship no .github/workflows on their default branch:\n` +
				`  ${ctx.noWorkflows.join(', ')}\n\n` +
				`  A covered repo is covered because its workflows run on the fleet, so its demand\n` +
				`  was not read.`
		);
		// Could not look, by this gate's own reasoning above: a missing workflows
		// directory on a covered repo's default branch is "the same 'could not
		// look' as an unreadable repo", never a finding.
		for (const name of ctx.noWorkflows)
			ctx.gateUnreadable.push({
				node: name,
				why: 'ships no .github/workflows on its default branch',
			});
		ctx.finish('no-workflows');
	}
}

export function checkUnresolvable(ctx) {
	if (ctx.unresolvable.length) {
		console.error(`✗ ${ctx.unresolvable.length} job(s) whose \`runs-on\` resolves to no label:\n`);
		for (const u of ctx.unresolvable) console.error(`  unresolvable runs-on in ${u}`);
		console.error(
			`\n  A \`runs-on\` this gate cannot read is demand it did not count. It is a finding, not\n` +
				`  "this job asks for nothing" — a scope that shrinks on a shape the reader does not\n` +
				`  know is how the old reader missed \`jdk21\` and \`cargo-bevy\`. Teach\n` +
				`  scripts/lib/runs-on-demand.mjs the shape, or write the labels as a JSON array literal.`
		);
		// A finding, not "could not look" — this file's own comment above.
		for (const u of ctx.unresolvable)
			ctx.gateFindings.push({
				node: null,
				kind: 'unresolvable-runs-on',
				reason: `unresolvable runs-on in ${u}`,
			});
		ctx.finish('unresolvable-runs-on');
	}
}

export function checkObservedError(ctx) {
	if (ctx.observedError) {
		console.error(`✗ observed demand: ${ctx.observedError}.`);
		console.error(
			`\n  The labels jobs actually requested are half of this gate's scope; without them only\n` +
				`  the static read of the workflows counts, and a \`runs-on\` resolved at run time is\n` +
				`  invisible. Point HADOKU_STATE_DIR at mgmt-api's state directory.`
		);
		ctx.gateUnreadable.push({ node: null, why: `observed demand: ${ctx.observedError}` });
		ctx.finish('observed-unreadable');
	}
}

export function reportHistorical(ctx) {
	if (ctx.historical.length) {
		ctx.log(
			`historical demand only (${ctx.historical.length}) — nothing offers it and no shipped workflow asks for it:`
		);
		for (const l of ctx.historical) {
			ctx.log(
				`  "${l}" — ${ctx.demandSources[l].observed} job(s) in ${RETENTION_DAYS}d, last ${ctx.observed?.last.get(l) ?? '?'}; ` +
					`ages out of the window`
			);
		}
	}
}

export function checkUnoffered(ctx) {
	if (ctx.unoffered.length) {
		console.error(`✗ ${ctx.unoffered.length} routing dependency NOTHING in the fleet offers:\n`);
		for (const l of ctx.unoffered) {
			console.error(
				`  "${l}" — a covered repo's workflow asks for it and no machine declares it,\n` +
					`    earned it in bootcamp, or is eligible for it. A job on this label is not\n` +
					`    slow, it is UNPLACEABLE — it queues until somebody cancels it, which is the\n` +
					`    854 minutes hadoku-games-host sat for 32 seconds of work.`
			);
		}
		console.error(
			`\n  Fix: give a machine the capability (\`fleet bootcamp --write\` once it can prove it),\n` +
				`  or stop the workflow asking for it. This gate deliberately does NOT drop the label\n` +
				`  from its dependency set just because nothing offers it — that is how a gate gets\n` +
				`  easier to pass the worse the fleet gets.`
		);
		for (const l of ctx.unoffered)
			ctx.gateFindings.push({
				node: null,
				kind: 'unoffered',
				reason: `"${l}" — a covered repo's workflow asks for it and nothing in the fleet offers it`,
			});
		ctx.finish('unoffered');
	}
}

export function checkMissing(ctx) {
	if (ctx.missing.length) {
		console.error(
			`✗ the runtime label floor will not see ${ctx.missing.length} routing dependency:\n`
		);
		for (const l of ctx.missing) {
			const asked = ctx.demandSources[l];
			console.error(
				`  "${l}" — requested (${asked.static.length} job(s) in workflows, ${asked.observed} ` +
					`observed in ${RETENTION_DAYS}d) and offered by ${offerersOf(ctx.manifest, ctx.holdings, l).join(', ')}, but runner-health\n` +
					`    watches observed demand plus ${ctx.FLOOR_DEMAND_PATH}, and this label is in neither, so\n` +
					`    the last runner offering it can go dark with no alert. That is exactly how taskauto\n` +
					`    queued for 6h45m on 2026-08-26.`
			);
		}
		console.error(
			`\n  Fix: the persisted static demand is ${
				ctx.floorDemandWriteError
					? `UNWRITABLE (${ctx.floorDemandWriteError})`
					: ctx.persistedStaticError
						? `unreadable (${ctx.persistedStaticError})`
						: 'out of date'
			}. Make ${ctx.FLOOR_DEMAND_PATH} writable and re-run.`
		);
		for (const l of ctx.missing)
			ctx.gateFindings.push({
				node: null,
				kind: 'missing',
				reason: `"${l}" is requested and offered but the runtime label floor will not see it`,
			});
		ctx.finish('missing');
	}
}

export function checkResidentFailures(ctx) {
	if (ctx.residentFailures.length) {
		console.error(`✗ resident backstop floor: ${ctx.residentFailures.length} problem(s):\n`);
		for (const f of ctx.residentFailures) console.error(`  ${f}`);
		console.error(
			`\n  Fix: see "the resident backstop" in @wolffm/fleet-manager's docs/VOCABULARY.md\n` +
				`  for how to move it — edit the two \`residentRepos\` entries, ` +
				`\`fleet reconcile --confirm\`,\n  then verify against the GitHub API, not the manifest.`
		);
		ctx.finish('resident-backstop', { residentFailures: ctx.residentFailures });
	}
}

export function checkLedgerError(ctx) {
	if (ctx.ledgerError) {
		console.error(`✗ could not read the demand ledger: ${ctx.ledgerError}`);
		console.error(
			`\n  \`hadoku-builder\`'s required set is derived from ` +
				`${join(stateDir(), 'demand-ledger.jsonl')}, and a ledger this gate cannot fully\n` +
				`  parse must not silently under-count demand and pass. Fix or regenerate it with\n` +
				`  \`fleet tool-inventory --write\`.`
		);
		ctx.gateUnreadable.push({
			node: null,
			why: `could not read the demand ledger: ${ctx.ledgerError}`,
		});
		ctx.finish('ledger-unreadable', { ledgerError: ctx.ledgerError });
	}
}

export function checkLedgerMissing(ctx) {
	if (!ctx.ledgerRecords) {
		console.error(`✗ no demand ledger at ${join(stateDir(), 'demand-ledger.jsonl')}`);
		console.error(
			`\n  \`hadoku-builder\`'s required set (P1.2/P1.3) is derived from it, and this gate\n` +
				`  cannot check the required-set floor without it. Run \`fleet tool-inventory --write\`\n` +
				`  first.`
		);
		ctx.gateUnreadable.push({
			node: null,
			why: `no demand ledger at ${join(stateDir(), 'demand-ledger.jsonl')}`,
		});
		ctx.finish('ledger-missing');
	}
}

// A LEDGER THAT PARSED AND ASKED FOR NOTHING IS THE THIRD CASE, and it used to
// be the silent one: `unprovenRequired` returns `[]` for an empty set, so the
// gap check below passed having checked nothing. Every node clears a bar of
// zero. Settled in wave 3a — an empty required set is a failure, not a pass —
// and it is now the SAME refusal the fast loop makes (`nodeFailsBootcamp`),
// so the gate and the loop agree about a bar neither can enforce.
export function checkEmptyRequired(ctx) {
	if (ctx.emptyRequired) {
		console.error(`✗ ${ctx.emptyRequired}`);
		ctx.gateFindings.push({ node: null, kind: 'required-set-empty', reason: ctx.emptyRequired });
		ctx.finish('required-set-empty', { emptyRequired: ctx.emptyRequired });
	}
}

export function checkRequiredGaps(ctx) {
	if (ctx.requiredGaps.length) {
		console.error(`✗ ${ctx.requiredGaps.length} demanded capability no node proves:\n`);
		for (const id of ctx.requiredGaps) {
			console.error(
				ctx.knownProbeableIds.has(id)
					? `  "${id}" — the demand ledger says a covered repo's job needs it on the general\n` +
							`    pool, and no node's \`fleet bootcamp --write\` finding proves it. That is\n` +
							`    the shape of the 2026-09-02 claw-5/claw-6 outage: registered, carrying\n` +
							`    hadoku-builder, no Python tool cache at all.`
					: `  "${id}" — the demand ledger asks for it and NOTHING in src/lib/capability-registry*.ts\n` +
							`    registers it, so no probe can ever prove it. Both python-toolcache/\n` +
							`    playwright/ffmpeg started exactly here before a job died on them.`
			);
		}
		console.error(
			`\n  Fix: run \`fleet bootcamp --write\` on a node that should carry it, or — if it is\n` +
				`  genuinely new — register it in src/lib/capability-registry*.ts and add it to\n` +
				`  \`toolchain.capabilities\` in fleet-runner-manifest.json.`
		);
		for (const id of ctx.requiredGaps)
			ctx.gateFindings.push({
				node: null,
				kind: 'required-gap',
				reason: `"${id}" is demanded and no node proves it`,
			});
		ctx.finish('required-gap', { requiredGaps: ctx.requiredGaps });
	}
}

export function checkDerivationFailures(ctx) {
	if (ctx.derivationFailures.length) {
		console.error(
			`✗ the derived label offer and the manifest disagree on ${ctx.derivationFailures.length} point(s):\n`
		);
		for (const f of ctx.derivationFailures) console.error(`  ${f}`);
		console.error(
			`\n  WHY THIS FAILS THE GATE (issue #19). The manifest's \`labels\` array is the JIT\n` +
				`  mint's label WRITER — fleet-loop -> ephemeral-tick -> dispatch-pass ->\n` +
				`  mintLabels() — and it is ALSO read by placement and by floor-probe. Since\n` +
				`  2026-09-10 src/lib/capability-offer.ts's \`nodeOffer\` derives that set from\n` +
				`  \`$capabilities.earned\` instead. If the two disagree, one of them is wrong about\n` +
				`  what GitHub will see, and the symptom is jobs queueing silently while this gate\n` +
				`  reports a healthy fleet — which is exactly what it did on a stripped manifest\n` +
				`  before this check existed.\n\n` +
				`  Fix: run \`fleet bootcamp --write\` against the node(s) named above, then re-run.`
		);
		for (const f of ctx.derivationFailures)
			ctx.gateFindings.push({ node: null, kind: 'derivation-disagreement', reason: f });
		ctx.finish('derivation-disagreement', { derivationFailures: ctx.derivationFailures });
	}
}

export function reportSuccess(ctx) {
	ctx.log(
		`✓ label floor covers every routing dependency: ${ctx.dependencies.join(', ') || '(none)'}` +
			`\n  floor model: each is served by a standing online runner OR an eligible minting node that offers it:` +
			ctx.dependencies
				.map((l) => {
					const offerers = offerersOf(ctx.manifest, ctx.holdings, l);
					const minting = offerers.filter((n) => mintsJitRunners(ctx.manifest.machines?.[n]));
					const standing = offerers.filter((n) => !minting.includes(n));
					return `\n    ${l}: standing ${standing.join(', ') || '(none)'}; minting ${minting.join(', ') || '(none)'}`;
				})
				.join('') +
			(ctx.residentHolders.size
				? `\n  (resident backstop: ${[...ctx.residentHolders].map(([r, h]) => `${r} on ${h.join('+')}`).join(', ')})`
				: '') +
			(ctx.servedByMintOnly.size
				? `\n  served by minting alone, by decision (#120): ${[...ctx.servedByMintOnly].sort().join(', ')}`
				: '') +
			`\n  required set (from the demand ledger): ${[...ctx.requiredSet].sort().join(', ') || '(none)'}` +
			(ctx.eligibleNodes.length
				? `\n  ${BUILDER_LABEL} — which nodes hold it and WHY:\n` +
					ctx.eligibleNodes
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((n) => `    ${n.name}: proves ${n.prereqs.join(', ') || '(nothing required)'}`)
						.join('\n')
				: '') +
			(ctx.disqualifiedNodes.length
				? `\n  ${BUILDER_LABEL} — disqualified:\n` +
					ctx.disqualifiedNodes
						.sort((a, b) => a.name.localeCompare(b.name))
						.map(
							(n) =>
								`    ${n.name}: blocked ${n.blocked.join(', ') || '(none)'}, unprobed ${n.unprobed.join(', ') || '(none)'}`
						)
						.join('\n')
				: '') +
			(ctx.unverifiedNodes.length
				? `\n  ${BUILDER_LABEL} — no recorded finding yet (run \`fleet bootcamp --write\`): ` +
					ctx.unverifiedNodes.sort().join(', ')
				: '') +
			// THE CONSUMER CONTRACT, evaluated per node on live data. The rule is
			// settled and enforced by the fast loop (see `contractVerdicts`); this is
			// where the verdict is visible on live data before the next tick acts.
			(ctx.contractVerdicts.length
				? `\n  consumer contract (a node carries ${BUILDER_LABEL} iff it proves the required set):\n` +
					ctx.contractVerdicts
						.map((v) => `    ${v.name}: ${v.ok ? 'proves it' : v.reason}`)
						.join('\n') +
					`\n    ENFORCED by the fast loop since wave 3c §G — \`nodeFailsBootcamp\` asks this` +
					`\n    same predicate, so a node reported here as not proving it is demoted on the` +
					`\n    next tick. A node with NO recorded finding still fails OPEN, by design, and` +
					`\n    is listed above under "no recorded finding yet".`
				: '')
	);
	ctx.finish('ok');
}
