// Split by cost, exactly as hadoku_site does since 2026-08-20.
//
// The in-chain pass (`pnpm lint`, and CI's lint job) runs cheap syntactic rules
// only. The type-aware set runs ONLY when ESLINT_TYPE_AWARE=1 — the nightly
// vibeCheck, and `pnpm run lint:types` locally. A green `pnpm lint` is therefore
// NOT evidence that an async change is safe; run lint:types before pushing one.
//
// No `project:` array: `projectService` resolves each file's owning tsconfig, so
// adding a directory needs no eslint wiring. `allowDefaultProject` covers the
// loose root-level .js config files that no tsconfig includes.
import process from 'node:process';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const TYPE_AWARE = process.env.ESLINT_TYPE_AWARE === '1';

export default tseslint.config(
	// `.claude/worktrees/**` is NOT optional. git skips a registered worktree in
	// `status`, so an agent worktree is invisible to git and fully visible here —
	// eslint linted 172 files out of a stale second copy on 2026-08-30, and the
	// type-aware pass reported 513 problems, every one of them from that copy
	// (its `src/tests/**` does not match the ignores below, so the test exemption
	// evaporates). The gate has to see THIS branch and nothing else.
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'manifests/**',
			'.claude/worktrees/**',
			'archive/**',
			'docs/handoff/**',
			'docs/planning/**',
			'**/__pycache__/**',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...(TYPE_AWARE
		? [
				// TYPESCRIPT SOURCE ONLY. The type-aware rules are tuned for typed
				// production code and misfire wholesale elsewhere: on plain .mjs under
				// scripts/ every value is `any`, so no-unsafe-* fires on essentially
				// every line while saying nothing. Those scripts stay in the CHEAP
				// pass, which is where the value is — it caught the truncated
				// removeScript (no-constant-binary-expression) that hadoku_site's
				// linter never saw, because it does not lint scripts/ at all.
				// misfire wholesale on test doubles: 59 `require-await` on fakes that
				// must be async to satisfy an interface, 17 `prefer-includes` on
				// deliberate index checks. Measured across the moved suites: 82
				// findings in tests, ZERO in src/. Tests stay in the CHEAP pass, which
				// is the one that earns its keep there — it found two dead imports in
				// dispatch-pass.test.ts that upstream never saw, because hadoku_site
				// excludes tests from eslint entirely.
				{
					...tseslint.configs.recommendedTypeChecked[0],
					ignores: ['src/tests/**', 'scripts/**', 'herdr/**', 'docs/planning/**'],
				},
				...tseslint.configs.recommendedTypeChecked.slice(1).map((c) => ({
					...c,
					ignores: ['src/tests/**', 'scripts/**', 'herdr/**', 'docs/planning/**'],
				})),
				...tseslint.configs.stylisticTypeChecked.map((c) => ({
					...c,
					ignores: ['src/tests/**', 'scripts/**', 'herdr/**', 'docs/planning/**'],
				})),
				{
					ignores: ['src/tests/**', 'scripts/**', 'herdr/**', 'docs/planning/**'],
					languageOptions: {
						parserOptions: {
							projectService: {
								// `docs/planning/*.mjs` is here for the same reason as
								// `scripts/*.mjs`: a committed, runnable analysis script that
								// no tsconfig owns. wave3m-measure.mjs is the reproduction
								// tool the 3m results cite, so it has to stay runnable AND
								// stay linted — ignoring `docs/planning/**` would have made
								// the error go away by removing the coverage, which is the
								// wrong half to give up.
								allowDefaultProject: ['*.js', 'scripts/*.mjs', 'docs/planning/*.mjs'],
							},
							tsconfigRootDir: import.meta.dirname,
						},
					},
					rules: {
						// Matches hadoku_site's type-aware block. This code passed that
						// gate before the move; adopting a different ruleset in the same
						// pass would mix a style churn into a mechanical extraction, and
						// every finding below is a preference, not a defect.
						'@typescript-eslint/no-floating-promises': 'error',
						'@typescript-eslint/no-misused-promises': 'error',
						'@typescript-eslint/await-thenable': 'error',
						'@typescript-eslint/no-unnecessary-condition': 'off',
						'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
						'@typescript-eslint/prefer-nullish-coalescing': 'off',
						'@typescript-eslint/prefer-optional-chain': 'off',
						'@typescript-eslint/consistent-type-definitions': 'off',
						'@typescript-eslint/non-nullable-type-assertion-style': 'off',
						'@typescript-eslint/no-non-null-assertion': 'off',
					},
				},
			]
		: []),
	{
		rules: {
			// A fleet checker that swallows an error reports a healthy fleet it
			// never looked at. See docs/operations/SELF_HOSTED_RUNNERS.md.
			'no-empty': ['error', { allowEmptyCatch: false }],
			// Deliberately NOT enabled for .ts — hadoku_site reached the same
			// conclusion. TypeScript already reports the real bug (TS2448,
			// "Block-scoped variable used before its declaration") and correctly
			// stays quiet about the benign shape eslint cannot distinguish: a
			// module-scope const referenced inside a function DEFINED above it,
			// which is fine because the function runs after module init.
			// fleet-loop.ts has exactly that shape three times.
			'no-use-before-define': 'off',
			// `varsIgnorePattern` is `^_$` — a BARE underscore — not `^_`.
			//
			// `^_` silently exempted `__dirname`, which is not an "intentionally
			// unused" marker at all: it is the CommonJS shim idiom, and five copies of
			// `const __dirname = dirname(fileURLToPath(import.meta.url))` outlived the
			// move to `lib/paths.mjs` that removed every use of them — fleet-roster,
			// check-header-fleet, check-identity-model, check-mf-externals and
			// check-tier-fleet. A rule that exempts a name that common is not a rule.
			//
			// Measured 2026-08-30, before deleting them: tightening to `^_$` cost
			// exactly those five errors across src/ and scripts/ and nothing else.
			// There is no `_foo`-means-deliberately-unused convention here to break.
			//
			// `argsIgnorePattern` stays `^_`: `_req` in an express handler is a real
			// convention, and a parameter cannot be deleted without moving every one
			// after it.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_$' },
			],
		},
	},
	{
		// Everything here runs on Node — the library, the CLI, and the gates.
		languageOptions: { globals: { ...globals.node } },
	},
	{
		files: ['src/tests/**'],
		rules: {
			// `test()` from node:test returns a promise the runner awaits itself, so
			// every call reads as floating. hadoku_site sidesteps this by excluding
			// tests from eslint entirely; that is a guard hole (it is how two dead
			// imports survived in dispatch-pass.test.ts). Disabling the ONE rule that
			// misfires keeps the rest of the type-aware set pointed at test code.
			'@typescript-eslint/no-floating-promises': 'off',
			// A no-op stub IS the assertion here: the FleetHost fake exists to prove
			// the contract needs nothing from its host at construction time. This is
			// NOT the empty-catch rule above, which stays on everywhere — swallowing
			// an error and declining to do work are different things.
			'@typescript-eslint/no-empty-function': 'off',
		},
	}
);
