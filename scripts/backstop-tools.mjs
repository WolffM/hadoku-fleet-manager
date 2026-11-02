#!/usr/bin/env node
/**
 * fleet backstop-tools — are the backstop's hand-installed yt-dlp and deno current
 * (fleet-manager#34). Reads and reports; installs nothing.
 *
 * The version is what a LOGIN shell on the backstop reports, the PATH an operator and
 * an agent's Bash tool see (`~/.local/bin` today), not mgmt-api's own. The
 * release list is GitHub's, unauthenticated, one call per tool.
 * lib/backstop-tools.mjs judges them.
 *
 * src/backstop-tools.ts runs it daily in mgmt-api and posts a stale tool to the
 * emergency channel once, then again every 30 days while it stays stale, then
 * a recovery once it is current.
 *
 * USAGE
 *   fleet backstop-tools [--json]
 *
 * EXIT 0 only when every tool is current.
 */
import { backstopNodeNames } from '../dist/lib/node-role.js';
import { createEmitter } from './lib/emit.mjs';
import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import { BACKSTOP_TOOLS, judgeTool } from './lib/backstop-tools.mjs';
import { fetchGithubReleaseTimes } from './lib/tool-release.mjs';
import { parseInstalledVersion } from './lib/version-algebra.mjs';

const args = process.argv.slice(2);
for (const a of args) {
	if (!['--json', '--help', '-h'].includes(a)) {
		console.error(`backstop-tools: unknown argument ${a}. See --help.`);
		process.exit(2);
	}
}
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);
if (args.includes('--help') || args.includes('-h')) {
	log('fleet backstop-tools [--json]');
	log("  the backstop's hand-installed yt-dlp and deno against their newest releases.");
	process.exit(0);
}

async function main() {
	const names = Object.keys(BACKSTOP_TOOLS);
	const unreadable = [];
	const unconverged = [];
	const results = [];
	let nodes = [];
	try {
		nodes = [...backstopNodeNames(loadManifest())];
	} catch (err) {
		unreadable.push({ node: '*', facet: 'tools', why: `the manifest: ${err.message}` });
	}
	// None declared is "could not look", never "every tool is current".
	if (!unreadable.length && !nodes.length)
		unreadable.push({ node: '*', facet: 'tools', why: 'the manifest declares no backstop node' });
	// The release lists are the same for every node: read each once.
	const releasesOf = Object.fromEntries(
		await Promise.all(
			names.map(async (n) => [n, await fetchGithubReleaseTimes(BACKSTOP_TOOLS[n].source)])
		)
	);

	for (const node of nodes) {
		// One login shell for every tool, each version between its own markers,
		// as the operator's own shell sees them: ~/.local/bin is on its PATH.
		const probe = names
			.map((n) => `echo "@@ ${n}"; ${BACKSTOP_TOOLS[n].version} 2>/dev/null || true`)
			.join('\n');
		const r = await runOn(node, `bash -l <<'PROBE'\n${probe}\nPROBE`, {
			as: 'admin',
			timeoutMs: 30_000,
		});
		const versions = {};
		let current = null;
		for (const line of r.stdout.split('\n')) {
			const m = /^@@ (\S+)$/.exec(line);
			if (m) current = m[1];
			else if (current && line.trim() && !(current in versions))
				versions[current] = parseInstalledVersion(line);
		}
		for (const name of names) {
			const row = { node, facet: `tool:${name}` };
			if (!r.stdout.includes('@@ ')) {
				unreadable.push({ ...row, why: `${node} did not answer: ${r.error ?? r.stderr.trim()}` });
				continue;
			}
			const releases = releasesOf[name];
			const verdict = judgeTool(name, {
				node,
				installed: versions[name] ?? null,
				releases: releases.status === 'known' ? releases.time : null,
				why: releases.reason,
			});
			results.push({ node, tool: name, ...verdict });
			log(
				`${node} ${name.padEnd(7)} ${verdict.state.padEnd(8)} ${verdict.installed ?? '-'}` +
					(verdict.latest ? ` (newest ${verdict.latest})` : '') +
					(verdict.why ? `  ${verdict.why}` : '')
			);
			if (verdict.state === 'unknown') unreadable.push({ ...row, why: verdict.why });
			else if (verdict.state !== 'current')
				unconverged.push({ ...row, before: verdict.installed ?? 'missing', why: verdict.why });
		}
	}
	for (const u of unreadable) log(`unreadable  ${u.node} ${u.facet}: ${u.why}`);

	const ok = unconverged.length === 0 && unreadable.length === 0;
	if (emitter.json)
		emitter.emit({
			ok,
			tools: results,
			planned: [],
			converged: [],
			deferred: [],
			unconverged,
			unreadable,
			changed: [],
		});
	process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`backstop-tools: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
