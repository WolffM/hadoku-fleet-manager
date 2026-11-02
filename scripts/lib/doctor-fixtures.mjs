/**
 * Shared fixtures for the doctor-*.test.mjs files: real, verbatim probe
 * captures from the fleet (claw-1/5/7/9, hokon, and the smaller failed-unit /
 * pm2 captures), plus the helpers that turn one into a `$health` facet.
 *
 * EVERY FIXTURE BELOW IS A VERBATIM CAPTURE from the real fleet, taken by the
 * probe in `doctor-probe.mjs` and pasted here unedited. That is deliberate and
 * it is the whole reason the files that import these can be trusted: four of
 * the bugs this lane fixed were invisible to a synthetic fixture and obvious
 * against a real node — the RAW_VALUE column (claw-1's 19,727-hour drive read
 * as 55 hours), the unlabelled `k10temp` (claw-5 reported as having no sensor
 * at all), the `exit 0` at the end of `WIFI_MANAGER_PROBE` (every node
 * truncated before DOCTOR-END), and `idle.throttleCount` parsed as a
 * 2,022,029 milli-degree sensor. A fixture written from intention would have
 * passed through all four.
 */
import { parseDoctor } from './doctor-parse.mjs';
import { healthFacet } from './doctor-facet.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES — captured from the fleet, 2026-09-10
// ═══════════════════════════════════════════════════════════════════════════

/** claw-1, an Intel MSI GE70 on a 19,727-hour HGST spinner. 61 → 97 °C. */
export const CLAW1 = `DOCTOR-BEGIN v1
D schema 1
D hostname claw-1
D product GE70 2PE
D kernel 6.12.73+deb13-amd64
D startedAt 2026-09-10T17:06:50Z
D uptimeSec 234235
D cores 8
D load1 0.39
D rootElevation yes
D idle.zone.0.acpitz 27800
D idle.zone.1.acpitz 29800
D idle.zone.2.acpitz 61000
D idle.zone.3.x86_pkg_temp 61000
D idle.hwmon.3.coretemp.Package_id_0 61000
D idle.hwmon.3.coretemp.Core_0 55000
D idle.throttleCount 2022029
D watchdog.active active
D watchdog.enabled enabled
D watchdog.keepalive inactive
D watchdog.loadTrigger none
D watchdog.sensorPath /sys/class/thermal/thermal_zone3/temp
D watchdog.sensorMilliC 62000
D crashes 8
D disk.root.fs ext4
D disk.root.totalKb 947014624
D disk.root.availKb 847505116
D disk.root.usePct 6
D mem.totalKb 12170524
D mem.availKb 10379008
D disk.root.device sda
D smart.device sda
S smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.73+deb13-amd64] (local build)
S === START OF READ SMART DATA SECTION ===
S SMART overall-health self-assessment test result: PASSED
S ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S   5 Reallocated_Sector_Ct   0x0033   100   100   005    Pre-fail  Always       -       0
S   9 Power_On_Hours          0x0012   055   055   000    Old_age   Always       -       19727
S 194 Temperature_Celsius     0x0002   153   153   000    Old_age   Always       -       39 (Min/Max 8/50)
S 197 Current_Pending_Sector  0x0022   100   100   000    Old_age   Always       -       0
D reboot.required no
D runners.registered 0
D runners.failed 0
D runners.busy 0
D errorsThisBoot 3
WMGR radio wlp5s0
WMGR nmcli 1.52.1
WMGR dev wlp5s0:wifi:connected:ExampleNet_5G
WMGR dev enp4s0:ethernet:unavailable:
WMGR profile ExampleNet_5G
D wifi.iface wlp5s0
D wifi.operstate up
D wifi.carrier 1
D wifi.ssid ExampleNet_5G
D wifi.signalDbm -57.00
D wifi.freqMhz 5180
D load.seconds 60
D load.workers 8
D load.throttleBefore 2022029
D peak.zone.3.x86_pkg_temp 97000
D peak.hwmon.3.coretemp.Package_id_0 97000
D peak.hwmon.3.coretemp.Core_0 96000
D peak.zone.2.acpitz 96000
D load.throttleAfter 2045679
D load.finishedAt 2026-09-10T17:07:52Z
DOCTOR-END claw-1`;

