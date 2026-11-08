/**
 * runner-units-probe — the NODE half of the runner-units audit, shared by
 * `fleet runner-units` (`scripts/runner-units.mjs`) and `fleet identity`
 * (`scripts/reconcile-runner-identity.mjs`), which now folds the same audit
 * into its own report (wave gates2 lane F1a, item 4: "MERGE ci:runner-units
 * -> check:runner-identity").
 *
 * Split out so the GitHub repo lookup — with its retry policy and its
 * memoisation — is not duplicated between the two callers; the classification
 * rules themselves (RENAMED/GONE/ARCHIVED/OFF-ROSTER/STRAY/SICK) stay in
 * `runner-unit-audit.mjs`, unchanged, which this does not replace.
 */
import { spawnSync } from 'node:child_process';
import { lookupOutcome } from './runner-unit-audit.mjs';

/**
 * Enumerate what is ACTUALLY on the box, in one round trip.
 *
 * Two record kinds, because the two failure shapes are different: an INSTALL
 * exists and may name the wrong repo, while a UNIT may exist with nothing
 * behind it at all. Reading only one of them misses half the ways this
 * drifts.
 */
export const RUNNER_UNITS_PROBE = String.raw`set -u
H="$HOME"
# INSTALLS — identity from .runner's gitHubUrl, which is what registration wrote.
for d in "$H"/runners/actions-runner-*/ "$H"/actions-runner-*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  url=""
  if [ -f "$d/.runner" ]; then
    url=$(tr -d '\000\357\273\277' < "$d/.runner" | grep -o '"gitHubUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  fi
  sz=$(du -sm "$d" 2>/dev/null | cut -f1)
  [ -n "$sz" ] || sz=0
  printf 'INSTALL\t%s\t%s\t%s\n' "$n" "$url" "$sz"
done
# UNITS — both schemes. A unit with no install behind it is the stray case.
systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print $1}' | while read -r u; do
  [ -n "$u" ] || continue
  a=$(systemctl show -p ActiveState --value "$u" 2>/dev/null)
  s=$(systemctl show -p SubState --value "$u" 2>/dev/null)
  r=$(systemctl show -p NRestarts --value "$u" 2>/dev/null)
  w=$(systemctl show -p WorkingDirectory --value "$u" 2>/dev/null)
  [ -n "$r" ] || r=0
  printf 'UNIT\tsystem\t%s\t%s\t%s\t%s\t%s\n' "$u" "$a" "$s" "$r" "$w"
done
systemctl --user list-units 'actions-runner-*' --all --no-legend --plain 2>/dev/null | awk '{print $1}' | while read -r u; do
  [ -n "$u" ] || continue
  a=$(systemctl --user show -p ActiveState --value "$u" 2>/dev/null)
  s=$(systemctl --user show -p SubState --value "$u" 2>/dev/null)
  r=$(systemctl --user show -p NRestarts --value "$u" 2>/dev/null)
  w=$(systemctl --user show -p WorkingDirectory --value "$u" 2>/dev/null)
  [ -n "$r" ] || r=0
  printf 'UNIT\tuser\t%s\t%s\t%s\t%s\t%s\n' "$u" "$a" "$s" "$r" "$w"
done`;

/** `{ installs: [{dir,url,sizeMb}], units: [{scope,unit,active,sub,restarts,wd}] }` from the probe's lines. */
export function parseRunnerUnitsProbe(out) {
	const installs = [];
	const units = [];
	for (const line of String(out).split('\n')) {
		const f = line.split('\t');
		if (f[0] === 'INSTALL') installs.push({ dir: f[1], url: f[2], sizeMb: Number(f[3]) || 0 });
		else if (f[0] === 'UNIT') {
			units.push({
				scope: f[1],
				unit: f[2],
				active: f[3],
				sub: f[4],
				restarts: Number(f[5]) || 0,
				wd: f[6] ?? '',
			});
		}
	}
	return { installs, units };
}

/**
 * Two attempts per repo, the same `READ_ATTEMPTS` queue-health uses against its
 * measured 0.13% transient rate. Retrying is not tolerating: a repo that fails
 * both is still unread and still fails the gate, with its reason.
 */
export const RUNNER_UNITS_LOOKUP_ATTEMPTS = 2;

/**
 * One `gh api repos/<path>` lookup, memoised per call — the roster alone is
 * ~26 of them, and an install may repeat a repo across several nodes.
 */
export function createRepoLookup({ attempts = RUNNER_UNITS_LOOKUP_ATTEMPTS } = {}) {
	const cache = new Map();
	return function lookupRepo(path) {
		if (cache.has(path)) return cache.get(path);
		let outcome = null;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const r = spawnSync('gh', ['api', `repos/${path}`], {
				encoding: 'utf8',
				maxBuffer: 8 << 20,
				timeout: 30_000,
			});
			outcome = lookupOutcome({
				ok: r.status === 0 && !r.error,
				stdout: r.stdout ?? '',
				stderr: r.error ? String(r.error.message) : (r.stderr ?? ''),
			});
			if (outcome.status !== 'error') break;
		}
		cache.set(path, outcome);
		return outcome;
	};
}
