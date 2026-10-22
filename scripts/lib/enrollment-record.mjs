/**
 * The enrollment record — what a node says about itself, exactly once.
 *
 * WHY THIS IS THE LAST THING node-bootstrap.sh DOES
 * -------------------------------------------------
 * garage-server-bazooka.sh ended in a 30-line ASCII banner. It was genuinely
 * useful to a human standing at the console and it was worth nothing to anything
 * else, so every field in it — cores, RAM, disk, whether ssh actually worked —
 * got RETYPED into the fleet manifest by hand, later, from memory. That is how
 * `ramGb: 11` came to sit beside a node that measures 11885MiB: the number in
 * the manifest is what somebody rounded, and the slice ceiling had to be derived
 * from the kernel instead because the declared value could not be trusted.
 *
 * So the last act is a RECORD, not a banner. Same facts, in the shape the
 * manifest entry needs, MEASURED rather than typed.
 *
 * WHY A LINE PROTOCOL AND NOT JSON
 * --------------------------------
 * The record is emitted on the tail of several hundred lines of apt output,
 * systemd noise and ANSI colour, and it is read three ways: by a human at a
 * console, by `fleet enroll` over ssh, and — the case that decides it — by
 * somebody pasting a scrollback buffer out of a serial console. `CAP <name>
 * <ok|no> <detail>` already survives all three (capability-probe.sh has emitted
 * it since 2026-08-29), and a JSON object spanning 40 lines of a noisy log does
 * not: one wrapped line and the whole document is unparseable, where one lost
 * line here is one missing field the parser names.
 *
 * THE ENVELOPE IS LOAD-BEARING. A record without its END line is TRUNCATED, and
 * a truncated record is refused. "I could not look" must never render as
 * "nothing is wrong": a bootstrap that died halfway through must not hand
 * `fleet enroll` a half-measured box that reads as a complete one.
 *
 * ENROLL IS THE ONLY INVERSION IN THE SYSTEM (docs/VOCABULARY.md). Everywhere
 * else a node is described by the manifest and observed by a probe; here there
 * is no manifest entry yet, so the box describes itself. Keeping that to ONE
 * command, ONE direction and ONE moment is what stops it becoming a heartbeat
 * protocol.
 *
 * @guards scripts/node-bootstrap.sh
 */

/** The only version this parser understands. Bumped, never widened silently. */
export const RECORD_VERSION = 'v1';

export const BEGIN = 'ENROLL-BEGIN';
export const END = 'ENROLL-END';

/**
 * Fields a manifest entry needs, and which therefore may not be missing.
 *
 * Every one of them is measured by node-bootstrap.sh. A field it could not
 * measure is emitted as the literal `unknown <reason>` — present, and honest
 * about being unknown. It is NEVER omitted and NEVER defaulted to zero: `null`
 * means nobody looked and `0` means somebody looked and found none, and a fleet
 * with no capacity must not render identically to a fleet nobody measured.
 */
export const REQUIRED_FIELDS = Object.freeze([
	'recordedAt',
	'hostname',
	'profile',
	'role',
	'cores',
	'memTotalKb',
	'diskModel',
	'diskFreeGb',
	'osId',
	'osCodename',
	'kernel',
	'fleetUser',
	'sshPort',
	'sudoNoPasswd',
	'sshKeyAuthLoopback',
	'sshFromControl',
	'authMode',
	'ready',
]);

/** Fields whose value is a count and must parse as one (or as `unknown`). */
export const NUMERIC_FIELDS = Object.freeze([
	'cores',
	'memTotalKb',
	'diskFreeGb',
	'sshPort',
	'memAvailableKb',
]);

/**
 * Fields whose value is `ok` / `no` / `unknown`, with an optional detail.
 *
 * `sshFromControl` is the one that has to stay three-valued or it is a lie. The
 * node cannot make the control host ssh to it — that is the control host's half
 * of enrollment. What it CAN observe is an inbound ssh session it is already
 * running inside, which proves a control host reached it. At a console there is
 * no such evidence and the answer is `unknown`, never `ok`, and never `no`
 * either: nobody looked is not the same as it does not work.
 *
 * `sshKeyAuthLoopback` is the part the node CAN prove on its own, end to end,
 * with a throwaway key. Keeping them as two fields rather than one is the
 * difference between "we tested what we could" and "we tested it".
 */
export const TRISTATE_FIELDS = Object.freeze([
	'sudoNoPasswd',
	'sshKeyAuthLoopback',
	'sshFromControl',
	'ready',
]);

