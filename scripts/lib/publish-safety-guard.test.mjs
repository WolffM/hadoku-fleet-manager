/**
 * NOTHING THAT LOCATES THE OPERATOR'S NETWORK OR HOME MAY SHIP.
 *
 * This repo is public. On 2026-08-30 its history was scrubbed of the home LAN,
 * the tailnet name and the Tailscale addresses, and nothing kept them out: by
 * 2026-10-11 all three were back, plus eight real NIC MACs, across 21 files. A
 * scrub with no gate is a scrub with an expiry date. This is the gate.
 *
 * WHAT IT REFUSES, in every tracked file outside the private trees:
 *
 *   - a PRIVATE IPv4 HOST address — 10/8, 172.16/12, 192.168/16, the
 *     100.64/10 block Tailscale assigns from, and 169.254/16. A CIDR of /16 or
 *     wider is a RANGE, not a place, and stays allowed (`100.64.0.0/10`,
 *     `10.5.0.0/16`). Fixtures use the RFC 5737 documentation ranges instead —
 *     192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — which no network routes,
 *     so a fixture can never be somebody's real address.
 *   - a tailnet name, `tail<hex>.ts.net`. Write `example.ts.net`.
 *   - a MAC address, unless it is a placeholder: `02:00:00:…` (a locally
 *     administered address no vendor ships) or `00:00:5e:00:53:…` (the RFC 7042
 *     documentation block).
 *   - a DENYLISTED literal: the things no pattern can describe — an SSID, a
 *     device serial, a name — and the real MACs with their colons stripped,
 *     because `unknown<mac>` is how a Debian installer names a box.
 *
 * THE DENYLIST IS NOT IN THIS REPO, because a list of what must not be
 * published is itself a publication. It was briefly committed as unsalted
 * sha256 and the 2026-10-19 review pointed out the obvious: a four-letter name
 * and a MAC behind a known vendor prefix both fall to brute force in seconds.
 * It is read from, in order:
 *
 *   1. `$PUBLISH_DENYLIST` — CI, from the repo secret of the same name
 *   2. `.publish-denylist` at this checkout's root, then at the MAIN checkout's
 *      root, so every linked worktree shares one copy. Gitignored.
 *
 * One literal per line, `#` comments. Matching is case-insensitive and
 * whole-word, except an all-hex entry of 8+ characters, which matches anywhere
 * so `unknown<mac>` is caught. NEITHER SOURCE PRESENT FAILS: a guard that
 * cannot read its list has not looked, and must not report clean. A hit is
 * reported by entry NUMBER, never by value, so a public CI log cannot print the
 * list it exists to protect.
 *
 * COMMENTS ARE NOT BLANKED, unlike every other guard here. Those guards ask
 * what the CODE does; this one asks what a stranger can READ, and a comment is
 * readable.
 *
 * `docs/planning/` is not scanned, it is BANNED. The planning docs live in
 * WolffM/hadoku-fleet-manager-private and reach this checkout only as a
 * gitignored symlink (scripts/attach-private.sh). A tracked file under it — or
 * the symlink itself, committed with `git add -f` — publishes the private repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const PRIVATE_TREES = ['docs/planning'];

const DENYLIST_FILE = '.publish-denylist';

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?(?!\w|\.\d)/g;
const TAILNET = /\btail[0-9a-f]{4,}\.ts\.net\b/gi;
const MAC = /(?<![0-9a-f:-])[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![0-9a-f:-])/gi;
const MAC_PLACEHOLDER = /^(?:02[:-]00[:-]00|00[:-]00[:-]5e[:-]00[:-]53)[:-]/i;

function isPrivate(a, b) {
	return (
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254)
	);
}

/** Literals → matchers. An all-hex entry matches embedded; anything else whole-word. */
export function compileDenylist(text) {
	return text
		.split('\n')
		.map((l) => l.replace(/#.*/, '').trim())
		.filter(Boolean)
		.map((lit) => {
			const esc = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			return /^[0-9a-f]{8,}$/i.test(lit)
				? new RegExp(esc, 'gi')
				: new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'gi');
		});
}

/** `{ source, text }` for the first denylist found, or null when none is. */
function readDenylist() {
	if (process.env.PUBLISH_DENYLIST?.trim()) {
		return { source: '$PUBLISH_DENYLIST', text: process.env.PUBLISH_DENYLIST };
	}
	const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
		cwd: ROOT,
		encoding: 'utf8',
	}).trim();
	const mainCheckout = dirname(isAbsolute(common) ? common : resolve(ROOT, common));
	for (const dir of [ROOT, mainCheckout]) {
		const p = join(dir, DENYLIST_FILE);
		if (existsSync(p)) return { source: p, text: readFileSync(p, 'utf8') };
	}
	return null;
}

/**
 * Every leak in `text`, as `{ rule, match, line }`. A regex-escaped address
 * (`192\.0\.2\.7` in an `assert.match`) is unescaped first — that form carried
 * the real LAN in preflight.test.mjs and no pattern for a bare address sees it.
 */
