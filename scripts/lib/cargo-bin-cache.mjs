/**
 * Does any workflow run a Rust cache step that DELETES the node's own cargo
 * binaries?
 *
 * `Swatinem/rust-cache` saves `$CARGO_HOME/bin` by default, and to keep only
 * what the job built its post step first removes every regular file that was
 * already there (`cleanBin`, guarded by `cache-bin`). On a hosted runner that
 * directory is thrown away with the image. On a fleet node it is the node's
 * toolchain: rustup itself, and whatever `cargo install` put beside it.
 *
 *   2026-09-14  claw-3 lost rustup (brave-quartet `check`, run 34543150470).
 *   2026-11-18  hokon lost fnm, cargo-ndk, wasm-bindgen, wasm-opt,
 *               wasm-server-runner and rustup (vibecheck run 44427533624; its
 *               log reads `... Cleaning cargo/bin ...`).
 *
 * The September fix was `cache-bin: false` plus a comment in each workflow
 * that named the action. vibecheck never named it: its composite action calls
 * `actions-rust-lang/setup-rust-toolchain`, which turns the cache on by
 * itself. So this reads what a workflow CALLS, not what it mentions, and
 * follows every action and reusable workflow the fleet owner publishes.
 *
 * WHAT IT CANNOT SEE: a third-party action that wraps the cache and is not in
 * `HAZARDS`. Those are counted (`examined.thirdParty`), never read: one
 * contents call per action per night is spend this finding does not justify.
 * A new wrapper is one row in `HAZARDS`.
 *
 * Pure. The caller supplies the workflow bodies and the reader for action
 * files, so the rule is testable without a token.
 */
import { stripYamlComments } from './yaml-comments.mjs';

/**
 * Actions whose post step cleans `$CARGO_HOME/bin`, and the `with:` settings
 * that stop it. ANY one of `safe` is enough, and only a literal `false`
 * counts: an expression cannot be shown to be false from here.
 */
export const HAZARDS = [
	{ action: 'swatinem/rust-cache', safe: ['cache-bin'] },
	// Calls Swatinem/rust-cache when `cache` is on (the default) and passes
	// `cache-bin` through.
	{ action: 'actions-rust-lang/setup-rust-toolchain', safe: ['cache', 'cache-bin'] },
];

/** Deepest chain of owned actions followed before the finding says it stopped. */
export const MAX_DEPTH = 4;

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
const indentOf = (line) => line.length - line.trimStart().length;

/** `key: value` pairs of a `with:` block, block or flow style. */
function withOf(lines, at, keyCol) {
	const out = {};
	const inline = /^with:\s*\{(.*)\}\s*$/.exec(lines[at].slice(keyCol));
	const pairs = inline
		? inline[1].split(',')
		: (() => {
				const kids = [];
				for (let j = at + 1; j < lines.length; j++) {
					if (!lines[j].trim()) continue;
					if (indentOf(lines[j]) <= keyCol) break;
					kids.push(lines[j]);
				}
				const col = Math.min(...kids.map(indentOf));
				return kids.filter((l) => indentOf(l) === col);
			})();
	for (const p of pairs) {
		const m = /^\s*([\w.-]+)\s*:\s*(.*)$/.exec(p);
		if (m) out[m[1]] = unquote(m[2]);
	}
	return out;
}

/**
 * Every `uses:` in `body`, with the `with:` beside it: `{ uses, line, with }`.
 *
 * Line-based, like every workflow reader here: there is no YAML parser in a
 * package with two dependencies. Comments are stripped first, so a commented
 * `cache-bin: false` proves nothing. A `uses:` written inside a `run:` script
 * is read as a step; that errs toward a finding, never toward a pass.
 */