/** `unknown` is a VALUE, not an absence. See REQUIRED_FIELDS. */
export const UNKNOWN = 'unknown';

export class EnrollmentRecordError extends Error {}

function bad(message) {
	throw new EnrollmentRecordError(`enrollment record: ${message}`);
}

/**
 * Pull the record out of whatever it was buried in and parse it.
 *
 * @param {string} text stdout of `node-bootstrap.sh`, apt noise and all
 * @returns {{
 *   version: string,
 *   fields: Record<string, string|number|null>,
 *   details: Record<string, string>,
 *   capabilities: {id: string, ok: boolean|null, detail: string}[],
 *   raw: string
 * }}
 */
export function parseEnrollmentRecord(text) {
	if (typeof text !== 'string') bad('input is not text');

	// Strip ANSI first. A serial console, `script(1)` and every ssh capture the
	// operator is likely to hand this carry colour codes, and a colour code in
	// front of ENROLL-BEGIN would make the envelope invisible — which is the one
	// failure that turns a complete record into a missing one.
	// eslint-disable-next-line no-control-regex
	const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
	const lines = clean.split('\n').map((l) => l.trimEnd());

	const beginAt = lines.findIndex((l) => l.trimStart().startsWith(`${BEGIN} `));
	if (beginAt === -1) {
		bad(
			`no ${BEGIN} line. Either node-bootstrap.sh never reached its final step, or the ` +
				`output was captured from the wrong stream — both are failures, and neither is ` +
				`"this node has nothing to report".`
		);
	}

	const version = lines[beginAt].trim().slice(BEGIN.length).trim();
	if (version !== RECORD_VERSION) {
		bad(
			`record claims version "${version}", this parser understands ${RECORD_VERSION}. ` +
				`Reading it anyway would mean guessing at fields whose meaning changed.`
		);
	}

	const endAt = lines.findIndex((l, i) => i > beginAt && l.trimStart().startsWith(END));
	if (endAt === -1) {
		bad(
			`${BEGIN} with no ${END}. The record is TRUNCATED — node-bootstrap.sh died, the ` +
				`connection dropped, or the buffer was cut. A half-measured node must not read ` +
				`as a fully measured one.`
		);
	}

	const body = lines.slice(beginAt + 1, endAt);
	/** @type {Record<string, string|number|null>} */
	const fields = {};
	/** @type {Record<string, string>} */
	const details = {};
	/** @type {{id: string, ok: boolean|null, detail: string}[]} */
	const capabilities = [];
	const seen = new Set();

	for (const line of body) {
		const s = line.trim();
		if (s === '') continue;

		if (s.startsWith('CAP ')) {
			const [, id, state, ...rest] = s.split(/\s+/);
			if (!id || !state) bad(`malformed CAP line: ${JSON.stringify(s)}`);
			if (!['ok', 'no', UNKNOWN].includes(state)) {
				bad(`CAP ${id} has state "${state}"; expected ok, no or ${UNKNOWN}`);
			}
			// `no` and `unknown` are DIFFERENT ANSWERS. `no` is a probe that ran and
			// said the node cannot; `unknown` is a probe that did not run. Folding
			// the second into the first is how a box nobody looked at becomes a box
			// known to lack a capability, which reads as a decision somebody made.
			const ok = state === 'ok' ? true : state === 'no' ? false : null;
			capabilities.push({ id, ok, detail: rest.join(' ') });
			continue;
		}

		if (!s.startsWith('ENROLL ')) {
			bad(
				`line inside the envelope is neither ENROLL nor CAP: ${JSON.stringify(s)}. ` +
					`Skipping it would let a stray line hide a field that belongs here.`
			);
		}

		const rest = s.slice('ENROLL '.length);
		const sp = rest.indexOf(' ');
		const key = sp === -1 ? rest : rest.slice(0, sp);
		const value = sp === -1 ? '' : rest.slice(sp + 1).trim();
		if (key === '') bad(`ENROLL line with no key: ${JSON.stringify(s)}`);
		// LAST-WINS IS THE WRONG DEFAULT HERE. Two `ENROLL cores` lines means two
		// measurements disagreed, or two records were concatenated; either way the
		// answer is not "take the second one".
		if (seen.has(key)) bad(`duplicate field "${key}" — two records concatenated?`);
		seen.add(key);

		if (NUMERIC_FIELDS.includes(key)) {
			if (value === UNKNOWN || value.startsWith(`${UNKNOWN} `)) {
				fields[key] = null;
				details[key] = value.slice(UNKNOWN.length).trim();
			} else if (/^-?\d+$/.test(value)) {
				fields[key] = Number(value);
			} else {
				bad(
					`${key} is ${JSON.stringify(value)}: neither an integer nor "${UNKNOWN} <reason>". ` +
						`Coercing it would turn an unmeasured box into a box measured at zero.`
				);
			}
			continue;
		}

		if (TRISTATE_FIELDS.includes(key)) {
			const [state, ...tail] = value.split(/\s+/);
			if (state === 'ok') fields[key] = 'ok';
			else if (state === 'no') fields[key] = 'no';
			else if (state === UNKNOWN) fields[key] = null;
			else bad(`${key} is "${state}"; expected ok, no or ${UNKNOWN}`);
			details[key] = tail.join(' ');
			continue;
		}

		if (value === '') bad(`${key} has an empty value. Emit "${UNKNOWN} <reason>" instead.`);
		if (value === UNKNOWN || value.startsWith(`${UNKNOWN} `)) {
			fields[key] = null;
			details[key] = value.slice(UNKNOWN.length).trim();
		} else {
			fields[key] = value;
		}
	}

	const missing = REQUIRED_FIELDS.filter((f) => !seen.has(f));
	if (missing.length) {
		bad(
			`${missing.length} required field(s) missing: ${missing.join(', ')}. ` +
				`A record short of these cannot become a manifest entry, and accepting it ` +
				`would put the guesswork back where this file exists to remove it.`
		);
	}

	// The END line names the node, and it must be the node the record is about.
	// Mismatched names mean two captures were spliced.
	const endName = lines[endAt].trim().slice(END.length).trim();
	if (endName && endName !== fields.hostname) {
		bad(`${END} names "${endName}" but the record is about "${fields.hostname}"`);
	}

	if (capabilities.length === 0) {
		bad(
			`no CAP lines. capability-probe.sh emits one per capability and never exits ` +
				`non-zero, so zero lines means it did not run — which is a probe that was not ` +
				`taken, not a node with no capabilities.`
		);
	}

	return {
		version,
		fields,
		details,
		capabilities,
		raw: lines.slice(beginAt, endAt + 1).join('\n'),
	};
}

