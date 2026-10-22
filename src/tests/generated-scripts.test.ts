/**
 * The generated shell scripts must be COMPLETE, not merely strings.
 *
 * `reconcile-fleet-runners.mjs` builds its remote scripts as template literals
 * full of shell. An unescaped backtick inside one silently ends the literal and
 * everything after it is parsed as JavaScript. This has now happened twice, in
 * the same file, in two different functions:
 *
 *   registerScript  `... with ` > `, so registering ...`
 *                   -> a string COMPARISON. Returned `false`, so no runner could
 *                      be registered anywhere from 1f8bd588 (2026-08-28).
 *
 *   removeScript    `... # NOT ` || true`. Deregistering ...`
 *                   -> `truncated || (true`...`)`. `||` short-circuits on the
 *                      truthy first half, so it returned a script that stops the
 *                      systemd unit and then STOPS — never running
 *                      `config.sh remove` and never deleting the directory.
 *                      Introduced by c2950bab, the commit titled "a failed
 *                      deregistration reported success", in the comment
 *                      explaining that very fix.
 *
 * `runOn`'s type assertion catches the first shape and NOT the second: a
 * truncated script is still a string. Only its CONTENT gives it away. So these
 * assert the commands that must survive to the end of each script.
 *
 * hadoku_site's eslint does not lint `scripts/`, which is why
 * `no-constant-binary-expression` never reported the second one there.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
	fileURLToPath(new URL('../../scripts/reconcile-fleet-runners.mjs', import.meta.url)),
	'utf8'
);

/** Pull one generator out of the module and run it, without importing the CLI. */
function generate(fnName: string, args: Record<string, string>): unknown {
	const start = SRC.indexOf(`function ${fnName}`);
	assert.notEqual(start, -1, `${fnName} not found`);
	const end = SRC.indexOf('\n}', SRC.indexOf('return', start)) + 2;
	const body = SRC.slice(start, end);
	const make = new Function(
		'repoSuffix',
		'readFileSync',
		'TOOLCACHE_RULE',
		'MIN_FREE_GB_AFTER',
		'INSTALL_GB',
		`return ${body}`
	) as (...a: unknown[]) => (a: Record<string, string>) => unknown;
	return make(
		(r: string) => r.split('/').pop()!.toLowerCase(),
		() => '# toolcache rule',
		'toolcache',
		15,
		1
	)(args);
}

void test('registerScript returns a complete script, not a comparison', () => {
	const out = generate('registerScript', {
		repo: 'WolffM/x',
		claw: 'claw-1',
		version: '2.337.0',
		token: 'tok',
		labels: 'hadoku-builder',
	});
	assert.equal(typeof out, 'string', 'an unescaped backtick makes this a boolean');
	const s = out as string;
	assert.match(s, /\.\/config\.sh/, 'must actually configure the runner');
	assert.match(s, /systemctl --user enable --now/, 'must install the unit');
	assert.match(s, /is-active/, 'must reach its final verification line');
});

void test('removeScript deregisters from GitHub, not just locally', () => {
	const out = generate('removeScript', { repo: 'WolffM/x', token: 'tok' });
	assert.equal(typeof out, 'string');
	const s = out as string;
	// The load-bearing one. Without it the unit disappears locally while GitHub
	// keeps a registration it will SCHEDULE ONTO with nothing listening.
	assert.match(s, /config\.sh remove/, 'must deregister from GitHub');
	assert.match(s, /DEREGISTER_FAILED/, 'must report a failed deregistration');
	assert.match(s, /rm -rf/, 'must reclaim the ~835MB directory');
});

