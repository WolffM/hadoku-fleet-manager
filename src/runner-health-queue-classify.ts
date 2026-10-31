import { ghGet } from './lib/github-client.js';
import type { GhRunner } from './lib/github-client.js';
import { isHostedLabel, judgeJobMint, type MintView } from './label-floor.js';
import { parseJitName } from './runner-health-watch.js';
import { nodeOf } from './runners/census.js';

export interface GhJob {
	/** Also the CHECK-RUN id, which is how the annotations endpoint is addressed. */
	id?: number;
	status?: string;
	conclusion?: string | null;
	runner_name?: string | null;
	/** null until a runner actually picks the job up — the queued/running tell. */
	started_at?: string | null;
	/** `runs-on` as GitHub resolved it. What a queued job is WAITING for. */
	labels?: string[];
	/**
	 * The job's steps, each with a `conclusion` that is null while it runs.
	 *
	 * This is the PROGRESS signal — see `stuckSince`. A count of finished steps
	 * that advances between ticks is a job doing work, however long it takes.
	 */
	steps?: { number?: number; name?: string; conclusion?: string | null }[];
}

/** One repo's registrations as this tick read them — the part the classifier needs. */
export interface RepoRunnerState {
	labels: Record<string, number>;
	runners: GhRunner[];
}

/** Why a queued run is waiting — the message half of the classification. */
export interface QueueVerdict {
	/** true = not a fleet fault, record it quietly. false = ping. */
	covered: boolean;
	/** Always populated. A finding with no reason is not actionable. */
	reason: string;
}

/**
 * How long a job may wait on a MINT before the wait itself is the finding.
 *
 * A mint serves in about 2.5 minutes at worst (MIN_QUEUED_MS + a fast-loop
 * tick + the mint), and a saturated fleet adds the length of the job ahead.
 * Under this, a job no standing runner covers but a live minting node offers
 * is waiting its turn and is recorded quietly (#110). Past it, it pages,
 * because a mint that never happens looks exactly like one that has not
 * happened YET — the dispatcher skipping the run, a repo it cannot mint for,
 * a node that accepts the mint and never serves — and a wait that only gets
 * quieter the longer it lasts is the inversion this file refuses.
 */
const MINT_WAIT_LOUD_MINUTES = 30;

/**
 * How long a minted runner may stay OFFLINE before it is called deaf.
 *
 * A JIT listener connects within seconds of its unit starting. Three minutes
 * is far past that, and the check only runs on a job already queued past
 * QUEUED_WARN_MINUTES, so nothing legitimate is caught by it.
 */
const DEAF_MINT_MINUTES = 3;

/**
 * Can anything actually serve this queued run?
 *
 * `covered` distinguishes "waiting its turn" from "waiting for a machine that
 * does not exist", and `reason` says WHICH — a bare "no online runner matches
 * its labels" sent the operator to look up the run every time, and could not
 * tell a busy pool from a hosted job from a genuinely dead label.
 *
 * A JOB NO STANDING RUNNER COVERS MAY STILL BE SERVED BY A MINT (#110). Under
 * all-JIT that is most jobs: a claw holds no registration until a job asks, so
 * the repo's own listing shows nothing that carries `hadoku-builder` or `jdk21`
 * while a claw is about to. That is judged by the label floor's own minting arm
 * (`judgeJobMint`), unmeasured hold included, and is quiet only inside
 * MINT_WAIT_LOUD_MINUTES.
 *
 * A MINTED RUNNER THAT NEVER CAME ONLINE IS NAMED FIRST, and loudly. On
 * 2026-10-16 the dispatcher minted hadoku-bomberman's runner on claw-9 at
 * 13:00:41Z; claw-9 had lost DNS, the listener retried for 65 minutes, and the
 * dispatcher held the job as in flight throughout, so nothing else could serve
 * it. Judged by labels alone that job was "covered by a mint" — the minting arm
 * offered it on a live claw — and would have gone quiet. The registration was
 * right there in the repo's listing, offline, carrying the job's id.
 *
 * Fails LOUD on anything it could not READ — a missing census or an unreadable
 * jobs list pings, because silence on an uncovered label is the outage this
 * check exists to catch. It does NOT fail loud on things it read successfully
 * and found empty; "I looked and nothing is waiting" is evidence, not absence
 * of it.
 */
