/**
 * The toolchain floor's `garage` entry: the Garage daemon of the storage pool
 * (fleet-manager#139, bootcamp F4). toolchain-release-tools.mjs spreads it into
 * RELEASE_TOOLS, and toolchain-floor.mjs, which owns how every entry is read,
 * spreads that into REPAIRS. One declaration, three consumers: the refresh
 * cycle, the doctor and bootcamp.
 *
 * WHERE: on every zone garage-layout.json declares (`when`,
 * {@link garageZone}; garage-layout-declared.mjs, #153), the pool's one
 * membership answer. It is NOT the earned `storage` label: the probe answers
 * `no` for it everywhere, so a label-keyed `when` applied nowhere and nothing
 * kept a running member's config current.
 *
 * DRIFT IS NOT RUNNING. The detect renders the config and unit this version
 * would write, from the same shell the repair uses ({@link renderScript}), and
 * compares them with what is installed. A difference is a `WHY drift: ...`
 * line: the floor repairs it, and the layout's probe plans an `install` step
 * on a node whose daemon is up (#153: #152's `rpc_public_addr` reached no
 * node, because every node read as `ok`).
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
 *
 * PEERS DIAL THE TAILNET (#152). Without `rpc_public_addr`, Garage advertises
 * the address it autodetects, the LAN one, and every peer gossips it. claw-1
 * runs ufw with INPUT DROP and only the tailnet allowed, so claw-8/9 never
 * reached it: claw-1 saw 3/3 up, they saw it "never seen". The repair writes
 * `rpc_public_addr = "<tailscale ip -4>:3901"`, read ON the node, so the layout's
 * bring-up and the toolchain floor's refresh render the same config. A node
 * with no tailnet IPv4 fails the repair and says so; falling back to the LAN
 * address is the failure itself. S3 needs nothing: Garage has no public S3
 * address, and `[::]:3900` answers on the tailnet (measured from hokon).
 */

import { declaredMembers } from './garage-layout-declared.mjs';

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
export const GARAGE_UNIT_PATH = '/etc/systemd/system/garage.service';
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

const rpcLines = (ip4) => ['rpc_bind_addr = "[::]:3901"', `rpc_public_addr = "${ip4}:3901"`];

/**
 * PURE. The config of a node whose tailnet IPv4 is `ip4`, with `dataDirs`
 * (the data-dirs file's text) in place of the default data directory. Paths
 * and ports only: the secrets are files systemd hands over.
 */
export const garageToml = (dataDirs, ip4) =>
	[
		...TOML_HEAD,
		dataDirs ? dataDirs.replace(/\n+$/, '') : DEFAULT_DATA_DIR,
		...rpcLines(ip4),
		...TOML_TAIL,
	].join('\n');

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

/**
 * Shell, run with a `$tmp` dir: this node's config in `$tmp/toml` (head, its
 * data dirs or the default, its tailnet `rpc_public_addr`, tail) and the unit
 * in `$tmp/unit`. `fail(msg)` runs when the node has no tailnet IPv4. The
 * repair installs the two files; the detect compares them (#153).
 */
const renderScript = (fail) => [
	'cat > "$tmp/head" <<\'HEAD_EOF\'',
	TOML_HEAD.join('\n'),
	'HEAD_EOF',
	// #152: the address peers dial, this node's own tailnet IPv4, never the LAN.
	'ip4="$(tailscale ip -4 2>/dev/null | head -n 1)"',
	`printf '%s' "$ip4" | grep -Eq '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$' ||`,
	`  { ${fail("no tailnet IPv4 on this node (tailscale ip -4 printed '$ip4'); peers dial rpc_public_addr over the tailnet, so the config is not written")} }`,
	`printf '%s\\n%s\\n' '${rpcLines('IP4').join("' '").replaceAll('IP4', `'"$ip4"'`)}' > "$tmp/rpc"`,
	'cat > "$tmp/tail" <<\'TAIL_EOF\'',
	TOML_TAIL.join('\n').replace(/\n$/, ''),
	'TAIL_EOF',
	`if [ -s ${GARAGE_DATA_DIRS_FILE} ]; then dd="$(cat ${GARAGE_DATA_DIRS_FILE})"; else dd='${DEFAULT_DATA_DIR}'; fi`,
	'printf \'%s\\n%s\\n%s\\n%s\\n\' "$(cat "$tmp/head")" "$dd" "$(cat "$tmp/rpc")" "$(cat "$tmp/tail")" > "$tmp/toml"',
	`cat > "$tmp/unit" <<'UNIT_EOF'`,
	GARAGE_UNIT.replace(/\n$/, ''),
	'UNIT_EOF',
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
	...renderScript((msg) => `echo "garage: ${msg}" >&2; exit 1;`),
	`if ! cmp -s "$tmp/toml" ${GARAGE_CONFIG}; then`,
	`  sudo -n install -D -m 0644 "$tmp/toml" ${GARAGE_CONFIG}`,
	'  changed=1',
	'fi',
	`if ! cmp -s "$tmp/unit" ${GARAGE_UNIT_PATH}; then`,
	`  sudo -n install -D -m 0644 "$tmp/unit" ${GARAGE_UNIT_PATH}`,
	'  changed=1',
	'fi',
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
 * Present, keyed, running, and its config and unit are what this version
 * renders (`WHY drift: <files> ...` otherwise). The first line is the doctor's reason when it is
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
	'  tmp="$(mktemp -d)"',
	'  trap \'rm -rf "$tmp"\' EXIT',
	...renderScript((msg) => `echo "WHY drift: ${msg}"; exit 0;`),
	'  drift=""',
	`  cmp -s "$tmp/toml" ${GARAGE_CONFIG} || drift="$drift ${GARAGE_CONFIG}"`,
	`  cmp -s "$tmp/unit" ${GARAGE_UNIT_PATH} || drift="$drift ${GARAGE_UNIT_PATH}"`,
	'  if [ -n "$drift" ]; then echo "WHY drift:$drift not what this version renders"; else echo OK; fi',
	'fi',
].join('\n');

/**
 * A `when` predicate (toolchain-floor.mjs `toolAppliesTo`): `name` is a zone
 * garage-layout.json declares. An unreadable declaration applies nowhere here;
 * the pool gate is what fails on it. `toString` is what bootcamp prints.
 */
export const garageZone = (_node, name) => declaredMembers().nodes.includes(name);
garageZone.toString = () => 'a zone of garage-layout.json';

export const GARAGE_REPAIRS = {
	garage: {
		when: garageZone,
		// A daemon, not a tool a job runs: no runner PATH to judge.
		role: 'admin',
		why:
			'the storage pool: every declared zone is a member of the 3-copy Garage cluster ' +
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
