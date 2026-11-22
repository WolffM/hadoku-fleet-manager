#!/usr/bin/env node
/**
 * fleet node-users --dev <node> — give one node a user for interactive sessions.
 *
 *   fleet node-users --dev claw-9                    # DRY RUN: inventory only
 *   fleet node-users --dev claw-9 --confirm
 *   fleet node-users --dev claw-9 --back --confirm   # undo it
 *
 * The `dev` role runs the operator's agent sessions (a Claude session under
 * herdr) on a claw, so that work leaves the controller. The concept is
 * `src/lib/node-users.ts`; the record is
 * `docs/planning/claw-sessions-2026-11-19.md`. Nothing of CI moves, so the
 * node is NOT drained. In order:
 *
 *   1. the manifest: `users.dev`, committed and pushed. FIRST, because an
 *      account no manifest entry claims is a blocking finding of the
 *      node-users facet, while a named user that does not exist yet is only
 *      advisory; and because a refused write then stops the run before the
 *      node is touched;
 *   2. the node part, as admin (lib/node-users-dev.mjs): the user, its key and
 *      linger, sshd's AllowUsers, the slice weight read back from the kernel;
 *   3. the controller's own `claude` binary, copied into the dev user's home,
 *      then this box logs in AS dev and runs it: a node that will refuse the
 *      operator's herdr stops here;
 *   4. the node-users facet, which must read the user back as ok.
 *
 * `--back` runs the other way round, node first, for the same reason. It
 * refuses while anything runs as the dev user: a live session is active work.
 * It removes the ACCOUNT and keeps the home directory.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
	DEV_CLAUDE_BIN,
	hostsSessions,
	nodeHome,
	nodeUser,
	setupDevUser,
} from '../dist/lib/node-users.js';
import { isBackstopNode } from '../dist/lib/node-role.js';
import { loadManifest, manifestPath, runOn, runRsync, sshDestination } from './lib/fleet-exec.mjs';
import { manifestEdit } from './lib/manifest-edit.mjs';
import { landingLine } from './lib/manifest-target.mjs';
import { controllerKeys, parseSteps } from './lib/node-users-cutover.mjs';
import {
	devBackScript,
	devInventoryScript,
	devSetupScript,
	flipDevManifest,
	manifestSaysDev,
} from './lib/node-users-dev.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--dev');
const NODE = at > -1 ? argv[at + 1] : undefined;
const CONFIRM = argv.includes('--confirm');
const BACK = argv.includes('--back');
const NO_PUSH = argv.includes('--no-push');
const MANIFEST = manifestPath();
const SCRIPTS = new URL('.', import.meta.url).pathname;
const WRITER = 'node-users';

const log = (...a) => console.log(...a);
function die(msg) {
	console.error(`node-users --dev: ${msg}`);
	process.exit(1);
}

function printSteps(parsed) {
	for (const s of parsed.steps)
		log(`   ${s.status === 'ok' ? '✓' : s.status === 'skip' ? '·' : '✗'} ${s.name}  ${s.detail}`);
}

/** The `claude` this controller runs, resolved through its links. Throws when there is none. */
function controllerClaude() {
	const found = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
	return realpathSync(found);
}

/** Copy the controller's claude to the dev user, then log in as dev and run it. */
async function installClaude(dev, flipped) {
	const manifest = { machines: { [NODE]: flipped } };
	runRsync([
		'-e',
		'ssh -o BatchMode=yes -o ConnectTimeout=10',
		'--chmod=F755',
		controllerClaude(),
		`${sshDestination(NODE, 'dev', manifest)}:${DEV_CLAUDE_BIN}`,
	]);
	const res = await runOn(
		NODE,
		`printf 'LOGIN %s\\n' "$USER"; printf 'CLAUDE %s\\n' "$("$HOME/${DEV_CLAUDE_BIN}" --version 2>&1 | head -1)"`,
		{ as: 'dev', manifest, timeoutMs: 60_000, connectTimeout: 10 }
	);
	const who = /^LOGIN (\S+)$/m.exec(res.stdout ?? '')?.[1];
	const version = /^CLAUDE (\d\S*.*)$/m.exec(res.stdout ?? '')?.[1];
	if (who !== dev)
		return {
			ok: false,
			detail: who
				? `logged in as ${who}, not ${dev}`
				: (res.error ?? (res.stderr.trim().split('\n').pop() || 'no answer')),
		};
	if (!version) return { ok: false, detail: `${dev} logged in, but claude did not run` };
	return { ok: true, detail: `the controller logs in as ${who}; claude ${version}` };
}

