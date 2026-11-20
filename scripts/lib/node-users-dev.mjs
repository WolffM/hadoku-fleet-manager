/**
 * THE DEV ROLE'S SETUP: one node gets a user that runs the operator's
 * interactive agent sessions (docs/planning/claw-sessions-2026-11-19.md,
 * src/lib/node-users.ts). Nothing of CI moves, so the node is not drained.
 *
 * Three node scripts and one manifest edit, all pure text here so the tests
 * can read them; `scripts/node-users-dev.mjs` runs them.
 *
 *   devInventoryScript   READ ONLY. What a setup would do here.
 *   devSetupScript       the change, as admin with sudo. IDEMPOTENT.
 *   devBackScript        the undo. Refuses while anything runs as the dev
 *                        user: a live session is active work. The ACCOUNT is
 *                        removed, because an account no manifest entry claims
 *                        is a blocking finding; its home directory is kept,
 *                        and a later setup takes it over again.
 *
 * WHAT THE USER IS. No sudo and no group but its own, checked before and
 * after. Home 0700. Linger, so a session outlives the ssh that started it.
 * A key that only the controller's address may use, with a pty (a session is
 * a terminal) and no agent or X11 forwarding. Its whole user slice weighs
 * SESSION_WEIGHT against ci's 100, so sessions take an idle machine and CI
 * wins a contended one. The weight is read back from the KERNEL
 * (`cpu.weight`), never from the drop-in this script wrote.
 *
 * Every script prints `STEP <name> <ok|skip|fail> <detail>` lines and ends
 * with `INVENTORY-END` / `SETUP-END` / `BACK-END`, parsed by
 * `parseSteps` (node-users-cutover.mjs). A missing end marker is a run that
 * did not finish, never a pass.
 */
import { SSHD_ALLOW_SH } from './node-users-cutover.mjs';
import { DEV_CLAUDE_BIN, SESSION_WEIGHT } from '../../dist/lib/node-users.js';

/** The drop-in that carries the weight across boots, under `user-<uid>.slice.d/`. */
export const SESSION_DROP_IN = '10-fleet-sessions.conf';

const CLAUDE_BIN = DEV_CLAUDE_BIN;

const NAME = /^[a-z_][a-z0-9_-]*$/;
const KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+$/;
const HOME = /^\/home\/[a-z_][a-z0-9_-]*$/;

function header({ admin, ci, dev, adminHome, devHome }) {
	for (const [k, v] of Object.entries({ admin, ci, dev }))
		if (!NAME.test(v ?? '')) throw new Error(`refusing ${k} user ${JSON.stringify(v)}`);
	if (dev === admin || dev === ci) throw new Error(`the dev user must not be ${dev}`);
	for (const [k, v] of Object.entries({ adminHome, devHome }))
		if (!HOME.test(v ?? '')) throw new Error(`refusing ${k} ${v}`);
	return `set -u
ADMIN='${admin}'
CI='${ci}'
DEV='${dev}'
AH='${adminHome}'
DH='${devHome}'
WEIGHT='${SESSION_WEIGHT}'
step() { printf 'STEP %s %s %s\\n' "$1" "$2" "\${3:-}"; }
die() { step "$1" fail "$2"; exit 1; }
${SSHD_ALLOW_SH}slice_of() { echo "/sys/fs/cgroup/user.slice/user-$(id -u "$1").slice"; }
# Everything that runs as dev: its sessions and whatever they started.
running() { sudo -n pgrep -c -u "$DEV" 2>/dev/null || true; }
`;
}

/** READ ONLY: what a setup would do here. */
export function devInventoryScript(users) {
	return `${header(users)}
echo INVENTORY-BEGIN
[ -e "$AH/pilot-claude-session" ] && step pilot ok "$AH/pilot-claude-session (the 2026-11-19 pilot) would be removed"
if getent passwd "$DEV" >/dev/null; then
	step user ok "$DEV exists (uid $(id -u "$DEV"), groups: $(id -Gn "$DEV"))"
	step sudo "$([ "$(sudo -n -l -U "$DEV" 2>/dev/null | grep -c 'may run' || true)" = 0 ] && echo ok || echo fail)" "$DEV must not be able to run sudo"
	w=$(cat "$(slice_of "$DEV")/cpu.weight" 2>/dev/null)
	step slice "$([ "$w" = "$WEIGHT" ] && echo skip || echo ok)" "cpu.weight \${w:-unread (no slice yet)}, target $WEIGHT"
	step sessions ok "$(running) process(es) run as $DEV"
else
	step user skip "$DEV would be created: home 0700, linger, no sudo, no extra group"
	step slice ok "its user slice would weigh $WEIGHT"
fi
step ci-weight ok "$CI's slice weighs $(cat "$(slice_of "$CI")/cpu.weight" 2>/dev/null || echo unread)"
if [ -z "$(allowed)" ]; then step sshd ok "no AllowUsers list"
elif allowed | grep -qx "$DEV"; then step sshd skip "AllowUsers already names $DEV"
else step sshd ok "AllowUsers ($(allowed | tr '\\n' ' ')) would gain $DEV"; fi
if sudo -n test -x "$DH/${CLAUDE_BIN}"; then step claude skip "installed"
else step claude ok "the controller's claude would be copied to $DH/${CLAUDE_BIN}"; fi
echo INVENTORY-END
`;
}

