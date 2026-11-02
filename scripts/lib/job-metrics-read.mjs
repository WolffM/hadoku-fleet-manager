/**
 * job-metrics-read — the node-side read: the script that filters a node's
 * JSONL to the retention window, the sentinel that tells a finished read
 * from a truncated one, and the parser for what comes back.
 *
 * Moved out of job-metrics.mjs (wave shrink-1 lane D), body unchanged.
 */

/** Parse a node's JSONL, tolerating the truncated final line an append can leave. */
export function parseMetrics(text) {
	const rows = [];
	let skipped = 0;
	for (const line of String(text ?? '').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			rows.push(JSON.parse(t));
		} catch {
			skipped += 1;
		}
	}
	return { rows, skipped };
}

/**
 * The line a node-side read prints LAST, and only when it finished.
 *
 * An end-of-read sentinel, because "the bytes stopped" and "the file ended"
 * look identical from here: a read cut short by a dying ssh session, a killed
 * awk or a full pipe hands back a perfectly parseable prefix, and a prefix of
 * a JSONL file is a smaller fleet rather than an error. The sentinel is what
 * turns a truncated read into a `read-error` instead of a quiet undercount.
 */
export const READ_END = '#job-metrics-read-end';

/**
 * The oldest `ts` a read still wants: `days` before `now`, as the hook writes it.
 *
 * The window is job-history's `RETENTION_DAYS`, passed in by the caller rather
 * than imported here so this file stays free of the built library. A row older
 * than that has no job-history record left to join against, and the node keeps
 * it only until the hook's next rotation.
 *
 * @param {number} now epoch ms
 * @param {number} days
 */
export function metricsSince(now, days) {
	if (!Number.isFinite(now) || !Number.isFinite(days) || days <= 0) {
		throw new RangeError(`metricsSince: need a time and a positive window, got ${now}, ${days}`);
	}
	return new Date(now - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The node-side half of a metrics read — ONLY the rows inside the window.
 *
 * AWK ON `ts`, NOT `tail -c`, and the choice is about what the caller wants
 * rather than what is cheapest. The caller wants "every row of the last N
 * days". `tail -c <bytes>` answers "the last <bytes> of the file", which is a
 * different question whose answer changes with each node's job RATE: on
 * claw-1 (1,935 rows in 14 days, 2026-09-18) a byte budget sized for claw-6
 * (162 rows) silently cuts the window short, and nothing in the output would
 * say so. A `ts` filter is the same window on every node, it counts what it
 * left behind (`older=`), and the rows it keeps are exactly the ones the
 * job-history join can still place. It also needs no line re-sync: awk never
 * starts mid-line.
 *
 * Both files, `.1` first. `job-metrics.sh` rotates at the retention boundary
 * and keeps ONE `.1`, so right after a rotation every in-window row is in `.1`
 * and the live file holds one. Reading the live file alone would halve the
 * window twice a month.
 *
 * A row with no `ts` is passed through, not dropped: the reader's
 * `parseMetrics` then counts it as unparseable, which is where a truncated
 * append has always been reported. A file that EXISTS and cannot be read
 * exits 3 with the errno on stderr — before this, the read was
 * `cat ... 2>/dev/null || true`, so an unreadable file was an empty one.
 * NEITHER file existing is still an empty read: before the hook is installed
 * there is legitimately nothing, and the caller already says so.
 *
 * @param {string} since ISO-8601 UTC, second resolution, from {@link metricsSince}
 */
export function metricsReadScript(since) {
	// Interpolated into shell, so it is validated rather than quoted: the only
	// thing that may reach the node is a timestamp of the exact shape the hook
	// writes, which is also the shape the string comparison below depends on.
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(since))) {
		throw new TypeError(`metricsReadScript: since must be YYYY-MM-DDTHH:MM:SSZ, got ${since}`);
	}
	return `f="$HOME/.hadoku/job-metrics.jsonl"
set --
for p in "$f.1" "$f"; do
	[ -e "$p" ] || continue
	if [ ! -r "$p" ]; then
		echo "job-metrics-read: EACCES $p exists and is not readable" >&2
		exit 3
	fi
	set -- "$@" "$p"
done
if [ "$#" -eq 0 ]; then
	echo "${READ_END} kept=0 older=0 files=0"
	exit 0
fi
awk -v since='${since}' -v files="$#" '
	match($0, /"ts":"[^"]*"/) {
		if (substr($0, RSTART + 6, RLENGTH - 7) < since) { older++; next }
	}
	{ print; kept++ }
	END { printf "${READ_END} kept=%d older=%d files=%d\\n", kept, older, files }
' "$@"
rc=$?
if [ "$rc" -ne 0 ]; then
	echo "job-metrics-read: EIO awk exited $rc reading $*" >&2
	exit 3
fi
`;
}

