/**
 * The host ports for fleet-manager running as its OWN SERVICE.
 *
 * Until 2026-09-21 the only host was mgmt-api, which built these ports from its
 * own logger, Discord sink and job sink and ran this package in its process.
 * The fleet is now a separate service (fleet-manager
 * docs/planning/leave-hadoku-site-2026-09-21.md), so it provides the same ports
 * itself, against the same endpoints and with its own identity:
 *
 *   logger      @wolffm/logger's server logger, service `fleet-manager`; warn+
 *               events ship to monitoring-api telemetry, as mgmt-api's do.
 *   alerts      the Discord webhook, with every alert mirrored into the ledger
 *               as `event=alert.fleet.<source>` — ledger readers match
 *               `event=alert.*`, so nothing downstream keys on the host's name.
 *               An undelivered alert is recorded to unsent-alerts.
 *   jobs        @wolffm/logger's execution-log client — the one client every
 *               monitoring-api job post goes through.
 *
 * Every credential and address comes from the environment the PM2 vault
 * wrapper builds — this is a published library, so it bakes in no hostname.
 * `FLEET_MANIFEST_DIR` and `HADOKU_STATE_DIR` are REQUIRED and THROW when unset:
 * they are the variables the CLI reads too, so the service and an operator's
 * `fleet ...` agree only if both are told the same place — and the CLI's
 * fallback derives the path from a sibling hadoku_site checkout, which is the
 * coupling this service exists to end. A missing credential or address, by
 * contrast, DEGRADES rather than throws: an alert with no webhook is logged
 * and recorded, a job record with no key is logged. A fleet monitor that refused
 * to start over a reporting credential would stop the fleet to report it.
 */
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createServerLogger } from '@wolffm/logger/server';
import { createJobReporter, generateRunId } from '@wolffm/logger/jobs';
import type { TelemetryEvent, TelemetrySink } from '@wolffm/logger';

import type { FleetHost, PostDiscordResult } from './host.js';

/** The package root: `dist/standalone.js` -> `..`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBHOOK_TIMEOUT_MS = 10_000;
const SINK_TIMEOUT_MS = 10_000;
/** Discord rejects `content` over 2,000 characters. */
const DISCORD_LIMIT = 1_900;

type Env = Record<string, string | undefined>;

/** Split on line boundaries so no single post exceeds Discord's limit. */
export function chunkForDiscord(content: string, limit = DISCORD_LIMIT): string[] {
	const out: string[] = [];
	let cur = '';
	const flush = () => {
		if (cur) out.push(cur);
		cur = '';
	};
	for (const line of content.split('\n')) {
		if (line.length > limit) {
			// A single line longer than the limit is cut, not dropped.
			flush();
			for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
			continue;
		}
		const next = cur ? `${cur}\n${line}` : line;
		if (next.length > limit) {
			flush();
			cur = line;
		} else cur = next;
	}
	flush();
	return out.length ? out : [content];
}

export function standaloneHost(env: Env = process.env): FleetHost {
	const required = (name: string): string => {
		const v = (env[name] ?? '').trim();
		if (!v) throw new Error(`fleet-manager service: ${name} is required and unset`);
		return v;
	};
	const manifestDir = required('FLEET_MANIFEST_DIR');
	const stateDir = required('HADOKU_STATE_DIR');
	const monitoringBase = (env.MONITORING_API_BASE ?? '').trim().replace(/\/$/, '');
	// Reporting needs both an address and an identity; without either it degrades.
	const serviceKey = (): string => (monitoringBase ? (env.FLEET_SERVICE_KEY ?? '').trim() : '');

	const sink: TelemetrySink = {
		push(event: TelemetryEvent): void {
			if (event.level !== 'warn' && event.level !== 'error') return;
			const key = serviceKey();
			if (!key) return;
			void fetch(`${monitoringBase}/api/telemetry`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-User-Key': key },
				body: JSON.stringify(event),
			}).catch(() => {
				// Telemetry is best-effort by contract; the line is already in PM2's log.
			});
		},
	};
	const log = createServerLogger({ service: 'fleet-manager', telemetrySink: sink });

	async function recordUnsent(content: string, source: string, lastError: string) {
		const key = serviceKey();
		if (!key) {
			log.error(
				`[alerts:${source}] cannot record unsent alert — FLEET_SERVICE_KEY or MONITORING_API_BASE is unset`
			);
			return false;
		}
		try {
			const resp = await fetch(`${monitoringBase}/api/unsent-alerts/record`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-User-Key': key },
				body: JSON.stringify({
					source: `fleet:${source}`,
					payload: content,
					last_error: lastError,
				}),
				signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
			});
			if (!resp.ok) log.error(`[alerts:${source}] unsent-alerts sink returned HTTP ${resp.status}`);
			return resp.ok;
		} catch (err) {
			log.error(
				`[alerts:${source}] unsent-alerts sink failed: ${err instanceof Error ? err.message : String(err)}`
			);
			return false;
		}
	}

	return {
		logger: {
			info: (m) => log.info(m),
			warn: (m) => log.warn(m),
			error: (m) => log.error(m),
		},
		alerts: {
			async post(content: string, source: string): Promise<PostDiscordResult> {
				const url = (env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK ?? '').trim();
				let lastError: string | null = url ? null : 'DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK unset';
				if (url) {
					for (const part of chunkForDiscord(content)) {
						try {
							const resp = await fetch(url, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ content: part }),
								signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
							});
							if (!resp.ok) lastError = `HTTP ${resp.status}`;
						} catch (err) {
							lastError = err instanceof Error ? err.message : String(err);
						}
						if (lastError) break;
					}
				}
				log.warn(`event=alert.fleet.${source} ${content.split('\n')[0].slice(0, 200)}`, {
					channel: 'discord',
					alertSource: source,
					delivered: !lastError,
				});
				if (!lastError) return { posted: true, sinkRecorded: false };
				log.error(`[alerts:${source}] webhook post failed: ${lastError}`);
				return {
					posted: false,
					sinkRecorded: await recordUnsent(content, source, lastError),
					lastError,
				};
			},
			recordQuietly(content: string, source: string): void {
				log.warn(`event=alert.fleet.${source} ${content.split('\n')[0].slice(0, 200)}`, {
					channel: 'ledger',
					alertSource: source,
					delivered: true,
					quiet: true,
				});
			},
		},
		jobs: {
			async recordJobResult(jobName, jobState, durationMs, opts) {
				const key = serviceKey();
				if (!key) {
					log.error(
						`[jobs] ${jobName} not recorded — FLEET_SERVICE_KEY or MONITORING_API_BASE is unset`
					);
					return;
				}
				const reporter = createJobReporter({
					url: `${monitoringBase}/api/jobs`,
					userKey: key,
					onError: (err) =>
						log.error(
							`[jobs] failed to record ${jobName}: ${err instanceof Error ? err.message : String(err)}`
						),
				});
				await reporter.finish(generateRunId('fleet'), jobName, jobState, {
					durationMs,
					error: opts?.error,
					cron: opts?.cron,
					metadata: opts?.data,
				});
			},
		},
		githubToken: () => (env.FLEET_GITHUB_TOKEN ?? '').trim() || undefined,
		manifestDir,
		stateDir,
		storeDoctorPath: env.FLEET_STORE_DOCTOR ?? join(ROOT, 'scripts', 'pnpm-store-doctor.sh'),
	};
}
