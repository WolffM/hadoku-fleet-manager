/**
 * header-template-audit — hadoku_site's own scaffolding: the ONE place drift
 * is born rather than found.
 *
 * Moved out of `check-header-fleet.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * A child app generated from a stale template starts pre-drifted, and every
 * other rule only sees repos that already exist. They sat on the
 * pre-lockdown pattern for the whole migration precisely because nothing
 * looked at them.
 *
 * Only real SOURCE templates belong in the list below. `templates/conjure-tunnel`
 * used to be here and was not one: hydrate-child-app.mjs writes its output to
 * `templates/<appId>-tunnel`, so that directory was a hydrated COPY of
 * tunnel-contained, and auditing it only re-checked what the fleet pass already
 * covers. Worse, listing it made it look maintained — four commits hand-edited
 * the generated copy alongside its source. It was deleted 2026-08-17 (the same
 * cleanup 2cb45404 did for templates/dataplatform-tunnel, and the one
 * CHECKLIST_conjure.md's own Cleanup section asked for). If a future app leaves
 * a `templates/<app>-tunnel` behind, delete it — do not add it here.
 * Every real source template, not just the ones that happened to be listed.
 * `templates/worker` carried a caret `@wolffm/worker-utils` peer that this gate
 * could not see, so the fleet-wide floor sweep of 2026-08-18 had to find it by
 * hand — the same "the list itself is the blind spot" lesson as
 * `not-in-fleet`. Only the peer-floor rule runs over templates, so widening the
 * list cannot false-positive a non-UI template.
 *
 * So the list is READ from `templates/*`, not typed. It was typed until
 * 2026-11-10, when hadoku_site retired `templates/tunnel` (25086b44c): the gate
 * reported a missing checkout, and `templates/game` and
 * `templates/tunnel-loopback-ui` had never been audited at all. A site with no
 * template directory is still a finding — "I could not look" is not "clean".
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankComments } from './blank-comments.mjs';
import { report, wolffmPeers, peerRangeIsSound } from './header-rules.mjs';
import { LOCAL_THEME_MODULE, RAW_PICKER_IMPORT, THEME_PICKER_PROP } from './header-fleet-audit.mjs';

/** Every directory under `templates/`, as a repo-relative path, sorted.
 *  @param {string} repoRoot @returns {string[]} */
export function listTemplates(repoRoot) {
	const dir = resolve(repoRoot, 'templates');
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => `templates/${e.name}`)
		.sort();
}

/** @param {string} repoRoot @param {(dir: string, argv: string[]) => string} git */
export function auditTemplates(repoRoot, git) {
	const templates = listTemplates(repoRoot);
	if (templates.length === 0) {
		report('templates', 'no-checkout', 'templates/ holds no template — has the scaffolding moved?');
		return;
	}
	for (const tpl of templates) {
		let files;
		try {
			files = git(repoRoot, ['ls-files', tpl]).split('\n').filter(Boolean);
		} catch {
			continue;
		}

		// Template peers get the same floor rule as the fleet — a template with a
		// caret peer scaffolds every future app pre-drifted.
		for (const f of files.filter((x) => x.endsWith('package.json'))) {
			let pkg;
			try {
				pkg = JSON.parse(readFileSync(resolve(repoRoot, f), 'utf8'));
			} catch {
				continue;
			}
			for (const { name, r } of wolffmPeers(pkg)) {
				if (peerRangeIsSound(r)) continue;
				report(
					'templates',
					'stale-peer',
					`${name} in ${f}: scaffolds peer range '${r}' — declare a floor ('>=${r.replace(/^[\^~]/, '')}')`
				);
			}
		}

		for (const f of files) {
			if (LOCAL_THEME_MODULE.test(f)) {
				report(
					'templates',
					'private-picker',
					`${f} — scaffolds a copy of a module that lives in @wolffm/themes`
				);
				continue;
			}
			if (!/\.(tsx?|jsx?)$/.test(f)) continue;
			let raw;
			try {
				raw = readFileSync(resolve(repoRoot, f), 'utf8');
			} catch {
				continue;
			}
			const src = blankComments(raw);
			if (RAW_PICKER_IMPORT.test(src)) {
				report(
					'templates',
					'private-picker',
					`${f} — scaffolds a raw picker import; AppHeader owns it`
				);
			}
			if (THEME_PICKER_PROP.test(src)) {
				report(
					'templates',
					'private-picker',
					`${f} — scaffolds a themePicker prop, removed in tuic 3.0.0`
				);
			}
		}

		// A template whose App renders AppHeader must also scaffold the provider.
		// Per-FILE on purpose — see the fleet's repo-wide `no-provider` for why
		// the two look alike and must stay apart.
		const appFiles = files.filter((f) => /(^|\/)App\.(tsx|jsx)$/.test(f));
		for (const f of appFiles) {
			const raw = readFileSync(resolve(repoRoot, f), 'utf8');
			const src = blankComments(raw);
			if (/<\s*AppHeader\b/.test(src) && !/\bHadokuThemeRoot\b/.test(src)) {
				report(
					'templates',
					'no-provider',
					`${f} — scaffolds <AppHeader> with no <HadokuThemeRoot>, so a generated app throws at mount`
				);
			}
		}
	}
}
