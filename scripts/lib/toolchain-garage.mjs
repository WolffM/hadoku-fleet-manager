/**
 * The toolchain floor's `garage` entry: the Garage daemon of the storage pool
 * (fleet-manager#139, bootcamp F4). toolchain-release-tools.mjs spreads it into
 * RELEASE_TOOLS, and toolchain-floor.mjs, which owns how every entry is read,
 * spreads that into REPAIRS. One declaration, three consumers: the refresh
 * cycle, the doctor and bootcamp.
 *
 * WHERE: only on a node that offers `storage` (`when`, read through
 * `nodeOffer`; src/lib/capability-registry-storage.ts). No node earns it until
 * disk qualification (F2) and the layout (F6) exist, so until then this entry
 * applies nowhere and installs nothing.
 *
 * THE RELEASE IS PINNED, not looked up. Garage publishes on its own Forgejo,
 * and its binaries carry no checksum file, so there is no feed to trust. The
 * pin is {@link GARAGE_RELEASE}: version, publish date, URL and the sha256 of
 * the x86_64 musl build, read through tool-release.mjs's `pinned` source so
 * the debounce and the currency check work as for any other tool. To move it,
 * change all four together; the repair refuses any other version.
 *
 * v2.5.0, measured 2026-11-23: the newest release in
 * git.deuxfleurs.fr/api/v1/repos/Deuxfleurs/garage/releases (2026-10-24),
 * 69,426,824 bytes. The sha256 is the release URL's download, and the same
 * hash is the `/garage` of Docker Hub's dxflrs/garage:v2.5.0 linux/amd64
 * layer: two paths to one file. `garage --version` prints
 * `garage v2.5.0 [features: ...]`.
 *
 * SECRETS FAIL CLOSED. The RPC secret and the admin token are the vault items
 * {@link GARAGE_SECRET_ITEMS} (hadoku_site#638), on the node as
 * `/etc/garage/secrets/<item>`, root 0600, and handed to the daemon by
 * systemd's `LoadCredential`, so the config file holds none. Until both are
 * there the repair installs everything, leaves the unit stopped and disabled,
 * and fails naming the missing items; the detect answers the same, so the
 * doctor's finding names them too. The unit asserts both files as well, so a
 * hand-started daemon cannot run without them. systemd exposes a credential at
 * 0440 under /run/credentials/garage.service, which only the unit can enter,
 * and Garage refuses any mode but 0600 unless
 * `GARAGE_ALLOW_WORLD_READABLE_SECRETS` is set: the unit sets it (#151,
 * measured on claw-1 with a transient unit, with and without). Putting them there is the
 * layout's job (F6, fleet-manager#141): this entry never reads the vault.
 *
 * THE USER IS SYSTEMD'S (`DynamicUser`), not a node role: Garage is not admin,
 * ci or dev work, and a dynamic user owns only /var/lib/garage and the
 * credentials. Ports are Garage's defaults: RPC 3901 (every member), S3 3900,
 * admin API 3903 on loopback only.
 */

import { STORAGE_LABEL } from '../../dist/lib/capability-registry-storage.js';

export const GARAGE_RELEASE = {
	version: '2.5.0',
	publishedAt: '2026-10-24T14:58:05Z',
	url: 'https://garagehq.deuxfleurs.fr/_releases/v2.5.0/x86_64-unknown-linux-musl/garage',
	sha256: '2ff667286217cd73ebcb1c03af993822365000441dfe31a80cb64c5189a9dea8',
};

/** The vault items the daemon reads, by name, as `/etc/garage/secrets/<item>`. */
export const GARAGE_SECRET_ITEMS = ['GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN'];
export const GARAGE_SECRET_DIR = '/etc/garage/secrets';
export const GARAGE_CONFIG = '/etc/garage.toml';
export const GARAGE_BIN = '/usr/local/bin/garage';
const CRED = '/run/credentials/garage.service';

/**
 * WHERE THE DATA GOES is the layout's, per node (fleet-manager#141): the
 * layout manager writes `data_dir = [...]` into {@link GARAGE_DATA_DIRS_FILE},
 * one entry per pool disk (`/srv/storage/<serial>/garage`, F5) or the root
 * zone (`/srv/storage/root/garage`), each with its capacity. The repair builds
 * the config around that file, so a refresh keeps the node's disks; without
 * it the daemon keeps its data under its own state directory.
 */
