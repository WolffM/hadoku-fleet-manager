/**
 * capability-seeds — earned capabilities come with their artifacts (#102, wave 4c lane E).
 *
 * WHY THIS EXISTS
 * ---------------
 * cardtable's Forge jobs moved onto the claws on 2026-10-07 and a COLD claw pays
 * the Forge bundle build in-job: 74-100s at ~504MB, long enough that the first
 * match on that node times out. The operator's call that day: an artifact on
 * disk is effectively free, and earning a capability should leave the claw
 * READY for the work it gates, not merely ABLE to do it eventually. No process
 * warmth — this seeds a FILE, never a JVM, a listener, or anything else that
 * stays resident to be "warm".
 *
 * The manifest's `$seeds` object, keyed by capability id, names the repo and
 * script that produce the artifact and where its cache lives on the claw. This
 * module is the pure(-ish) half: deciding whether a node should be seeded, and
 * the shell text that does it. `converge-toolchain.mjs` (nightly,
 * `ci:toolchain-refresh`) and `bootcamp.mjs` are the two callers — see the
 * brief's "who runs them" — and both are thin: they select nodes, then call
 * {@link seedNode} once per node.
 *
 * CAPABILITY AND REPO ELIGIBILITY, NOT CAPABILITY ALONE
 * ------------------------------------------------------
 * claw-5 earns `jdk21` (it has the RAM) and is HARD-EXCLUDED from cardtable's
 * work (`excludeRepos`, wave 3w #82 — vitest timeouts, 100% of job kinds >=1.5x
 * slower than the rest of the fleet). Seeding claw-5's Forge cache would spend
 * disk and an mvn build on an artifact that repo's jobs will never ask this
 * node to use: `placement-rules.mjs`'s `mayRunRepo` is the SAME exclusion the
 * dispatcher honours, so a seed is gated on it too — {@link seedNode} checks
 * both `nodeEarnsSeed` and `mayRunRepo` before doing anything else. "Ready for
 * the work it gates" presupposes the node is eligible to receive that work at
 * all.
 *
 * HOKON IS A GUEST: NOTHING SEEDS IT
 * -----------------------------------
 * Not because hokon could not use the artifact — because the fleet chain does
 * not touch hokon at all (operator, 2026-09-14), the same rule
 * `converge-toolchain`/`bootcamp` already enforce by role. {@link seedNode}
 * re-checks the role itself rather than trusting the caller to have filtered
 * guests out — "a guard rather than a sentence" (capabilities.ts's own phrase
 * for the same shape). `capability-seeds.test.mjs` proves hokon is refused with
 * ZERO ssh or gh calls, not merely that it ends up unseeded.
 *
 * NO TOKEN EVER LANDS ON A CLAW
 * ------------------------------
 * The controller resolves the seed's ARGUMENT (today: cardtable's `forge`
 * submodule pin at its default branch) and fetches the SCRIPT TEXT, both
 * through its own `gh` — never an ssh call that reaches the claw, and never a
 * secret in the shipped text. What reaches the node over ssh is: the resolved
 * pin (a public git commit sha — cardtable is private, `WolffM/forge` is
 * public, settled in the wave brief), the cache directory, and the script body
 * itself. `capability-seeds.test.mjs` asserts a sentinel token value set in the
 * test's own environment never appears in anything handed to the `ssh` dep.
 *
 * *** BLOCKED ON CARDTABLE: forge-bundle.sh CANNOT BE DRIVEN AS-IS ***
 * ----------------------------------------------------------------------
 * Read `~/repos/hadoku-cardtable/scripts/forge-bundle.sh` before changing
 * anything here. It takes NO arguments and resolves its own pin with
 * `git ls-tree HEAD forge` — IN THE CURRENT DIRECTORY. There is no env var or
 * flag that accepts a pre-resolved pin. That is fine for CI, which always runs
 * inside a real cardtable checkout with the `forge` submodule entry at HEAD;
 * it is NOT fine for "ship the script, no checkout", because there is nothing
 * for `git ls-tree` to read.
 *
 * So {@link buildRunScript} below ships the script text wrapped with
 * `export CARDTABLE_FORGE_PIN='<pin>'` and `CARDTABLE_FORGE_CACHE`, which is
 * the shape this module is written against — but the REAL, unmodified
 * forge-bundle.sh does not read `CARDTABLE_FORGE_PIN` and will fall through to
 * its own `git ls-tree HEAD forge`, which fails loudly (not silently — see
 * `parseSeedProof`) with no `.git` on the shipped tree:
 * "git ls-tree HEAD forge returned no pin — is the forge submodule entry
 * missing from this commit?". That is a SAFE failure (a reported, non-zero
 * finding, never a false "seeded"), but it means a real nightly run will fail
 * every cardtable seed until cardtable makes one additive change:
 *
 *   PIN="${CARDTABLE_FORGE_PIN:-}"
 *   if [ -z "$PIN" ]; then
 *     PIN=$(git ls-tree HEAD forge 2>/dev/null | awk '{print $3}') || true
 *   fi
 *
 * — a two-line, backward-compatible override (CI continues to work exactly as
 * today; only a caller that SETS the var takes the new path). This lane does
 * NOT edit cardtable (out of scope by the brief); `capability-seeds.test.mjs`
 * proves the fleet-manager side of the contract against a FIXTURE script
 * shaped like forge-bundle.sh WOULD be after that change, so the orchestration
 * here (gh resolution, disk floor, busy check, token safety, idempotency
 * proof) is fully exercised and ready the day cardtable lands it.
 *
 * A DISK BUDGET WELL ABOVE ADMISSION'S FLOOR
 * --------------------------------------------
 * `admitMint` in `src/runners/ephemeral.ts` refuses a mint under 2048 MB free.
 * {@link SEED_DISK_FLOOR_MB} is 8192 MB — 4x that floor — derived from what
 * actually lives under a seed's cache: forge-bundle.sh measures ~504 MB per
 * pin and keeps up to 3 (`KEEP_PINS`), so steady state is ~1.5 GB, but a BUILD
 * (not a cache HIT) clones the `forge` submodule and runs `mvn package`,
 * which downloads into `~/.m2` on a cold node and leaves build output under a
 * scratch dir before the bundle is copied out — comfortably more than the
 * steady-state cache alone. 8 GiB leaves that process room without getting
 * anywhere near the fleet's `minFreeGb: 25` alarm threshold from the other
 * direction.
 *
 * DONE IS CURRENT, NOT PRESENT
 * ------------------------------
 * forge-bundle.sh prints exactly two log shapes for a successful run, to
 * stderr: `HIT: pin <PIN> already cached at <dir>` or `BUILD finished in <N>s
 * total (...)`. {@link parseSeedProof} reads those verbatim — the script's
 * own account of what it just did for TODAY's pin — rather than trusting a
 * zero exit code alone, which would not distinguish "proved current" from
 * "exited 0 and printed nothing we understood".
 */