/**
 * Render a record. The inverse of {@link parseEnrollmentRecord}, and the shape
 * node-bootstrap.sh emits by hand in shell — this exists so the format has one
 * written definition and a round-trip test, not so the shell script calls it
 * (there is no node on a box that has not been bootstrapped yet).
 *
 * @param {{
 *   fields: Record<string, string|number|null>,
 *   details?: Record<string, string>,
 *   capabilities?: {id: string, ok: boolean|null, detail?: string}[]
 * }} record
 */
export function formatEnrollmentRecord(record) {
	const fields = record.fields ?? {};
	const details = record.details ?? {};
	const caps = record.capabilities ?? [];

	const missing = REQUIRED_FIELDS.filter((f) => !(f in fields));
	if (missing.length)
		bad(`cannot render, ${missing.length} field(s) missing: ${missing.join(', ')}`);

	const out = [`${BEGIN} ${RECORD_VERSION}`];
	for (const [key, value] of Object.entries(fields)) {
		if (/\s/.test(key)) bad(`field name ${JSON.stringify(key)} contains whitespace`);
		let rendered;
		if (value === null) {
			const why = (details[key] ?? '').trim();
			if (!why) {
				bad(
					`${key} is unknown with no reason. "${UNKNOWN}" alone tells the operator ` +
						`nothing about whether to go and look.`
				);
			}
			rendered = `${UNKNOWN} ${why}`;
		} else if (TRISTATE_FIELDS.includes(key)) {
			if (value !== 'ok' && value !== 'no') bad(`${key} must be ok, no or null; got ${value}`);
			const tail = (details[key] ?? '').trim();
			rendered = tail ? `${value} ${tail}` : String(value);
		} else {
			rendered = String(value);
		}
		if (rendered.includes('\n')) bad(`${key} value spans lines; the format is line-oriented`);
		out.push(`ENROLL ${key} ${rendered}`);
	}
	for (const c of caps) {
		const state = c.ok === true ? 'ok' : c.ok === false ? 'no' : UNKNOWN;
		out.push(`CAP ${c.id} ${state} ${(c.detail ?? '').trim()}`.trimEnd());
	}
	out.push(`${END} ${fields.hostname}`);
	return out.join('\n') + '\n';
}

