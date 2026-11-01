import type { Command } from './cli-types.js';

export const commandsOnboarding: Record<string, Command> = {
	// IMAGE and CONVERT, the two onboarding phases before `provision` can pick a
	// node up. See the table in docs/VOCABULARY.md.
	//
	// `onboard` is the front door and the only one an operator should need to
	// remember: it asks for the device, the profile and the key, fetches and
	// checksums the installer, and hands the destructive part to `usb-prep`.
	// The two below it stay reachable because a half-finished stick is refreshed
	// with `usb-prep --skip-ventoy`, and because `node-bootstrap` runs ON the
	// node, where this CLI is not installed.
	onboard: {
		script: 'onboarding.sh',
		kind: 'onboarding',
		summary: 'guided: build the install stick for a new node (start here)',
	},
	'usb-prep': {
		script: 'node-usb-prep.sh',
		kind: 'onboarding',
		summary: 'build the Ventoy + CLAWKIT stick for a new node (interactive)',
	},
	'add-dvd': {
		script: 'add-dvd.sh',
		kind: 'onboarding',
		flags: [],
		summary: 'put a full Debian DVD on the stick for a node with no network during install',
	},
	'verify-stick': {
		script: 'verify-stick.sh',
		kind: 'onboarding',
		summary: 'read a built stick back and check it before you carry it anywhere',
	},
	refresh: {
		script: 'refresh-preseed.sh',
		kind: 'onboarding',
		flags: ['--reset'],
		summary:
			'bring a built stick up to date — payload and preseed, no erase (--reset re-asks wifi)',
	},
	telemetry: {
		script: 'read-telemetry.sh',
		kind: 'onboarding',
		summary: 'read what a failed install recorded onto the stick',
	},
	'net-survey': {
		script: 'net-survey.sh',
		kind: 'onboarding',
		summary: 'read the site network: devices, fleet reachability, per-node wifi',
	},
	convert: {
		script: 'convert.sh',
		kind: 'node-side',
		summary: 'repair then bootstrap, in one step (runs ON the node)',
	},
	'node-bootstrap': {
		script: 'node-bootstrap.sh',
		kind: 'node-side',
		summary: 'convert an installed OS into a fleet node (runs ON the node)',
	},
	'admin-fix': {
		script: 'fixes/claw-admin-fix.sh',
		kind: 'node-side',
		summary: 'recover admin access (runs from a USB stick)',
	},
	register: {
		script: 'register-fleet-runner.sh',
		kind: 'node-side',
		flags: [],
		summary: 'register one runner by hand (legacy system unit)',
	},
};
