#!/bin/sh
# claw-admin-fix.sh — give `hadoku` key-based root on a claw.
#
# Runs from a USB stick inside a `init=/bin/bash` root shell, because the claws
# have SSH-key login and no reachable root: garage-server-bazooka.sh adds
# openclaw to the sudo GROUP but never writes a NOPASSWD rule, and openclaw's
# password was random and printed once. See docs/operations/CLAW_ADMIN_RECOVERY.md.
#
# WHY /bin/sh AND NOT BASH-ISMS: at `init=/bin/bash` nothing is set up — no
# systemd, no udev, possibly no /proc — so this sticks to POSIX and mounts what
# it needs itself. It is idempotent; re-running it on a done node is a no-op.

set -u

ADMIN=hadoku

say() { printf '\n=== %s ===\n' "$1"; }
die() { printf '\n!!! FAILED: %s\n' "$1"; exit 1; }

# The key comes from the stick this runs from — `fleet usb-prep` writes it to
# bootstrap/authorized_key.pub beside fixes/ — so it is always the key the stick
# was built with, and no real key is committed to a public repo.
KEY_FILE="$(dirname "$0")/../bootstrap/authorized_key.pub"
KEY="$(head -n 1 "$KEY_FILE" 2>/dev/null)"
case "$KEY" in
ssh-*' '*) ;;
*) die "no public key at $KEY_FILE — is this the fleet stick? Nothing was changed" ;;
esac

say "claw admin fix — starting on $(cat /proc/sys/kernel/hostname 2>/dev/null || echo '?')"

# /proc is normally mounted by init, which is not running here. usermod and
# visudo both misbehave without it.
[ -d /proc/self ] || mount -t proc proc /proc 2>/dev/null || true
[ -d /sys/kernel ] || mount -t sysfs sysfs /sys 2>/dev/null || true

say "remounting / read-write"
mount -o remount,rw / || die "could not remount / rw — stop here, nothing was changed"

# Refuse to run against the wrong box. If there is no such user this is not a
# claw, and blindly creating one would be worse than failing.
id "$ADMIN" >/dev/null 2>&1 || die "user '$ADMIN' does not exist — wrong node?"

say "installing hokon's key for $ADMIN"
mkdir -p "/home/$ADMIN/.ssh"
if grep -qxF "$KEY" "/home/$ADMIN/.ssh/authorized_keys" 2>/dev/null; then
	echo "    key already present — skipping"
else
	printf '%s\n' "$KEY" >> "/home/$ADMIN/.ssh/authorized_keys"
	echo "    key appended"
fi
chown -R "$ADMIN:$ADMIN" "/home/$ADMIN/.ssh"
chmod 700 "/home/$ADMIN/.ssh"
chmod 600 "/home/$ADMIN/.ssh/authorized_keys"

say "adding $ADMIN to sudo, adm, systemd-journal"
# claw-2 is missing `sudo`; adm + systemd-journal are empty on all three, which
# is why crash logs were unreadable during the 2026-08-17 outages.
usermod -aG sudo,adm,systemd-journal "$ADMIN" || die "usermod failed"
echo "    groups now: $(id -nG "$ADMIN")"

say "writing the sudoers rule the provisioning script never wrote"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$ADMIN" > "/etc/sudoers.d/$ADMIN"
chmod 440 "/etc/sudoers.d/$ADMIN"

say "validating sudoers (a broken file locks everyone out)"
if visudo -c; then
	echo "    sudoers OK"
else
	rm -f "/etc/sudoers.d/$ADMIN"
	die "sudoers did NOT validate — the new file was removed, system left as it was"
fi

say "flushing to disk"
sync

cat <<'DONE'

==========================================================
  SUCCESS — this claw is done.

  Next:  exec /sbin/init      (or: sync, then power-cycle)

  Verify from hokon once it is back up:
    ssh -i ~/.ssh/id_ed25519_hokon hadoku@claw-N 'sudo -n whoami'
  Expect:  root
==========================================================

DONE
