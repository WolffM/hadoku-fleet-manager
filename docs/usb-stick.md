# The onboarding USB stick: layout and why

Design rationale for `scripts/node-usb-prep.sh`, which builds the stick (`fleet usb-prep`). Moved here from that script's header; the script points back to this file.

THE LAYOUT, AND WHY IT IS VENTOY
--------------------------------

Partition 1 is Ventoy's. Drop `debian-13.iso` onto it and it boots; drop a
second ISO beside it later and you pick at boot.

Multi-ISO is NOT here because a distro change is planned — it is not. Every
node runs Debian Trixie and `os.distro` in the profile says so per node. It is
here because the alternative, one dd'd stick per ISO, means the recovery
script lives on whichever stick you did not bring, and because a stick that
can carry a second image costs nothing until the day it is needed.

The tail of the disk is an ext4 partition labelled CLAWKIT carrying the
profile, the fixes and the bootstrap. ext4, NOT vfat, and that is inherited
reasoning worth restating: the stick gets read inside an `init=/bin/bash`
shell where there is no udev and no auto-modprobe, so vfat may not be loadable
at all. ext4 is already the root filesystem on every claw.

VENTOY'S OWN LAYOUT PUTS ITS 32MB `VTOYEFI` PARTITION AT NUMBER 2, so CLAWKIT
lands at 3 on a normal install. This script does not assume a number — it
diffs the partition table before and after, and prints the device it actually
created. `blkid -L CLAWKIT` finds it on the target.

WHAT WAS KEPT FROM claw-usb-prep.sh, VERBATIM IN SPIRIT
-------------------------------------------------------

All of the safety scaffolding, now in `lib/usb-device-guard.sh` so it can be
tested without a block device:

- the removable-flag check, refusing on an unreadable flag as well as on 0
- the root disk resolved ALL THE WAY DOWN the btrfs -> LVM -> LUKS stack,
  because `lsblk -no PKNAME` returns empty for hokon's root and the guard
  then compared against "" and passed for every device including that root
- the size ceiling
- refusal on a partition rather than a whole disk
- sha256 verify after copy, and a parse check on the copy
- DRY RUN BY DEFAULT; `--confirm` acts

THE DEVICE IS AN EXPLICIT ARGUMENT AND IS NEVER GUESSED. The interactive mode
below LISTS candidates with size and model so the operator can recognise
theirs; it does not preselect one, and there is no default. Every check is a
refusal, not a warning.

VENTOY IS THIRD-PARTY AND IS NOT VENDORED. If it is not present the script
says exactly what to fetch and stops. It does not download an installer that
writes a bootloader.
