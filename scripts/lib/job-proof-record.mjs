/**
 * WHERE `fleet prove-job` REMEMBERS WHAT IT PROVED, and how bootcamp reads it back.
 *
 * NOT THE MANIFEST, ON PURPOSE. A `$capabilities` write is landed as a commit on
 * hadoku_site and a commit restarts the production API (#59: every no-op
 * bootcamp did exactly that). A proof is a FACT ABOUT A RUN — it changes every
 * time someone runs it, and "when did I last look" must not become a commit. It
 * lives beside `fleet-drain.json` in the state directory, which is operator
 * state that nothing redeploys.
 *
 * Two entries per (node, capability): `last` — the most recent terminal attempt,
 * whatever it said, so a regression is visible — and `lastPass`, so "when was
 * this ever proved" survives a later failure. A `refused` run never reaches this
 * file: nothing was attempted, and recording it would erase a real proof with a
 * non-result.
 *
 * READ-ONLY FOR EVERYONE BUT `prove-job`. `bootcamp` only reads, and a record it
 * cannot read is reported with its reason — never as "no proof", which would
 * claim the question was asked and answered.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PROOF_FILE = 'job-proofs.json';

export const proofPath = (dir) => join(dir, PROOF_FILE);

/** The key a proof is filed under: the capability when there is one, else the job itself. */
export function proofKey(node, result) {
	return `${node}::${result.capability ?? `job:${result.repo}/${result.workflow}/${result.job}`}`;
}

/** Everything a reader needs, nothing that grows (no logs, no attempt list). */
export function slimProof(result) {
	return {
		at: result.finishedAt,
		verdict: result.verdict,
		ok: result.ok === true,
		runId: result.runId,
		jobId: result.jobId,
		runnerName: result.runnerName,
		jobConclusion: result.jobConclusion,
		ranOnTarget: result.ranOnTarget === true,
		evidenceLines: Array.isArray(result.evidence) ? result.evidence.length : 0,
		repo: result.repo,
		workflow: result.workflow,
		job: result.job,
	};
}

/** `{ok:true, proofs}` — a missing file is an empty ledger, an unreadable one is NOT. */
export function readProofs(dir) {
	const path = proofPath(dir);
	if (!existsSync(path)) return { ok: true, proofs: {} };
	try {
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
			return { ok: false, reason: `${path} is not a JSON object` };
		}
		return { ok: true, proofs: doc };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}

/** PURE. The ledger after one more result, or the SAME object when nothing is to be recorded. */
export function mergeProof(proofs, node, result) {
	if (result.verdict === 'refused') return proofs;
	const key = proofKey(node, result);
	const slim = slimProof(result);
	const prev = proofs[key] ?? {};
	return { ...proofs, [key]: { last: slim, lastPass: slim.ok ? slim : (prev.lastPass ?? null) } };
}

/** Write atomically. Returns `{ok:true}` or `{ok:false, reason}` — never throws, never silent. */
export function recordProof(dir, node, result) {
	const read = readProofs(dir);
	if (!read.ok)
		return { ok: false, reason: `not overwriting an unreadable ledger: ${read.reason}` };
	const next = mergeProof(read.proofs, node, result);
	if (next === read.proofs) return { ok: true, written: false };
	try {
		mkdirSync(dirname(proofPath(dir)), { recursive: true });
		const tmp = `${proofPath(dir)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
		renameSync(tmp, proofPath(dir));
		return { ok: true, written: true };
	} catch (err) {
		return { ok: false, reason: `could not write ${proofPath(dir)}: ${err.message}` };
	}
}

/** `3.2 h`, `2.0 d`, `41 min` — one figure, the unit that reads naturally. */
export function ageText(ms) {
	if (!Number.isFinite(ms) || ms < 0) return 'age unknown';
	const min = ms / 60_000;
	if (min < 90) return `${Math.round(min)} min`;
	if (min < 48 * 60) return `${(min / 60).toFixed(1)} h`;
	return `${(min / 1440).toFixed(1)} d`;
}

/**
 * What bootcamp prints for one (node, capability). PURE over an injected clock.
 *
 * NEVER A FINDING. A missing proof is information — most capabilities on most
 * nodes have never been job-proven — and promoting it to a failure would turn
 * every bootcamp run red for a thing nobody asked it to enforce.
 */
export function describeProof(entry, capabilityId, node, nowMs) {
	const cmd = `fleet prove-job --node ${node} --capability ${capabilityId}`;
	if (!entry?.last) {
		return {
			state: 'none',
			line: `job-proof: ${capabilityId} — never proved by a job here (${cmd})`,
		};
	}
	const { last, lastPass } = entry;
	const age = (p) => ageText(nowMs - Date.parse(p.at));
	const ran = (p) => `run ${p.runId} on ${p.runnerName}`;
	if (last.ok) {
		return {
			state: 'pass',
			line: `job-proof: ${capabilityId} — PASSED ${last.at} (${age(last)} ago), ${ran(last)}`,
		};
	}
	const was = lastPass ? `last pass ${lastPass.at} (${age(lastPass)} ago)` : 'never passed';
	return {
		state: 'failing',
		line: `job-proof: ${capabilityId} — last attempt ${last.verdict} ${last.at} (${age(last)} ago); ${was} (${cmd})`,
	};
}