export const GARAGE_DATA_DIRS_FILE = '/etc/garage/data-dirs.toml';
const DEFAULT_DATA_DIR = 'data_dir = "/var/lib/garage/data"';

const TOML_HEAD = [
	'# Written by fleet-manager (scripts/lib/toolchain-garage.mjs); edits are replaced.',
	'metadata_dir = "/var/lib/garage/meta"',
];
const TOML_TAIL = [
	'db_engine = "lmdb"',
	'replication_factor = 3',
	'rpc_bind_addr = "[::]:3901"',
	`rpc_secret_file = "${CRED}/rpc_secret"`,
	'',
	'[s3_api]',
	's3_region = "garage"',
	'api_bind_addr = "[::]:3900"',
	'',
	'[admin]',
	'api_bind_addr = "127.0.0.1:3903"',
	`admin_token_file = "${CRED}/admin_token"`,
	'',
];

/**
 * PURE. The config, with `dataDirs` (the data-dirs file's text) in place of
 * the default data directory. Paths and ports only: the secrets are files
 * systemd hands over.
 */
export const garageToml = (dataDirs = null) =>
	[...TOML_HEAD, dataDirs ? dataDirs.replace(/\n+$/, '') : DEFAULT_DATA_DIR, ...TOML_TAIL].join(
		'\n'
	);

/** The config on a node with no data-dirs file. */
export const GARAGE_TOML = garageToml();

export const GARAGE_UNIT = [
	'# Written by fleet-manager (scripts/lib/toolchain-garage.mjs); edits are replaced.',
	'[Unit]',
	'Description=Garage object store (fleet storage pool)',
	'Wants=network-online.target',
	'After=network-online.target',
	...GARAGE_SECRET_ITEMS.map((i) => `AssertFileNotEmpty=${GARAGE_SECRET_DIR}/${i}`),
	'',
	'[Service]',
	`ExecStart=${GARAGE_BIN} -c ${GARAGE_CONFIG} server`,
	'Environment=RUST_LOG=garage=info',
	// systemd hands credentials over at 0440 in a directory only this unit can
	// enter; Garage v2.5.0 refuses anything but 0600 without this knob (#151).
	'Environment=GARAGE_ALLOW_WORLD_READABLE_SECRETS=true',
	'DynamicUser=yes',
	'StateDirectory=garage',
	`LoadCredential=rpc_secret:${GARAGE_SECRET_DIR}/GARAGE_RPC_SECRET`,
	`LoadCredential=admin_token:${GARAGE_SECRET_DIR}/GARAGE_ADMIN_TOKEN`,
	'NoNewPrivileges=yes',
	'ProtectHome=yes',
	'ProtectSystem=strict',
	// The pool's disks (F5) and the root zone; `-`: a node with neither still starts.
	'ReadWritePaths=-/srv/storage',
	'LimitNOFILE=42000',
	'Restart=on-failure',
	'RestartSec=10',
	'',
	'[Install]',
	'WantedBy=multi-user.target',
	'',
].join('\n');

/** Shell: `$missing` names every secret item absent or empty on the node. */
const MISSING_SECRETS = [
	'missing=""',
	`for item in ${GARAGE_SECRET_ITEMS.join(' ')}; do`,
	`  [ -s "${GARAGE_SECRET_DIR}/$item" ] || missing="$missing $item"`,
	'done',
];

/** Write `text` to `dest` (root, 0644) only when it differs; sets `changed=1`. */
const placeFile = (text, dest, tag) => [
	`cat > "$tmp/${tag}" <<'${tag.toUpperCase()}_EOF'`,
	text.replace(/\n$/, ''),
	`${tag.toUpperCase()}_EOF`,
	`if ! cmp -s "$tmp/${tag}" ${dest}; then`,
	`  sudo -n install -D -m 0644 "$tmp/${tag}" ${dest}`,
	'  changed=1',
	'fi',
];