import { execFile } from 'node:child_process';
import { capability, provenCapabilities } from '../../dist/capabilities.js';
import { isGuestNode } from '../../dist/lib/node-role.js';
import { mayRunRepo } from './placement-rules.mjs';
import { runOn } from './fleet-exec.mjs';
import { READ_ATTEMPTS, describeReadFailure } from './queue-health.mjs';

/**
 * Free-space floor, in MiB, on the filesystem holding a seed's cache. See the
 * header's "A DISK BUDGET" section for the derivation. Refusing below this is
 * a FINDING (point 3 of the brief: "a refused seed is a finding, not a skip"),
 * never a silent skip.
 */
export const SEED_DISK_FLOOR_MB = 8192;

/** `argument.kind` values this module knows how to resolve. */
export const SEED_ARGUMENT_KINDS = ['submodule-pin'];

/** Statuses that count against the caller's exit code — "could not look" and
 * "refused" are both findings; "not applicable to this node" and "skipped
 * because busy" are not. */
export const SEED_FINDING_STATUSES = ['refused', 'unreadable', 'failed'];

export function isSeedFinding(status) {
	return SEED_FINDING_STATUSES.includes(status);
}

/**
 * `[id, spec]` pairs out of `manifest.$seeds`, or `[]` when the key is absent
 * (seeds are optional — a manifest with none is not an error) or malformed
 * (an object check is ALL this does; {@link validateSeeds} is where a
 * malformed entry becomes a finding, not here, where it would have to pick
 * silently between throwing and guessing).
 */
