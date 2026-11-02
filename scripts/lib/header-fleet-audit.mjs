/**
 * header-fleet-audit — the per-repo pass over every `uiApp` consumer,
 * checking package staleness, the update/landing path, private
 * theme/settings copies, the shared header and its name, the favicon, and
 * the theme provider.
 *
 * Moved out of `check-header-fleet.mjs` (wave shrink-1 lane D), body
 * unchanged — see that file's header for the full rule catalogue (WHAT IT
 * CHECKS / THE RULES).
 */

import { readFile, readBlanked } from './header-source.mjs';
import { stripYamlComments } from './yaml-comments.mjs';
import {
	report,
	wolffmPeers,
	peerRangeIsSound,
	checkNpmAuthForm,
	checkReleaseAgeCooldown,
	checkHeaderName,
	checkFavicon,
	checkTypesEntry,
	latestVersion,
	majorOf,
} from './header-rules.mjs';

/**
 * The patterns the FLEET pass and the TEMPLATE pass both apply.
 *
 * Both halves genuinely run the same rules over different inputs — a fleet repo
 * has drifted, a template scaffolds every future app pre-drifted — so what they
 * share is the DEFINITION, not the finding: each half words its own message,
 * because "declares" and "scaffolds" are different claims about the world. Left
 * inline they were three verbatim copies apiece, which is exactly how one half
 * gets tightened and the other silently keeps passing.
 *
 * The picker-import pattern used to be spelt as two regexes on the fleet side
 * (`ConnectedThemePicker` and `ThemePicker` separately) and as this one on the
 * template side; `\b` before `ThemePicker` cannot match inside
 * `ConnectedThemePicker`, so the union of the two is exactly this language.
 */
export const LOCAL_THEME_MODULE =
	/(^|\/)(hooks\/useTheme|prefs\/themePrefs|app\/themeConfig)\.(tsx?|jsx?)$/;
