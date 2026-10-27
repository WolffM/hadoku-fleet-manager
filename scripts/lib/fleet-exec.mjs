/**
 * fleet-exec — the one way a script reaches a fleet node.
 *
 * WHY THIS EXISTS
 * ---------------
 * Seven scripts had each grown their own copy of the same twelve lines:
 * `isLocalNode(node) ? bash -s : ssh -o BatchMode=yes -o ConnectTimeout=10
 * <node> bash -s`, plus their own manifest read and their own `--machine`
 * filter. The copies had already drifted — three different ConnectTimeouts, two
 * different result shapes ({stdout,stderr} vs {out}), one with maxBuffer and six
 * without — and drift in a transport layer is exactly the kind that shows up as
 * "that node is unreachable" rather than as a bug.
 *
 * THE LOCAL RULE IS LOAD-BEARING, NOT AN OPTIMISATION
 * ---------------------------------------------------
 * hokon refuses ssh to itself. A fleet loop that ssh'd unconditionally read hokon
 * as permanently unreachable — which is how the fast loop treated it as saturated
 * for weeks. Every caller needs this branch, so it belongs here and nowhere else.
 *
 * "Nowhere else" was aspirational until 2026-08-30: the same question was being
 * answered five ways across the two halves, and only one of them survived an
 * FQDN. The single answer now lives in `src/lib/node-identity.ts` and is
 * imported BUILT below, so the library and the scripts cannot drift apart —
 * there is only one implementation to drift from.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * -----------------------------------
 * It does not decide what "healthy" means, parse a probe, or own drift policy.
 * It moves a script to a node and brings bytes back. The facet-specific
 * reading stays with the facet — a shared transport must not become a shared
 * verdict, or every check inherits every other check's blind spot.
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { manifest as manifestFile } from './paths.mjs';
// The BUILT copy, deliberately. TypeScript is the source of truth for this rule
// and `tsconfig.json` sets no `allowJs`, so a second .mjs implementation was the
// only alternative — which is the exact thing being deleted here. dist/ ships
// with the package and with `scripts/`, so a consumer always resolves it; a
// source checkout that has not been built fails LOUDLY on the import rather
// than quietly taking the wrong branch.
import { isLocalNode } from '../../dist/lib/node-identity.js';
import { nodeCommand, nodeUser } from '../../dist/lib/node-users.js';
// The BUILT copy for the same reason, and from the same `src/lib/` shelf: one
// question, one answer. `nodeRole` is the operator's decision about what the
// fleet chain may DO to a box, and it is read here so that the transport layer
// and the gates cannot disagree about which boxes are guests.
import { isGuestNode } from '../../dist/lib/node-role.js';

/**
 * The single node model. Every fleet script reads placement/limits from here.
 *
 * A FUNCTION, not a constant, and that is the whole point. `manifestFile` calls
 * `manifestDir()` -> `siteRoot()`, which THROWS when no hadoku_site checkout is
 * on disk — deliberately, because a manifest that resolves to nothing reports a
 * healthy fleet of zero machines. Resolved eagerly at module load, that throw
 * fired on `import`, so merely IMPORTING the transport layer demanded operator
 * config. CI has no sibling checkout, so `fleet-exec.test.mjs` — which wants
 * nothing but the pure arg parser — died before a single test ran, and CI stayed
 * red for 46 runs (40b42ce, 2026-08-30).
 *
 * Deferring it keeps both properties: a caller that actually needs the manifest
 * still gets the loud failure, and a caller that only needs `unconsumedArgs` no
 * longer pays for a file it never reads. Do not re-freeze this into a `const`;
 * `manifest-path-is-lazy` in the test beside this file fails the build if you do.
 */
export function manifestPath() {
	return manifestFile('fleet-runner-manifest.json');
}

/** This box's raw `os.hostname()`. Reported, never compared — use {@link isLocalNode}. */
export const LOCAL = hostname();

export { isLocalNode };

