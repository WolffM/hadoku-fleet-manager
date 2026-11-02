/**
 * The label floor's PER-LABEL alerting: no-demand, mint-unknown, truncated,
 * and the escalating per-label "nothing has served this label" page — split
 * out of `runner-health-label-floor.ts` (wave shrink-1 lane C). Owns the
 * cross-tick streak (`labelZeroTicks`) this alerting debounces on.
 */
import { logger } from './host.js';
import { BUILDER_LABEL } from './runners/census.js';
import { SELF_REPO } from './lib/github-client.js';
import {
	confirmFloorZero,
	floorConfirmDelaySec,
	type FloorConfirmation,
} from './runner-health-label-floor-confirm.js';
import { alertOnce, clearAlert } from './lib/alert-ledger.js';
import { TICK_INTERVAL_MS, OFFLINE_TICKS_BEFORE_ALERT } from './lib/runner-health-shared.js';
import { selfHostname } from './lib/runner-health-shared.js';
import type { LabelFloorVerdict, MintView } from './label-floor.js';

export interface MintProbe {
	view: MintView;
	drainProblem: string | null;
}

/**
 * Watched label → consecutive ticks it was judged UNSERVED (no standing online
 * runner, no eligible minting offerer).
 *
 * The label floor used to page on the FIRST tick at zero, which made it fire on
 * every transient disconnect. On 2026-08-20 all four hokon runners dropped
 * their broker long-poll for ~10s (`SocketException (125): Operation canceled`,
 * then `Back off 9.591 seconds`), and `pm2-host` paged "will queue forever"
 * while nothing was wrong — no process had restarted, and the PM2 deploy 36
 * minutes earlier had run fine. That runner log holds 115 such backoffs in two
 * days, so this was not a one-off.
 *
 * `alertOnce` could not absorb it: that is a re-alert RATE LIMIT, and
 * `clearAlert` deliberately re-arms so the next occurrence fires immediately —
 * correct for a condition that stays broken, wrong for one that flaps.
 *
 * So the floor now debounces on OFFLINE_TICKS_BEFORE_ALERT, exactly as the
 * per-node check already does, and for the reason that constant already
 * documents: a blip clears well inside it, a real outage does not. Only the
 * ALERT waits — `labelOnline` and the sitrep still report zero the moment it
 * is true, because that is a fact about now and this is a judgement about
 * whether it is worth waking someone.
 */
const labelZeroTicks = new Map<string, number>();

/**
 * The label floor's alerting half: the demand-shape alerts (no demand at all,
 * the minting arm unreadable, a truncated listing) and the escalating
 * per-label "nothing has served this label" page, confirmed by a second look
 * before it fires.
 *
 * Takes the WATCH SET and the VERDICTS already judged for this tick
 * (`runner-health-label-floor.ts` computes both, since they also feed
 * `data.label_floor`) — this function's only job is deciding what to say
 * about them.
 */
