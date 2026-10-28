/**
 * Bulk GitHub readers spend a GitHub App's pool, not the user's (fleet-manager#9).
 *
 * The 5,000/h core limit belongs to the GitHub USER: the host `gh` login,
 * HADOKU_SITE_TOKEN and every workflow PAT draw on one pool, so a bulk gate
 * that spends it blinds runner-health, dispatch and minting for the rest of the
 * hour (2026-10-25: 155 used at 05:05Z, 5,000 at 05:30Z). The reserve in
 * `gh-reserve.mjs` stops a gate before it spends the last 1,500; this takes the
 * gates off that pool altogether. An App installation token is rate-limited
 * per INSTALLATION, so nothing a gate spends can reach the fleet's own loops.
 *
 * HOW: the App's id and private key arrive in the environment
 * (`FLEET_GH_APP_ID`, `FLEET_GH_APP_KEY`; mgmt-api passes them from the vault
 * through each gate's `envFromVault`). `useAppPool` signs a ten-minute JWT,
 * exchanges it for a one-hour installation token, and sets `GH_TOKEN`, which
 * every `gh` this process spawns then uses, `gh api rate_limit` included. So
 * the reserve check that follows reads the App's pool, the pool the gate is
 * about to spend.
 *
 * NO CREDENTIALS, OR A MINT THAT FAILS, FALLS BACK TO THE USER POOL, AND SAYS
 * SO. The gate still runs under the reserve, which was the whole protection
 * before the App existed; refusing would turn a broken App into a fleet with no
 * gates. The fallback is never silent: the note goes to stderr with its reason,
 * so the run that degraded names why.
 *
 * A `GH_TOKEN` already in the environment wins: whoever set it chose a token.
 *
 * The App (`hadoku-fleet-gates`) is hadoku_site's: it holds the key, rotates
 * and probes it, and documents the App in docs/operations/GITHUB_APP.md. This
 * file only mints from what it is handed.
 */
import { createSign } from 'node:crypto';
import { fleetOwner } from '../../dist/lib/fleet-config.js';

const API = 'https://api.github.com';
const MINT_TIMEOUT_MS = 15_000;

/** `{ appId, key, installationId }` from the environment, or null when the App is not configured. */
export function appCredentials(env = process.env) {
	const appId = (env.FLEET_GH_APP_ID ?? '').trim();
	// A key pasted through a single-line field arrives with literal `\n`s.
	const key = (env.FLEET_GH_APP_KEY ?? '').replace(/\\n/g, '\n').trim();
	if (!appId || !key) return null;
	const installationId = (env.FLEET_GH_APP_INSTALLATION_ID ?? '').trim() || null;
	return { appId, key, installationId };
}

const b64url = (v) => Buffer.from(v).toString('base64url');

/**
 * The App's own JWT (RS256). `iat` is backdated a minute for clock drift, as
 * GitHub's docs ask; the ten-minute lifetime is GitHub's ceiling.
 */
export function appJwt(appId, key, nowMs = Date.now()) {
	const now = Math.floor(nowMs / 1000);
	const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
	const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key, 'base64url');
	return `${head}.${body}.${sig}`;
}

async function call(fetchFn, path, jwt, method = 'GET') {
	const res = await fetchFn(`${API}${path}`, {
		method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${jwt}`,
			'x-github-api-version': '2022-11-28',
		},
		signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
	});
	const text = await res.text();
	if (!res.ok) {
		let msg = text.slice(0, 200);
		try {
			msg = JSON.parse(text).message ?? msg;
		} catch {
			// Not JSON (a proxy page, an empty body): the raw head is the reason.
		}
		throw new Error(`${method} ${path} answered ${res.status}: ${msg}`);
	}
	return JSON.parse(text);
}

/**
 * A one-hour installation token for the installation on `owner`.
 * `{ token, expiresAtMs, installationId }`; throws with the reason.
 */
export async function mintInstallationToken(
	creds,
	{ owner, fetchFn = globalThis.fetch, nowMs = Date.now() } = {}
) {
	const jwt = appJwt(creds.appId, creds.key, nowMs);
	let installationId = creds.installationId;
	if (!installationId) {
		const all = await call(fetchFn, '/app/installations?per_page=100', jwt);
		const mine = all.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
		if (!mine) {
			const seen = all.map((i) => i.account?.login).join(', ') || 'none';
			throw new Error(`the App is not installed on ${owner} (installed on: ${seen})`);
		}
		installationId = String(mine.id);
	}
	const t = await call(fetchFn, `/app/installations/${installationId}/access_tokens`, jwt, 'POST');
	return { token: t.token, expiresAtMs: Date.parse(t.expires_at), installationId };
}

/**
 * Put this process's `gh` on the App's pool. Returns `{ pool: 'app' | 'user' |
 * 'preset', note }`; on `user`, the note (already written to stderr) says why.
 */
export async function useAppPool(
	gate,
	{ env = process.env, owner = fleetOwner(), fetchFn, warn = (m) => console.error(m) } = {}
) {
	if ((env.GH_TOKEN ?? '').trim()) {
		return { pool: 'preset', note: `${gate}: GH_TOKEN is already set; using it` };
	}
	const creds = appCredentials(env);
	let why;
	if (!creds) {
		why = 'no App credentials (FLEET_GH_APP_ID and FLEET_GH_APP_KEY are unset)';
	} else {
		try {
			const minted = await mintInstallationToken(creds, { owner, fetchFn });
			env.GH_TOKEN = minted.token;
			return {
				pool: 'app',
				note: `${gate}: on the GitHub App's pool (installation ${minted.installationId})`,
			};
		} catch (err) {
			why = `the App token could not be minted: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	const note =
		`${gate}: spending the USER's GitHub pool, shared with runner-health and dispatch, ` +
		`because ${why} (fleet-manager#9). The reserve still applies.`;
	warn(note);
	return { pool: 'user', note };
}