/**
 * Refuse a non-string script, naming the node.
 *
 * Not defensive noise — this caught a live outage. Every script here is a
 * template literal full of shell, and an UNESCAPED backtick inside one silently
 * ends the literal: the rest of the "script" is then parsed as JavaScript, and
 * `\` > \`` turns the whole expression into a STRING COMPARISON. registerScript
 * returned `false` for months (since 1f8bd588, 2026-08-28), so
 * `reconcile-fleet-runners --confirm` could not register a single runner. It
 * surfaced only as `ERR_INVALID_ARG_TYPE ... Received type boolean (false)` from
 * deep inside node's stream internals, naming neither the caller nor the node.
 *
 * Nothing typechecks JS inside a template literal, and no gate reads these
 * scripts. This assertion is the only thing standing between that mistake and a
 * three-frame-deep stream error.
 */
function assertScript(node, script) {
	if (typeof script !== 'string') {
		throw new TypeError(
			`fleet-exec: script for ${node} is ${typeof script}, not a string. ` +
				'A template literal that evaluates to a non-string almost always means an ' +
				'UNESCAPED BACKTICK ended it early — escape every backtick inside these ' +
				'shell scripts as \\`.'
		);
	}
	if (!script.trim()) {
		throw new TypeError(`fleet-exec: script for ${node} is empty.`);
	}
}

/**
 * `[bin, argv]` that runs a script from stdin on `node` as ROLE
 * (`src/lib/node-users.ts`): `ssh <user>@<node> bash -s`, or `bash -c 'bash -s'`
 * on this box. Throws when the role's user is not the one this process runs as
 * locally, or the manifest names a malformed user.
 */