export async function runLabelFloorAlerts(
	token: string,
	watch: { labels: string[]; staticProblem: string | null },
	verdicts: Record<string, LabelFloorVerdict>,
	mint: MintProbe | null,
	truncated: boolean,
	/** `runners.length`/`runnersResp.total_count` from this tick's listing — for the truncated alert's message. */
	truncatedCensus: { seen: number; total: number | undefined }
): Promise<void> {
	// A DEMAND WITH NOTHING IN IT IS NOT A FLEET WITH NOTHING TO SERVE. The
	// fleet runs hundreds of jobs a day; an empty watched set means job history
	// stopped recording AND the persisted static demand is gone, and a floor
	// that watches nothing passes everything. Paged on its own key.
	if (!watch.labels.some((l) => l !== BUILDER_LABEL)) {
		await alertOnce(
			'label-floor:no-demand',
			`🚨 **runners** on \`${selfHostname()}\`: the label floor has NOTHING to watch — no ` +
				'job in the retention window requested a routing label, and the static demand ' +
				`could not be read (${watch.staticProblem ?? 'it was empty'}). A floor over an ` +
				'empty set passes every outage. Check that job history is recording and run ' +
				'`fleet label-floor`.'
		);
	} else {
		clearAlert('label-floor:no-demand');
	}

	// The minting arm could not be asked at all. Loud on its own key, like a
	// truncated listing, and every label that needed it is HELD below.
	const needsMint = watch.labels.filter(
		(l) => l !== BUILDER_LABEL && verdicts[l].state === 'unmeasured'
	);
	if (!mint && needsMint.length) {
		await alertOnce(
			'label-floor:mint-unknown',
			`🚨 **runners** on \`${selfHostname()}\`: the fleet manifest is unreadable, so the label ` +
				`floor cannot ask which minting nodes offer ${needsMint.map((l) => `\`${l}\``).join(', ')} ` +
				'— no standing runner carries them online. Not judged this tick; fix the manifest.'
		);
	} else {
		clearAlert('label-floor:mint-unknown');
	}

	// A zero is not paged on one look. `confirmFloorZero` is called at most
	// once per tick, and only when a label this check can page for is judged
	// UNSERVED in the first read — so the happy path costs nothing, and a label
	// the claws are minting fine never costs a second listing.
	const pageable = watch.labels.filter((l) => l !== BUILDER_LABEL);
	const suspected = pageable.filter((l) => verdicts[l].state === 'unserved');
	const confirmation =
		suspected.length && !truncated
			? await confirmFloorZero(token)
			: (null as FloorConfirmation | null);
	if (truncated) {
		// LOUD, and about the right thing. A truncated listing is not a
		// capability outage and must not be rendered as one — but it is also not
		// a clean bill of health, so it pages on its own key and the per-label
		// streaks below are HELD rather than advanced or cleared.
		await alertOnce(
			'label-floor:truncated',
			`🚨 **runners** on \`${selfHostname()}\`: the runner listing for \`${SELF_REPO}\` came back ` +
				`PARTIAL — ${truncatedCensus.seen} of ${truncatedCensus.total} registrations. The label floor ` +
				'cannot be judged from part of a census, so it is not being judged this tick. ' +
				"`per_page` is already at GitHub's maximum of 100; this needs a page-until-empty loop."
		);
	} else {
		clearAlert('label-floor:truncated');
	}

	// A label that LEFT the watched set (its demand aged out) takes its streak
	// and its alert with it — otherwise an alert for a label nothing asks for
	// any more stays armed, and the next unrelated blip re-pages it.
	for (const label of [...labelZeroTicks.keys()]) {
		if (watch.labels.includes(label)) continue;
		labelZeroTicks.delete(label);
		clearAlert(`label-floor:${label}`);
	}

	for (const label of watch.labels) {
		const verdict = verdicts[label];
		const key = `label-floor:${label}`;
		// RETIRED 2026-09-08 (decision C0b, see `claw-floor-design-2026-09-07.md`
		// §10). `hadoku-builder` is the fleet's one ELIGIBILITY label: the fast
		// loop writes it, every claw mints it, and "can CI run right now" is
		// owned by `check-queue-health`, measured by queue age. An all-claws-down
		// outage — the only state in which nothing could serve it — already pages
		// through the backstop's 🔻, which promotes hokon onto it in this same
		// tick. Still MEASURED and JUDGED (the snapshot and the per-node
		// suppression below read the verdict), just never alerted on here.
		if (label === BUILDER_LABEL) {
			labelZeroTicks.delete(label);
			clearAlert(key);
			continue;
		}
		if (verdict.state === 'standing' || verdict.state === 'minting') {
			labelZeroTicks.delete(label);
			clearAlert(key);
			continue;
		}
		if (verdict.state === 'unmeasured') {
			// THE FAST LOOP HAS NOT PROBED YET — ~60s after every mgmt-api restart,
			// and runner-health's first tick lands inside it. Nothing stands, and
			// the minting nodes that offer this have not been looked at. HOLD:
			// clearing would be "I could not look" rendering as "nothing is wrong";
			// advancing would page a healthy fleet on every deploy (census.ts,
			// 2026-09-02).
			logger.warn(
				`[runner-health] label floor \`${label}\`: no standing runner online, and the minting ` +
					`node(s) offering it (${verdict.nodes.join(', ') || 'unknown — manifest unreadable'}) ` +
					'have not been probed yet — holding the streak, not paging.'
			);
			continue;
		}
		// UNSERVED on the first read. A partial census produced the standing
		// zero — it is not evidence.
		if (truncated) continue;
		// Could not look a second time: a suppressed budget, an unreadable
		// listing, or one that came back truncated. HOLD the streak. Clearing
		// it would be "I could not look" rendering as "nothing is wrong";
		// advancing it would page on a single look, which is the thing this
		// confirmation exists to stop.
		if (!confirmation) {
			logger.warn(
				`[runner-health] label floor \`${label}\` read UNSERVED but the confirming listing was ` +
					'unreadable — holding the streak, not paging. Check the token and the rate-limit ' +
					'budget: an unconfirmed zero is neither a breach nor a pass.'
			);
			continue;
		}
		const second = confirmation.labels[label] ?? 0;
		// The two reads DISAGREED. That is the 2026-09-12 shape (#24): GitHub's
		// `status` said offline on one read and online seconds later, while it
		// was scheduling jobs onto the very runner in question. Held, not
		// cleared — a sustained outage that flaps keeps its streak instead of
		// being reset by the flapping, so it still pages on the next tick both
		// reads agree on.
		if (second > 0) {
			logger.warn(
				`[runner-health] label floor \`${label}\`: first read said 0 online, the confirming ` +
					`read ${floorConfirmDelaySec()}s later said ${second} ` +
					`(online: ${confirmation.names}). Two answers is not evidence — holding.`
			);
			continue;
		}
		const seen = (labelZeroTicks.get(label) ?? 0) + 1;
		labelZeroTicks.set(label, seen);
		if (seen >= OFFLINE_TICKS_BEFORE_ALERT) {
			const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
			await alertOnce(
				key,
				`🚨 **runners** on \`${selfHostname()}\`: nothing has served label \`${label}\` for ` +
					`${mins} min — ${verdict.why}${mint?.drainProblem ? ` (${mint.drainProblem})` : ''}. ` +
					`Jobs using \`runs-on: [self-hosted, ${label}]\` will queue. Two reads ` +
					`${floorConfirmDelaySec()}s apart agreed: \`${SELF_REPO}\` lists ` +
					`${confirmation.registrations} registration(s), none of them carrying it online. ` +
					`Online runners: ${confirmation.names}`
			);
		}
	}
}

/** Test seam: cross-tick memory this module owns. */
export function __resetLabelFloorAlertsForTesting(): void {
	labelZeroTicks.clear();
}