/** claw-5, an FX-8350 whose unlabelled k10temp moved 19 → 24 °C under load. */
export const CLAW5 = `DOCTOR-BEGIN v1
D schema 1
D hostname claw-5
D product MS-7693
D kernel 6.12.94+deb13-amd64
D cores 8
D rootElevation yes
D idle.hwmon.1.k10temp.temp1 19250
D idle.hwmon.2.nouveau.temp1 39000
D idle.throttleCount 0
D watchdog.active active
D watchdog.enabled enabled
D disk.root.fs ext4
D disk.root.totalKb 960302868
D disk.root.availKb 882496928
D disk.root.usePct 4
D mem.totalKb 16318072
D mem.availKb 15203380
D disk.root.device sda
D smart.device sda
S SMART overall-health self-assessment test result: PASSED
S   9 Power_On_Hours          0x0032   097   097   000    Old_age   Always       -       3583
S 194 Temperature_Celsius     0x0022   035   045   000    Old_age   Always       -       35 (Min/Max 24/45)
D reboot.required no
D runners.registered 0
D runners.failed 0
D runners.busy 0
WMGR radio -
WMGR nmcli -
D load.seconds 60
D load.workers 8
D load.throttleBefore 0
D peak.hwmon.1.k10temp.temp1 24375
D peak.hwmon.2.nouveau.temp1 40000
D load.throttleAfter 0
DOCTOR-END claw-5`;

/**
 * claw-9, the node the `sensor-did-not-move` rule was rewritten for: an
 * i7-5930K locked at 3.0 GHz with turbo off (a 09-20 BIOS reset) under a
 * desktop tower cooler, so the die genuinely stays cool.
 *
 * Captured by lane T on 2026-09-22 from a live `fleet doctor --machine claw-9`
 * run against the THEN-deployed rule: package 39 → 47 °C and every per-core
 * sensor +8…+13 °C under the same load. The facet stores whole degrees, so the
 * milli values below are `<degree>000` — the derived readings round to exactly
 * the captured numbers. The wifi stanza is omitted: claw-9's radio is unmanaged
 * and that finding is not this fixture's subject.
 */
export const CLAW9 = `DOCTOR-BEGIN v1
D schema 1
D hostname claw-9
D product All Series
D kernel 6.12.107+deb13-amd64
D cores 12
D load1 0
D rootElevation yes
D idle.zone.0.x86_pkg_temp 40000
D idle.hwmon.1.coretemp.Package_id_0 39000
D idle.hwmon.1.coretemp.Core_0 33000
D idle.hwmon.1.coretemp.Core_1 33000
D idle.hwmon.1.coretemp.Core_2 34000
D idle.hwmon.1.coretemp.Core_3 30000
D idle.hwmon.1.coretemp.Core_4 34000
D idle.hwmon.1.coretemp.Core_5 35000
D idle.throttleCount 0
D watchdog.active active
D watchdog.enabled enabled
D disk.root.fs ext4
D disk.root.totalKb 216713768
D disk.root.availKb 190845160
D disk.root.usePct 8
D mem.totalKb 32771412
D mem.availKb 31888300
D disk.root.device sda
D smart.device sda
S smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.107+deb13-amd64] (local build)
S SMART overall-health self-assessment test result: PASSED
S ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S   5 Reallocated_Sector_Ct   0x0033   100   100   005    Pre-fail  Always       -       7
S   9 Power_On_Hours          0x0012   055   055   000    Old_age   Always       -       29886
D reboot.required no
D runners.registered 0
D runners.failed 0
D runners.busy 0
D load.seconds 60
D load.workers 12
D load.throttleBefore 0
D peak.zone.0.x86_pkg_temp 47000
D peak.hwmon.1.coretemp.Package_id_0 47000
D peak.hwmon.1.coretemp.Core_0 45000
D peak.hwmon.1.coretemp.Core_1 41000
D peak.hwmon.1.coretemp.Core_2 47000
D peak.hwmon.1.coretemp.Core_3 40000
D peak.hwmon.1.coretemp.Core_4 47000
D peak.hwmon.1.coretemp.Core_5 46000
D load.throttleAfter 0
DOCTOR-END claw-9`;

/** claw-7, whose Crucial MX100 reports 91,529 power-on hours, and a SPLIT radio. */
export const CLAW7_SMART = [
	'SMART overall-health self-assessment test result: PASSED',
	'ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE',
	'  5 Reallocate_NAND_Blk_Cnt 0x0033   100   100   000    Pre-fail  Always       -       1',
	'  9 Power_On_Hours          0x0032   100   100   000    Old_age   Always       -       91529',
	'194 Temperature_Celsius     0x0022   065   047   000    Old_age   Always       -       35 (Min/Max 18/53)',
	'197 Current_Pending_ECC_Cnt 0x0032   100   100   000    Old_age   Always       -       0',
	'202 Percent_Lifetime_Remain 0x0031   067   067   000    Pre-fail  Offline      -       33',
];

