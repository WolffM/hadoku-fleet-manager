import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { ghGet, ghWrite } from '../../dist/lib/github-client.js';
import { ghBlackoutRemainingMs } from '../../dist/lib/github-client-blackout.js';
import { probeGate } from './floor-probe.mjs';

export function githubToken() {
	for (const k of ['HADOKU_SITE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
		const v = process.env[k]?.trim();
		if (v) return v;
	}
	try {
		// `gh auth token` is the operator's own credential and this command is
		// operator-invoked. The vault broker is hadoku_site's and cannot be reached
		// from here without vendoring it.
		return execFileSync('gh', ['auth', 'token'], {
			encoding: 'utf8',
			timeout: 10_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Every GitHub call this harness makes, metered against §7's 200-call cap and
 * suppressed by the SAME blackout the reap and the label sweep already honour.
 *
 * Suppression returns each function's "could not look" value — `null` for a
 * read, `{ok:false}` for a write. It must NEVER return anything a caller could
 * read as "unchanged": telling the dispatcher its cached queue is current when
 * we simply did not look is the failure CLAUDE.md names by name.
 */
export function meteredGh(budget, token) {
	const spent = () => budget.spent;
	const stop = () => probeGate(budget, ghBlackoutRemainingMs());
	return {
		spent,
		async get(path, repo) {
			const why = stop();
			if (why) return { ok: false, why, body: null };
			const body = await ghGet(path, token, repo);
			return { ok: body !== null, why: body === null ? 'GitHub did not answer' : null, body };
		},
		async write(method, path, tok, body, repo) {
			const why = stop();
			if (why) return { ok: false, status: 0, why };
			const res = await ghWrite(method, path, tok, body, repo);
			return { ...res, why: res.ok ? null : `HTTP ${res.status}` };
		},
	};
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
