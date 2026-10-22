#!/usr/bin/env node
/**
 * Bump @wolffm/fleet-manager's version when this commit touches anything that
 * SHIPS, and re-stage package.json so the bump rides along in the same commit.
 *
 * Run by .husky/pre-commit, LAST — once the quality gates have passed, so a
 * commit that's about to be rejected never leaves a bumped package.json
 * behind. Mirrors @wolffm/task's scripts/version-bump.mjs, collapsed to one
 * package (fleet-manager ships as a single package, no workspace fan-out).
 *
 * The published surface checked here is EXACTLY what
 * .github/workflows/publish.yml's "Did the published surface change?" step
 * diffs: `package.json src scripts deploy`. The two must agree — that step's
 * own comment says there is no version-bump hook in this repo yet and, until
 * there is, its hard failure on a stale version IS the reminder. This script
 * is what makes that failure stop firing in the first place.
 *
 *   node scripts/version-bump.mjs                        # bump + re-stage
 *   node scripts/version-bump.mjs --dry-run              # print what it would do
 *   node scripts/version-bump.mjs --dry-run --files a b  # classify these paths
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// Mirrors publish.yml's `git diff --name-only ... -- package.json src scripts
// deploy` verbatim. Deliberately NOT matched: docs/, e2e/, .github/, manifests/,
// tsconfig*, *.md other than what `files` ships via README.md at the root —
// none of those change a published artifact, so they must not burn a version.
const SHIPS = /^(package\.json|src\/|scripts\/|deploy\/)/;

export function classify(files) {
	return files.some((f) => SHIPS.test(f));
}

/** Next patch, rolling over to the next minor at .20. Mirrors every sibling's bump_version(). */
export function nextVersion(version) {
	const [maj, min, pat] = version.split('.').map(Number);
	return pat === 20 ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** The version this package had at HEAD, or null when it's a fresh repo/file. */
function versionAtHead() {
	try {
		return JSON.parse(git('show', 'HEAD:package.json')).version;
	} catch {
		return null;
	}
}

function main() {
	const filesFlag = process.argv.indexOf('--files');
	const staged =
		filesFlag === -1
			? git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
			: process.argv.slice(filesFlag + 1);

	if (!classify(staged)) {
		console.log('📦 No publishable file changed — no version bump.');
		return;
	}

	const file = 'package.json';
	const json = JSON.parse(readFileSync(file, 'utf8'));
	const head = versionAtHead();

	// Already moved relative to HEAD — a hand-written bump, or a retry after a
	// commit the gates aborted (the tree kept the bump, HEAD never got it).
	if (head && head !== json.version) {
		console.log(`📦 @wolffm/fleet-manager: already ${head} -> ${json.version}, leaving it`);
		return;
	}

	const next = nextVersion(json.version);
	if (dryRun) {
		console.log(`📦 @wolffm/fleet-manager: would bump ${json.version} -> ${next}`);
		return;
	}

	// Patch the version string in place rather than re-stringifying the parsed
	// object — a JSON.stringify round-trip reindents the whole file, turning a
	// bump into a whole-file diff that format:check then rejects.
	const src = readFileSync(file, 'utf8');
	const patched = src.replace(/("version"\s*:\s*")[^"]*(")/, (m, a, b) => a + next + b);
	if (patched === src) {
		console.error(`version-bump: no version field to patch in ${file}`);
		process.exit(1);
	}
	writeFileSync(file, patched);
	git('add', file);
	console.log(`📦 @wolffm/fleet-manager: ${json.version} -> ${next}`);
}

// Importable so classify()/nextVersion() can be checked directly without
// touching the tree; only running it as a CLI writes anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