/** The setup, as ADMIN. `controllerKeys` are the controller's public keys, `type base64` each. */
export function devSetupScript(users, { controllerKeys }) {
	const keys = controllerKeys.filter((k) => KEY.test(k));
	if (!keys.length) throw new Error('no usable controller public key');
	return `${header(users)}
set -o pipefail
KEYS=$(cat <<'FLEET_KEYS'
${keys.join('\n')}
FLEET_KEYS
)
echo SETUP-BEGIN
[ "$HOME" = "$AH" ] || die preflight "running as $HOME, not admin's $AH"
sudo -n true 2>/dev/null || die preflight "admin has no passwordless sudo"
step preflight ok "admin with sudo"

# 1. The user. No sudo and no shared group, read back, not assumed.
if ! getent passwd "$DEV" >/dev/null; then
	sudo -n useradd --create-home --shell /bin/bash "$DEV" || die user "useradd failed"
fi
sudo -n usermod --unlock "$DEV" >/dev/null 2>&1 || true
# A home an earlier undo kept belongs to a uid that no longer exists: take it all.
[ "$(sudo -n stat -c %u "$DH")" = "$(id -u "$DEV")" ] || sudo -n chown -R "$DEV:$DEV" "$DH" || die user "could not own $DH"
sudo -n chown "$DEV:$DEV" "$DH" && sudo -n chmod 0700 "$DH" || die user "could not own $DH"
[ "$(id -Gn "$DEV")" = "$DEV" ] || die user "$DEV is in groups: $(id -Gn "$DEV")"
[ "$(sudo -n -l -U "$DEV" 2>/dev/null | grep -c 'may run' || true)" = 0 ] || die user "$DEV may run sudo"
sudo -n loginctl enable-linger "$DEV" || die user "could not enable linger"
step user ok "$DEV uid $(id -u "$DEV"), 0700, linger, no sudo"

# 2. The key: admin's lines for the controller's keys, from this address only.
#    A pty, because a session is a terminal. No agent or X11 forwarding.
from=\${SSH_CLIENT%% *}
[ -n "$from" ] || die key "no SSH_CLIENT: run this over the controller's ssh"
ak=$(while read -r t b; do
	grep -qF " $b" "$AH/.ssh/authorized_keys" && printf 'from="%s",no-agent-forwarding,no-X11-forwarding %s %s fleet-operator\\n' "$from" "$t" "$b"
done <<<"$KEYS")
[ -n "$ak" ] || die key "none of the controller's keys is in $AH/.ssh/authorized_keys"
sudo -n install -d -m 0700 -o "$DEV" -g "$DEV" "$DH/.ssh"
printf '%s\\n' "$ak" | sudo -n tee "$DH/.ssh/authorized_keys" >/dev/null
sudo -n chown "$DEV:$DEV" "$DH/.ssh/authorized_keys" && sudo -n chmod 0600 "$DH/.ssh/authorized_keys"
step key ok "$(printf '%s\\n' "$ak" | wc -l) key(s), from=$from"

# 3. sshd must LET dev in: an unlisted user is refused before a key is read.
if [ -n "$(allowed)" ] && ! allowed | grep -qx "$DEV"; then
	conf=$(allow_conf)
	[ -n "$conf" ] || die sshd "sshd has an AllowUsers list but no file under /etc/ssh names it"
	sudo -n cp -p "$conf" "$conf.fleet-bak" || die sshd "could not back up $conf"
	sudo -n sed -i -E "s/^([[:space:]]*[Aa]llow[Uu]sers[[:space:]].*)$/\\1 $DEV/" "$conf"
	if ! sudo -n sshd -t; then
		sudo -n mv "$conf.fleet-bak" "$conf"
		die sshd "sshd rejected $conf with $DEV added; restored"
	fi
	sudo -n rm -f "$conf.fleet-bak"
	sudo -n systemctl reload ssh || die sshd "ssh did not reload"
fi
[ -z "$(allowed)" ] || allowed | grep -qx "$DEV" || die sshd "sshd's effective AllowUsers still leaves out $DEV"
step sshd ok "$DEV may log in"

# 4. The weight: a drop-in for every boot, set-property for the slice that
#    linger just started, and the kernel's own file as the answer.
unit="user-$(id -u "$DEV").slice"
sudo -n install -d -m 0755 "/etc/systemd/system/$unit.d"
printf '[Slice]\\nCPUWeight=%s\\nIOWeight=%s\\n' "$WEIGHT" "$WEIGHT" | sudo -n tee "/etc/systemd/system/$unit.d/${SESSION_DROP_IN}" >/dev/null
sudo -n systemctl daemon-reload || die slice "daemon-reload failed"
sudo -n systemctl set-property --runtime "$unit" "CPUWeight=$WEIGHT" "IOWeight=$WEIGHT" || die slice "could not set the weight on $unit"
w=$(cat "$(slice_of "$DEV")/cpu.weight" 2>/dev/null)
[ "$w" = "$WEIGHT" ] || die slice "the kernel reads cpu.weight \${w:-nothing} for $unit, not $WEIGHT"
cw=$(cat "$(slice_of "$CI")/cpu.weight" 2>/dev/null)
[ -z "$cw" ] || [ "$w" -lt "$cw" ] || die slice "$DEV's slice ($w) does not weigh less than $CI's ($cw)"
step slice ok "$unit cpu.weight $w, below $CI's \${cw:-unread}"

# 5. Where the controller copies claude to, and the pilot's leftover in admin's home.
sudo -n install -d -m 0755 -o "$DEV" -g "$DEV" "$DH/.local" "$DH/.local/bin" || die dirs "could not make $DH/.local/bin"
rm -rf "$AH/pilot-claude-session"
step dirs ok "$DH/.local/bin"
echo SETUP-END
`;
}

