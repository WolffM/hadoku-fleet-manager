/**
 * `fleet source` — another repo's SHIPPED files, from the command line.
 *
 *   fleet source list <owner/repo> [prefix] [--json]
 *   fleet source read <owner/repo> <path>  [--json]
 *
 * A door onto `lib/fleet-source.mjs` for consumers that cannot import it: a
 * stdlib-only Python script, a TypeScript job that would otherwise shell out to
 * an adapter of its own (hadoku_site#483). Same contract as the module: the
 * default branch, read from a mirror this fetches itself; an unreadable repo
 * exits 1 with the reason, and a path not in the tree is `text: null`, exit 1.
 *
 * Ends by setting `process.exitCode`, never `process.exit()`: a file read into a
 * pipe is routinely past the 8 KB a premature exit abandons (lib/emit.mjs).
 *
 * `--json` documents: `{ repo, sha, files }` for list, `{ repo, sha, path, text }`
 * for read, `{ repo, unreadable }` when the repo could not be read.
 */
import { createEmitter } from './lib/emit.mjs';
import { tryShipped } from './lib/fleet-source.mjs';

const emitter = createEmitter();
const args = process.argv.slice(2).filter((a) => a !== '--json');
const [verb, repo, arg] = args;

function usage() {
	const msg = 'usage: fleet source list <owner/repo> [prefix] | read <owner/repo> <path> [--json]';
	if (emitter.json) emitter.emit({ error: msg });
	else console.error(msg);
	return 2;
}

function main() {
	if (!repo || !['list', 'read'].includes(verb) || (verb === 'read' && !arg)) return usage();

	const source = tryShipped(repo);
	if ('unreadable' in source) {
		if (emitter.json) emitter.emit({ repo, unreadable: source.unreadable });
		else console.error(`✗ ${repo}: ${source.unreadable}`);
		return 1;
	}

	if (verb === 'list') {
		const files = source.list(arg ?? '');
		if (emitter.json) emitter.emit({ repo, sha: source.sha, files });
		else process.stdout.write(files.map((f) => f + '\n').join(''));
		return 0;
	}

	const text = source.read(arg);
	if (emitter.json) emitter.emit({ repo, sha: source.sha, path: arg, text });
	else if (text === null) console.error(`✗ ${repo}@${source.sha.slice(0, 12)}: no file ${arg}`);
	else process.stdout.write(text);
	return text === null ? 1 : 0;
}

process.exitCode = main();