export const GARAGE_REPAIR = [
	'set -e',
	'v="${TARGET_VERSION:?a pinned version}"',
	`[ "$v" = "${GARAGE_RELEASE.version}" ] || { echo "garage $v is not the pinned release ` +
		`${GARAGE_RELEASE.version}: pin its URL and sha256 in toolchain-garage.mjs first" >&2; exit 1; }`,
	`want="${GARAGE_RELEASE.sha256}"`,
	'tmp="$(mktemp -d)"',
	'trap \'rm -rf "$tmp"\' EXIT',
	'changed=0',
	`if [ "$(sha256sum ${GARAGE_BIN} 2>/dev/null | cut -d" " -f1)" != "$want" ]; then`,
	`  curl -fsSL --max-time 600 -o "$tmp/garage" "${GARAGE_RELEASE.url}"`,
	'  [ "$(sha256sum "$tmp/garage" | cut -d" " -f1)" = "$want" ] ||',
	'    { echo "garage $v: the download does not match the pinned sha256" >&2; exit 1; }',
	'  chmod 0755 "$tmp/garage"',
	'  "$tmp/garage" --version | grep -q "^garage v$v " ||',
	'    { echo "garage $v: the binary does not report itself as v$v" >&2; exit 1; }',
	`  sudo -n install -D -m 0755 "$tmp/garage" ${GARAGE_BIN}.new`,
	`  sudo -n mv -f ${GARAGE_BIN}.new ${GARAGE_BIN}`,
	'  changed=1',
	'fi',
	// The config: head, this node's data dirs (or the default), tail.
	'cat > "$tmp/head" <<\'HEAD_EOF\'',
	TOML_HEAD.join('\n'),
	'HEAD_EOF',
	'cat > "$tmp/tail" <<\'TAIL_EOF\'',
	TOML_TAIL.join('\n').replace(/\n$/, ''),
	'TAIL_EOF',
	`if [ -s ${GARAGE_DATA_DIRS_FILE} ]; then dd="$(cat ${GARAGE_DATA_DIRS_FILE})"; else dd='${DEFAULT_DATA_DIR}'; fi`,
	'printf \'%s\\n%s\\n%s\\n\' "$(cat "$tmp/head")" "$dd" "$(cat "$tmp/tail")" > "$tmp/toml"',
	`if ! cmp -s "$tmp/toml" ${GARAGE_CONFIG}; then`,
	`  sudo -n install -D -m 0644 "$tmp/toml" ${GARAGE_CONFIG}`,
	'  changed=1',
	'fi',
	...placeFile(GARAGE_UNIT, '/etc/systemd/system/garage.service', 'unit'),
	// 0711: any user may stat an item (the detect, as ci), only root may read one.
	`sudo -n install -d -m 0711 ${GARAGE_SECRET_DIR}`,
	'sudo -n systemctl daemon-reload',
	...MISSING_SECRETS,
	'if [ -n "$missing" ]; then',
	'  if systemctl is-enabled -q garage.service || systemctl is-active -q garage.service; then',
	'    sudo -n systemctl disable --now garage.service',
	'  fi',
	`  echo "garage installed but NOT started: vault item(s)$missing absent from ${GARAGE_SECRET_DIR}" >&2`,
	'  exit 1',
	'fi',
	'sudo -n systemctl enable -q garage.service',
	'if [ "$changed" = 1 ]; then sudo -n systemctl restart garage.service; else sudo -n systemctl start garage.service; fi',
	'sleep 3',
	'systemctl is-active -q garage.service ||',
	'  { echo "garage.service did not stay up: $(sudo -n journalctl -u garage.service -n 5 --no-pager -o cat)" >&2; exit 1; }',
].join('\n');

/**
 * Present, keyed and running. The first line is the doctor's reason when it is
 * not `OK` (a `WHY ` line; toolchain-doctor.mjs), so a node without its secrets
 * is a finding that names the vault items.
 */
export const GARAGE_DETECT = [
	'if ! garage --version >/dev/null 2>&1; then exit 0; fi',
	...MISSING_SECRETS,
	'if [ -n "$missing" ]; then',
	`  echo "WHY garage is installed but not running: vault item(s)$missing absent from ${GARAGE_SECRET_DIR}"`,
	'elif ! systemctl is-active -q garage.service; then',
	'  echo "WHY garage.service is not active"',
	'else',
	'  echo OK',
	'fi',
].join('\n');

export const GARAGE_REPAIRS = {
	garage: {
		when: STORAGE_LABEL,
		// A daemon, not a tool a job runs: no runner PATH to judge.
		role: 'admin',
		why:
			'the storage pool: every `storage` node is a member of the 3-copy Garage cluster ' +
			'dataplatform stores blobs in. The pinned upstream binary, its config and a systemd unit.',
		detect: GARAGE_DETECT,
		version: 'garage --version 2>/dev/null',
		latest: {
			source: {
				kind: 'pinned',
				version: GARAGE_RELEASE.version,
				publishedAt: GARAGE_RELEASE.publishedAt,
			},
		},
		repair: GARAGE_REPAIR,
	},
};