/**
 * The manifest entry a human is being asked to commit, derived from the record.
 *
 * PROPOSED, never written. `fleet enroll` is a separate workstream and it exits
 * non-zero until an operator commits what this returns: measurement is
 * automated, DECLARATION STAYS A HUMAN ACT. Everything here is measured;
 * nothing here is a routing decision. In particular there are no `labels` —
 * `hadoku-builder` is eligibility and the fast loop is its writer, and a
 * node that arrived this morning claiming to be schedulable would be scheduled
 * onto before anything had probed it.
 */
/**
 * The per-runner memory ceiling every capacity number here is derived against.
 *
 * 4096 MiB is `slice.unitMaxMb` across the fleet and the value ci-throttle.sh
 * enforces per runner. Measured job memory over 390 real jobs: p50 927 MB,
 * p95 3337, p99 3423 — so one runner fits inside 4 GB with headroom, and the
 * observed max is CENSORED at exactly 4096 because hadoku_site/analyze hit the
 * ceiling 27,258 times.
 */
export const RUNNER_CEILING_MB = 4096;

/** The most runners any single node may take, whatever its size. */
export const MAX_RUNNERS_PER_NODE = 4;

/**
 * Capacity, DERIVED from measured memory — never assigned by hand.
 *
 * The operator's rule, 2026-09-08: "I don't like manual assignment of the
 * claws. I prefer it to be based on the capabilities. 4 runners at 4gb floor
 * should be the cap."
 *
 * A FLAT 4 GB FLOOR WOULD BREAK HALF THE FLEET, so the cap and the floor are
 * separated. Checked against every node before adopting it: `minFreeMb 4096`
 * everywhere gives claw-2 (7168 MB) and claw-6 (7849 MB) a maxConcurrent of
 * ZERO, and halves claw-1/3/4/5. The 4 GB is what a RUNNER gets; the floor is
 * what the OS keeps, and on an 8 GB box those cannot be the same number.
 *
 * So the floor scales with the box — MemTotal/8, which reproduces the fleet's
 * existing 2048 on 16 GB and 4096 on 32 GB — clamped to [1536, 8192] because
 * below 1536 an 8 GB node has nothing left and above 8192 a large node is
 * reserving more than hokon does.
 *
 * `maxConcurrent` is then simply how many 4 GB runners fit in what is left,
 * capped at 4. That reproduces claw-3/4/5 at 3 and claw-7 at 4 exactly as an
 * operator set them, and trims claw-1 3→2, claw-2 2→1, claw-6 2→1, where the
 * hand-set numbers exceeded what 4 GB per runner actually allows.
 *
 * @param {number|null} memTotalMb measured MemTotal, NOT the rounded ramGb
 */
export function derivedCapacity(memTotalMb) {
	// null is "nobody measured", and it must not become a number. A node whose
	// memory could not be read gets no capacity rather than a guessed one.
	if (!memTotalMb || memTotalMb <= 0) return { minFreeMb: null, maxConcurrent: null };
	const raw = Math.round(memTotalMb / 8 / 512) * 512;
	const minFreeMb = Math.max(1536, Math.min(8192, raw));
	const usable = memTotalMb - minFreeMb;
	const maxConcurrent = Math.max(
		1,
		Math.min(MAX_RUNNERS_PER_NODE, Math.floor(usable / RUNNER_CEILING_MB))
	);
	return { minFreeMb, maxConcurrent };
}

// ── placement, DERIVED under all-JIT ─────────────────────────────────────────
//
// Onboarding claw-9 by hand (2026-09-20/21) took four HAND EDITS after the
// measurement, each one discovered by a later command refusing: `labels: []`,
// `role`, `maxRegistrations`, `slice`, `minFreeGb` (#50, #52). Every one of
// them is a fleet constant or a restatement of a measured fact — none is a
// decision — so after the tier ladder was retired (2026-09-21) there is no
// placement input left that a human owes at declaration time.
//
// `ephemeral` is DELIBERATELY NOT HERE. It is the one flag with an ordering
// dependency: it may only be set once the node has EARNED `jitconfig`, which
// requires the JIT payload to have been seeded first. Flipping it here would
// mint runners the node cannot start — the exact trap claw-8's throttle gate
// caught. `provision` sets it, after bootcamp.

/**
 * The DISK floor every machine must declare, in GB.
 *
 * `register-fleet-runner.sh` refuses to register on a box with under 16 GB free
 * (MIN_FREE_GB_AFTER 15 + INSTALL_GB 1), and the site repo's `claw-cleanup.test.ts`
 * fails the repo on any machine whose `minFreeGb` is not ABOVE that refusal.
 * Until 2026-09-21 `fleet enroll` wrote no `minFreeGb` at all, so every node it
 * declared reddened the site repo's main the next time that test ran (#52) —
 * claw-8 and claw-9 both landed that way and were fixed by hand. 25 GB is what
 * every machine in the live manifest already carries, claw and guest alike.
 */
