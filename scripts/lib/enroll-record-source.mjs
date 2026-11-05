/**
 * `fleet enroll`'s record acquisition — split out of scripts/enroll-node.mjs
 * (wave 5p lane D) so the CLI stays under the 800-line ceiling. Takes the
 * CLI's flags and helpers (`log`/`warn`/`die`) through `ctx`; never imports
 * the CLI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { sshCapture, writeSshConfig } from './enroll-ssh.mjs';
import { readStdinWhole } from './stdin.mjs';

/**
 * Obtain the enrollment record: `--stdin`, `--file <capture>`, or — the
 * normal path — the node's own newest bootstrap log, read over ssh.
 */
export function obtainRecordText(ctx) {
	const { STDIN, FILE, NODE, ADDRESS, log, die } = ctx;
	if (STDIN) {
		const recordText = readStdinWhole();
		log(`[enroll] record from stdin${NODE ? '' : ' (no re-probe possible)'}`);
		return recordText;
	}
	if (FILE) {
		if (!existsSync(FILE)) die(`no such capture: ${FILE}`);
		const recordText = readFileSync(FILE, 'utf8');
		log(`[enroll] record from ${FILE}${NODE ? '' : ' (no re-probe possible)'}`);
		return recordText;
	}
	// The record lives in the bootstrap log because node-bootstrap.sh tees its
	// whole run there. Newest wins: a re-bootstrapped box has several.
	let recordText;
	try {
		// ALWAYS EXIT 0 REMOTELY, and decide from the OUTPUT. `cat ""` fails when
		// the glob matches nothing, and execFileSync cannot tell that apart from
		// a refused connection — so the first cut of this reported a perfectly
		// reachable claw-1 as "cannot reach over ssh". That is a message naming a
		// symptom four layers from the cause, which is the specific failure this
		// repo keeps re-learning. Reachability and emptiness are now two answers.
		// NODE, not `name` — `name` is derived from the RECORD, which this ssh call
		// is about to fetch, so it is still in its temporal dead zone here. Using it
		// threw "Cannot access 'name' before initialization" and enrolment reported
		// it as "cannot reach claw-8 over ssh", which is the wrong diagnosis for a
		// bug on the control host.
		if (ADDRESS) {
			const seeded = writeSshConfig(NODE, ADDRESS);
			if (seeded.state === 'written')
				log(`  ssh config: seeded ${NODE} -> ${seeded.hostName} so this run can reach it`);
			else if (seeded.state === 'already')
				log(`  ssh config: ${NODE} already resolves — --address ignored`);
		}
		recordText = sshCapture(
			NODE,
			'f="$(ls -t /var/log/node-bootstrap-*.log 2>/dev/null | head -1)"; ' +
				'[ -n "$f" ] && cat "$f" 2>/dev/null; exit 0'
		);
	} catch (err) {
		die(
			`cannot reach ${NODE} over ssh: ${err.message.split('\n')[0]}\n` +
				`  This is not "the node has nothing to report" — it is the control host ` +
				`failing the half of enrollment only it can do.`
		);
	}
	if (!recordText.trim()) {
		die(
			`${NODE} is reachable but has no /var/log/node-bootstrap-*.log.\n` +
				`  Run node-bootstrap.sh on it first — enroll declares a CONVERTED box, ` +
				`it does not convert one.`
		);
	}
	log(`[enroll] record read from ${NODE}:/var/log/node-bootstrap-*.log`);
	return recordText;
}

/** The control host's own measurement — `null` without a `NODE` to re-probe. */
export function probeNode(ctx) {
	const { NODE, die } = ctx;
	if (!NODE) return null;
	try {
		const raw = sshCapture(
			NODE,
			[
				'echo "cores=$(nproc 2>/dev/null)"',
				// Distinct (core, socket) pairs: SMT siblings share one. The CPU term
				// of `derivedCapacity` counts these, never nproc's threads.
				'echo "physicalCores=$(lscpu -p=Core,Socket 2>/dev/null | grep -v \'^#\' | sort -u | wc -l)"',
				'echo "memTotalKb=$(awk \'/^MemTotal/{print $2}\' /proc/meminfo 2>/dev/null)"',
				'echo "diskFreeGb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc 0-9)"',
				'echo "hostname=$(hostname 2>/dev/null)"',
				'echo "kernel=$(uname -r 2>/dev/null)"',
			].join('; ')
		);
		return Object.fromEntries(
			raw
				.split('\n')
				.filter((l) => l.includes('='))
				.map((l) => {
					const i = l.indexOf('=');
					return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
				})
		);
	} catch (err) {
		die(`re-probe of ${NODE} failed: ${err.message.split('\n')[0]}`);
		return null;
	}
}
