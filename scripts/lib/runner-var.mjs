/**
 * Which runs-on form a workflow uses, and what an UNSET `CI_RUNNER` costs it.
 *
 * Pure, so the classification can be tested without a checkout or a token — the
 * checker beside it does the reading.
 *
 * THE TWO FORMS ARE NOT EQUIVALENT WHEN THE VARIABLE IS MISSING, and that is the
 * whole reason this exists:
 *
 *   ${{ fromJSON(vars.CI_RUNNER) }}              unset -> runs-on resolves to
 *                                                NOTHING; every workflow in the
 *                                                repo FAILS TO START.
 *   ${{ fromJSON(vars.CI_RUNNER || '[...]') }}   unset -> falls back to the
 *                                                literal and still schedules.
 *
 * The fleet converged on the bare form on 2026-08-30, because ci-runner-fallback
 * writes the variable to every covered repo and the literal was a second copy of
 * the label set in each repo. That trade is only sound while the variable is
 * actually there — which is exactly what nothing checked. `ci-runner-fallback.ts`
 * claimed "the seeding pass and `fleet check-runner-var` exist to catch" a repo
 * where it was never written; neither existed until now.
 */
import { stripYamlComments } from './yaml-comments.mjs';
import { READ_ATTEMPTS, describeReadFailure } from './queue-health.mjs';

/** `vars.CI_RUNNER` in real YAML, never in a comment. */
const REFERENCES = /vars\.CI_RUNNER/;
/** The fallback form: `fromJSON(vars.CI_RUNNER || '[...]')`. */
const HAS_FALLBACK = /fromJSON\(\s*vars\.CI_RUNNER\s*\|\|/;

/**
 * How `body` uses CI_RUNNER: `'bare'`, `'fallback'`, or `null` if it does not.
 *
 * COMMENT-STRIPPED, and that is load-bearing rather than tidy. Four repos in
 * this fleet carry a comment reading "do NOT restore the `vars.CI_RUNNER || ...`
 * fallback here", and a raw grep scores that as usage of the very thing it
 * forbids — it reported 7 users of the fallback where there are 3. Reading a
 * comment as evidence is the mistake this codebase has now made four times.
 *
 * @param {string} body raw workflow YAML
 * @returns {'bare' | 'fallback' | null}
 */
export function runnerVarForm(body) {
	const src = stripYamlComments(body);
	if (!REFERENCES.test(src)) return null;
	return HAS_FALLBACK.test(src) ? 'fallback' : 'bare';
}

/**
 * The verdict for one repo, given how its workflows read and whether the
 * variable is set.
 *
 * `varValue` is `null` for "not set" and `undefined` for "could not read". Those
 * are different answers and must not collapse: an unreadable variable is not a
 * healthy one, and reporting it as fine is the failure this fleet's rules exist
 * to prevent. So `undefined` is its own finding, never a pass.
 *
 * @param {string} repo
 * @param {{file: string, form: 'bare'|'fallback'}[]} uses
 * @param {string|null|undefined} varValue
 * @param {string} [reason] why an `undefined` read failed, carried into `why`
 * @returns {{repo: string, status: string, why: string, files?: string[]} | null}
 */
/**
 * Read the variable, retrying a transient failure, and keep WHY it failed (#125).
 *
 * `readOnce(repo)` returns the value or throws gh's error. A 404 is the real
 * answer "not set" — the case this check is FOR — so it is returned at once and
 * never retried. Anything else is tried READ_ATTEMPTS times, the same rule and
 * the same diagnosis check-queue-health uses: on 2026-10-20 a single blip on
 * brave-quartet paged @here as "could not read CI_RUNNER" with no reason, and a
 * re-run hours later was clean. Retrying is not tolerating — a repo that fails
 * every attempt is still `undefined`, and still a finding.
 *
 * @returns {{ value: string|null } | { value: undefined, reason: string }}
 */
export function readRunnerVar(
	repo,
	readOnce,
	{ attempts = READ_ATTEMPTS, sleep = () => {}, timeoutMs } = {}
) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return { value: readOnce(repo) || null };
		} catch (err) {
			if (/HTTP 404|Not Found/i.test(String(err?.stderr ?? err?.message ?? '')))
				return { value: null };
			reason = `${describeReadFailure(err, timeoutMs)} (attempt ${attempt}/${attempts})`;
			if (attempt < attempts) sleep();
		}
	}
	return { value: undefined, reason };
}

export function repoVerdict(repo, uses, varValue, reason) {
	if (!uses.length) return null; // does not reference it — nothing to check

	const bare = uses.filter((u) => u.form === 'bare');

	if (varValue === undefined) {
		return {
			repo,
			status: 'unreadable',
			why:
				`could not read CI_RUNNER (${uses.length} workflow(s) reference it)` +
				(reason ? `: ${reason}` : '') +
				'. Unknown is not healthy — this is reported, never passed.',
		};
	}

	if (varValue === null) {
		if (bare.length) {
			return {
				repo,
				status: 'missing',
				why:
					`CI_RUNNER is NOT SET and ${bare.length} workflow(s) use the bare ` +
					'`fromJSON(vars.CI_RUNNER)` form, so runs-on resolves to nothing and they ' +
					'FAIL TO START. Set it to ["self-hosted","hadoku-builder"], or add runner ' +
					'coverage so ci-runner-fallback writes it.',
				files: bare.map((u) => u.file),
			};
		}
		return {
			repo,
			status: 'unset-but-safe',
			why:
				"CI_RUNNER is not set, but every reference carries the `|| '[...]'` fallback, " +
				'so these still schedule. Do not convert them to the bare form until the ' +
				'variable is guaranteed.',
			files: uses.map((u) => u.file),
		};
	}

	return { repo, status: 'ok', why: `CI_RUNNER = ${varValue}` };
}