/**
 * WHAT A METRICS READ OF ONE NODE FOUND — and, when it found nothing, WHY.
 *
 * THREE CLASSES, because they are three different jobs for whoever reads them:
 *
 *   ok           the node answered and the read finished (the sentinel is
 *                there). Zero rows is still `ok`: the hook may not be
 *                installed yet, and the caller says so.
 *   unreachable  ssh itself failed — exit 255, the status it reserves for its
 *                own errors (connect, auth, host key). The box may be down.
 *   read-error   the node was reached, or the read was local, and the bytes did
 *                not come back whole: a local errno (`ENOBUFS` when the output
 *                outgrew the buffer, `ETIMEDOUT`), the node-side read exiting
 *                non-zero with its own errno, or a read that ended without the
 *                sentinel. The box is UP; the read is what broke.
 *
 * Until #37 there was one class. claw-1 answered, its 1.1 MB file overflowed
 * Node's 1 MiB default, and the report said UNREACHABLE — true that nothing
 * was read, false about the node, and it points whoever reads it at the
 * network instead of at a buffer. Both non-ok classes still FAIL the caller:
 * "I could not look" must never render as "nothing is wrong", and a class
 * that names the reason is what makes the failure actionable.
 *
 * @param {string} node
 * @param {{ok: boolean, out?: string, stderr?: string, error?: string|null,
 *          code?: string|null, status?: number|null, local?: boolean}} res
 *          a `runOnSync` result
 */
export function readOutcome(node, res) {
	const fail = (read, errno, why) => ({
		node,
		read,
		errno,
		why,
		rows: [],
		skipped: 0,
		older: null,
	});
	if (!res.ok) {
		if (res.code) return fail('read-error', res.code, res.error || res.code);
		if (!res.local && res.status === 255) {
			return fail('unreachable', null, res.error || 'ssh exited 255');
		}
		const m = /job-metrics-read: (E[A-Z]+)\b/.exec(String(res.stderr ?? ''));
		return fail(
			'read-error',
			m ? m[1] : null,
			res.error || `the read exited ${res.status ?? 'without a status'}`
		);
	}
	const lines = String(res.out ?? '').split('\n');
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	const last = lines.length ? lines[lines.length - 1] : '';
	if (!last.startsWith(READ_END)) {
		return fail(
			'read-error',
			null,
			`the read ended without its "${READ_END}" line — the output is incomplete, not short`
		);
	}
	lines.pop();
	const kv = {};
	for (const tok of last.split(/\s+/).slice(1)) {
		const i = tok.indexOf('=');
		if (i > 0) kv[tok.slice(0, i)] = Number(tok.slice(i + 1));
	}
	const { rows, skipped } = parseMetrics(lines.join('\n'));
	return {
		node,
		read: 'ok',
		errno: null,
		why: null,
		rows,
		skipped,
		older: Number.isFinite(kv.older) ? kv.older : null,
	};
}

/**
 * `perNode` with EVERY node that was asked, not only the ones that answered.
 *
 * `byNode` groups rows, so a node with no rows — unreadable, unreachable, or
 * simply idle — has no entry, and a consumer reading `perNode` alone saw a
 * six-claw fleet on 2026-09-18 while claw-1 sat in a separate `unreachable`
 * list. Here every asked node appears exactly once and says how its read went
 * (`read`), so the failure is in the same list the numbers are in.
 *
 * A node that could not be read carries `jobs: null` rather than 0 — "I could
 * not look" is not a node that ran nothing.
 *
 * @param {Array<object>} summaries `byNode` output
 * @param {Array<{node: string, read: string, errno: string|null, why: string|null}>} reads
 */
export function perNodeWithReads(summaries, reads) {
	const seen = new Set(summaries.map((s) => s.node));
	const out = summaries.map((s) => ({ ...s, read: 'ok' }));
	for (const r of reads) {
		if (seen.has(r.node)) continue;
		seen.add(r.node);
		out.push(
			r.read === 'ok'
				? { node: r.node, read: 'ok', jobs: 0 }
				: { node: r.node, read: r.read, errno: r.errno, why: r.why, jobs: null }
		);
	}
	return out;
}
