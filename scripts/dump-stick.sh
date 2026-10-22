K=$(blkid -L CLAWKIT) || { echo "CLAWKIT not found"; exit 1; }
echo "device: $K"
M=$(mktemp -d); mount -o ro "$K" "$M" || { echo "mount failed"; exit 1; }
echo "--- everything on the partition ---"
find "$M" -maxdepth 3 | sed "s|$M|CLAWKIT|"
echo "--- fleet lines from any captured syslog ---"
find "$M" -name 'syslog.txt' -exec grep -h fleet {} \; 2>/dev/null | tail -20
echo "--- (no output above the dashes means nothing was written) ---"
umount "$M"; rmdir "$M"