export async function classifyQueuedRun(
	runId: number | undefined,
	token: string,
	repo: string,
	state: RepoRunnerState | null,
	mint: { view: MintView } | null,
	ageMin: number,
	nowMs: number
): Promise<QueueVerdict> {
	if (!runId)
		return { covered: false, reason: 'the run carried no id, so its jobs are unreadable.' };
	if (!state)
		return {
			covered: false,
			reason: `the runner listing for \`${repo}\` was unreadable, so coverage could not be judged.`,
		};
	const labelOnline = state.labels;
	const detail = await ghGet<{ jobs?: GhJob[] }>(`/actions/runs/${runId}/jobs`, token, repo);
	if (!detail || !Array.isArray(detail.jobs))
		return {
			covered: false,
			reason: 'its job list was unreadable, so coverage could not be judged.',
		};
	// A queued run with NO jobs at all has not been scheduled — nothing has been
	// attributed to a runner, hosted or otherwise. Past the threshold that is a
	// stuck run and stays LOUD, which is what it has always been.
	if (!detail.jobs.length)
		return {
			covered: false,
			reason: 'the run has NO jobs at all — GitHub has not scheduled it.',
		};
	const waiting = detail.jobs.filter((j) => j.status === 'queued' || !j.started_at);
	// Jobs exist and every one has been picked up. The run listing lags job state
	// by a few seconds, so a run can still read `queued` with nothing waiting —
	// not "I could not look" but "I looked and nothing is waiting", which is
	// evidence rather than the absence of it.
	if (!waiting.length)
		return {
			covered: true,
			reason: 'every job has already been picked up; the run listing is lagging.',
		};

	const deaf = deafMints(waiting, runId, state.runners, mint, nowMs);
	if (deaf.length)
		return {
			covered: false,
			reason:
				`${deaf.join('; ')} — still OFFLINE in GitHub's listing, so its listener cannot reach ` +
				'GitHub, and the dispatcher holds the job as in flight so nothing else will serve it.',
		};

	const mismatched = mismatchedMints(waiting, state.runners, mint, nowMs);
	if (mismatched.length)
		return {
			covered: false,
			reason:
				`${mismatched.join('; ')} — GitHub will never assign it the job, and the dispatcher ` +
				'holds the job as in flight until the reap releases that registration.',
		};

	const unmet = new Set<string>();
	/** Jobs no standing runner covers, for the minting arm. */
	const forMint: string[][] = [];
	let hostedOnly = true;
	let unlabelled = false;
	for (const j of waiting) {
		const labels = Array.isArray(j.labels) ? j.labels : [];
		// A job with no readable labels cannot be shown to be covered.
		if (!labels.length) {
			unlabelled = true;
			continue;
		}
		// A job is hosted if ANY of its labels is a hosted image — `runs-on` picks
		// one runner, and no self-hosted box carries `ubuntu-latest`.
		if (labels.some(isHostedLabel)) continue;
		hostedOnly = false;
		const missing = labels.filter((l) => (labelOnline[l] ?? 0) === 0);
		for (const l of missing) unmet.add(l);
		if (missing.length) forMint.push(labels);
	}
	if (unlabelled)
		return {
			covered: false,
			reason: 'a queued job reported no labels, so coverage could not be judged.',
		};
	if (unmet.size) {
		const named = Array.from(unmet)
			.map((l) => `\`${l}\``)
			.join(', ');
		// The manifest could not be read, so the minting arm cannot be asked:
		// nothing showed the job covered, which is the old verdict, unchanged.
		if (!mint)
			return {
				covered: false,
				reason: `NO online runner carries ${named} — that is a coverage gap, not a busy pool.`,
			};
		const verdicts = forMint.map((labels) => judgeJobMint(labels, mint.view));
		const unserved = verdicts.find((v) => v.state === 'unserved');
		if (unserved && unserved.state === 'unserved')
			return {
				covered: false,
				reason: `NO online runner carries ${named} (${unserved.why}) — that is a coverage gap, not a busy pool.`,
			};
		const via = [
			...new Set(
				verdicts.flatMap((v) => (v.state === 'minting' || v.state === 'unmeasured' ? v.nodes : []))
			),
		].join(', ');
		const unmeasured = verdicts.some((v) => v.state === 'unmeasured');
		const how = unmeasured
			? `the fast loop has not probed the minting nodes that offer it (${via}) since the restart`
			: `${via} offer${via.includes(',') ? '' : 's'} it and can mint`;
		if (ageMin > MINT_WAIT_LOUD_MINUTES)
			return {
				covered: false,
				reason:
					`no standing runner carries ${named}; ${how}, but nothing has served it in ` +
					`${MINT_WAIT_LOUD_MINUTES}+ min. Check \`[dispatch] skipped run ${runId}\` in mgmt-api's log.`,
			};
		return {
			covered: true,
			reason: `no standing runner carries ${named}; ${how}, so it is waiting for a mint.`,
		};
	}
	if (hostedOnly)
		return {
			covered: true,
			reason:
				'every queued job is GitHub-HOSTED, so the fleet does not serve it and cannot be the cause.',
		};
	return { covered: true, reason: 'every label it wants IS online; the pool is busy.' };
}

