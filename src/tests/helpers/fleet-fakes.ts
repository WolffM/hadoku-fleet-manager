/**
 * ONE model of each system the runner code talks to.
 *
 * WHY THIS EXISTS
 * ---------------
 * The GitHub API, the JIT provisioner and systemd were each hand-modelled
 * independently in three or four test files — `generate-jitconfig`, `SLOT-READY`,
 * `list-units` and the config-staging step all written out separately, 271 lines
 * of setup across six files. Independent copies can each be wrong differently,
 * and they were: one returned `{ok, status, body}` from a write while the real
 * `ghWrite` returned `{ok, status}` and dropped the body. Production created real
 * registrations and reported them as failures, and every one of those tests
 * passed throughout.
 *
 * THE RULE THESE FAKES FOLLOW
 * ---------------------------
 * A fake may only claim a shape that something has checked against reality.
 * Every field below is verified live by `check:boundary-contracts` — the runs
 * listing, the jobs listing and their labels, the runners listing and its
 * `{name}` label objects. The one shape a read-only contract check cannot cover
 * is the mint RESPONSE, because verifying it means creating a runner; that is
 * covered end to end by `.github/workflows/jit-canary.yml`, a job no standing
 * runner in the fleet can serve.
 *
 * So: read contracts in the gate, write contracts in the canary, and one fake
 * here that cannot drift from either without something going red.
 */

/** A jitconfig the safety assertions accept. */
export function jitConfig(runner: Record<string, string>): string {
	return Buffer.from(
		JSON.stringify({ '.runner': Buffer.from(JSON.stringify(runner)).toString('base64') })
	).toString('base64');
}

export const GOOD_JITCONFIG = jitConfig({ DisableUpdate: 'True', Ephemeral: 'True' });

export interface GhFakeOptions {
	/** Runners the listing returns. `labels` are `{name}` objects, as GitHub sends. */
	runners?: { id: number; name: string; status?: string; busy?: boolean; labels?: string[] }[];
	workflowRuns?: unknown[];
	jobs?: unknown[];
	/** Force the mint to fail, for the paths that must clean up after themselves. */
	mintOk?: boolean;
	/** Force `POST /actions/runners/registration-token` to fail — the warm mint's
	 * equivalent of `mintOk`, for a genuinely different endpoint. */
	registrationTokenOk?: boolean;
}

export interface GhFake {
	get: (path: string, token?: string, repo?: string) => Promise<unknown>;
	write: (
		method: 'POST' | 'DELETE',
		path: string,
		token?: string,
		body?: unknown,
		repo?: string
	) => Promise<{ ok: boolean; status: number; body?: unknown }>;
	/** Every path written to, in order — for asserting what reached GitHub. */
	writes: string[];
	/** Every path READ, in order — poll cadence is asserted from this. */
	reads: string[];
	/** reads + writes, in call order. */
	calls: string[];
	/** Labels the last mint requested. The self-hosted bug was invisible without this. */
	mintedLabels: string[];
}

export function fakeGh(o: GhFakeOptions = {}): GhFake {
	const writes: string[] = [];
	const reads: string[] = [];
	const calls: string[] = [];
	const state = { mintedLabels: [] as string[] };
	const fake: GhFake = {
		writes,
		reads,
		calls,
		get mintedLabels() {
			return state.mintedLabels;
		},
		get: async (path: string) => {
			reads.push(path);
			calls.push(path);
			if (path.includes('status=queued') || path.includes('/actions/runs?'))
				return { workflow_runs: o.workflowRuns ?? [] };
			if (path.includes('/jobs')) return { jobs: o.jobs ?? [] };
			return {
				runners: (o.runners ?? []).map((r) => ({
					id: r.id,
					name: r.name,
					status: r.status ?? 'online',
					busy: r.busy ?? false,
					// OBJECTS, not strings. check:boundary-contracts pins this.
					labels: (r.labels ?? []).map((name) => ({ name })),
				})),
			};
		},
		write: async (method, path, _token, body) => {
			writes.push(path);
			calls.push(path);
			if (path.includes('generate-jitconfig')) {
				state.mintedLabels = ((body as { labels?: string[] })?.labels ?? []).slice();
				if (o.mintOk === false) return { ok: false, status: 422 };
				return { ok: true, status: 201, body: { encoded_jit_config: GOOD_JITCONFIG } };
			}
			if (path.includes('registration-token')) {
				if (o.registrationTokenOk === false) return { ok: false, status: 403 };
				return { ok: true, status: 201, body: { token: 'FAKE-REG-TOKEN' } };
			}
			void method;
			return { ok: true, status: 204 };
		},
	};
	return fake;
}

export interface ShellFakeOptions {
	/** Live `jit-*` units, as `systemctl --user list-units --no-legend` prints them. */
	units?: string[];
	unreachable?: boolean;
}

export type ShellFake = (node: string, cmd: string) => Promise<string | null>;

export function fakeShell(o: ShellFakeOptions = {}): ShellFake {
	return async (_node: string, cmd: string): Promise<string | null> => {
		if (o.unreachable) return null;
		if (cmd.includes('echo REACHABLE')) return 'REACHABLE';
		// The config-staging step, which must succeed before the unit starts.
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('pgrep')) return '';
		if (cmd.includes('list-units'))
			return (o.units ?? []).map((u) => `${u}.service loaded active running x`).join('\n');
		// TWO COLUMNS, because the dispatcher now asks for two. `dispatchEphemeral`
		// reads `$7, $2` — available AND installed — off one line, since the
		// per-unit cap is derived from MemTotal minus the node's minFreeMb. A stub
		// answering one number makes every node read as "installed memory could not
		// be read" and the tick mint nothing, which is a fixture modelling the wrong
		// command rather than a fleet declining work. The warm half still asks for
		// `$2` alone and takes the first field.
		if (cmd.includes('free -m')) return cmd.includes('$7, $2') ? '9000 16000' : '9000';
		const m = /SLOT=(\d+)/.exec(cmd);
		if (m) return `SLOT-READY /home/hadoku/.hadoku/jit/slot${m[1]} 2.336.0`;
		return 'Running as unit: x.service';
	};
}
