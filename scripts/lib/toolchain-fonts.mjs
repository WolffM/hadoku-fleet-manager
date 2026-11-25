/**
 * The toolchain floor's `fonts` entry. toolchain-floor.mjs's REPAIRS table
 * spreads it in; it lives here because that file is at its size ceiling.
 * toolchain-floor.mjs documents every field.
 *
 * WHY (operator, 2026-11-25: "everyone should be getting this in the
 * toolchain"). A browser renders text with whatever fontconfig resolves, so
 * two claws with different fonts lay the same page out differently and a
 * Playwright assertion on layout passes on one and fails on the other.
 * hadoku-watchparty's nightly e2e went red on some claws and installs
 * fonts-liberation in its own workflow to cope. Measured 2026-11-25, `fc-list
 * | wc -l` as ci: claw-2/3/4/5/6/8/9 58 fonts; claw-1 50 (no DejaVu, so
 * `fc-match sans-serif` resolved to WenQuanYi Zen Hei there and to DejaVu Sans
 * everywhere else); claw-10, imaged from the profile, 8 (DejaVu only: no
 * Liberation, and `fc-match emoji` fell back to DejaVu Sans). Every font on
 * the claws had come from a hand-run `playwright install-deps` that nothing
 * declared.
 *
 * WHAT: {@link FONT_PACKAGES}, each with the reason it is carried. The set is
 * Playwright's own `install-deps` font list for Debian 13 (playwright-core
 * 1.62.1, `debian13-x64` tools) plus DejaVu, the one font family the measured
 * claws disagreed on beyond it. The same names are in both node profiles'
 * `toolchain.packages`, which is what images a new node; this entry is what
 * finds and repairs drift on a node already running.
 *
 * DETECT EXECUTES FONTCONFIG, not dpkg: `fc-list -q` exits 1 when no installed
 * font matches the family, which is what the browser would find. A package
 * installed with its font files deleted reads as missing.
 */

import { debInstalled } from './deb-installed.mjs';

/** Debian package -> the family `fc-list` must find, and why it is carried. */
export const FONT_PACKAGES = Object.freeze({
	'fonts-liberation': {
		family: 'Liberation Sans',
		why: 'metric-compatible with Arial, Times New Roman and Courier New; what a page asking for those gets',
	},
	'fonts-dejavu-core': {
		family: 'DejaVu Sans',
		why: 'the default sans-serif/serif/monospace; without it claw-1 resolved sans-serif to WenQuanYi Zen Hei',
	},
	'fonts-noto-color-emoji': {
		family: 'Noto Color Emoji',
		why: 'colour emoji; without it claw-10 matched emoji to DejaVu Sans',
	},
	'fonts-freefont-ttf': {
		family: 'FreeSans',
		why: 'Playwright install-deps: broad Latin/Greek/Cyrillic cover',
	},
	'fonts-ipafont-gothic': { family: 'IPAGothic', why: 'Playwright install-deps: Japanese' },
	'fonts-wqy-zenhei': { family: 'WenQuanYi Zen Hei', why: 'Playwright install-deps: Chinese' },
	'fonts-tlwg-loma-otf': { family: 'Loma', why: 'Playwright install-deps: Thai' },
	'fonts-unifont': {
		family: 'Unifont',
		why: 'Playwright install-deps: last-resort glyph for any BMP code point',
	},
	'xfonts-scalable': {
		family: 'Bitstream Charter',
		why: 'Playwright install-deps: scalable Type 1 fonts',
	},
});

/** What the repair installs: the fonts, and fontconfig, whose `fc-list` the detect runs. */
export const FONT_REPAIR_PACKAGES = Object.freeze(['fontconfig', ...Object.keys(FONT_PACKAGES)]);

export const FONT_REPAIRS = {
	fonts: {
		why:
			'every claw renders a browser page with the same fonts (Playwright’s Debian install-deps ' +
			'set plus DejaVu; FONT_PACKAGES in toolchain-fonts.mjs gives each one’s reason), so a ' +
			'layout assertion cannot pass on one claw and fail on another.',
		// OK, or the first family no installed font matches. No `exit`: a
		// consumer may splice this into a larger probe script.
		detect:
			'm=""; for f in ' +
			Object.values(FONT_PACKAGES)
				.map((f) => `"${f.family}"`)
				.join(' ') +
			'; do fc-list -q ":family=$f" || { m="$f"; break; }; done; ' +
			'if [ -z "$m" ]; then echo OK; else echo "no font for family $m"; fi',
		// Installs only what dpkg says is absent; a font package's own trigger
		// rebuilds the fontconfig cache.
		repair: [
			'set -e',
			'need=""',
			`for p in ${FONT_REPAIR_PACKAGES.join(' ')}; do`,
			`  ${debInstalled('"$p"')} || need="$need $p"`,
			'done',
			'[ -z "$need" ] && exit 0',
			'sudo -n apt-get update -qq',
			'# shellcheck disable=SC2086',
			'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need',
		].join('\n'),
	},
};