export const FLEET_MIN_FREE_GB = 25;

/**
 * The standing-registration ceiling for a claw.
 *
 * Under all-JIT this binds only a node's `residentRepos` (usually none), but
 * `reconcile` still reads it as the plan cap. 32 is what 8 of 9 live machines
 * carry; claw-3's 16 is a hand decision predating the JIT conversion.
 */
export const CLAW_MAX_REGISTRATIONS = 32;

/**
 * runners.slice swap ceiling, in MB.
 *
 * Matches the installer's own default (`sliceCfg.swapMb ?? 4096` in
 * deploy-runners-slice.mjs). Capped swap trades a fast OOM for hours of
 * thrashing on a spinning root disk — written explicitly rather than defaulted
 * so the entry says so where the next reader looks.
 */
export const SLICE_SWAP_MB = 4096;

/**
 * The placement shape every new claw is declared with — a fleet constant plus
 * measured capacity, never a decision.
 *
 * `labels: []` IS the all-JIT shape, not an omission: a JIT node mints a runner
 * per job with its labels on the mint call, and standing eligibility is written
 * by the fast loop once the node is safe. A non-empty array here would describe
 * registrations the node does not keep. `reconcile` refuses a node with NO
 * labels array at all, which is the refusal that forced the first claw-9 hand
 * edit — an empty array is the answer that both satisfies it and says the
 * truth. (A GUEST's labels are declared, not derived; nothing in this file
 * enrols a guest.)
 */
export function derivedPlacement() {
	return {
		role: 'claw',
		labels: [],
		maxRegistrations: CLAW_MAX_REGISTRATIONS,
		minFreeGb: FLEET_MIN_FREE_GB,
		slice: { swapMb: SLICE_SWAP_MB, unitMaxMb: RUNNER_CEILING_MB },
	};
}

/**
 * The placement keys an entry is MISSING — and only those.
 *
 * Used by `provision` against an entry declared by an OLDER enroll (or by
 * hand), so a node can be brought to the derived shape without overwriting
 * anything a human chose afterwards: claw-3's `labels: ['jit-canary']` and
 * `maxRegistrations: 16` survive, and an entry that already has every key gets
 * nothing. A present-but-wrong-typed `labels` (the reconcile refusal) is
 * replaced, because `[]` is the only value this can derive.
 *
 * @returns {Record<string, unknown>} the fields to ADD; `{}` when the entry
 *   already carries the full derived shape
 */
export function placementBackfill(entry) {
	const want = derivedPlacement();
	const add = {};
	if (entry?.role === undefined) add.role = want.role;
	if (!Array.isArray(entry?.labels)) add.labels = want.labels;
	if (entry?.maxRegistrations === undefined) add.maxRegistrations = want.maxRegistrations;
	if (entry?.minFreeGb === undefined) add.minFreeGb = want.minFreeGb;
	if (entry?.slice === undefined || typeof entry?.slice !== 'object' || entry?.slice === null)
		add.slice = want.slice;
	return add;
}

export function proposedManifestEntry(parsed) {
	const f = parsed.fields;
	const cores = f.cores;
	const memKb = f.memTotalKb;
	return {
		name: f.hostname,
		cores,
		// MEASURED MemTotal in MiB, kept alongside the rounded GB because the two
		// are not the same number and the slice ceiling needs the first: claw-1
		// measures 11885MiB and its manifest says ramGb 11.
		memTotalMb: memKb === null ? null : Math.floor(memKb / 1024),
		ramGb: memKb === null ? null : Math.floor(memKb / 1024 / 1024),
		diskFreeGb: f.diskFreeGb,
		// DERIVED, so no human types a number that ci-throttle.sh will silently
		// replace with MAX_CONCURRENT=99 if they forget one.
		...derivedCapacity(memKb === null ? null : Math.floor(memKb / 1024)),
		// PLACEMENT, DERIVED (see derivedPlacement above). claw-9's onboarding
		// needed four hand edits for exactly these fields, each discovered by a
		// later command refusing; `ephemeral` is absent on purpose — it waits for
		// bootcamp to earn `jitconfig`.
		...derivedPlacement(),
		capabilities: parsed.capabilities.filter((c) => c.ok === true).map((c) => c.id),
		unproven: parsed.capabilities.filter((c) => c.ok !== true).map((c) => c.id),
	};
}
