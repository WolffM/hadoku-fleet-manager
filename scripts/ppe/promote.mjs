#!/usr/bin/env node
// Promote ppe -> main, and revert a red ppe push. Run by
// .github/workflows/ppe-promote.yml (docs/planning/ppe-promotion-2026-11-01.md).
//
// Reads (never restated per repo): the required checks from main's ruleset,
// else main's classic branch protection; each pushed tip's check runs and
// statuses; when main and ppe were last pushed (the repo activity API). Every
// read is the job's own GITHUB_TOKEN, so none of it touches the fleet's
// shared GitHub budget.
//
// "I could not look" never promotes and never reverts. Any failed read exits
// 1 with the reason and changes nothing.
import { pathToFileURL } from 'node:url';

import {
	commitVerdict,
	checkState,
	decide,
	revertMessage,
	sessions,
	subject,
	trailer,
} from './decide.mjs';
import {
	CouldNotLook,
	fail,
	hydrate,
	log,
	makeApi,
	notice,
	openRepo,
	reportIssue,
	setOutput,
	summary,
} from './lib.mjs';

/** More pushed commits than this above the newest green and the promoter refuses to judge. */
export const MAX_WALK = 60;

export async function requiredChecks(api, mainBranch) {
	const rules = await api.get(`/{repo}/rules/branches/${mainBranch}`);
	const fromRules = rules
		.filter((r) => r.type === 'required_status_checks')
		.flatMap((r) => r.parameters?.required_status_checks ?? [])
		.map((c) => c.context);
	if (fromRules.length) return { required: [...new Set(fromRules)], source: 'ruleset' };
	const branch = await api.get(`/{repo}/branches/${mainBranch}`);
	const rsc = branch?.protection?.required_status_checks ?? {};
	const classic = rsc.contexts?.length ? rsc.contexts : (rsc.checks ?? []).map((c) => c.context);
	if (classic.length) return { required: [...new Set(classic)], source: 'branch protection' };
	throw new CouldNotLook(
		`${mainBranch} declares no required checks (no ruleset rule, no branch protection): nothing can be called green`
	);
}

/**
 * Each required context's state on one commit. `ids`, when passed, is filled
 * with each context's check-run id: for an Actions check that is the job id,
 * which is how the run and its attempt are found.
 */
export async function contextStates(api, sha, required, ids = {}) {
	const states = {};
	// GitHub's default `filter=latest`: a re-run's check run replaces the
	// attempt before it, so a red that passed on re-run reads green.
	const runs = await api.get(`/{repo}/commits/${sha}/check-runs?per_page=100`);
	for (const name of required) {
		const all = (runs.check_runs ?? []).filter((r) => r.name === name);
		const mine = all.map(checkState);
		if (!mine.length) continue;
		if (all.length === 1 && all[0].id) ids[name] = all[0].id;
		states[name] = mine.includes('pending')
			? 'pending'
			: mine.includes('failure')
				? 'failure'
				: mine.includes('success')
					? 'success'
					: 'missing';
	}
	if (required.some((r) => !(r in states))) {
		const combined = await api.get(`/{repo}/commits/${sha}/status?per_page=100`);
		for (const s of combined.statuses ?? []) {
			if (required.includes(s.context) && !(s.context in states)) states[s.context] = checkState(s);
		}
	}
	return states;
}

/**
 * The Actions run behind a check run, and which attempt it is. null when the
 * check is not an Actions job (GitHub answers 404): such a red cannot be
 * re-run, so it reverts as it always did. Any other failure is CouldNotLook.
 */
export async function runOfCheck(api, checkRunId) {
	let job;
	try {
		job = await api.get(`/{repo}/actions/jobs/${checkRunId}`);
	} catch (err) {
		if (err instanceof CouldNotLook && /HTTP 404/.test(err.message)) return null;
		throw err;
	}
	return { id: job.run_id, attempt: job.run_attempt ?? 1, runner: job.runner_name || null };
}

/** The runner each attempt of a run's `job` ran on, oldest first, with its conclusion. */
async function attemptHistory(api, run, jobName) {
	const out = [];
	for (let a = 1; a <= run.attempt; a++) {
		const jobs = await api.get(`/{repo}/actions/runs/${run.id}/attempts/${a}/jobs?per_page=100`);
		const j = (jobs.jobs ?? []).find((x) => x.name === jobName);
		out.push({ attempt: a, runner: j?.runner_name || null, conclusion: j?.conclusion ?? null });
	}
	return out;
}

