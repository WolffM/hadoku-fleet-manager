#!/usr/bin/env node
/**
 * fleet node-users --cutover <node> — move one node's CI off the admin user.
 *
 *   fleet node-users --cutover claw-5                     # DRY RUN: inventory only
 *   fleet node-users --cutover claw-5 --confirm [--docker]
 *   fleet node-users --cutover claw-5 --back --confirm    # roll it back
 *
 * The node must be DRAINED first (`fleet drain claw-5 --reason ...`) and idle;
 * the node script refuses a running job itself. In order:
 *
 *   1. the node part, as admin (lib/node-users-cutover.mjs): the ci user, its
 *      restricted key and linger, sshd's AllowUsers, admin's CI stopped, the
 *      trees moved and chowned, links and text re-pointed; then this box
 *      logs in as ci, so a node that will refuse the fleet stops here;
 *   2. the manifest: `users.ci` (and `containers: "docker"` with --docker, the
 *      operator's rootless-docker claws), committed and pushed to main;
 *   3. everything that now has to run AS ci, through the fleet's own commands:
 *      the runners slice, the throttle hook and harvester, the toolchain
 *      (installs rootless docker where declared), bootcamp's re-prove;
 *   4. the node-users facet, which must read `ok`.
 *
 * It never UNDRAINS. When every step is green it says so, and whether the
 * deployed fleet (mgmt-api's manifest) has the flip yet; the operator undrains.
 * A failed step stops the run and prints the `--back` command. Every step is
 * idempotent, so re-running `--confirm` finishes a run that stopped.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { ciIsSeparate, cutoverCiUser, nodeHome, nodeUser } from '../dist/lib/node-users.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { readDrains } from './lib/expected-down.mjs';
import { runOn } from './lib/fleet-exec.mjs';
import {
	deploySiteRoot,
	landWrite,
	landingLine,
	refusalLine,
	writeTarget,
} from './lib/manifest-target.mjs';
import {
	backScript,
	cutoverScript,
	flipManifest,
	inventoryScript,
	manifestSays,
	parseSteps,
} from './lib/node-users-cutover.mjs';
import { manifest } from './lib/paths.mjs';
import { renderJson } from './lib/prettier-json.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--cutover');
const NODE = at > -1 ? argv[at + 1] : undefined;
const CONFIRM = argv.includes('--confirm');
const BACK = argv.includes('--back');
const DOCKER = argv.includes('--docker');
const NO_PUSH = argv.includes('--no-push');
const MANIFEST = manifest('fleet-runner-manifest.json');
const SCRIPTS = new URL('.', import.meta.url).pathname;

const log = (...a) => console.log(...a);
function die(msg) {
	console.error(`node-users --cutover: ${msg}`);
	process.exit(1);
}

/** The controller's public keys, `type base64` each: the ones its ssh offers. */
function controllerKeys() {
	const dir = join(homedir(), '.ssh');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith('.pub'))
		.map((f) => readFileSync(join(dir, f), 'utf8').trim().split(/\s+/).slice(0, 2).join(' '));
}

function printSteps(parsed) {
	for (const s of parsed.steps)
		log(`   ${s.status === 'ok' ? '✓' : s.status === 'skip' ? '·' : '✗'} ${s.name}  ${s.detail}`);
}

/** One fleet subcommand, by its script, output passed through. */
function fleet(script, args) {
	log(`\n── ${script.replace(/\.mjs$/, '')} ${args.join(' ')}`);
	const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { stdio: 'inherit' });
	return r.status === 0;
}

/** Write the manifest flip, read it back, and land it on main. */
async function writeFlip(doc, users) {
	copyFileSync(MANIFEST, `${MANIFEST}.bak`);
	flipManifest(doc, NODE, { ci: users.ci, docker: DOCKER, back: BACK });
	const rendered = await renderJson(doc, MANIFEST);
	writeFileSync(MANIFEST, rendered.text);
	let verify;
	try {
		verify = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	} catch (err) {
		copyFileSync(`${MANIFEST}.bak`, MANIFEST);
		die(`the manifest did not parse after writing (${err.message}); restored from .bak`);
	}
	if (!manifestSays(verify.machines[NODE], { docker: DOCKER, back: BACK })) {
		copyFileSync(`${MANIFEST}.bak`, MANIFEST);
		die(`${NODE}'s flip did not land in the manifest; restored from .bak`);
	}
	const landed = landWrite(MANIFEST, {
		writer: 'node-users',
		summary: BACK ? `${NODE} CI back on admin` : `${NODE} CI runs as ${users.ci}`,
		push: !NO_PUSH,
	});
	if (landed.ok) log(landingLine(landed, { writer: 'node-users' }));
	else log(`! the flip for ${NODE} is NOT on main: ${landed.why}`);
	return landed.ok;
}

/**
 * Log in to the node as the ci role, the way every fleet command will, and
 * read back the user sshd gave the session. `flipped` is the node's
 * entry as the manifest WILL say it: before the flip lands, the manifest on
 * disk still answers ci with admin.
 */
async function ciLogin(ci, flipped) {
	const res = await runOn(NODE, 'printf "LOGIN %s\\n" "$USER"', {
		as: 'ci',
		manifest: { machines: { [NODE]: flipped } },
		timeoutMs: 30_000,
		connectTimeout: 10,
	});
	const who = /^LOGIN (\S+)$/m.exec(res.stdout ?? '')?.[1];
	if (who === ci) return { ok: true, detail: `the controller logs in as ${who}` };
	const why = res.error ?? (res.stderr.trim().split('\n').pop() || 'no answer');
	return { ok: false, detail: who ? `logged in as ${who}, not ${ci}` : why };
}

