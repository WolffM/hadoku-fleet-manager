/**
 * THIS BOX'S PROCESS TREE, from the kernel: pid → ppid out of `/proc/<pid>/stat`,
 * a pid's descendants, and a pid's cgroup out of `/proc/<pid>/cgroup`.
 *
 * Two readers ask it about one PM2 app: `service-inventory` charges a service
 * for its whole subtree, not its wrapper's few MB, and `check-egress-slices`
 * judges a tunnel-only app by where its children run, because the wrapper PM2
 * reports stays in pm2's own cgroup (fleet-manager#87). Moved here from those
 * two so the observation layer can read it without importing a domain.
 */
import { readFileSync, readdirSync } from 'node:fs';

/** pid → ppid for every process on the box, out of `/proc/<pid>/stat`. */
export function ppidMap() {
	const map = new Map();
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		let stat;
		try {
			stat = readFileSync(`/proc/${name}/stat`, 'utf8');
		} catch (err) {
			// A pid that exited between readdir and read is normal and not a gap:
			// it held no resources by the time we looked. Any OTHER errno is.
			if (err.code === 'ENOENT' || err.code === 'ESRCH') continue;
			throw err;
		}
		// comm can contain spaces and parens, so fields are counted from the LAST ')'.
		const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		map.set(Number(name), Number(after[1]));
	}
	return map;
}

/**
 * Every descendant pid of `root`, from a pid→ppid map, `root` first.
 *
 * A PM2 "app" is a wrapper that spawns the real process — `tunnel` spawns
 * cloudflared, `dataplatform` spawns a venv python, `valheim` spawns a game
 * server, `crossposter` spawns its python into a scope of its own slice.
 */
export function descendantPids(root, ppidByPid) {
	const children = new Map();
	for (const [pid, ppid] of ppidByPid) {
		if (!children.has(ppid)) children.set(ppid, []);
		children.get(ppid).push(pid);
	}
	const out = [];
	const stack = [root];
	const seen = new Set();
	while (stack.length) {
		const pid = stack.pop();
		if (seen.has(pid)) continue; // a pid cycle cannot happen, but a reused pid in a stale map can
		seen.add(pid);
		out.push(pid);
		for (const c of children.get(pid) ?? []) stack.push(c);
	}
	return out;
}

/**
 * The cgroup v2 path of `pid` (`0::<path>`), or null when it could not be read:
 * the pid exited, or is not ours to read. The caller decides what null means;
 * it is never a pass.
 */
export function cgroupOf(pid) {
	if (!pid || pid <= 0) return null;
	try {
		const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
			.split('\n')
			.find((l) => l.startsWith('0::'));
		return line ? line.slice(3).trim() : null;
	} catch {
		return null;
	}
}

/** `{ pid, cgroup }` for every DESCENDANT of `root` (not `root` itself). */
export function descendantCgroups(root, ppidByPid = ppidMap()) {
	return descendantPids(root, ppidByPid)
		.filter((pid) => pid !== root)
		.map((pid) => ({ pid, cgroup: cgroupOf(pid) }));
}
