/**
 * hadoku.sessions.find — open the picker popup, seeded with the terminal
 * selection when there is one. An action has no terminal of its own, so it
 * asks herdr to open the `picker` pane instead of drawing anything.
 */

import { execFileSync } from 'node:child_process';

const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
let ctx = {};
try {
	ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
} catch (err) {
	console.error(
		`hadoku.sessions.find: unreadable plugin context, opening unseeded: ${err.message}`
	);
}
const seed = String(ctx.selected_text ?? '')
	.replace(/\s+/g, ' ')
	.trim()
	.slice(0, 200);
const argv = ['plugin', 'pane', 'open', '--plugin', 'hadoku.sessions', '--entrypoint', 'picker'];
if (seed) argv.push('--env', `FIND_SEED=${seed}`);
execFileSync(herdr, argv, { stdio: 'inherit' });