/** The undo, as ADMIN. Never while a session runs. */
export function devBackScript(users) {
	return `${header(users)}
echo BACK-BEGIN
[ "$HOME" = "$AH" ] || die preflight "running as $HOME, not admin's $AH"
getent passwd "$DEV" >/dev/null || die preflight "$DEV does not exist: nothing to undo"
sudo -n loginctl disable-linger "$DEV" || true
sudo -n systemctl stop "user@$(id -u "$DEV").service" >/dev/null 2>&1 || true
n=$(running)
[ "\${n:-1}" = 0 ] || die preflight "$n process(es) still run as $DEV: a live session is active work; close it first"
step preflight ok "nothing runs as $DEV"
sudo -n rm -f "$DH/.ssh/authorized_keys"
conf=$(allow_conf)
if [ -n "$conf" ] && allowed | grep -qx "$DEV"; then
	sudo -n sed -i -E "/^[[:space:]]*[Aa]llow[Uu]sers[[:space:]]/ s/[[:space:]]$DEV([[:space:]]|$)/\\1/" "$conf"
	sudo -n sshd -t && sudo -n systemctl reload ssh || die stop "sshd did not take $DEV out of AllowUsers"
fi
sudo -n rm -rf "/etc/systemd/system/user-$(id -u "$DEV").slice.d"
sudo -n systemctl daemon-reload
sudo -n userdel "$DEV" || die stop "could not remove the account $DEV"
getent passwd "$DEV" >/dev/null && die stop "$DEV still exists"
step stop ok "the account $DEV is removed; $DH is kept"
echo BACK-END
`;
}

/** Whether the manifest already says what this run would write. */
export function manifestSaysDev(m, { dev, back = false } = {}) {
	return back ? m?.users?.dev === undefined : m?.users?.dev === dev;
}

/** The manifest edit: `users.dev`; `back` removes it. Returns the entry it changed. */
export function flipDevManifest(doc, node, { dev, back = false }) {
	const m = doc.machines?.[node];
	if (!m) throw new Error(`${node} is not in the manifest`);
	if (back) {
		if (m.users) {
			delete m.users.dev;
			if (!Object.keys(m.users).length) delete m.users;
		}
		return m;
	}
	if (!NAME.test(dev ?? '')) throw new Error(`refusing dev user ${JSON.stringify(dev)}`);
	m.users = { ...(m.users ?? {}), dev };
	return m;
}
