import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	REPAIRS,
	applicableRepairs,
	isVersionManaged,
	repairNeedsRoot,
} from './toolchain-floor.mjs';

/**
 * #34: the backstop keeps its own yt-dlp and deno current in ~/.local/bin, with
 * no sudo, through the same release feeds and extraction gate as a services
 * host. A claw and a services host never get the user copies.
 */
test('#34: yt-dlp-user and deno-user apply to the backstop only, need no root, and gate on one extraction', () => {
	const ids = (node) => applicableRepairs(node).map(([id]) => id);
	for (const id of ['yt-dlp-user', 'deno-user']) {
		assert.ok(ids({ role: 'backstop' }).includes(id), `${id} on the backstop`);
		assert.ok(!ids({ role: 'claw' }).includes(id), `${id} not on a claw`);
		assert.ok(!ids({ role: 'claw', services: 'pm2' }).includes(id), `${id} not on a services host`);
		assert.equal(repairNeedsRoot(id), false, `${id} installs without sudo`);
		assert.ok(isVersionManaged(REPAIRS[id]), `${id} follows its releases`);
		assert.match(REPAIRS[id].repair, /\$HOME\/\.local\/bin/, `${id} installs into ~/.local/bin`);
		assert.match(REPAIRS[id].repair, /ytsearch1:test/, `${id} proves one real extraction first`);
	}
	assert.ok(!ids({ role: 'backstop' }).includes('yt-dlp'), 'the system copy is a services host’s');
	assert.equal(repairNeedsRoot('yt-dlp'), true);
	assert.equal(
		REPAIRS['yt-dlp-user'].minAge,
		REPAIRS['yt-dlp'].minAge,
		'one day, as the services hosts'
	);
});