/**
 * JIT registrations minted for one of these waiting jobs that are ONLINE and
 * idle but do not carry every label the job asks for (fleet-manager#2).
 *
 * On 2026-10-23 hokon's mint for hadoku-bomberman registered without
 * `hadoku-builder`, and this alert said hokon "offers it and can mint" while
 * the runner it HAD minted sat right there in the listing, unable to take the
 * job. Matched by the job id the name carries only — a pre-job-scoped name
 * cannot say which job's labels it should be held to. Labels compare
 * case-insensitively, as GitHub matches them.
 */
export function mismatchedMints(
	waiting: GhJob[],
	runners: GhRunner[],
	mint: { view: MintView } | null,
	nowMs: number
): string[] {
	const wanted = new Map<number, string[]>();
	for (const j of waiting)
		if (typeof j.id === 'number' && Array.isArray(j.labels)) wanted.set(j.id, j.labels);
	const nodes = mint?.view.nodes.map((n) => n.name) ?? [];
	const out: string[] = [];
	for (const r of runners) {
		if (r.status !== 'online' || r.busy) continue;
		const parsed = parseJitName(r.name);
		const labels = parsed?.jobId != null ? wanted.get(parsed.jobId) : undefined;
		if (!parsed || !labels) continue;
		const carries = new Set((r.labels ?? []).map((l) => l.name.toLowerCase()));
		const missing = labels.filter((l) => !carries.has(l.toLowerCase()));
		if (!missing.length) continue;
		const node = nodes.length ? nodeOf(r.name, nodes) : '';
		const where = nodes.includes(node) ? ` on \`${node}\`` : '';
		const ageMin = Math.round((nowMs - parsed.mintedAtMs) / 60000);
		out.push(
			`\`${r.name}\` was minted for it${where} ${ageMin}m ago and is online, but lacks ` +
				missing.map((l) => `\`${l}\``).join(', ')
		);
	}
	return out;
}

/**
 * JIT registrations minted for one of these waiting jobs that never came online.
 *
 * Matched by the job id the name carries (`parseJitName`), or by the run id
 * for a name from before the job-scoped format. Only a registration that is
 * OFFLINE and older than DEAF_MINT_MINUTES counts: an online one is either
 * about to take the job or serving another (the dispatcher's own reassignment
 * case), and neither is deaf. One line per runner, naming its node.
 */
export function deafMints(
	waiting: GhJob[],
	runId: number,
	runners: GhRunner[],
	mint: { view: MintView } | null,
	nowMs: number
): string[] {
	const jobIds = new Set(
		waiting.map((j) => j.id).filter((id): id is number => typeof id === 'number')
	);
	const nodes = mint?.view.nodes.map((n) => n.name) ?? [];
	const out: string[] = [];
	for (const r of runners) {
		if (r.status === 'online') continue;
		const parsed = parseJitName(r.name);
		if (!parsed) continue;
		const ours = parsed.jobId !== null ? jobIds.has(parsed.jobId) : parsed.runId === runId;
		if (!ours) continue;
		const ageMin = (nowMs - parsed.mintedAtMs) / 60000;
		if (!(ageMin > DEAF_MINT_MINUTES)) continue;
		const node = nodes.length ? nodeOf(r.name, nodes) : '';
		const where = nodes.includes(node) ? ` on \`${node}\`` : '';
		out.push(`\`${r.name}\` was minted for it${where} ${Math.round(ageMin)}m ago`);
	}
	return out;
}
