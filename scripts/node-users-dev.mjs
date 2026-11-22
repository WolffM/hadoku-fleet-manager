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
 *   4. the lease (plan step 4): crossposter's `claude-lease`, copied from the
 *      controller like `claude`, and the node's own edge key
 *      (`<node>-sessions`, vault item `leaseKeyItem(node)`), written into the
 *      dev user's home over ssh stdin. The key comes from THIS process's
 *      environment, so run from the site checkout's root under its dev-vault:
 *      the site's `.devvault.json` declares the item and its identity is
 *      granted it (never this repo's: it is public and its key is its CI key). Then `claude-lease whoami` runs as dev: the identity must be
 *      the node's and a member of the edge list `crossposter-claude-code-lease`;
 *   5. GitHub (plan step 5): the node's fine-grained token (`ghTokenItem`),
 *      from the same environment, logs the dev user's gh in and becomes git's
 *      credential; git's name and email are copied from the controller. Then
 *      `gh api user` as dev must answer a login;
 *   6. the node-users facet, which must read the user back as ok.
 *
 * A session then starts on the node as `claude-lease exec -- claude`, so its
 * lease and the 429/401 outcome that benches an account both go as the
 * node's identity. No `--want` and no `--fallback-dir`: the pool's change
 * event exists only on the controller, and a claw has no login of its own.
 *
 * `--back` runs the other way round, node first, for the same reason. It
 * refuses while anything runs as the dev user: a live session is active work.
 * It removes the ACCOUNT and keeps the home directory.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import {
	DEV_CLAUDE_BIN,
	DEV_LEASE_BIN,
	ghTokenItem,
	hostsSessions,
	leaseIdentity,
	leaseKeyItem,
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
	ghCheckScript,
	ghLoginScript,
	leaseCheckScript,
	leaseKeyScript,
	manifestSaysDev,
	parseGhCheck,
	parseLeaseWhoami,
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

/**
 * crossposter's `claude-lease` as the controller's panes run it. It is not
 * linked onto PATH: `claude-as`, which is, calls it from its own directory.
 */
function controllerLease() {
	return join(dirname(controllerBin('claude-as')), 'claude-lease');
}

/** A command this controller runs, resolved through its links. Throws when there is none. */
function controllerBin(name) {
	const found = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
	return realpathSync(found);
}

function copyToDev(local, remote, manifest) {
	runRsync([
		'-e',
		'ssh -o BatchMode=yes -o ConnectTimeout=10',
		'--chmod=F755',
		local,
		`${sshDestination(NODE, 'dev', manifest)}:${remote}`,
	]);
}

/** Copy the controller's claude to the dev user, then log in as dev and run it. */
async function installClaude(dev, flipped) {
	const manifest = { machines: { [NODE]: flipped } };
	copyToDev(controllerBin('claude'), DEV_CLAUDE_BIN, manifest);
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

/**
 * Copy claude-lease, write the node's key when this environment holds it,
 * then ask `claude-lease whoami` as dev. `{ ok, lines }`: ok only when the
 * identity is the node's own and the edge admits it to the lease route.
 */
async function installLease(flipped) {
	const manifest = { machines: { [NODE]: flipped } };
	const lines = [];
	const source = controllerLease();
	copyToDev(source, DEV_LEASE_BIN, manifest);
	lines.push(`✓ lease  ${source} copied to ~/${DEV_LEASE_BIN}`);
	const item = leaseKeyItem(NODE);
	const key = process.env[item];
	if (key) {
		const wrote = await runOn(NODE, leaseKeyScript(key), {
			as: 'dev',
			manifest,
			timeoutMs: 60_000,
			connectTimeout: 10,
		});
		const mode = /^KEY-WRITTEN (\d+)$/m.exec(wrote.stdout ?? '')?.[1];
		if (mode !== '600')
			return {
				ok: false,
				lines: [
					...lines,
					`✗ lease  the key was not written: ${wrote.error ?? (mode ? `mode ${mode}` : 'no answer')}`,
				],
			};
		lines.push(`✓ lease  ${item} written, mode 600`);
	} else {
		lines.push(`· lease  ${item} is not in this environment; the key on ${NODE}, if any, is kept`);
	}
	const who = parseLeaseWhoami(
		(
			await runOn(NODE, leaseCheckScript(), {
				as: 'dev',
				manifest,
				timeoutMs: 60_000,
				connectTimeout: 10,
			})
		).stdout
	);
	const want = leaseIdentity(NODE);
	if (who.member === null)
		return {
			ok: false,
			lines: [...lines, `✗ lease  claude-lease could not say who the key is: ${who.why}`],
		};
	if (who.identity !== want)
		return {
			ok: false,
			lines: [
				...lines,
				`✗ lease  the key on ${NODE} is ${who.identity ?? 'no identity'}, not ${want}`,
			],
		};
	if (!who.member)
		return {
			ok: false,
			lines: [
				...lines,
				`✗ lease  ${want} is NOT on the edge list crossposter-claude-code-lease (Service grants)`,
			],
		};
	lines.push(
		`✓ lease  ${want} reaches the lease route; crossposter lists it under "Who may lease"`
	);
	return { ok: true, lines };
}

/** The controller's own git name and email, which a claw session commits as. */
function controllerGitIdentity() {
	const get = (k) => {
		const r = spawnSync('git', ['config', '--global', k], { encoding: 'utf8' });
		return r.status === 0 ? r.stdout.trim() : '';
	};
	return { name: get('user.name'), email: get('user.email') };
}

/**
 * Log the dev user's gh in when this environment holds the node's GitHub
 * token, then ask GitHub who it is as dev. `{ ok, lines }`.
 */
async function installGh(flipped) {
	const manifest = { machines: { [NODE]: flipped } };
	const as = { manifest, timeoutMs: 60_000, connectTimeout: 10 };
	const lines = [];
	const item = ghTokenItem(NODE);
	const token = process.env[item];
	if (token) {
		const identity = controllerGitIdentity();
		if (!identity.name || !identity.email)
			return {
				ok: false,
				lines: ['✗ github  this controller has no global git user.name/user.email to copy'],
			};
		const wrote = await runOn(NODE, ghLoginScript(token, identity), { as: 'dev', ...as });
		if (!/^GH-LOGIN \S+$/m.test(wrote.stdout ?? ''))
			return {
				ok: false,
				lines: [
					`✗ github  gh did not log in: ${wrote.error ?? (wrote.stderr.trim().split('\n').pop() || 'no answer')}`,
				],
			};
		lines.push(`✓ github  ${item} logged gh in; git uses it and commits as ${identity.name}`);
	} else {
		lines.push(
			`· github  ${item} is not in this environment; the login on ${NODE}, if any, is kept`
		);
	}
	const who = parseGhCheck((await runOn(NODE, ghCheckScript(), { as: 'dev', ...as })).stdout);
	if (!who.login)
		return { ok: false, lines: [...lines, `✗ github  gh as dev is not logged in: ${who.why}`] };
	lines.push(`✓ github  GitHub answers ${who.login} to the dev user's gh`);
	return { ok: true, lines };
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
		if (!BACK)
			log(
				process.env[leaseKeyItem(NODE)]
					? `   ✓ lease  claude-lease and ${leaseKeyItem(NODE)} would be written to ${dev}`
					: `   · lease  claude-lease would be copied; ${leaseKeyItem(NODE)} is not in this environment, so no key would be written`
			);
		if (!BACK)
			log(
				process.env[ghTokenItem(NODE)]
					? `   ✓ github  ${ghTokenItem(NODE)} would log in ${dev}'s gh and become git's credential`
					: `   · github  ${ghTokenItem(NODE)} is not in this environment, so gh would not be logged in`
			);
		log('\nDRY RUN. Nothing was changed. Re-run with --confirm.');
		return;
	}
	log('   done:');
	if (!BACK) await writeFlip(dev);

	let lease = null;
	let github = null;
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
		lease = await installLease(flipped);
		for (const l of lease.lines) log(`   ${l}`);
		github = await installGh(flipped);
		for (const l of github.lines) log(`   ${l}`);
	}

	if (BACK) await writeFlip(dev);

	log(`\n── node-users --machine ${NODE}`);
	const facet = spawnSync(process.execPath, [join(SCRIPTS, 'node-users.mjs'), '--machine', NODE], {
		stdio: 'inherit',
	});
	if (facet.status !== 0)
		die(`the node-users facet does not read ${NODE} as ok; see its findings above`);
	if (github && !github.ok)
		die(
			`${dev} cannot reach GitHub as ${ghTokenItem(NODE)} yet (above). ` +
				'docs/herdr.md "Sessions on a claw" says how to mint and grant it, and how to re-run this to deliver it.'
		);
	if (lease && !lease.ok)
		die(
			`${dev} is set up, but its sessions cannot lease as ${leaseIdentity(NODE)} yet (above). ` +
				`The operator mints ${leaseIdentity(NODE)} and grants ${leaseKeyItem(NODE)} first; ` +
				'docs/herdr.md "Sessions on a claw" has the commands, and how to re-run this to deliver the key.'
		);
	log(
		BACK
			? `\n✓ ${NODE}: no sessions; the account ${dev} is gone and its home is kept.`
			: `\n✓ ${NODE}: sessions run as ${dev}. From the controller: herdr machine add ${dev}@${NODE}`
	);
}

main().catch((err) => die(err instanceof Error ? err.stack : String(err)));