async function writeFlip(dev) {
	const result = await manifestEdit(
		(doc) => {
			if (manifestSaysDev(doc.machines?.[NODE], { dev, back: BACK })) return false;
			flipDevManifest(doc, NODE, { dev, back: BACK });
			return true;
		},
		{
			target: MANIFEST,
			writer: WRITER,
			reason: BACK ? `${NODE} hosts no sessions` : `${NODE} hosts sessions as ${dev}`,
			push: !NO_PUSH,
		}
	);
	if ('ok' in result && result.ok === false) die(`the manifest was not written: ${result.why}`);
	if (!result.changed) return log(`   · manifest  ${MANIFEST} already says so`);
	if (result.landed.ok) log(landingLine(result.landed, { writer: WRITER }));
	else die(`users.dev for ${NODE} is written but NOT landed: ${result.landed.why}`);
}

async function main() {
	if (!NODE || NODE.startsWith('-')) die('name the node: --dev <node>');
	const m = loadManifest(MANIFEST).machines?.[NODE];
	if (!m) die(`${NODE} is not in ${MANIFEST}`);
	if (isBackstopNode(m))
		die(`${NODE} is the controller: the operator's sessions already run there as themselves`);
	if (BACK && !hostsSessions(m)) die(`${NODE} names no users.dev: nothing to undo`);
	const dev = hostsSessions(m) ? nodeUser(m, 'dev') : setupDevUser(m);
	const flipped = { ...m, users: { ...(m.users ?? {}), dev } };
	const users = {
		admin: nodeUser(m, 'admin'),
		ci: nodeUser(m, 'ci'),
		dev,
		adminHome: nodeHome(m, 'admin'),
		devHome: nodeHome(flipped, 'dev'),
	};

	log(`── ${NODE}  ${BACK ? `UNDO: sessions as ${dev}` : `sessions will run as ${dev}`}`);
	const inv = await runOn(NODE, devInventoryScript(users), { as: 'admin', timeoutMs: 60_000 });
	const invSteps = parseSteps(inv.stdout, 'INVENTORY-END');
	// On --confirm the inventory is the plan this run is about to carry out,
	// read before anything changes; the lines after it are what was done.
	if (CONFIRM) log('   the plan, read before anything changed:');
	printSteps(invSteps);
	if (!invSteps.complete) die(`the inventory did not finish: ${inv.error ?? inv.stderr.trim()}`);
	if (!CONFIRM) {
		// writeFlip says the same of the manifest when it runs, so only here.
		log(
			manifestSaysDev(m, { dev, back: BACK })
				? `   · manifest  ${MANIFEST} already says so`
				: `   ✓ manifest  users.dev ${BACK ? 'would be removed from' : `= ${dev} would be written to`} ${MANIFEST}`
		);
		log('\nDRY RUN. Nothing was changed. Re-run with --confirm.');
		return;
	}
	log('   done:');
	if (!BACK) await writeFlip(dev);

	const script = BACK
		? devBackScript(users)
		: devSetupScript(users, { controllerKeys: controllerKeys() });
	const ran = await runOn(NODE, script, { as: 'admin', timeoutMs: 10 * 60_000 });
	const steps = parseSteps(ran.stdout, BACK ? 'BACK-END' : 'SETUP-END');
	printSteps(steps);
	if (!steps.complete)
		die(
			`the node step stopped: ${steps.steps.find((s) => s.status === 'fail')?.detail ?? ran.error ?? ran.stderr.trim().split('\n').pop()}.` +
				' Fix it and re-run --confirm; every step is idempotent.'
		);
	if (!BACK) {
		const claude = await installClaude(dev, flipped);
		log(`   ${claude.ok ? '✓' : '✗'} login  ${claude.detail}`);
		if (!claude.ok) die(`${dev} cannot be used from here yet. Fix it and re-run --confirm.`);
	}

	if (BACK) await writeFlip(dev);

	log(`\n── node-users --machine ${NODE}`);
	const facet = spawnSync(process.execPath, [join(SCRIPTS, 'node-users.mjs'), '--machine', NODE], {
		stdio: 'inherit',
	});
	if (facet.status !== 0)
		die(`the node-users facet does not read ${NODE} as ok; see its findings above`);
	log(
		BACK
			? `\n✓ ${NODE}: no sessions; the account ${dev} is gone and its home is kept.`
			: `\n✓ ${NODE}: sessions run as ${dev}. From the controller: herdr machine add ${dev}@${NODE}`
	);
}

main().catch((err) => die(err instanceof Error ? err.stack : String(err)));
