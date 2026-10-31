/**
 * GateDoc — the shared `--json` shape a migrated `ci:audit-gates` check
 * emits (wave 5f lane B, plan §6.2: "audit-gates' 14 prose gates migrate to
 * GateDoc one at a time"). Mirrors `src/fleet-report-types.ts`'s `GateDoc`
 * interface (wave 5e) field for field:
 *
 *   ok: boolean
 *   findings: { node: string|null, kind: string, reason: string }[]
 *   unreadable: { node: string|null, why: string }[]
 *   why?: string
 *
 * This file cannot import that interface — it is a `.mjs` script and
 * `tsconfig.json` carries no `allowJs`, the same reason `blank-comments.mjs`
 * and friends stay untyped — so `buildGateDoc` is the one place every
 * migrated gate script constructs the shape, instead of five scripts each
 * re-deciding what "why" means when `ok` is false.
 *
 * `findings` and `unreadable` ARE DIFFERENT QUESTIONS (CLAUDE.md: "'I could
 * not look' must never render as 'nothing is wrong'"). `findings` is what the
 * gate LOOKED AT and did not like; `unreadable` is what it could not look at
 * AT ALL. Folding the second into the first, or into a quiet `ok: true`, is
 * exactly the failure CLAUDE.md names — so `ok` defaults to false whenever
 * either array is non-empty, and `why` is never silently dropped on a failing
 * run just because the caller forgot to pass one.
 */

/**
 * @typedef {{ node: string|null, kind: string, reason: string }} GateFinding
 * @typedef {{ node: string|null, why: string }} GateUnreadable
 * @typedef {{ ok: boolean, findings: GateFinding[], unreadable: GateUnreadable[], why?: string }} GateDoc
 */

/**
 * @param {{ findings?: GateFinding[], unreadable?: GateUnreadable[], ok?: boolean, why?: string }} [opts]
 * @returns {GateDoc}
 */
export function buildGateDoc({ findings = [], unreadable = [], ok, why } = {}) {
	const computedOk = ok ?? (findings.length === 0 && unreadable.length === 0);
	/** @type {GateDoc} */
	const doc = { ok: computedOk, findings, unreadable };
	// `why` is never omitted on a failing run (a caller that forgets one would
	// otherwise ship a GateDoc the consumer's "an `error`/`why`/`reason`
	// string must explain every failure" rule cannot read) and never carried
	// on a clean one (its OWN doc comment: optional, present "when not ok").
	if (!computedOk) doc.why = why ?? summarise(findings, unreadable);
	return doc;
}

function summarise(findings, unreadable) {
	const parts = [];
	if (findings.length) parts.push(`${findings.length} finding(s)`);
	if (unreadable.length) parts.push(`${unreadable.length} unreadable`);
	return parts.join(', ') || 'not ok';
}
