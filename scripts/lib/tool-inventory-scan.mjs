/**
 * tool-inventory-scan — may a workflow invoke a tool the nodes it can land on
 * do not have, unless it provides that tool itself?
 *
 * Split out of `check-tool-inventory.mjs` (now `scripts/tool-inventory.mjs`,
 * wave gates2 lane F1a) so `fleet converge-toolchain --refresh` can fold this
 * same scan's findings into its own nightly report — the evidence table's
 * "move check-tool-inventory's 'a workflow invokes a tool the node lacks'
 * into a toolchain-refresh finding." `fleet tool-inventory` keeps calling
 * these same primitives for its own missing-tool section, alongside the
 * demand-ledger write and capability-retirement tracking that file carries
 * and this one does not — see that CLI's header for why those stayed there
 * (the demand ledger is the one writer of `demand-ledger.jsonl`, read by
 * `check-label-floor`, `node-eligibility.ts` and `bootcamp-proof.ts`, so it
 * had to keep working, not merely answer its old subcommand name).
 *
 * WHAT COUNTS AS PROVIDING A TOOL
 *   - present on every node the workflow's `runs-on` can select, or
 *   - a `command -v` / `which` guard anywhere in the same workflow, or
 *   - an install of it in the same workflow (rustup brings cargo, etc.), or
 *   - the workflow runs hosted, where the image supplies it.
 */
import { runOn } from './fleet-exec.mjs';
import { tryShipped } from './fleet-source.mjs';
import { splitJobs, deriveLabels } from './demand-derive.mjs';

/**
 * Tools worth checking. Deliberately a list rather than "every first token":
 * a naive scan of `run:` blocks returns `echo`, `if`, `exit`, `const` and `let`
 * — shell keywords and JavaScript — and drowns the signal completely.
 */