export function findLeaks(raw, denylist = []) {
	const text = raw.replaceAll('\\.', '.');
	const leaks = [];
	const lineOf = (index) => text.slice(0, index).split('\n').length;
	for (const m of text.matchAll(IPV4)) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		const prefix = m[5] === undefined ? undefined : Number(m[5]);
		if (!isPrivate(a, b)) continue;
		if (prefix !== undefined && prefix <= 16) continue;
		leaks.push({ rule: 'private IPv4 host', match: m[0], line: lineOf(m.index) });
	}
	for (const m of text.matchAll(TAILNET)) {
		leaks.push({ rule: 'tailnet name', match: m[0], line: lineOf(m.index) });
	}
	for (const m of text.matchAll(MAC)) {
		if (MAC_PLACEHOLDER.test(m[0])) continue;
		leaks.push({ rule: 'MAC address', match: m[0], line: lineOf(m.index) });
	}
	denylist.forEach((re, i) => {
		for (const m of text.matchAll(re)) {
			leaks.push({ rule: 'denylisted literal', match: `entry #${i + 1}`, line: lineOf(m.index) });
		}
	});
	return leaks;
}

function shippedFiles() {
	const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
	return out.split('\0').filter(Boolean);
}

void test('nothing under a private tree is tracked', () => {
	const tracked = shippedFiles().filter((f) =>
		PRIVATE_TREES.some((t) => f === t || f.startsWith(`${t}/`))
	);
	assert.deepEqual(
		tracked,
		[],
		`${PRIVATE_TREES.join(', ')} belongs to WolffM/hadoku-fleet-manager-private. ` +
			`Commit there (the symlink points at its checkout) and \`git rm --cached\` these here.`
	);
});

void test('no tracked file locates the operator', () => {
	const list = readDenylist();
	assert.ok(
		list,
		`no denylist: set $PUBLISH_DENYLIST, or create ${DENYLIST_FILE} at the repo root ` +
			`(the main checkout's copy serves every worktree). Without it this guard has not looked.`
	);
	const denylist = compileDenylist(list.text);
	assert.ok(denylist.length > 0, `the denylist from ${list.source} has no entries`);

	const files = shippedFiles();
	// Zero files scanned is "I could not look", not "nothing leaks".
	assert.ok(
		files.length > 100,
		`only ${files.length} tracked files found — git ls-files is not seeing the repo`
	);

	const offenders = [];
	for (const f of files) {
		const buf = readFileSync(join(ROOT, f));
		if (buf.subarray(0, 8000).includes(0)) continue;
		for (const l of findLeaks(buf.toString('utf8'), denylist)) {
			offenders.push(`${f}:${l.line}  ${l.rule}: ${l.match}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`${offenders.length} leak(s) in files that will be public. Use the documentation ranges (192.0.2.0/24, ` +
			`198.51.100.0/24, 203.0.113.0/24), example.ts.net, and 02:00:00:… MACs. A denylist entry ` +
			`number indexes ${list.source}:\n  ${offenders.join('\n  ')}`
	);
});

// The samples are assembled at runtime so this file passes its own scan.
void test('findLeaks: a private host address fails, a documentation address and a wide range pass', () => {
	const lan = ['192', '168', '7', '7'].join('.');
	assert.equal(findLeaks(`ssh ${lan}`).length, 1);
	assert.equal(findLeaks(`addr ${['10', '1', '2', '0'].join('.')}/24`).length, 1);
	assert.equal(findLeaks(`tailscale0 ${['100', '101', '1', '2'].join('.')}/32`).length, 1);
	assert.equal(findLeaks(`/via ${['192', '168', '7', '7'].join('\\.')}/`).length, 1);
	assert.deepEqual(findLeaks('ssh 192.0.2.7, 198.51.100.4, 203.0.113.9'), []);
	assert.deepEqual(findLeaks('ranges 100.64.0.0/10 and 10.5.0.0/16 and 172.16.0.0/12'), []);
	assert.deepEqual(findLeaks('version 1.2.3 and v10.1.2.3'), []);
});

void test('findLeaks: a tailnet name fails, an example one passes', () => {
	assert.equal(findLeaks(`claw-1.${'tail'}9a8b7c.ts.net`).length, 1);
	assert.deepEqual(findLeaks('claw-1.example.ts.net'), []);
});

void test('findLeaks: a vendor MAC fails, a placeholder passes, in either separator', () => {
	assert.equal(findLeaks(['4c', '11', '22', '33', '44', '55'].join(':')).length, 1);
	assert.equal(findLeaks(['4C', '11', '22', '33', '44', '55'].join('-')).length, 1);
	assert.deepEqual(findLeaks('02:00:00:00:0a:b3 and 00:00:5E:00:53:01'), []);
	assert.deepEqual(findLeaks('at 12:30:45 on the dot'), []);
});

void test('findLeaks: a denylisted word is whole-word, a hex entry matches embedded, and the value is never echoed', () => {
	const list = compileDenylist('# comment\nZzqx\nCorp-Net_5G\n0123456789ab\n');
	const hits = findLeaks("Zzqx's box joined corp-net_5g as unknown0123456789AB", list);
	assert.deepEqual(
		hits.map((h) => h.match),
		['entry #1', 'entry #2', 'entry #3']
	);
	assert.deepEqual(findLeaks('zzqxy, Corp-Net_5GHz and 0123456789a', list), []);
});