export function seedEntries(manifest) {
	const raw = manifest?.$seeds;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
	return Object.entries(raw).filter(([id]) => !id.startsWith('$'));
}

/**
 * Validate `manifest.$seeds` against the capability registry — called from
 * `check-capability-schema.mjs`, merged into its one finding array.
 *
 * PURE, offline, same shape as `validateCapabilities`'s findings
 * (`{rule, machine, capability, message}`) so the two concat without the
 * caller needing to know which validator produced which entry.
 */
export function validateSeeds(manifest) {
	const findings = [];
	const add = (rule, cap, message) =>
		findings.push({ rule, machine: null, capability: cap, message });

	const raw = manifest?.$seeds;
	if (raw === undefined) return findings; // optional section; absence is not a finding
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		add(
			'seeds-malformed',
			null,
			'`$seeds` must be an object keyed by capability id, if present at all.'
		);
		return findings;
	}

	for (const [id, spec] of Object.entries(raw)) {
		if (id.startsWith('$')) continue; // a `$why`-style comment key, not an entry

		const cap = capability(id);
		if (!cap) {
			add(
				'seed-unknown-capability',
				id,
				`$seeds declares "${id}", which is in no capability registry entry. A seed exists ` +
					`to make an EARNED capability's gated work cheap to run; there is nothing to earn ` +
					`here, and nothing can ever check whether a node qualifies.`
			);
			continue;
		}
		if (cap.surface !== 'label') {
			add(
				'seed-surface-mismatch',
				id,
				`$seeds declares "${id}", but it is a ${cap.surface} capability. A seed differentiates ` +
					`claws that have earned a LABEL from claws that have not — a toolchain capability ` +
					`applies to every node, so seeding "for it" says nothing.`
			);
			continue;
		}

		if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
			add('seed-malformed', id, `$seeds["${id}"] must be an object.`);
			continue;
		}

		if (typeof spec.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(spec.repo)) {
			add(
				'seed-bad-repo',
				id,
				`$seeds["${id}"].repo must be an "owner/name" string naming the repo whose script ` +
					`produces this artifact.`
			);
		}

		if (
			typeof spec.script !== 'string' ||
			!spec.script ||
			spec.script.startsWith('/') ||
			spec.script.split('/').includes('..')
		) {
			add(
				'seed-bad-script',
				id,
				`$seeds["${id}"].script must be a path RELATIVE to the repo's root, with no leading ` +
					`"/" and no ".." segment.`
			);
		}

		// `cache` IS THE SHAPE CONTRACT WITH LANE F: `fleet doctor` sizes seed
		// caches by reading this field, so its NAME and its `~`-relative form are
		// load-bearing for a reader this lane does not own.
		if (typeof spec.cache !== 'string' || !/^~\/.+/.test(spec.cache)) {
			add(
				'seed-bad-cache',
				id,
				`$seeds["${id}"].cache must be \`~\`-relative (e.g. "~/.cache/cardtable-forge") — ` +
					`the cache directory on the claw, which \`fleet doctor\` also reads by this exact ` +
					`field name to report seed-cache sizes.`
			);
		}

		const arg = spec.argument;
		if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
			add('seed-bad-argument', id, `$seeds["${id}"].argument must be an object.`);
		} else if (!SEED_ARGUMENT_KINDS.includes(arg.kind)) {
			add(
				'seed-unknown-argument-kind',
				id,
				`$seeds["${id}"].argument.kind is "${arg.kind}", which this package does not know how ` +
					`to resolve. Known kinds: ${SEED_ARGUMENT_KINDS.join(', ')}.`
			);
		} else if (arg.kind === 'submodule-pin') {
			if (typeof arg.submodule !== 'string' || !arg.submodule) {
				add(
					'seed-bad-argument',
					id,
					`$seeds["${id}"].argument.submodule must name the submodule path whose pinned ` +
						`commit is this seed's argument.`
				);
			}
			if (arg.ref !== undefined && arg.ref !== 'default') {
				add(
					'seed-bad-argument',
					id,
					`$seeds["${id}"].argument.ref must be "default" (the repo's own default branch) ` +
						`or omitted — resolving against a fixed branch name would silently go stale the ` +
						`day the repo's default branch is renamed.`
				);
			}
		}
	}

	return findings;
}