export const RAW_PICKER_IMPORT =
	/\bimport\s*\{[^}]*\b(Connected)?ThemePicker\b[^}]*\}\s*from\s*['"]@wolffm\/task-ui-components['"]/;
export const THEME_PICKER_PROP = /\bthemePicker\s*=\s*\{/;

/**
 * @param {string[]} fleet repo slugs consuming `@wolffm/task-ui-components`
 * @param {{useWorktree: boolean, noFetch: boolean, noRegistry: boolean, openRepo: Function}} opts
 */
export function auditFleetRepos(
	fleet,
	{ useWorktree, noFetch, noRegistry, openRepo, resetFileCache }
) {
	for (const repo of fleet) {
		resetFileCache();
		const source = openRepo(repo, { useWorktree, noFetch });
		if (source.missing) {
			// A finding, not a skip. Silently skipping every repo is how this script
			// printed "OK — no drift" while auditing nothing at all, which is worse
			// than no audit: it actively asserts the fleet is clean.
			report(repo, 'no-checkout', `${source.unreadable} — nothing was audited for this repo`);
			continue;
		}

		let files;
		try {
			if (source.unreadable) throw new Error(source.unreadable);
			files = source.files();
		} catch (err) {
			// A finding, not a stderr line. This used to log and `continue`, so a
			// repo whose files could not be listed ran ZERO rules while the summary
			// still said "no drift" — the `no-checkout` trap one step further in, and
			// invisible to ci:header-fleet, which reads stdout only.
			report(
				repo,
				'unreadable',
				`cannot list ${useWorktree ? 'the working copy' : 'the shipped default branch'} (${String(
					err.message || err
				)
					.split('\n')[0]
					.slice(0, 160)}) — nothing was audited for this repo`
			);
			continue;
		}

		// ---- published types entry resolves ----------------------------------
		checkTypesEntry(repo, source);

		// ---- npm registry auth uses the canonical token ----------------------
		checkNpmAuthForm(repo, source, files);

		// ---- package manifests: staleness -----------------------------------
		const manifests = files.filter(
			(f) => f.endsWith('package.json') && !f.includes('node_modules')
		);
		let consumesWolffm = false;

		for (const m of manifests) {
			const raw = readFile(source, m);
			if (!raw) continue;
			let pkg;
			try {
				pkg = JSON.parse(raw);
			} catch {
				continue;
			}
			for (const field of ['dependencies', 'devDependencies']) {
				for (const [name, range] of Object.entries(pkg[field] || {})) {
					if (!name.startsWith('@wolffm/')) continue;
					consumesWolffm = true;
					const r = String(range);
					// `workspace:` and `*` are not version claims — nothing to compare.
					if (r.startsWith('workspace:') || r === '*') continue;
					const declared = (r.match(/(\d+\.\d+\.\d+)/) || [])[1];
					const latest = latestVersion(name, { noRegistry });
					if (declared && latest && declared !== latest) {
						const dm = majorOf(r);
						const lm = majorOf(latest);
						report(repo, 'stale-package', `${name} in ${m}: declares ${r}, latest is ${latest}`, {
							pkg: name,
							manifest: m,
							declared: r,
							latest,
							// A caret range cannot cross a major, so a major gap does NOT
							// close on its own the way a minor one does — it waits for
							// `pnpm update --latest` and, failing that, forever.
							majorGap: dm !== null && lm !== null && lm > dm,
						});
					}
				}
			}

			// ---- peer ranges must be floors ---------------------------------
			// `pnpm update --latest` (every child's update-wolffm.yml) bumps
			// dependencies/devDependencies but never peerDependencies, so a
			// caret/tilde/exact @wolffm peer goes stale the moment the fleet
			// crosses a major, and every consumer install then trips peer
			// conflicts — six repos sat on peer ^3.0.0 while installing tuic 4.x
			// (found 2026-08-07). Fleet convention: peers declare a floor
			// (`>=x.y.z`), which cannot rot. The real compatibility gate is each
			// child's CI building against actual latest, not this range.
			for (const { name, r } of wolffmPeers(pkg)) {
				consumesWolffm = true;
				if (peerRangeIsSound(r)) continue;
				report(
					repo,
					'stale-peer',
					`${name} in ${m}: peer range '${r}' rots as majors advance — declare a floor ('>=${r.replace(/^[\^~]/, '')}')`
				);
			}
		}

		if (!consumesWolffm) continue;

		// ---- the release-age cooldown must not gate @wolffm/* -----------------
		checkReleaseAgeCooldown(repo, source, files);

		// ---- an update path must exist --------------------------------------
		const updateFlows = files.filter((f) =>
			/^\.github\/workflows\/.*update.*wolffm.*\.ya?ml$/i.test(f)
		);
		if (updateFlows.length === 0) {
			report(
				repo,
				'no-update-flow',
				'consumes @wolffm/* but has no .github/workflows/update-wolffm.yml — nothing will ever update it'
			);
		}

		// ---- ...and it must be able to LAND its result -----------------------
		// The default branch is protected, and a fresh bump has run none of its
		// required checks, so a plain push is rejected — but only when there is
		// actually something to push; with nothing to update the job exits 0 early,
		// so a broken repo sits GREEN indefinitely and the freeze surfaces days
		// later, on the first real payload. Until 2026-10-23 the fix was a PAT
		// checkout that bypassed protection as an admin: HADOKU_SITE_TOKEN, repo +
		// workflow on the whole account, in every consumer. The landing path now
		// is the shared `update-wolffm` action, which pushes a bot branch with the
		// job's own token and has mgmt-api fast-forward main onto it; a repo that
		// still holds the PAT is check-site-token's finding, not this one's.
		for (const f of updateFlows) {
			const raw = readFile(source, f);
			if (!raw) continue;
			// Comment-stripped: a commented-out `uses:` line is not a step that runs.
			if (!/uses:\s*\S+\/update-wolffm@\S+/.test(stripYamlComments(raw))) {
				report(
					repo,
					'no-landing-path',
					`${f} — does not use the shared update-wolffm action, so nothing can land its bump on a protected main; the run stays green until the first real update, then the repo silently freezes`
				);
			}
		}

		// ---- private theme/settings implementations -------------------------
		const sources = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.includes('node_modules'));
		for (const f of sources) {
			if (LOCAL_THEME_MODULE.test(f)) {
				report(
					repo,
					'private-picker',
					`${f} — a local copy of a module that lives in @wolffm/themes`
				);
				continue;
			}
			const src = readBlanked(source, f);
			if (!src) continue;
			if (RAW_PICKER_IMPORT.test(src)) {
				report(
					repo,
					'private-picker',
					`${f} — imports a raw picker; AppHeader owns it since tuic 3.0.0`
				);
			}
			if (THEME_PICKER_PROP.test(src)) {
				report(repo, 'private-picker', `${f} — passes a themePicker prop, removed in tuic 3.0.0`);
			}
			if (/\bshowSettings\s*=\s*\{/.test(src)) {
				report(repo, 'private-picker', `${f} — passes showSettings, removed in tuic 3.0.0`);
			}
		}

		// ---- an app root should mount the shared header ----------------------
		const appRoots = sources.filter((f) => /(^|\/)App\.(tsx|jsx)$/.test(f));
		for (const f of appRoots) {
			const src = readBlanked(source, f);
			if (!src) continue;
			// RENDERED, not named. A bare-identifier match passed an App.tsx that
			// imports AppHeader and never mounts it — an import left behind by a
			// refactor is exactly the shape a header quietly disappears in.
			if (!/<\s*AppHeader\b/.test(src)) {
				report(repo, 'no-app-header', `${f} — an app root that renders no <AppHeader>`);
			}
		}

		// ---- and it must call the app what the catalogue calls it -------------
		checkHeaderName(repo, source, appRoots);

		// ---- every entry shell declares an icon -------------------------------
		checkFavicon(repo, source, files);

		// ---- the provider must exist wherever the controls are used ----------
		//
		// This rule exists because I shipped exactly this bug: hadoku-watchparty's chat
		// panel was switched to <HadokuThemePicker /> without adding
		// <HadokuThemeRoot> anywhere, so it would have thrown at mount. Nothing
		// caught it — the repo's tests never render that component, and both
		// typecheck and build pass happily, because a missing React context is a
		// runtime fact, not a type error.
		//
		// Repo-wide rather than per-file: the provider legitimately lives at the app
		// root while the consumer sits several components down.
		//
		// NOT the same rule as the templates' `no-provider`, despite the name: that
		// one is per-FILE (an App.tsx must itself contain both), because a template
		// is a self-contained scaffold with nothing above its root to inherit a
		// provider from. Do not fold the two together — merging would either blind
		// this one to a provider-less app root or make that one accept a provider
		// sitting in some unrelated template file.
		const usesControls = [];
		let hasProvider = false;
		for (const f of sources) {
			const src = readBlanked(source, f);
			if (!src) continue;
			// MOUNTED, not named — same reason as `no-app-header`: an import of the
			// provider that nothing renders provides nothing, and throws at mount
			// exactly as a missing one does.
			if (/<\s*HadokuThemeRoot\b/.test(src)) hasProvider = true;
			if (/<\s*(AppHeader|HadokuThemePicker)\b/.test(src) || /\buseHadokuTheme\s*\(/.test(src)) {
				usesControls.push(f);
			}
		}
		if (usesControls.length > 0 && !hasProvider) {
			report(
				repo,
				'no-provider',
				`uses the shared header/theme controls (${usesControls[0]}${usesControls.length > 1 ? ` +${usesControls.length - 1} more` : ''}) but mounts no <HadokuThemeRoot> — this throws at runtime`
			);
		}
	}
}