/** hokon: no passwordless sudo, so SMART is a NAMED refusal, not a pass. */
export const HOKON = `DOCTOR-BEGIN v1
D schema 1
D hostname hokon
D product MS-7D70
D kernel 6.12.101+deb13-amd64
D cores 12
D rootElevation no
D idle.hwmon.5.k10temp.Tctl 88875
D idle.hwmon.5.k10temp.Tccd1 88500
D idle.hwmon.0.nvme.Composite 43850
D idle.throttleCount 0
D watchdog.active inactive
D watchdog.enabled not-found
D watchdog.keepalive inactive
U watchdog.conf /etc/watchdog.conf is not readable
D disk.root.fs btrfs
D disk.root.totalKb 1884868608
D disk.root.availKb 821455272
D disk.root.usePct 57
D disk.root.device nvme1n1
U smart reading SMART needs root and sudo -n was refused on this node
D reboot.required yes
D reboot.stagedAtEpoch 1788096830
D reboot.packages linux-image-6.12.105+deb13-amd64,linux-image-6.12.107+deb13-amd64
D runners.registered 0
D runners.failed 0
D runners.busy 0
WMGR radio wlp13s0
WMGR nmcli 1.52.1
WMGR dev wlp13s0:wifi:disconnected:
D wifi.iface wlp13s0
D wifi.operstate down
D wifi.carrier 0
D load.seconds 60
D load.workers 12
D load.throttleBefore 0
D peak.hwmon.5.k10temp.Tccd1 97125
D peak.hwmon.5.k10temp.Tctl 97500
D load.throttleAfter 0
DOCTOR-END hokon`;

export const facetOf = (raw, extra = {}) =>
	healthFacet({
		node: /D hostname (\S+)/.exec(raw)[1],
		probe: parseDoctor(raw),
		at: '2026-09-10T17:07:52.000Z',
		...extra,
	});

export const NOW = Date.parse('2026-09-10T18:00:00Z');
export const find = (fs, category) => fs.filter((f) => f.category === category);

/** A minimal, synthetic probe capture (no real fixture predates this field) —
 *  same minimal shape the existing no-sensor case already uses: enough facts
 *  to produce a complete, parseable health facet, nothing more. */
export function workProbe(lines) {
	return (
		'DOCTOR-BEGIN v1\n' +
		'D hostname claw-x\n' +
		'U idle.sensors no readable sensor under /sys/class/thermal or /sys/class/hwmon\n' +
		'D disk.root.totalKb 1000000\n' +
		'D disk.root.availKb 900000\n' +
		lines.join('\n') +
		'\nDOCTOR-END claw-x'
	);
}

// VERBATIM, 2026-10-27, from the real `doctorProbe({ loadSeconds: 0 })` run on
// each node. claw-3's unit is cktest-runner, retired 07-30 and left enabled;
// claw-1's is modules-load from the 10-25 boot before DKMS rebuilt nvidia.
export const FAILED_CLAW3 = [
	'D failedUnits.count 1',
	'D failedUnit.cktest-runner.service 1792941799',
];
export const FAILED_CLAW1 = [
	'D failedUnits.count 1',
	'D failedUnit.systemd-modules-load.service 1792938169',
];
export const FAILED_CLAW4 = ['D failedUnits.count 0'];

export const failedFacet = (lines) =>
	healthFacet({ node: 'claw-x', probe: parseDoctor(workProbe(lines)) });

// VERBATIM, 2026-10-28, from `doctorProbe({ loadSeconds: 0 })` on each node.
// claw-6 is a declared pm2 host of the app layer running nothing, uncapped.
export const PM2_HOKON = ['D pm2Units.count 1', 'D pm2Unit.pm2-hadoku.service 34359738368 28'];
export const PM2_CLAW6 = ['D pm2Units.count 1', 'D pm2Unit.pm2-hadoku.service max 0'];
export const PM2_CLAW5 = ['D pm2Units.count 0'];
/** claw-4, 2026-11-02: two service tenants bounded by their hosting slice, and the admin pm2 by its own unit. */
export const PM2_CLAW4 = [
	'D pm2Units.count 3',
	'D pm2Unit.pm2-archivebot-svc.service max 1 /hosting.slice/hosting-archivebot.slice/pm2-archivebot-svc.service 1073741824',
	'D pm2Unit.pm2-hadoku.service 536870912 0 /system.slice/pm2-hadoku.service max',
	'D pm2Unit.pm2-pygmalion-svc.service max 1 /hosting.slice/hosting-pygmalion.slice/pm2-pygmalion-svc.service 536870912',
];

export const pm2Facet = (lines) =>
	healthFacet({ node: 'claw-x', probe: parseDoctor(workProbe(lines)) });