/**
 * Has this node PROVEN the capability a seed is keyed by? Delegates to
 * {@link provenCapabilities} — the same `earned ∪ prereqs` bootcamp itself
 * writes — rather than re-deriving "earned" a second way.
 */
export function nodeEarnsSeed(node, id) {
	const proven = provenCapabilities(node);
	return proven !== null && proven.has(id);
}

/** `~/sub/dir` -> the shell text `"$HOME/sub/dir"`, quoted for embedding. */
function cacheAbsPath(cache) {
	const rel = cache.replace(/^~\/?/, '');
	return rel ? `"$HOME/${rel}"` : '"$HOME"';
}

/** The remote probe for a live job: `pgrep -x`, never `-f`, so this script's
 * own name can never self-match (CLAUDE.md, `[R]unner.Worker` sibling form). */
export const BUSY_CHECK_SCRIPT =
	'if pgrep -x Runner.Worker >/dev/null 2>&1; then echo BUSY; else echo IDLE; fi';

/** The remote probe for free space on the filesystem holding a seed's cache. */
export function diskCheckScript(cache) {
	const abs = cacheAbsPath(cache);
	return `mkdir -p ${abs} 2>/dev/null\ndf -Pk ${abs} 2>/dev/null | tail -n 1 | awk '{print $4}'`;
}

/**
 * The runnable text that SEEDS one node: the fetched script, prefixed with the
 * controller-resolved argument as an env var never passed through ssh's own
 * argv (same shape `installScript`'s `TARGET_VERSION` prefix uses) — nothing
 * on this node's process list or `.bash_history` ever shows the pin arriving
 * any other way.
 */
export function buildRunScript(spec, resolved) {
	const abs = cacheAbsPath(spec.cache);
	return [
		'set -eu',
		`export CARDTABLE_FORGE_PIN='${resolved.pin}'`,
		`export CARDTABLE_FORGE_CACHE=${abs}`,
		`mkdir -p ${abs}`,
		resolved.scriptText,
	].join('\n');
}

/**
 * The seed script's own proof that it is CURRENT for today's argument — see
 * the header's "DONE IS CURRENT, NOT PRESENT". Reads forge-bundle.sh's two
 * literal log shapes; a run that printed neither proved nothing, whatever its
 * exit code.
 */
export function parseSeedProof(output) {
	const text = String(output ?? '');
	const hit = /HIT: pin (\S+) already cached/.exec(text);
	if (hit) return { kind: 'HIT', pin: hit[1] };
	const build = /BUILD finished in (\d+)s/.exec(text);
	if (build) return { kind: 'BUILD', seconds: Number(build[1]) };
	return { kind: null, reason: 'the seed script printed neither a HIT nor a BUILD-finished line' };
}

/**
 * Resolve a seed's argument and fetch its script text — CONTROLLER-SIDE, via
 * the injected `gh`. Never ssh's anywhere; never reaches the claw.
 *
 * @param {object} spec a validated `$seeds` entry
 * @param {(args: string[]) => Promise<{ok:boolean, stdout:string, stderr:string, error:string|null}>} gh
 */