function scriptCommand(node, role, connectTimeout, manifest) {
	const m = manifest ?? cachedManifest();
	return nodeCommand(node, role, 'bash -s', m?.machines?.[node] ?? null, {
		sshOpts: ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`],
	});
}

/**
 * `<user>@<node>` for a role, for the few callers that spawn ssh or rsync
 * themselves instead of going through {@link runOn}.
 */
export function sshDestination(node, role, manifest) {
	const m = manifest ?? cachedManifest();
	return `${nodeUser(m?.machines?.[node] ?? null, role)}@${node}`;
}

let manifestCache;
/** The manifest, read once per process: a script's run is short, and roles do not change mid-run. */
function cachedManifest() {
	manifestCache ??= loadManifest();
	return manifestCache;
}

export function loadManifest(path = manifestPath()) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Nodes a command should act on.
 *
 * Still spelled `selectMachines`: this is a published subpath export
 * (`@wolffm/fleet-manager/fleet-exec`) and hadoku_site's
 * `scripts/admin/check-boundary-contracts.mjs` imports it by that name. Same
 * reason `machineArg` below keeps its spelling — it is named for the
 * `--machine` FLAG, which is operator UI. See docs/VOCABULARY.md §"Where the
 * rename stops".
 *
 * `where` is the caller's own eligibility rule — a throttle deploy needs
 * `maxConcurrent`, a slice deploy needs `slice`, a toolchain probe needs only
 * that the node is not `placement: excluded`. Filtering here rather than
 * mid-loop keeps "no nodes matched" a single, explainable outcome instead of
 * a silently short run.
 */
export function selectMachines(manifest, { only = null, where = null } = {}) {
	return Object.entries(manifest.machines ?? {}).filter(
		([name, m]) => (!only || name === only) && (!where || where(m, name))
	);
}

/**
 * THE VALUE OF `--machine`, READ AND NOT JUDGED.
 *
 * {@link machineArg} is the operator-facing parser and it EXITS THE PROCESS on a
 * stray positional. That is right for a command's own argument handling and
 * catastrophic for a role lookup: asking "did the operator name this node?"
 * must never be able to kill the caller, and `guestGate` asks it on every node
 * of every sweep. So the reading half lives here, pure, and the refusing half
 * stays where an operator can see it.
 *
 * Both spellings, because `--machine=NAME` and `--machine NAME` are the same
 * request and a parser that silently disagreed with itself about that is the
 * 2026-09-08 bug `machineArg` carries a paragraph about.
 */
function namedMachine(argv) {
	const eq = argv.find((a) => a.startsWith('--machine='));
	if (eq !== undefined) return eq.slice('--machine='.length) || null;
	const i = argv.indexOf('--machine');
	if (i === -1) return null;
	const v = argv[i + 1];
	return v === undefined || v.startsWith('-') ? null : v;
}

/**
 * Memoized manifest, for role lookups ONLY.
 *
 * Lazy for the same reason {@link manifestPath} is — importing the transport
 * layer must not demand operator config — and memoized because a fleet sweep
 * asks this once per node and the answer cannot change mid-sweep without the
 * sweep judging two nodes against two manifests.
 */
let roleManifestCache;
function roleManifest() {
	if (roleManifestCache === undefined) roleManifestCache = loadManifest();
	return roleManifestCache;
}

/**
 * MAY THE FLEET CHAIN REACH THIS BOX? — asked once, here, for every transport.
 *
 * `src/lib/node-role.ts` owns what a role IS; this owns what a role MEANS to a
 * script that is about to run something somewhere. Five scripts rediscovered
 * the same rule in Wave 3d and each wrote its own `isGuestNode(...) && !FLAG`,
 * and `fleet slice --check` was the sixth — red in `ci:audit-gates` while it
 * printed "On hokon, as the operator: sudo -v && fleet slice --machine hokon
 * --confirm", which is precisely the thing the fleet must never ask of a guest.
 *
 * THREE DOORS OPEN IT, and all three are an explicit human act:
 *   - `includeGuests: true` from the caller, for a command whose whole purpose
 *     is the guest.
 *   - `--include-guests` on the command line, the spelling `converge-toolchain`
 *     established.
 *   - `--machine <the guest>`, naming it outright. An operator who typed the
 *     node's name is not going to be surprised by reaching it, and refusing
 *     there would leave no way to audit a guest at all.
 *
 * A guest that none of the three named is SKIPPED, and the skip is a fact the
 * caller must report — never a silent one. `skippedByRole` exists so a report
 * can carry it.
 *
 * @param {string} node
 * @param {{includeGuests?: boolean, argv?: string[], manifest?: object}} [opts]
 * @returns {{skip: boolean, role: 'claw'|'guest', why: string|null}}
 */
export function guestGate(node, { includeGuests = false, argv, manifest } = {}) {
	const av = argv ?? process.argv.slice(2);
	const m = manifest ?? roleManifest();
	const role = isGuestNode(m?.machines?.[node]) ? 'guest' : 'claw';
	if (role !== 'guest') return { skip: false, role, why: null };
	if (includeGuests === true) return { skip: false, role, why: 'the caller passed includeGuests' };
	if (av.includes('--include-guests')) return { skip: false, role, why: '--include-guests' };
	if (namedMachine(av) === node) return { skip: false, role, why: `--machine ${node}` };
	return {
		skip: true,
		role,
		why:
			'a guest lends the fleet a registration and nothing else (operator, 2026-09-14); ' +
			`reach it with --machine ${node} or --include-guests`,
	};
}

/**
 * The nodes a command may act on, with the guests it refused to act on.
 *
 * THE ROLE-AWARE DOOR, and the one every fleet-reaching script should come
 * through. {@link selectMachines} keeps its exact behaviour — it is a published
 * subpath export and hadoku_site's `check-boundary-contracts.mjs` imports it —
 * so this wraps it rather than changing it under a consumer in another repo.
 *
 * `skippedByRole` is returned SEPARATELY rather than folded into `nodes`,
 * matching what `deploy-ci-throttle` already does with its own list: `nodes`
 * means "the boxes this run acted on", and a guest is exactly a box it did not.
 * Merging them would make a skipped guest indistinguishable from a deployed
 * node to anything counting them.
 *
 * A caller MUST report what comes back in `skippedByRole`. A skip nobody prints
 * is how a node stops being checked and nobody notices — the reason
 * `converge-toolchain` prints its own.
 */
export function selectNodes(
	manifest,
	{ only = null, where = null, includeGuests = false, argv } = {}
) {
	const nodes = [];
	const skippedByRole = [];
	for (const entry of selectMachines(manifest, { only, where })) {
		const gate = guestGate(entry[0], { includeGuests, argv, manifest });
		if (gate.skip) skippedByRole.push({ node: entry[0], role: gate.role, why: gate.why });
		else nodes.push(entry);
	}
	return { nodes, skippedByRole };
}

/**
 * Tokens in `argv` that nothing consumed.
 *
 * Pure, and exported so the refusal below can be tested without a process.
 * `valueFlags` names the flags that swallow the token after them; anything else
 * beginning with `-` is a boolean flag and is left alone. A bare `--` ends flag
 * parsing, as it does everywhere else.
 *
 * Unknown FLAGS are deliberately still allowed. Refusing them would mean every
 * caller declaring its whole flag set here, and the callers do not agree on one
 * — `--restart` exists in the slice deployer and nowhere else. A typo'd flag is
 * a real hazard and a separate piece of work; a typo'd flag at least does not
 * silently WIDEN the blast radius, which is what a positional does.
 */
export function unconsumedArgs(argv, { valueFlags = [] } = {}) {
	const takesValue = new Set(['--machine', ...valueFlags]);
	const stray = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') break;
		if (a.startsWith('-')) {
			if (takesValue.has(a)) i++;
			continue;
		}
		stray.push(a);
	}
	return stray;
}

/**
 * Value of `--machine <name>`, or null — AND A REFUSAL FOR ANYTHING ELSE.
 *
 * THE BUG THIS EXISTS TO CLOSE, measured 2026-08-30 against the real manifest:
 *
 *     ["claw-3", "--confirm"]             -> only=null  targets claw-1, claw-2, claw-3, hokon
 *     ["--machine","claw-3","--confirm"]  -> only=claw-3 targets claw-3
 *     ["claw-4", "--confirm"]             -> only=null  targets claw-1, claw-2, claw-3, hokon
 *
 * The third line is the dangerous one and it is the one an operator onboarding a
 * node will type. `claw-4` is not in the manifest, so provision-fleet.mjs's
 * guard — "a node is provisioned BECAUSE it is declared, add it to the
 * manifest first", the guard written for exactly this moment — NEVER FIRES,
 * because four other nodes matched. `fleet provision claw-4 --confirm` then
 * applies a confirmed run across the entire live fleet, production host
 * included, and reports success.
 *
 * A bare positional is REFUSED, never treated as an implied `--machine`. The
 * repo's convention is that ambiguity is refused, and inferring it here would
 * make the safe spelling and the dangerous one differ only in what this function
 * happened to guess. It is also why this exits rather than throwing: the
 * audience is an operator at a terminal, and a stack trace is not a refusal.
 *
 * `--machine` with no value, or with another flag as its value, is refused for
 * the same reason — `--machine --confirm` would otherwise scope the run to a
 * node named "--confirm", match nothing, and (in the deployers) report a
 * clean pass over zero nodes.
 */
export function machineArg(argv = process.argv.slice(2), { valueFlags = [] } = {}) {
	const stray = unconsumedArgs(argv, { valueFlags });
	if (stray.length) {
		console.error(
			`fleet: unrecognised argument${stray.length > 1 ? 's' : ''}: ${stray.join(' ')}\n\n` +
				`  Node scoping is spelled --machine <name>, never a bare positional.\n` +
				`  A positional is IGNORED, so the run silently covers the WHOLE FLEET — and\n` +
				`  with --confirm it applies to every declared node including the production\n` +
				`  host. The "add it to the manifest first" guard cannot fire either, because\n` +
				`  the other nodes still match.\n\n` +
				`  Did you mean:  --machine ${stray[0]}`
		);
		process.exit(1);
	}
	// `--machine=NAME` IS THE SAME REQUEST AS `--machine NAME`, and until
	// 2026-09-08 this parser silently disagreed.
	//
	// It looked only for a bare `--machine` token, so `--machine=claw-7` fell
	// through every check: `unconsumedArgs` skips anything starting with `-` as a
	// boolean flag, so it was not a stray, and indexOf found nothing, so the
	// function returned null — WHOLE FLEET. `fleet provision --machine=claw-7
	// --confirm` therefore applied to every declared node including the
	// production host, which is verbatim the outcome the refusal above warns
	// about for positionals. The parser written to prevent a silently widened
	// blast radius had one of its own, reachable by the more conventional
	// spelling of its own flag.
	const eq = argv.find((a) => a.startsWith('--machine='));
	if (eq !== undefined) {
		const v = eq.slice('--machine='.length);
		if (!v) {
			console.error(
				'fleet: --machine= was given with no machine name.\n' +
					'  Scoping to a node that cannot exist matches nothing, and a deployer that\n' +
					'  matched nothing reports a clean pass over zero nodes.'
			);
			process.exit(1);
		}
		return v;
	}
	const i = argv.indexOf('--machine');
	if (i === -1) return null;
	const value = argv[i + 1];
	if (value === undefined || value.startsWith('-')) {
		console.error(
			`fleet: --machine needs a machine name${value === undefined ? '' : `, got ${value}`}.\n` +
				`  Scoping to a node that cannot exist matches nothing, and a deployer that\n` +
				`  matched nothing reports a clean pass over zero nodes.`
		);
		process.exit(1);
	}
	return value;
}

/**
 * What a transport returns instead of reaching a guest.
 *
 * `ok: false`, deliberately, and this is the strict direction that
 * `src/lib/node-role.ts` argues for its own default. A caller that has not been
 * taught about `skippedByRole` then sees a node it did not get an answer from,
 * which is TRUE — "I chose not to look" and "I could not look" are different
 * facts but neither of them is "nothing is wrong". An `ok: true` skip with empty
 * output would hand every unconverted caller a healthy fleet of one fewer
 * machine, which is the failure CLAUDE.md names first.
 */
/**
 * Why a call failed, in words a finding can carry. `execFile` reports a call
 * IT killed at the timeout as a bare "Command failed: <argv>", the same text
 * as any other failure, and the process it killed never got to say why (an
 * ssh stuck resolving a name prints nothing). So a kill says it was one, and
 * otherwise the far side's own last words win over the argv.
 */
function failureReason(err, timeoutMs, stderr) {
	if (err.killed)
		return `no answer within ${Math.round(timeoutMs / 1000)}s (killed by ${err.signal ?? 'timeout'})`;
	return stderr.trim().split('\n').at(-1) || String(err.message);
}

/** A role that cannot be acted as is a result, like an unreachable node: never a throw. */
function roleFailure(local, err) {
	const error = `cannot act as the role: ${err.message}`;
	return { ok: false, stdout: '', stderr: error, out: error, local, error };
}

function guestSkipResult(node, gate) {
	return {
		ok: false,
		skippedByRole: gate.role,
		stdout: '',
		stderr: '',
		out: '',
		local: false,
		error: `skipped: guest — ${gate.why}`,
	};
}

/**
 * Should this transport call refuse the node?
 *
 * TRI-STATE, and the middle state is a documented debt rather than a design.
 *
 *   `includeGuests: true`      reach, whatever the role.
 *   `includeGuests: false`     ENFORCE — a guest is skipped unless the operator
 *                              named it (see {@link guestGate}).
 *   omitted                    reach, unenforced.
 *
 * Omitted cannot be made to mean "enforce" in one wave, and pretending
 * otherwise would be worse than saying so. `scripts/lib/node-role-guard.test.mjs`
 * measured it: ELEVEN scripts reach a node without consulting a role, six of
 * them through `selectMachines` + `runOn` with hokon in the selection. Flipping
 * this default would skip hokon inside all of them at once — and the ones
 * written properly, with an end-of-output sentinel, read a missing answer as
 * "the probe never ran" and turn red. That is six gates reddened by a lane that
 * owns none of them. The guard names every one and refuses to let the list
 * grow; the default flips when the list is empty.
 */
function guestSkip(node, includeGuests, argv, manifest) {
	if (includeGuests === undefined) return null;
	const gate = guestGate(node, { includeGuests, argv, manifest });
	return gate.skip ? gate : null;
}

/**
 * Run a shell script on a node and collect its output.
 *
 * Never rejects: an unreachable node is a RESULT, not an exception. A fleet
 * sweep that throws on the first dead box reports nothing about the other three.
 *
 * `includeGuests` arms the role gate — see {@link guestSkip}.
 *
 * `as` is the NODE USER ROLE the script runs as (`src/lib/node-users.ts`):
 * `admin` (the default: provisioning, system units, observation) or `ci`
 * (anything that touches CI's units, slots, toolchains or `$HOME`). A role
 * that cannot be acted as comes back as a failed result, never a throw.
 */
export function runOn(
	node,
	script,
	{
		timeoutMs = 120_000,
		connectTimeout = 10,
		maxBuffer,
		includeGuests,
		argv: gateArgv,
		manifest,
		as = 'admin',
	} = {}
) {
	assertScript(node, script);
	const gate = guestSkip(node, includeGuests, gateArgv, manifest);
	if (gate) return Promise.resolve(guestSkipResult(node, gate));
	const local = isLocalNode(node);
	let cmd;
	let argv;
	try {
		[cmd, argv] = scriptCommand(node, as, connectTimeout, manifest);
	} catch (err) {
		return Promise.resolve(roleFailure(local, err));
	}
	const opts = { timeout: timeoutMs };
	if (maxBuffer) opts.maxBuffer = maxBuffer;
	return new Promise((res) => {
		let stdinError = null;
		const child = execFile(cmd, argv, opts, (err, stdout, stderr) => {
			const o = stdout ?? '';
			const e = stderr ?? '';
			res({
				ok: !err && !stdinError,
				stdout: o,
				stderr: e,
				out: o + e,
				local,
				error: err ? failureReason(err, timeoutMs, e) : stdinError,
			});
		});
		/*
		 * A child that exits BEFORE reading its script is a normal outcome, and
		 * without this handler it takes the whole CLI down with it.
		 *
		 * `execFile` gives back a pipe; writing to a pipe whose reader is gone
		 * raises EPIPE on the stream. An 'error' event with no listener is
		 * rethrown as an uncaught exception, so the process that was merely
		 * ASKING a node a question dies instead — and what the caller gets back
		 * is a Node crash dump on stdout where a `--json` document should be.
		 * That is the shape of #48: `deployer: ... still refuses` and two of its
		 * neighbours failed in the full run and passed alone for weeks, because
		 * the tests that lose the race are precisely the ones whose subject
		 * REFUSES — it exits early by design, and under load the exit wins.
		 *
		 * So EPIPE here is not an error to report: the child's own exit status
		 * and output already say what happened, and the execFile callback above
		 * is what reports them. Anything else on this stream is a real fault
		 * with no other channel to surface on, so it is carried into the result
		 * rather than swallowed — a `catch {}` that discards the reason is how
		 * a rate limit, a timeout and a dead box become one undiagnosable
		 * finding.
		 */
		child.stdin.on('error', (e) => {
			if (e?.code === 'EPIPE' || e?.code === 'ERR_STREAM_DESTROYED') return;
			stdinError = String(e?.message ?? e);
		});
		child.stdin.end(script);
	});
}

/**
 * The stdout a SYNC call may bring back before Node kills the child — 64 MiB.
 *
 * Node's own default is 1 MiB, and past it `execFileSync` throws `ENOBUFS`
 * after the node has ANSWERED. That is the 2026-09-18 finding (#37): claw-1's
 * `job-metrics.jsonl` reached 1,136,332 bytes, `fleet job-metrics` read the
 * node as `spawnSync ssh ENOBUFS`, and the report filed a claw that was up
 * and serving jobs under UNREACHABLE. Every node's file grows at its own job
 * rate, so the other six were each one busy fortnight behind it.
 *
 * Sized for the FLEET, not for the one file that tripped it: the other sync
 * callers that set their own ceiling already chose 8-64 MiB
 * (`check-tier-fleet`, `service-inventory`), and a transport default below the
 * largest of them would make the next reader rediscover this. It is a CEILING,
 * not an allocation — the buffer grows with what actually arrives.
 *
 * The async {@link runOn} is left at Node's default on purpose: its callers
 * pass `maxBuffer` explicitly where they need it, and changing a default under
 * a dozen deployers is a different lane's blast radius.
 */
export const SYNC_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Blocking twin of {@link runOn}, for callers whose main loop is synchronous.
 *
 * A FAILURE CARRIES ITS CLASS, not just a message. `code` is Node's errno for
 * a failure on THIS side of the pipe (`ENOBUFS`, `ETIMEDOUT`, `ENOENT` for a
 * missing binary) and `status` is the child's exit status. ssh reserves 255 for
 * its own failures — connect, auth, host key — so `status === 255` on a remote
 * call is the only shape that means "the node could not be reached". Before
 * this, every failure was one flattened string and a caller had no way to tell
 * a dead box from a full buffer, so it called both unreachable.
 */
export function runOnSync(
	node,
	script,
	{
		timeoutMs = 120_000,
		connectTimeout = 10,
		maxBuffer = SYNC_MAX_BUFFER,
		includeGuests,
		argv: gateArgv,
		manifest,
		as = 'admin',
	} = {}
) {
	const gate = guestSkip(node, includeGuests, gateArgv, manifest);
	if (gate) return guestSkipResult(node, gate);
	const local = isLocalNode(node);
	let cmd;
	let argv;
	try {
		[cmd, argv] = scriptCommand(node, as, connectTimeout, manifest);
	} catch (err) {
		return { ...roleFailure(local, err), code: null, status: null };
	}
	const opts = { input: script, encoding: 'utf8', timeout: timeoutMs, maxBuffer };
	try {
		const out = execFileSync(cmd, argv, opts);
		return { ok: true, out, stdout: out, stderr: '', local, error: null, code: null, status: 0 };
	} catch (err) {
		const o = String(err.stdout ?? '');
		return {
			ok: false,
			out: o,
			stdout: o,
			stderr: String(err.stderr ?? ''),
			local,
			error: (err.code === 'ETIMEDOUT'
				? `no answer within ${Math.round(timeoutMs / 1000)}s (killed by ${err.signal ?? 'timeout'})`
				: String(err.stderr || err.message)
			)
				.trim()
				.slice(0, 200),
			code: typeof err.code === 'string' ? err.code : null,
			status: typeof err.status === 'number' ? err.status : null,
		};
	}
}

/**
 * Parse the `SUMMARY k=v k=v` line a node-half script emits.
 *
 * Returns null when there is NO summary line — which a caller must treat as a
 * failed run, not as an empty one. A node that died mid-transaction prints
 * plenty of output and no summary; reading that as "nothing to do" is how an
 * audit reports green on a box it never finished talking to.
 */
export function parseSummary(out, prefix = 'SUMMARY') {
	const line = out.split('\n').find((l) => l.startsWith(prefix));
	if (!line) return null;
	const kv = {};
	for (const tok of line.split(/\s+/).slice(1)) {
		const i = tok.indexOf('=');
		if (i > 0) kv[tok.slice(0, i)] = tok.slice(i + 1);
	}
	return kv;
}
