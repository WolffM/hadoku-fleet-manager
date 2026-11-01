/**
 * The pure ssh helpers of `enroll-node.mjs` (wave 5o lane D split, pure
 * move): capturing a remote record, probing a candidate ssh name, and
 * writing the operator's `~/.ssh/config` block. None of these close over the
 * CLI's own argv/`JSON_OUT`/`log`/`warn`/`die` state — each takes exactly
 * what it needs as a parameter — so they moved as-is; `die`, `printAddressing`
 * and the rest of `enroll-node.mjs`'s flow stayed, for the same reason
 * `d6dcfa5`/`8fb8009` kept their closure-bound functions in their CLIs.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
// The BUILT copy, for the same reason fleet-exec.mjs imports isLocalNode that
// way: one question, one answer, and no second implementation to drift from.
import { DEFAULT_ADMIN_USER } from '../../dist/lib/node-users.js';
import { chooseSshHostName, sshNameCandidates } from './node-interfaces.mjs';

export function sshCapture(target, remote) {
	return execFileSync(
		'ssh',
		['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remote],
		{ encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 }
	);
}

/**
 * Add a node to ~/.ssh/config, in a block this tool owns.
 *
 * WHY ENROLMENT DOES THIS. Nothing in the fleet can reach a node it cannot
 * name: `fleet provision --machine claw-8` resolves through ssh like everything
 * else, so the entry is a PREREQUISITE for every step after enrolment and was
 * the one hand-edit with no command behind it.
 *
 * WHY IT IS SO CAUTIOUS. ~/.ssh/config is the operator's file, shared with every
 * other tool on this host, and it is the file that — edited wrongly — locks you
 * out of the fleet. So: it never rewrites, only appends; it writes a DELIMITED
 * block naming this node so removal is unambiguous; it backs the file up first;
 * and it does nothing at all if ssh can already resolve the name, because an
 * existing entry is an operator's decision and not drift to correct.
 *
 * THE ENTRY IS SELF-CONTAINED. The fleet's existing block lists node names
 * explicitly (`Host claw1 claw-1 claw2 ...`), and appending a name to that line
 * means REWRITING a line the operator wrote. Carrying User/IdentityFile in the
 * new block instead costs four lines and touches nothing that already works.
 * The values are read from `ssh -G` against an existing claw rather than
 * invented — the same derivation refresh-preseed.sh uses for the fleet key.
 *
 * IT PREFERS A NAME, AND IT PROVES THE NAME FIRST (issue #8). Every `HostName`
 * in this file is a LAN IP, which is a DHCP lease: the 2026-09-07 SSID rename
 * moved claw-3's and the fleet read a live node as permanently unreachable from
 * six scripts at once. `sshTarget` already refuses to hand an IP to `ssh`; this
 * is the only code in the repo that WRITES one, so the rule had no reach until
 * here. The candidates and the decision live in `node-interfaces.mjs`; this
 * function supplies the one thing a pure function cannot, which is whether the
 * name actually opens a session.
 *
 * A NAME THAT MERELY RESOLVES IS NOT GOOD ENOUGH, and that is not caution for
 * its own sake: on this fleet today the tailnet name resolves for all eight
 * claws and then HANGS, because `tailscale up --ssh` (run by this very script,
 * below) puts tailscaled in front of port 22 and the tailnet's ACL answers
 * `check` with a browser login. Writing that name would strand the node.
 */
export function probeSshName(name, user, identity) {
	try {
		execFileSync(
			'ssh',
			[
				'-o',
				'BatchMode=yes',
				'-o',
				'ConnectTimeout=5',
				'-o',
				'StrictHostKeyChecking=accept-new',
				'-o',
				'IdentitiesOnly=yes',
				'-i',
				identity,
				'-l',
				user,
				name,
				'true',
			],
			// A HARD TIMEOUT ON TOP OF ConnectTimeout, because the failure this
			// probe exists to catch is not a refused connection — it is a session
			// that opens, prints a login URL and then sits there. ConnectTimeout
			// covers the TCP handshake only and would never fire on it.
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }
		);
		return { name, reachable: true, reason: 'answered ssh' };
	} catch (err) {
		const why =
			err?.signal === 'SIGTERM'
				? 'the session opened but never returned within 15s — an interception (Tailscale SSH check-mode looks exactly like this), not a refusal'
				: (String(err?.stderr || err?.message || '')
						.split('\n')
						.map((l) => l.trim())
						.find((l) => l && !l.startsWith('Warning: Permanently added')) ??
					'ssh failed with no message');
		return { name, reachable: false, reason: why.slice(0, 160) };
	}
}