/** Does the DEPLOYED manifest (what mgmt-api mints from) agree with the flip yet? */
function deployedAgrees(ci) {
	const p = join(deploySiteRoot(), 'scripts', 'admin', 'fleet-runner-manifest.json');
	try {
		const m = JSON.parse(readFileSync(p, 'utf8')).machines?.[NODE];
		return BACK ? !ciIsSeparate(m) : nodeUser(m, 'ci') === ci;
	} catch {
		return null;
	}
}

async function main() {
	if (!NODE || NODE.startsWith('-')) die('name the node: --cutover <node>');
	const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const m = doc.machines?.[NODE];
	if (!m) die(`${NODE} is not in ${MANIFEST}`);
	if (isGuestNode(m)) die(`${NODE} is a guest: the fleet does not provision its users`);
	if (BACK && !ciIsSeparate(m)) die(`${NODE} is not cut over (no users.ci): nothing to roll back`);
	const ci = ciIsSeparate(m) ? nodeUser(m, 'ci') : cutoverCiUser(m);
	const flipped = { ...m, users: { ...(m.users ?? {}), ci } };
	const users = {
		admin: nodeUser(m, 'admin'),
		ci,
		adminHome: nodeHome(m, 'admin'),
		ciHome: nodeHome(flipped, 'ci'),
	};

	log(
		`── ${NODE}  ${BACK ? 'ROLLBACK' : 'cutover'}: CI ${BACK ? `${ci} -> ${users.admin}` : `${users.admin} -> ${ci}`}`
	);
	const inv = await runOn(NODE, inventoryScript(users), { as: 'admin', timeoutMs: 600_000 });
	const invSteps = parseSteps(inv.stdout, 'INVENTORY-END');
	printSteps(invSteps);
	if (!invSteps.complete) die(`the inventory did not finish: ${inv.error ?? inv.stderr.trim()}`);
	const target = writeTarget(MANIFEST);
	const alreadyFlipped = manifestSays(m, { docker: DOCKER, back: BACK });
	log(
		alreadyFlipped
			? `   · manifest  ${MANIFEST} already says so`
			: target.ok
				? `   ✓ manifest  the flip lands in ${MANIFEST}`
				: `   ✗ manifest  ${refusalLine(target, { writer: 'node-users', file: MANIFEST })}`
	);
	if (!CONFIRM) {
		log('\nDRY RUN. Nothing was changed. Drain the node, then re-run with --confirm.');
		return;
	}

	if (!readDrains()[NODE])
		die(`${NODE} is not drained. \`fleet drain ${NODE} --reason "node-users cutover"\` first.`);
	if (!target.ok && !alreadyFlipped)
		die(refusalLine(target, { writer: 'node-users', file: MANIFEST }));

	// 1. The node.
	log(
		`\n── node: ${BACK ? 'moving CI back to admin' : `moving CI to ${ci}`} (chown of the moved trees takes minutes)`
	);
	const script = BACK
		? backScript(users)
		: cutoverScript(users, { controllerKeys: controllerKeys() });
	const ran = await runOn(NODE, script, { as: 'admin', timeoutMs: 90 * 60_000 });
	const steps = parseSteps(ran.stdout, BACK ? 'BACK-END' : 'CUTOVER-END');
	printSteps(steps);
	if (!steps.complete) {
		die(
			`the node step stopped: ${steps.steps.find((s) => s.status === 'fail')?.detail ?? ran.error ?? ran.stderr.trim().split('\n').pop()}.` +
				' Fix it and re-run --confirm; every step is idempotent.'
		);
	}

	// 1b. Log in as ci from here, the way every fleet command will. The node
	// step's own checks read sshd's config; this reads sshd's ANSWER, which is
	// what claw-5 got wrong on 2026-10-28 with every node step green.
	if (!BACK) {
		const login = await ciLogin(ci, flipped);
		log(`   ${login.ok ? '✓' : '✗'} login  ${login.detail}`);
		if (!login.ok) die(`the controller cannot log in as ${ci}. Fix it and re-run --confirm.`);
	}

	// 2. The manifest.
	if (!alreadyFlipped && !(await writeFlip(doc, users)))
		die('the manifest flip did not land; re-run --confirm');

	// 3. Redeploy as the role that now runs CI, and re-prove.
	const machine = ['--machine', NODE];
	const chain = [
		['deploy-runners-slice.mjs', [...machine, '--confirm']],
		['deploy-ci-throttle.mjs', [...machine, '--confirm']],
		['converge-toolchain.mjs', [...machine, '--write']],
		['bootcamp.mjs', [...machine, '--write']],
		['node-users.mjs', machine],
	];
	for (const [s, a] of chain) {
		if (!fleet(s, a)) {
			die(
				`${s} failed. The node stays drained. Fix and re-run \`fleet node-users --cutover ${NODE} --confirm\`` +
					(BACK ? '.' : `, or roll back: \`fleet node-users --cutover ${NODE} --back --confirm\`.`)
			);
		}
	}

	const live = deployedAgrees(ci);
	log(
		`\n✓ ${NODE}: CI runs as ${BACK ? users.admin : ci}, every label re-proved, the facet reads ok.`
	);
	log(
		live
			? `  The deployed manifest agrees. Undrain: fleet drain ${NODE} --undo`
			: `  The deployed manifest does NOT have the flip yet${live === null ? ' (unreadable)' : ''}: wait for mgmt-api's redeploy before \`fleet drain ${NODE} --undo\`, or its next mint ssh's as the wrong user.`
	);
}

main().catch((err) => die(err instanceof Error ? err.stack : String(err)));