export function stepsOf(body) {
	const lines = stripYamlComments(body).split('\n');
	const steps = [];
	lines.forEach((line, i) => {
		const m = /^(\s*(?:-\s+)?)uses:\s*(\S.*)$/.exec(line);
		if (!m) return;
		const keyCol = m[1].length;
		// The step's other keys sit at `keyCol`: on its `- ` line, or between
		// the lines above and below that are indented at least that far.
		let withAt = -1;
		const isWith = (j) => {
			const l = lines[j];
			const lead = /^(\s*(?:-\s+)?)/.exec(l)[1].length;
			return lead === keyCol && /^with:/.test(l.slice(keyCol));
		};
		// A `- uses:` line opens its step, so nothing above it belongs to it.
		const opens = m[1].includes('-');
		for (let j = i - 1; !opens && j >= 0 && withAt < 0; j--) {
			if (!lines[j].trim()) continue;
			if (isWith(j)) withAt = j;
			if (indentOf(lines[j]) < keyCol) break;
		}
		for (let j = i + 1; j < lines.length && withAt < 0; j++) {
			if (!lines[j].trim()) continue;
			if (indentOf(lines[j]) < keyCol) break;
			if (isWith(j)) withAt = j;
		}
		steps.push({
			uses: unquote(m[2]),
			line: i + 1,
			with: withAt < 0 ? {} : withOf(lines, withAt, keyCol),
		});
	});
	return steps;
}

/**
 * What one `uses:` value is, for a workflow in `repo` owned by `owner`.
 *
 *   { kind: 'hazard', hazard }      an action in HAZARDS
 *   { kind: 'owned', ref }          the owner's action or reusable workflow
 *   { kind: 'local-workflow' }      `./.github/workflows/x.yml`, already a body
 *   { kind: 'third-party' }         not read
 */
export function classifyUses(uses, repo, owner) {
	if (uses.startsWith('docker://')) return { kind: 'third-party' };
	if (uses.startsWith('./') || uses === '.') {
		const path = uses.replace(/^\.\/?/, '').replace(/\/+$/, '');
		if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return { kind: 'local-workflow' };
		// `./x` is the calling repo's checkout, in a workflow and in a
		// composite action alike.
		return { kind: 'owned', ref: { repo, ref: 'HEAD', path } };
	}
	const at = uses.lastIndexOf('@');
	const [who, name, ...rest] = (at < 0 ? uses : uses.slice(0, at)).split('/');
	if (at < 0 || !who || !name) return { kind: 'third-party' };
	const hazard = HAZARDS.find((h) => h.action === `${who}/${name}`.toLowerCase());
	if (hazard) return { kind: 'hazard', hazard };
	if (who.toLowerCase() !== owner.toLowerCase()) return { kind: 'third-party' };
	return {
		kind: 'owned',
		ref: { repo: `${who}/${name}`, ref: uses.slice(at + 1), path: rest.join('/') },
	};
}

export const refKey = (r) => `${r.repo}@${r.ref}:${r.path}`;

/** Why a hazard step still deletes, or `null` when a `safe` key is a literal false. */
function hazardReason(step, hazard) {
	if (hazard.safe.some((k) => (step.with[k] ?? '').toLowerCase() === 'false')) return null;
	const set = hazard.safe.filter((k) => step.with[k] !== undefined);
	const how = hazard.safe.map((k) => `\`${k}: false\``).join(' or ');
	return set.length
		? `${set.map((k) => `${k}: ${step.with[k]}`).join(', ')} is not a literal false; needs ${how}`
		: `no ${how}`;
}

/**
 * `./<path>/x` when an `actions/checkout` in the same file put ANOTHER repo at
 * `<path>`: the action lives there, not in the calling repo. Only a literal
 * `repository:` resolves; a ref that is an expression reads the default branch.
 */
function checkedOutElsewhere(c, steps) {
	if (c.kind !== 'owned' || c.ref.ref !== 'HEAD') return c;
	for (const s of steps) {
		const dir = s.with.path;
		const from = s.with.repository;
		if (!/^actions\/checkout@/i.test(s.uses) || !dir || !from || from.includes('${{')) continue;
		if (!c.ref.path.startsWith(`${dir}/`)) continue;
		const ref = s.with.ref && !s.with.ref.includes('${{') ? s.with.ref : 'HEAD';
		return { kind: 'owned', ref: { repo: from, ref, path: c.ref.path.slice(dir.length + 1) } };
	}
	return c;
}

/** One body's hazards and the owned things it calls. */
function scan(text, repo, owner) {
	const hazards = [];
	const calls = [];
	let thirdParty = 0;
	const steps = stepsOf(text);
	for (const step of steps) {
		const local = step.uses.startsWith('./');
		const c0 = classifyUses(step.uses, repo, owner);
		const c = local ? checkedOutElsewhere(c0, steps) : c0;
		if (c.kind === 'hazard') {
			const reason = hazardReason(step, c.hazard);
			if (reason) hazards.push({ uses: step.uses, line: step.line, reason });
		} else if (c.kind === 'owned') calls.push({ uses: step.uses, line: step.line, ref: c.ref });
		else if (c.kind === 'third-party') thirdParty++;
	}
	return { hazards, calls, thirdParty };
}