void test('no generator is truncated by an unescaped backtick', () => {
	// Every backtick inside these template literals must be escaped. An
	// unescaped one ends the literal, and what follows is parsed as JavaScript.
	for (const fn of ['registerScript', 'removeScript']) {
		const start = SRC.indexOf(`function ${fn}`);
		const end = SRC.indexOf('\n}', SRC.indexOf('return', start)) + 2;
		const body = SRC.slice(start, end);
		const inner = body.slice(body.indexOf('`') + 1, body.lastIndexOf('`'));
		const unescaped = [...inner.matchAll(/(?<!\\)`/g)];
		assert.equal(
			unescaped.length,
			0,
			`${fn}: ${unescaped.length} unescaped backtick(s) — each one ends the template ` +
				'literal and turns the rest of the script into JavaScript'
		);
	}
});

// --- the claw-1 teardown, 2026-09-01 ----------------------------------------
// removeScript knew about ONE systemd manager. claw-1's runners were installed
// with `sudo ./svc.sh install`, so the user-level disable matched nothing under
// `|| true`, `config.sh remove` refused, and the script deleted the directory
// anyway. 3 removed, 21 failed, 18 services left running on deleted working
// directories with 7 still `online`.

void test('a failed deregistration LEAVES the install, so a retry can work', () => {
	// The single most important line in this file. Deleting the directory here is
	// what turned 21 retryable failures into ones only the REST API could finish.
	const s = generate('removeScript', { repo: 'WolffM/x', token: 'tok' }) as string;
	const start = s.indexOf('if ! ./config.sh remove');
	assert.notEqual(start, -1, 'the deregister guard must still exist');
	const block = s.slice(start, s.indexOf('\nfi', start));
	assert.doesNotMatch(block, /rm -rf/, 'the directory must SURVIVE a failed deregistration');
	assert.match(block, /exit 6/, 'and it must still fail loudly');
});

void test('a SYSTEM-installed runner is torn down through svc.sh, not systemctl --user', () => {
	const s = generate('removeScript', { repo: 'WolffM/x', token: 'tok' }) as string;
	assert.match(s, /actions\.runner\.WolffM-x\./, 'must look for the system unit at all');
	assert.match(s, /svc\.sh stop/, 'only svc.sh can uninstall what svc.sh installed');
	assert.match(s, /svc\.sh uninstall/);
	assert.match(s, /NEEDS_ROOT/, 'and must say so rather than failing silently');
});

void test('sudo never prompts — the reconciler runs unattended on a cron', () => {
	// An interactive sudo hangs the ssh forever. `reconcile-fleet-runners.mjs`
	// exists to run without an operator present; a password prompt is an outage.
	const s = generate('removeScript', { repo: 'WolffM/x', token: 'tok' }) as string;
	// Only EXECUTABLE lines. A comment explaining why `-n` matters, and an `echo`
	// reporting that passwordless root is missing, both contain the word and
	// invoke nothing. A test that cannot tell those from a real invocation gets
	// weakened the first time it cries wolf, which is worse than not having it.
	const commands = s
		.split('\n')
		.filter((l) => {
			const t = l.trim();
			return t && !t.startsWith('#') && !t.startsWith('echo');
		})
		.join('\n');
	for (const m of commands.matchAll(/sudo(?! -n)\b/g)) {
		assert.fail(`bare sudo at offset ${m.index}: every sudo here must be \`sudo -n\``);
	}
	assert.match(commands, /sudo -n/, 'and it must actually use sudo for the system path');
});

void test('the system unit glob keeps the repo name GitHub used, not the slug', () => {
	// The directory is lowercased; the unit is not. `hadoku-printTool` installs
	// as actions.runner.WolffM-hadoku-printTool.claw-1.service while its
	// directory is actions-runner-hadoku-printtool. Matching on the slug finds
	// nothing, which is the shape of the original bug.
	const s = generate('removeScript', { repo: 'WolffM/hadoku-printTool', token: 't' }) as string;
	assert.match(s, /actions\.runner\.WolffM-hadoku-printTool\./);
	assert.match(s, /actions-runner-hadoku-printtool/, 'the DIRECTORY stays lowercased');
});