export async function resolveSeed(spec, gh) {
	if (spec.argument?.kind !== 'submodule-pin') {
		return { ok: false, reason: `unsupported argument kind "${spec.argument?.kind}"` };
	}

	const repoInfo = await gh(['api', `repos/${spec.repo}`]);
	if (!repoInfo.ok) {
		return {
			ok: false,
			reason: `could not read repos/${spec.repo}: ${repoInfo.error ?? repoInfo.stderr}`,
		};
	}
	let defaultBranch;
	try {
		defaultBranch = JSON.parse(repoInfo.stdout).default_branch;
	} catch {
		return { ok: false, reason: `repos/${spec.repo} did not return parseable JSON` };
	}
	if (!defaultBranch) {
		return { ok: false, reason: `repos/${spec.repo} carried no default_branch` };
	}

	const sub = spec.argument.submodule;
	const subResp = await gh(['api', `repos/${spec.repo}/contents/${sub}?ref=${defaultBranch}`]);
	if (!subResp.ok) {
		return {
			ok: false,
			reason: `could not read ${sub} at ${spec.repo}@${defaultBranch}: ${subResp.error ?? subResp.stderr}`,
		};
	}
	let subEntry;
	try {
		subEntry = JSON.parse(subResp.stdout);
	} catch {
		return { ok: false, reason: `contents/${sub} did not return parseable JSON` };
	}
	if (subEntry.type !== 'submodule' || typeof subEntry.sha !== 'string' || !subEntry.sha) {
		return {
			ok: false,
			reason: `${sub} at ${spec.repo}@${defaultBranch} is not a submodule entry (got type=${subEntry.type})`,
		};
	}

	const scriptResp = await gh([
		'api',
		`repos/${spec.repo}/contents/${spec.script}?ref=${defaultBranch}`,
	]);
	if (!scriptResp.ok) {
		return {
			ok: false,
			reason: `could not fetch ${spec.script}: ${scriptResp.error ?? scriptResp.stderr}`,
		};
	}
	let scriptEntry;
	try {
		scriptEntry = JSON.parse(scriptResp.stdout);
	} catch {
		return { ok: false, reason: `contents/${spec.script} did not return parseable JSON` };
	}
	if (scriptEntry.encoding !== 'base64' || typeof scriptEntry.content !== 'string') {
		return { ok: false, reason: `${spec.script} response carried no base64 content` };
	}
	const scriptText = Buffer.from(scriptEntry.content.replace(/\n/g, ''), 'base64').toString('utf8');

	return { ok: true, pin: subEntry.sha, defaultBranch, scriptText };
}

/**
 * Decide and, if ready, perform seeding for ONE capability on ONE node.
 *
 * ORDER MATTERS and is cheapest-check-first: a guest or an unearned/ineligible
 * node costs ZERO ssh/gh calls (see the header). Only once a node is eligible
 * does this ask the node anything, and only once the node answers IDLE with
 * room does it ask GitHub for anything.
 *
 * @returns {Promise<{id:string, status:string, reason?:string, freeMb?:number, proof?:string, pin?:string}>}
 */