export const LEDGER_TITLE = 'ppe: flake ledger';

/**
 * Record a push that went red and then green on a re-run. One open issue is
 * the ledger, one comment per push; a push already in it is not recorded
 * twice (the promoter runs on every CI completion and sees it again).
 */
async function recordFlake(api, result, entry, required) {
	const history = await attemptHistory(api, entry.run, required[0]);
	if (!history.slice(0, -1).some((h) => h.conclusion === 'failure')) return; // re-run by hand, never red
	const issue = await reportIssue(
		api,
		LEDGER_TITLE,
		[
			'Every ppe push that went red, was re-run by the promoter on a fresh runner, and passed. One comment per push.',
			'',
			'A push here was NOT reverted. A test that appears more than once is a flake to fix, not to re-run (fleet-manager#68).',
		].join('\n')
	);
	const number = issue.url.split('/').pop();
	const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
	const comments = await api.get(`/{repo}/issues/${number}/comments?per_page=100&since=${since}`);
	if (comments.some((c) => c.body?.includes(entry.sha))) return;
	await api.post(`/{repo}/issues/${number}/comments`, {
		body: [
			`**flaked, then passed**: \`${entry.sha}\` ${subject(entry.message)} (Session: ${trailer(entry.message, 'Session') ?? 'none'})`,
			'',
			...history.map(
				(h) =>
					`- attempt ${h.attempt}: ${h.conclusion ?? 'unknown'} on \`${h.runner ?? 'unknown runner'}\``
			),
			'',
			`Run: ${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${entry.run.id}`,
		].join('\n'),
	});
	result.flaked = { sha: entry.sha, history, ledger: issue.url };
}

async function lastPushMs(api, branch) {
	const acts = await api.get(
		`/{repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=1`
	);
	return acts.length ? Date.parse(acts[0].timestamp) : null;
}

function readChain(git, mainBranch, ppeBranch) {
	const raw = git([
		'log',
		'--first-parent',
		'--format=%H%x00%P%x00%B%x1e',
		`o/${mainBranch}..o/${ppeBranch}`,
	]);
	return raw
		.split('\x1e')
		.map((s) => s.replace(/^\n/, ''))
		.filter(Boolean)
		.map((rec) => {
			const [sha, parents, message] = rec.split('\x00');
			return { sha, parents: parents.split(' ').filter(Boolean), message };
		});
}

/**
 * File the report. A failure here comes AFTER a push may have landed, so it is
 * recorded on the result (and fails the job) rather than thrown: thrown, it
 * would read as "could not look, nothing changed", which would be false.
 */
async function fileIssue(api, result, title, body) {
	try {
		return (await reportIssue(api, title, body)).url;
	} catch (err) {
		if (!(err instanceof CouldNotLook)) throw err;
		result.reportErrors.push(`could not file "${title}": ${err.message}`);
		return '(issue not filed)';
	}
}

/**
 * One pass: gather, decide, act. Returns a result for the summary; throws
 * CouldNotLook when it could not see enough to act.
 */