/**
 * The finding for every workflow in `repos` whose steps, or the owned actions
 * they call, would clean `$CARGO_HOME/bin`.
 *
 * `bodies` is `readWorkflowBodies`' map. `readActions(refs)` returns
 * `Map<refKey, { ok: true, text } | { ok: false, reason }>` for owned action
 * and reusable-workflow files (`readActionFiles`, ./workflow-bodies.mjs).
 *
 * An unreadable workflow or action is a finding with its reason, and a scan
 * that read no file at all is `error`, never a clean result.
 *
 * @returns {{ ok: boolean, findings: {repo: string, file: string, line: number,
 *   via: string[], status: 'deletes-bin'|'unreadable'|'too-deep', reason: string}[],
 *   examined: {repos: number, files: number, ownedActions: number, thirdParty: number},
 *   error?: string }}
 */
export function cargoBinCheck(repos, { bodies, owner, readActions }) {
	const findings = [];
	const entries = [];
	let thirdParty = 0;
	for (const repo of repos) {
		const read = bodies.get(repo);
		if (!read?.ok) {
			findings.push({
				repo,
				file: '.github/workflows',
				line: 0,
				via: [],
				status: 'unreadable',
				reason: `could not list .github/workflows: ${read?.reason ?? 'not in the workflow read'}`,
			});
			continue;
		}
		for (const { name, text, reason } of read.files) {
			const file = `.github/workflows/${name}`;
			if (text === null) {
				findings.push({
					repo,
					file,
					line: 0,
					via: [],
					status: 'unreadable',
					reason: `could not read: ${reason}`,
				});
				continue;
			}
			const s = scan(text, repo, owner);
			thirdParty += s.thirdParty;
			entries.push({ repo, file, ...s });
		}
	}
	const examined = { repos: repos.length, files: entries.length, ownedActions: 0, thirdParty };
	if (!entries.length) {
		return {
			ok: false,
			findings,
			examined,
			error: `cargoBin: read no workflow file in ${repos.length} repo(s)`,
		};
	}

	// Owned actions, read one level per round and scanned once each.
	const actions = new Map();
	let frontier = entries.flatMap((e) => e.calls.map((c) => c.ref));
	for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
		const want = new Map();
		for (const ref of frontier) if (!actions.has(refKey(ref))) want.set(refKey(ref), ref);
		if (!want.size) break;
		const got = readActions([...want.values()]);
		frontier = [];
		for (const [key, ref] of want) {
			const r = got.get(key);
			if (!r?.ok) {
				actions.set(key, { reason: r?.reason ?? 'the reader returned nothing' });
				continue;
			}
			const s = scan(r.text, ref.repo, owner);
			thirdParty += s.thirdParty;
			actions.set(key, s);
			frontier.push(...s.calls.map((c) => c.ref));
		}
	}
	examined.ownedActions = [...actions.values()].filter((a) => !a.reason).length;
	examined.thirdParty = thirdParty;

	for (const e of entries) {
		const at = (line, via, status, reason) =>
			findings.push({ repo: e.repo, file: e.file, line, via, status, reason });
		for (const h of e.hazards) at(h.line, [h.uses], 'deletes-bin', h.reason);
		const walk = (calls, line, via, seen) => {
			for (const c of calls) {
				const key = refKey(c.ref);
				if (seen.has(key)) continue;
				const chain = [...via, c.uses];
				const a = actions.get(key);
				if (!a) {
					at(line ?? c.line, chain, 'too-deep', `not followed past ${MAX_DEPTH} nested actions`);
				} else if (a.reason) {
					at(line ?? c.line, chain, 'unreadable', `could not read ${key}: ${a.reason}`);
				} else {
					for (const h of a.hazards) {
						at(line ?? c.line, [...chain, h.uses], 'deletes-bin', h.reason);
					}
					walk(a.calls, line ?? c.line, chain, new Set([...seen, key]));
				}
			}
		};
		walk(e.calls, null, [], new Set());
	}
	return { ok: findings.length === 0, findings, examined };
}