export const TOOLS = [
	'pnpm',
	'node',
	'corepack',
	'git',
	'curl',
	'gh',
	'python3',
	'jq',
	'bash',
	'cargo',
	'ffmpeg',
	'mpv',
	'docker',
	'unzip',
	'trunk',
	'rustup',
	'pm2',
	'rsync',
	'tar',
	'sqlite3',
	'uv',
	// P3.4/P1.6: hadoku-pygmalion's CI installs via `python -m pip install`, and
	// nothing anywhere probed for it — both node profiles in
	// manifests/node-profiles.json already DECLARE `python3-pip`, but bootstrap
	// only ever runs at enrollment, so claw-1 and claw-2 drifted from that
	// declaration and had no pip on PATH regardless. `capabilities.ts`'s
	// `python-pip` probe (§P) is the thing that will catch this drifting back;
	// this entry is what makes the drift visible in the meantime.
	'pip',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this job's text RUN `t` as a command? Word-delimited on both sides.
 *
 * A quoted `echo`/`printf` argument is PROSE printed to the log, not a command:
 * hadoku-watchparty's deploy job prints "Recovery: pm2 reset watchparty" for
 * the operator, and once the scan went per job (#98) that line was read as a
 * `pm2` invocation on a claw. The quoted argument is dropped; anything after
 * it on the line (`echo "x" && pm2 ...`) is still scanned.
 */
export function invokes(jobText, t) {
	const text = jobText.replace(/\b(echo|printf)\s+(["'])(?:(?!\2)[^\n])*\2/g, '$1');
	return new RegExp(`(^|[\\s;&|("'\`])${escapeRe(t)}[\\s]`, 'm').test(text);
}

/**
 * Does this job provide `t` itself — a guard, its own install, or a release
 * download OF THAT TOOL? Read off ONE job's text (#98).
 *
 * Each pattern names the tool as a WHOLE WORD. `install .*${t}` used to match
 * `install -g pnpm` for `pnpm`, but also `install` anywhere before `gh` inside
 * `highlight`, and an unescaped `${t}.rs` read `.` as any character. A
 * `releases/download` URL counts only when the URL names the tool: a job that
 * downloads `trunk` has not thereby provided `jq`.
 */
export function providesTool(jobText, t) {
	const w = `\\b${escapeRe(t)}\\b`;
	if (new RegExp(`(command -v|which)\\s+${w}`).test(jobText)) return true;
	if (new RegExp(`\\binstall\\b[^\\n]*${w}`).test(jobText)) return true;
	if (new RegExp(`${w}(\\.rs|-rs)\\b`).test(jobText)) return true;
	for (const url of jobText.match(/\S*releases\/download\S*/g) ?? []) {
		if (new RegExp(w).test(url)) return true;
	}
	// rustup installs cargo.
	return t === 'cargo' && /command -v rustup|rustup\.rs/.test(jobText);
}

/**
 * Which of `tools` each of `nodes` has on PATH as the `ci` role. Every node is
 * probed at once; a node whose probe produced nothing at all is `unreachable`
 * — "I could not look" is never read as "it has nothing", which would turn one
 * dead node into one finding per tool per workflow instead of one.
 *
 * @returns {Promise<{present: Record<string, Set<string>>, unreachable: string[]}>}
 */
export async function probeToolPresence(nodes, tools = TOOLS) {
	const script = tools
		.map(
			(t) =>
				`printf '%s\\t%s\\n' "${t}" "$(command -v ${t} >/dev/null 2>&1 && echo yes || echo no)"`
		)
		.join('\n');
	const present = {};
	const unreachable = [];
	await Promise.all(
		nodes.map(async (m) => {
			const r = await runOn(m, script, { as: 'ci', timeoutMs: 60_000 });
			if (!r.ok && !r.stdout) {
				unreachable.push(m);
				return;
			}
			const have = new Set();
			for (const l of r.stdout.split('\n')) {
				const [t, ok] = l.trim().split('\t');
				if (ok === 'yes') have.add(t);
			}
			present[m] = have;
		})
	);
	return { present, unreachable };
}

/**
 * Every missing-tool finding across `repos`' shipped workflows, given which
 * tools are present on `clawSet` (`present`, from {@link probeToolPresence}).
 * Pure given its inputs, so it is testable without ssh or a real checkout.
 *
 * `onAllClaws` only trusts nodes this run actually READ: an unreachable node
 * must not make every OTHER node's presence look incomplete (measured
 * 2026-08-29: claw-1 down turned into 340 false findings when `present[m]`
 * for the down node was read as "missing every tool").
 *
 * @returns {{findings: string[], examined: number, examinedJobs: number, noCheckoutCount: number}}
 */
export function scanWorkflows({
	repos,
	clawSet,
	present,
	tools = TOOLS,
	fetchShipped = tryShipped,
}) {
	const readable = clawSet.filter((m) => present[m]);
	const onAllClaws = (t) => readable.length > 0 && readable.every((m) => present[m].has(t));

	const findings = [];
	let examined = 0;
	let examinedJobs = 0;
	let noCheckoutCount = 0;

	for (const slug of repos) {
		// A covered repo whose shipped workflows could not be read was not
		// inspected AT ALL — "I could not look", never "nothing to invoke here".
		const source = fetchShipped(slug);
		if ('unreadable' in source) {
			noCheckoutCount++;
			findings.push(
				`${slug}: shipped workflows unreadable (${source.unreadable}) — its workflows could not ` +
					`be inspected for tool use here. Unreadable is not clean.`
			);
			continue;
		}
		const name = slug.split('/').pop();
		for (const { file, text: raw } of source.workflows()) {
			// STRIP COMMENTS AND NAME/DESCRIPTION LINES BEFORE MATCHING. A tool name
			// in prose is not an invocation.
			const text = raw
				.split('\n')
				.filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*(name|description):/.test(l))
				.join('\n');
			const rel = `${name}/.github/workflows/${file}`;
			const jobs = splitJobs(text);

			// PER JOB, NOT PER FILE (#98): each job is a fresh runner, so a guard or
			// install in one job does not cover another, and `runs-on` resolving to
			// the FLEET FORM (`${{ fromJSON(vars.CI_RUNNER) }}`, never the literal
			// "self-hosted") must be matched the way `deriveLabels` matches it.
			let fileInspected = false;
			for (const j of jobs) {
				const { runsOn, selfHosted, hosted } = deriveLabels(j.text);
				if (hosted || !selfHosted) continue;
				fileInspected = true;
				examinedJobs++;
				// A job pinned to pm2-host lands on the production host only.
				if (/pm2-host/.test(runsOn)) continue;
				for (const t of tools) {
					if (onAllClaws(t)) continue;
					if (!invokes(j.text, t)) continue;
					if (providesTool(j.text, t)) continue;
					findings.push(
						`${rel}:${j.id}: invokes "${t}", which is missing on ${clawSet.filter((m) => !present[m]?.has(t)).join(', ')} — ` +
							`and the job neither guards nor installs it. The job will pass on whichever runner ` +
							`happens to have it and die on the others, which reads as flakiness (P4).`
					);
				}
			}
			if (fileInspected) examined++;
		}
	}
	return { findings, examined, examinedJobs, noCheckoutCount };
}