export async function promoteOnce(o) {
	const { api, mainBranch, ppeBranch } = o;
	const { git } = openRepo({
		remote: o.remote,
		deployKey: o.deployKey,
		branches: [mainBranch, ppeBranch],
	});
	const mainSha = git(['rev-parse', `o/${mainBranch}`]).trim();
	const mainAhead = Number(git(['rev-list', '--count', `o/${ppeBranch}..o/${mainBranch}`]).trim());
	const commits = readChain(git, mainBranch, ppeBranch);
	if (!commits.length)
		return { action: 'none', notes: [`${ppeBranch} has nothing ${mainBranch} lacks`] };

	const { required, source } = await requiredChecks(api, mainBranch);
	log(`required checks (${source}): ${required.join(', ')}`);

	const chain = [];
	for (const c of commits) {
		if (chain.length >= MAX_WALK)
			throw new CouldNotLook(
				`more than ${MAX_WALK} first-parent commits on ${ppeBranch} above its newest green; refusing to judge a range that long`
			);
		const ids = {};
		const states = await contextStates(api, c.sha, required, ids);
		const verdict = commitVerdict(states, required);
		const failing = required.filter((r) => states[r] === 'failure');
		// The run behind the verdict: the failing context's for a red, the first
		// required context's for a green (a green on attempt 2 is a flake to record).
		const ctx = verdict === 'red' ? failing[0] : verdict === 'green' ? required[0] : null;
		const run = ctx && ids[ctx] ? await runOfCheck(api, ids[ctx]) : null;
		chain.push({ ...c, verdict, failing, run });
		log(`  ${c.sha.slice(0, 7)} ${verdict.padEnd(8)} ${subject(c.message)}`);
		if (verdict === 'green') break;
	}

	const nowMs = o.nowMs ?? Date.now();
	const [lastMainPushMs, lastPpePushMs] = o.force
		? [null, null]
		: await Promise.all([lastPushMs(api, mainBranch), lastPushMs(api, ppeBranch)]);
	const d = decide({ chain, mainAhead, force: o.force, nowMs, lastMainPushMs, lastPpePushMs });
	const result = {
		action: 'none',
		notes: d.notes,
		reportErrors: [],
		decision: d,
		required,
		mainSha,
	};

	const newestGreen = chain.find((e) => e.verdict === 'green');
	if (newestGreen?.run && newestGreen.run.attempt > 1) {
		try {
			await recordFlake(api, result, newestGreen, required);
		} catch (err) {
			if (!(err instanceof CouldNotLook)) throw err;
			result.reportErrors.push(
				`could not record ${newestGreen.sha.slice(0, 7)} in the flake ledger: ${err.message}`
			);
		}
	}

	if (d.promote) {
		// A plain push of an existing commit: git refuses it unless it is a
		// fast-forward, which is the only promotion there is. Never --force.
		const push = git.try(['push', '-q', 'origin', `${d.promote.sha}:refs/heads/${mainBranch}`]);
		if (push.ok) {
			result.action = 'promoted';
			result.promoted = d.promote.sha;
			log(
				`promoted ${mainBranch} ${mainSha.slice(0, 7)} -> ${d.promote.sha.slice(0, 7)} (${d.promote.reason})`
			);
		} else {
			notice(
				`${mainBranch} moved before the fast-forward landed; the next run promotes (${push.err.trim().split('\n').pop()})`
			);
			result.notes.push(`fast-forward of ${mainBranch} refused: it moved`);
		}
	}

	if (d.rerun) {
		// Only the failed jobs, on whatever runner is minted next: every CI runner
		// is ephemeral (JIT), so this is a fresh one. A refusal is CouldNotLook:
		// nothing reverts on a red we could not give its second attempt.
		await api.post(`/{repo}/actions/runs/${d.rerun.run.id}/rerun-failed-jobs`, {});
		result.rerun = d.rerun;
		result.action = result.action === 'promoted' ? 'promoted+rerun' : 'rerun';
		log(
			`re-running the failed jobs of run ${d.rerun.run.id} (${d.rerun.sha.slice(0, 7)}, attempt ${d.rerun.run.attempt} on ${d.rerun.run.runner ?? 'an unnamed runner'})`
		);
	}

	if (d.revert) {
		hydrate(git, [ppeBranch]);
		const tip = chain[0].sha;
		git(['checkout', '-q', '--detach', tip]);
		for (const c of d.revert.commits) {
			const r = git.try(['revert', '--no-commit', c.sha]);
			if (!r.ok) {
				git.try(['revert', '--abort']);
				git.try(['reset', '-q', '--hard', tip]);
				d.human = {
					sha: d.revert.culprit,
					reason: `reverting ${c.sha.slice(0, 7)} conflicts with what was pushed after it`,
				};
				d.revert = null;
				break;
			}
		}
		if (d.revert) {
			git(['commit', '-q', '-m', revertMessage(d.revert)]);
			const push = git.try(['push', '-q', 'origin', `HEAD:refs/heads/${ppeBranch}`]);
			if (!push.ok) {
				// ppe moved: decide again on the new tip rather than push over it.
				return { action: 'retry', notes: [`${ppeBranch} moved while reverting`] };
			}
			result.reverted = { ...d.revert, revertSha: git(['rev-parse', 'HEAD']).trim() };
			result.action = result.action === 'promoted' ? 'promoted+reverted' : 'reverted';
			const who = sessions(d.revert);
			const title = `ppe: reverted red push ${d.revert.culprit.slice(0, 7)}`;
			result.issue = await fileIssue(
				api,
				result,
				title,
				[
					`The promoter reverted push \`${d.revert.culprit}\` on \`${ppeBranch}\`: ${d.revert.failing.join(', ') || 'required checks'} red${d.revert.run ? ` on ${d.revert.run.attempt} attempt(s), the last on \`${d.revert.run.runner ?? 'an unnamed runner'}\`` : ''}.`,
					'',
					`Session(s): ${who.length ? who.map((s) => `\`${s}\``).join(', ') : 'none named (the commits carry no `Session:` trailer)'}`,
					'',
					'Reverted, newest first:',
					...d.revert.commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${subject(c.message)}`),
					'',
					`Revert commit: \`${result.reverted.revertSha}\`. Fix forward on top of it and push to \`${ppeBranch}\` again.`,
				].join('\n')
			);
		}
	}

	if (d.human) {
		const issue = await fileIssue(
			api,
			result,
			`ppe: red push ${d.human.sha.slice(0, 7)} needs a human`,
			[
				`The promoter did not revert \`${d.human.sha}\` on \`${ppeBranch}\`: ${d.human.reason}.`,
				'',
				`Nothing above the newest green promotes until \`${ppeBranch}\` is green again.`,
			].join('\n')
		);
		result.human = { ...d.human, issue };
	}
	return result;
}

