/**
 * The toolchain floor's `clamav` entry. toolchain-floor.mjs's REPAIRS table
 * spreads it in; it lives here because that file is at its size ceiling.
 * toolchain-floor.mjs documents every field.
 *
 * WHAT IT CARRIES: the scanner (`clamav`) and the signature updater
 * (`clamav-freshclam`), with freshclam enabled. NOT `clamav-daemon`: the
 * watchparty ingest runs one clamscan per run inside its job, so a standing
 * clamd would be ~1 GB resident that no job accounts for. Neither package
 * pulls the daemon in (Debian 13: `clamav` depends on clamav-freshclam and
 * recommends only clamav-base). `clamdscan` does, so it is not installed.
 *
 * WHERE: only on nodes the ingest can land on today, the ones that offer
 * `nvenc-h264` AND `data-peer` (its `runs-on`), so bootcamp installs it
 * before probing and the node can then earn `clamav`. If the ingest's
 * `runs-on` changes, {@link INGEST_LABELS} changes with it.
 *
 * ONE UPDATER, NOT TWO. Debian's clamav-freshclam ships the updater daemon AND
 * a daily `clamav-freshclam-once.timer` with `Persistent=true`, both enabled.
 * After any boot that missed the timer's slot the two start within seconds,
 * and the second loses the lock on /var/log/clamav/freshclam.log and exits 2.
 * When the daemon is the loser it stays dead (`Restart=no`): no signature
 * updates, and the capability probe reads freshclam inactive. That is what
 * claw-1 did after the reboot cycle's kernel reboot on 2026-11-23. The daemon
 * already polls on its own schedule, so the repair disables the timer and the
 * detect refuses a node where it is still enabled.
 */

import { nodeOffer } from '../../dist/lib/capability-offer.js';

/** The labels watchparty's ingest routes on besides `clamav` itself. */
export const INGEST_LABELS = ['nvenc-h264', 'data-peer'];

/** A `when` predicate: the node offers every one of {@link INGEST_LABELS}. */
const ingestNode = (node) => {
	const offer = nodeOffer(node ?? {}, { eligible: false });
	return INGEST_LABELS.every((l) => offer.includes(l));
};
// bootcamp prints `installed for ${tool.when}`; a bare function would print its source.
ingestNode.toString = () => `offers ${INGEST_LABELS.join(' and ')} (watchparty ingest)`;

export const CLAMAV_REPAIRS = {
	clamav: {
		when: ingestNode,
		apt: 'clamav',
		why:
			'watchparty’s ingest scans each run’s new files with clamscan before encoding, routed ' +
			'by the `clamav` label. freshclam keeps the signatures fresh; no clamd is installed.',
		// Runs the scanner, and reads the updater's unit state. The signature age
		// is the capability probe's measurement, not a reason to reinstall.
		detect:
			'clamscan --version >/dev/null 2>&1 && systemctl is-active -q clamav-freshclam && ' +
			'systemctl is-enabled -q clamav-freshclam && ' +
			'! systemctl is-enabled -q clamav-freshclam-once.timer && echo OK',
		// `install` on an installed package moves it to apt's candidate, so the
		// same text is the install and the refresh cycle's upgrade.
		repair: [
			'set -e',
			'sudo -n apt-get update -qq',
			'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq clamav clamav-freshclam',
			// Only where the package ships it: an absent unit makes `disable` fail.
			'if systemctl cat clamav-freshclam-once.timer >/dev/null 2>&1; then',
			'\tsudo -n systemctl disable --now clamav-freshclam-once.timer',
			'fi',
			'sudo -n systemctl enable --now clamav-freshclam',
		].join('\n'),
	},
};
