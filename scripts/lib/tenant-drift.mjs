/**
 * IS THE REGISTERED HOSTING REQUEST STILL THE ONE THE APP SHIPS? Asked hourly
 * by `fleet hosting-verify`.
 *
 * The tenant registry is a COPY of each app's `hosting.json`, taken when
 * someone runs `fleet hosting-request <repo> --register`, and nothing compared
 * the two afterwards (the refactor plan's runbook row R9: "registration is
 * manual and the copy goes stale"). A request changed in the app repo did
 * nothing until somebody re-registered it, and nothing said so. Operator,
 * 2026-11-04: one source of truth. The app's shipped `hosting.json` is it; the
 * registry is the fleet's cache of it.
 *
 *   same       nothing to do.
 *   changed    the shipped request is VALID and differs: re-register it (the
 *              caller does), and name every field that moved.
 *   invalid    the shipped request fails validation: keep the last valid copy,
 *              and FAIL with the problems; an app may not unplace itself with
 *              a typo.
 *   unknown    the registered entry names no repo source (a local path), so
 *              there is nothing to compare: say so.
 *
 * PURE: the caller reads the shipped text.
 */
import { validateHostingRequest } from './hosting-request.mjs';

/** `owner/name` from a registry `source` of `owner/name:hosting.json`, or null. */
export function repoOfSource(source) {
	const m = /^([\w.-]+\/[\w.-]+):hosting\.json$/.exec(String(source ?? ''));
	return m ? m[1] : null;
}

/** Every leaf path whose value differs between two requests. */
export function changedFields(a, b, prefix = '') {
	const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
	const out = [];
	for (const k of [...keys].sort()) {
		const x = a?.[k];
		const y = b?.[k];
		const p = prefix ? `${prefix}.${k}` : k;
		const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
		if (obj(x) && obj(y)) out.push(...changedFields(x, y, p));
		else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p);
	}
	return out;
}

/**
 * @param {{request: object, source?: string}} entry  one registry entry
 * @param {string|null} shippedText  the app's shipped hosting.json, or null if it ships none
 * @returns {{verdict: 'same'|'changed'|'invalid'|'unknown', fields?: string[], request?: object, problems?: object[], why?: string}}
 */
export function judgeTenantDrift(entry, shippedText) {
	if (!repoOfSource(entry.source)) {
		return {
			verdict: 'unknown',
			why: `registered from ${entry.source ?? 'an unrecorded source'}, not an app repo: nothing to compare against`,
		};
	}
	if (shippedText === null || shippedText === undefined) {
		return { verdict: 'invalid', problems: [], why: `${entry.source} is not shipped any more` };
	}
	let raw;
	try {
		raw = JSON.parse(shippedText);
	} catch (err) {
		return { verdict: 'invalid', problems: [], why: `${entry.source} is not JSON: ${err.message}` };
	}
	const { ok, request, problems } = validateHostingRequest(raw);
	if (!ok) {
		return {
			verdict: 'invalid',
			problems,
			why:
				`${entry.source} fails validation (${problems.map((p) => `${p.path || '(root)'}: ${p.why}`).join('; ')}); ` +
				'the last valid registration stands',
		};
	}
	const fields = changedFields(entry.request, request);
	return fields.length ? { verdict: 'changed', fields, request } : { verdict: 'same' };
}