export async function main(env = process.env) {
	const repo = env.GITHUB_REPOSITORY;
	const o = {
		api: makeApi({ token: env.GITHUB_TOKEN, repo, base: env.GITHUB_API_URL }),
		remote: env.PPE_REMOTE || `git@github.com:${repo}.git`,
		deployKey: env.PPE_DEPLOY_KEY,
		mainBranch: env.PPE_MAIN_BRANCH || 'main',
		ppeBranch: env.PPE_BRANCH || 'ppe',
		force: env.PPE_FORCE === 'true',
		nowMs: env.PPE_NOW_MS ? Number(env.PPE_NOW_MS) : undefined,
	};
	if (!env.GITHUB_TOKEN) {
		fail('no GITHUB_TOKEN: could not look, so nothing was promoted or reverted');
		return 1;
	}
	if (!o.deployKey && !env.PPE_REMOTE) {
		fail(
			'no deploy key (secret PPE_PROMOTE_KEY): could not push, so nothing was promoted or reverted'
		);
		return 1;
	}
	let result;
	try {
		for (let attempt = 1; attempt <= 3; attempt++) {
			result = await promoteOnce(o);
			if (result.action !== 'retry') break;
			log(`attempt ${attempt}: ${result.notes.join('; ')}; deciding again`);
		}
	} catch (err) {
		if (!(err instanceof CouldNotLook)) throw err;
		fail(`could not look, so nothing was promoted or reverted: ${err.message}`);
		summary(
			`### ppe promotion: could not look\n\n${err.message}\n\nNothing was promoted or reverted.`,
			env
		);
		setOutput('action', 'could-not-look', env);
		return 1;
	}
	setOutput('action', result.action, env);
	if (result.promoted) setOutput('promoted', result.promoted, env);
	summary(
		[
			`### ppe promotion: ${result.action}`,
			'',
			...(result.promoted ? [`- promoted \`${result.promoted}\``] : []),
			...(result.reverted
				? [
						`- reverted push \`${result.reverted.culprit}\` as \`${result.reverted.revertSha}\` (${result.issue})`,
					]
				: []),
			...(result.rerun
				? [
						`- re-running the failed jobs of \`${result.rerun.sha}\` (attempt ${result.rerun.run.attempt} was red on ${result.rerun.run.runner ?? 'an unnamed runner'}); it reverts only if the re-run is red too`,
					]
				: []),
			...(result.flaked
				? [`- \`${result.flaked.sha}\` flaked, then passed: recorded in ${result.flaked.ledger}`]
				: []),
			...(result.human ? [`- needs a human: ${result.human.reason} (${result.human.issue})`] : []),
			...result.notes.map((n) => `- ${n}`),
		].join('\n'),
		env
	);
	for (const n of result.notes) log(n);
	if (result.action === 'retry') {
		fail(
			`${o.ppeBranch} kept moving during three attempts; the next CI completion runs this again`
		);
		return 1;
	}
	for (const e of result.reportErrors ?? []) fail(e);
	if (result.reportErrors?.length) return 1;
	if (result.human) {
		fail(
			`red push ${result.human.sha.slice(0, 7)} needs a human: ${result.human.reason} (${result.human.issue})`
		);
		return 1;
	}
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exitCode = await main();
}
