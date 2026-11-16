#!/usr/bin/env node
// Merge a push to main that is not a promotion (a bot's) into ppe, so the
// next promotion is still a fast-forward. Run by .github/workflows/ppe-sync.yml.
// A promotion's push is already in ppe and is left alone. A conflict is reported, never forced.
import { pathToFileURL } from 'node:url';

import {
	CouldNotLook,
	fetchPushToken,
	fail,
	hydrate,
	log,
	makeApi,
	openRepo,
	reportIssue,
	setOutput,
	summary,
} from './lib.mjs';

export function syncMessage(mainBranch, ppeBranch, mainSha) {
	return `Merge ${mainBranch} into ${ppeBranch} at ${mainSha.slice(0, 7)}\n\nSession: sync-main-to-ppe\n`;
}

export function syncOnce(o) {
	const { mainBranch, ppeBranch } = o;
	const { git } = openRepo({
		remote: o.remote,
		pushToken: o.pushToken,
		branches: [mainBranch, ppeBranch],
	});
	const mainSha = git(['rev-parse', `o/${mainBranch}`]).trim();
	if (git.try(['merge-base', '--is-ancestor', `o/${mainBranch}`, `o/${ppeBranch}`]).ok)
		return {
			action: 'none',
			mainSha,
			note: `${mainBranch} ${mainSha.slice(0, 7)} is already in ${ppeBranch}`,
		};
	hydrate(git, [mainBranch, ppeBranch]);
	const ppeSha = git(['rev-parse', `o/${ppeBranch}`]).trim();
	git(['checkout', '-q', '--detach', ppeSha]);
	const merge = git.try([
		'merge',
		'-q',
		'--no-ff',
		'-m',
		syncMessage(mainBranch, ppeBranch, mainSha),
		mainSha,
	]);
	if (!merge.ok) {
		const conflicted = git
			.try(['diff', '--name-only', '--diff-filter=U'])
			.out.trim()
			.split('\n')
			.filter(Boolean);
		git.try(['merge', '--abort']);
		return { action: 'conflict', mainSha, ppeSha, conflicted };
	}
	const push = git.try(['push', '-q', 'origin', `HEAD:refs/heads/${ppeBranch}`]);
	if (!push.ok) return { action: 'retry', mainSha };
	return { action: 'merged', mainSha, mergeSha: git(['rev-parse', 'HEAD']).trim() };
}

export async function main(env = process.env) {
	const repo = env.GITHUB_REPOSITORY;
	const o = {
		remote: env.PPE_REMOTE || `https://github.com/${repo}.git`,
		pushToken: null,
		mainBranch: env.PPE_MAIN_BRANCH || 'main',
		ppeBranch: env.PPE_BRANCH || 'ppe',
	};
	// PPE_REMOTE is the tests' local remote, which needs no credential.
	if (!env.PPE_REMOTE) {
		if (!env.FLEET_SERVICE_KEY || !env.PPE_PUSH_TOKEN_URL) {
			fail(
				'FLEET_SERVICE_KEY and PPE_PUSH_TOKEN_URL are both required: could not get a push token, so nothing was merged'
			);
			return 1;
		}
		try {
			o.pushToken = await fetchPushToken({
				url: env.PPE_PUSH_TOKEN_URL,
				serviceKey: env.FLEET_SERVICE_KEY,
			});
		} catch (err) {
			fail(`could not get a push token, so nothing was merged: ${err.message}`);
			return 1;
		}
	}
	let r;
	try {
		for (let attempt = 1; attempt <= 3; attempt++) {
			r = syncOnce(o);
			if (r.action !== 'retry') break;
			log(`attempt ${attempt}: ${o.ppeBranch} moved while merging; merging again`);
		}
	} catch (err) {
		if (!(err instanceof CouldNotLook)) throw err;
		fail(`could not look, so nothing was merged: ${err.message}`);
		setOutput('action', 'could-not-look', env);
		return 1;
	}
	setOutput('action', r.action, env);
	if (r.action === 'none') {
		log(r.note);
		return 0;
	}
	if (r.action === 'merged') {
		log(
			`merged ${o.mainBranch} ${r.mainSha.slice(0, 7)} into ${o.ppeBranch} as ${r.mergeSha.slice(0, 7)}`
		);
		summary(`### sync-main-to-ppe: merged \`${r.mainSha}\` as \`${r.mergeSha}\``, env);
		return 0;
	}
	if (r.action === 'retry') {
		fail(`${o.ppeBranch} kept moving during three attempts; nothing was merged`);
		return 1;
	}
	// A conflict: reported, never resolved here. Until a human merges it, ppe
	// cannot fast-forward main and promotion waits.
	const title = `ppe: ${o.mainBranch} ${r.mainSha.slice(0, 7)} does not merge into ${o.ppeBranch}`;
	const body = [
		`\`${o.mainBranch}\` at \`${r.mainSha}\` conflicts with \`${o.ppeBranch}\` at \`${r.ppeSha}\`, so sync-main-to-ppe merged nothing.`,
		'',
		'Conflicted paths:',
		...r.conflicted.map((p) => `- \`${p}\``),
		'',
		`Promotion waits until \`${o.ppeBranch}\` contains \`${o.mainBranch}\`: merge it by hand, resolve, and push to \`${o.ppeBranch}\`.`,
	].join('\n');
	let where = '(issue not filed)';
	if (env.GITHUB_TOKEN) {
		try {
			where = (
				await reportIssue(
					makeApi({ token: env.GITHUB_TOKEN, repo, base: env.GITHUB_API_URL }),
					title,
					body
				)
			).url;
		} catch (err) {
			if (!(err instanceof CouldNotLook)) throw err;
			fail(`could not file the conflict issue: ${err.message}`);
		}
	}
	fail(`${title}: ${r.conflicted.join(', ')} (${where})`);
	summary(`### sync-main-to-ppe: conflict\n\n${body}`, env);
	return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exitCode = await main();
}