async function seedNodeFor(name, node, manifest, id, spec, deps) {
	if (!nodeEarnsSeed(node, id)) return { id, status: 'not-earned' };

	const eligible = mayRunRepo(spec.repo, manifest).includes(name);
	if (!eligible) {
		return {
			id,
			status: 'repo-ineligible',
			reason:
				`${name} may not run ${spec.repo}'s work (manifest exclusion) — seeding it would ` +
				`spend disk and a build on an artifact this node's jobs will never use`,
		};
	}

	const busy = await deps.ssh(name, BUSY_CHECK_SCRIPT, { timeoutMs: 30_000 });
	if (!busy.ok) {
		return {
			id,
			status: 'unreadable',
			reason: `could not check for a live Runner.Worker: ${describeSshFailure(busy)}`,
		};
	}
	if (busy.stdout.includes('BUSY')) return { id, status: 'busy' };

	const disk = await deps.ssh(name, diskCheckScript(spec.cache), { timeoutMs: 30_000 });
	if (!disk.ok) {
		return {
			id,
			status: 'unreadable',
			reason: `could not read free space on ${spec.cache}: ${describeSshFailure(disk)}`,
		};
	}
	const availKb = Number(disk.stdout.trim());
	if (!Number.isFinite(availKb)) {
		return {
			id,
			status: 'unreadable',
			reason: `df did not return a number for ${spec.cache}: "${disk.stdout.trim()}"`,
		};
	}
	const freeMb = Math.floor(availKb / 1024);
	if (freeMb < SEED_DISK_FLOOR_MB) {
		return {
			id,
			status: 'refused',
			freeMb,
			reason: `${freeMb} MiB free on the filesystem holding ${spec.cache}, below the ${SEED_DISK_FLOOR_MB} MiB floor`,
		};
	}

	const resolved = await resolveSeed(spec, deps.gh);
	if (!resolved.ok) return { id, status: 'failed', freeMb, reason: resolved.reason };

	const runScript = buildRunScript(spec, resolved);
	const ran = await deps.ssh(name, runScript, { timeoutMs: 600_000 });
	const proof = parseSeedProof(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`);
	if (!ran.ok || !proof.kind) {
		return {
			id,
			status: 'failed',
			freeMb,
			reason: !ran.ok ? `seed script failed: ${describeSshFailure(ran)}` : proof.reason,
		};
	}
	return { id, status: 'seeded', freeMb, proof: proof.kind, pin: resolved.pin };
}

/**
 * Seed every applicable capability on one node. A GUEST is refused outright,
 * for every entry, with no I/O at all — see the header's "HOKON IS A GUEST".
 *
 * @param {string} name
 * @param {object} node a manifest machine entry
 * @param {object} manifest the parsed fleet manifest (for `$seeds` and placement rules)
 * @param {{ssh: Function, gh: Function}} deps
 */
export async function seedNode(name, node, manifest, deps) {
	const entries = seedEntries(manifest);
	if (isGuestNode(node)) {
		return entries.map(([id]) => ({
			id,
			status: 'guest',
			reason:
				'a guest lends the fleet a registration and nothing else (operator, 2026-09-14) — never seeded',
		}));
	}
	const results = [];
	for (const [id, spec] of entries) {
		results.push(await seedNodeFor(name, node, manifest, id, spec, deps));
	}
	return results;
}

/** One `gh api` call, never throwing: `{ok, stdout, stderr, error}`. The controller's own `gh` auth. */
function ghOnce(args, { timeoutMs = 30_000 } = {}) {
	return new Promise((resolve) => {
		execFile(
			'gh',
			args,
			{ encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({
					ok: !err,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					error: err
						? describeReadFailure({ status: err.code, stderr, message: err.message }, timeoutMs)
						: null,
				});
			}
		);
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a one-shot `gh(args)` in {@link READ_ATTEMPTS} retries — the same
 * tolerance for the measured 0.13% transient `gh api` failure rate every other
 * controller-side `gh` reader in this repo applies (CLAUDE.md). Retrying is
 * NOT tolerating: a call that fails every attempt still returns `ok: false`.
 */
export function ghWithRetry(ghOneShot, { attempts = READ_ATTEMPTS, delayMs = 1000 } = {}) {
	return async (args) => {
		let last;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			last = await ghOneShot(args);
			if (last.ok) return last;
			if (attempt < attempts) await sleep(delayMs);
		}
		return { ...last, error: `${last.error} (attempt ${attempts}/${attempts})` };
	};
}

/**
 * The reason behind a failed ssh result. STDERR WINS over the transport's own
 * `.error` when both are present — `.error` on a `runOn` result is often just
 * "Command failed" or an errno, and the script's own diagnostic (why `mvn`
 * failed, why `df` could not read a path) is what an operator needs, the same
 * preference `bootcamp.mjs`'s `reasonOf` already gives its own remote calls.
 */
function describeSshFailure(r) {
	const stderr = String(r?.stderr ?? '').trim();
	if (stderr) return stderr.split('\n').slice(-3).join(' | ').slice(-300);
	return r?.error || 'unknown failure';
}

/** The real {ssh, gh} pair: ssh over `fleet-exec.mjs`'s `runOn`, gh retried per {@link READ_ATTEMPTS}. */
export function defaultSeedDeps() {
	return { ssh: runOn, gh: ghWithRetry(ghOnce) };
}
