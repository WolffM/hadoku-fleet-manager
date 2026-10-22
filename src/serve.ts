#!/usr/bin/env node
/**
 * Entrypoint for fleet-manager as its own service (PM2 `fleet-manager`).
 *
 * `FLEET_LOOPS=off` serves the API without starting the monitors. That exists
 * for the cutover and nothing else: the loops WRITE runner labels, and two
 * copies running at once — this service and mgmt-api's in-process one — would
 * be two writers on one label, the failure the fast loop's history is made of.
 * The service starts with loops off until the in-process copy is gone.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createFleetManager } from './index.js';
import { createFleetServer } from './server.js';
import { standaloneHost } from './standalone.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
	version: string;
};

const host = standaloneHost();
const manager = createFleetManager(host);
const port = Number(process.env.FLEET_PORT ?? 4010);
const loops = (process.env.FLEET_LOOPS ?? 'on') !== 'off';

createFleetServer(manager, { version }).listen(port, '127.0.0.1', () => {
	host.logger.info(
		`[fleet-manager] ${version} listening on 127.0.0.1:${port}; loops ${loops ? 'ON' : 'OFF'}`
	);
	if (loops) manager.start();
});