export function writeSshConfig(node, address) {
	const cfg = `${process.env.HOME}/.ssh/config`;
	if (!address) return { state: 'no-address' };
	// ALREADY RESOLVABLE IS NOT DRIFT. If the operator has an entry, it wins.
	try {
		const g = execFileSync('ssh', ['-G', node], { encoding: 'utf8' });
		const host = /^hostname (.+)$/m.exec(g)?.[1]?.trim();
		if (host && host !== node) return { state: 'already', hostname: host };
	} catch {
		/* no config at all is fine — fall through and write one */
	}
	let existing = '';
	try {
		existing = readFileSync(cfg, 'utf8');
	} catch {
		/* creating it is fine */
	}
	if (existing.includes(`# >>> fleet enroll: ${node}`)) return { state: 'already' };

	// Derived from a node that already works, never invented.
	let user = DEFAULT_ADMIN_USER;
	let identity = '~/.ssh/id_ed25519_hokon';
	try {
		const g = execFileSync('ssh', ['-G', 'claw-1'], { encoding: 'utf8' });
		user = /^user (.+)$/m.exec(g)?.[1]?.trim() || user;
		identity = /^identityfile (.+)$/m.exec(g)?.[1]?.trim() || identity;
	} catch {
		/* keep the defaults */
	}

	// NAME FIRST, AND ONLY ON PROOF. Each candidate costs at most 15s and only on
	// the one run per box that enrols it.
	const probes = sshNameCandidates(node).map((c) => probeSshName(c.name, user, identity));
	const choice = chooseSshHostName({ node, address, probes });

	const short = node.replace('-', '');
	const settings = [
		`    User ${user}`,
		`    IdentityFile ${identity}`,
		'    IdentitiesOnly yes',
		'    StrictHostKeyChecking accept-new',
	];
	const block = [
		'',
		`# >>> fleet enroll: ${node} >>>`,
		`# Written by \`fleet enroll ${node} --write\`. Remove this whole block to undo.`,
		`# HostName: ${choice.why}`,
		`Host ${short} ${node}`,
		`    HostName ${choice.hostName}`,
		...settings,
		// THE ADDRESS IS KEPT EITHER WAY, and when the primary is a name it is kept
		// as a REACHABLE alias rather than as a comment. A name that stops resolving
		// should cost `ssh claw-N-lan` and not a garage trip, and an address that is
		// only written down in prose is an address nobody can use at 3am.
		...(choice.kind === 'name'
			? [
					`# The lease ${node} answered on at enrolment, kept so a name that stops`,
					'# resolving is a second try rather than a lost node.',
					`Host ${short}-lan ${node}-lan`,
					`    HostName ${address}`,
					...settings,
				]
			: []),
		`# <<< fleet enroll: ${node} <<<`,
		'',
	].join('\n');

	if (existing) copyFileSync(cfg, `${cfg}.bak-fleet-enroll`);
	// F3 (write-then-rename, fsync'd): a rename always lands a freshly created
	// inode, so the 0600 this file's security depends on is set explicitly
	// after, rather than relying on `writeFileSync`'s create-only `mode` (which
	// a pre-existing config left at some other mode anyway).
	writeFileAtomic(cfg, existing + block);
	chmodSync(cfg, 0o600);
	return {
		state: 'written',
		address,
		hostName: choice.hostName,
		kind: choice.kind,
		pinnedToLease: choice.pinnedToLease,
		why: choice.why,
		rejected: choice.rejected,
		backup: existing ? `${cfg}.bak-fleet-enroll` : null,
	};
}
