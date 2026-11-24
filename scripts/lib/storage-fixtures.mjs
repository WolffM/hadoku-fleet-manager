/**
 * Verbatim `storage-probe.sh` captures from the fleet, 2026-11-23, for the
 * storage-inventory tests. Same rule as doctor-fixtures.mjs: a fixture written
 * from intention would pass where a real drive's output does not.
 *
 * ONE EDIT: this repo is public, so every drive serial and WWN is replaced by
 * a placeholder (`SERIAL-<node>-<dev>`, consistently across the lsblk row and
 * smartctl's `Serial Number:` line). Everything else is as the node printed it.
 */

/** claw-9: root on a 240G SSD (sda), sdb a BLANK 1TB WD10EZEX — no partition table, no signature. As root. */
export const CLAW9 = `STORAGE-BEGIN v1
storage.root yes
storage.smartTool /usr/sbin/smartctl
disk sda
disk.sda.sizeBytes 240057409536
disk.sda.rotational 0
disk.sda.removable 0
disk.sda.model WDC WDS240G2G0A-
disk.sda.scheduler mq-deadline
disk.sda.kind ata
disk.sda.mountpoints /,[SWAP]
P sda NAME="sda" TYPE="disk" SIZE="240057409536" MODEL="WDC WDS240G2G0A-00JH30" SERIAL="SERIAL-claw-9-sda" TRAN="sata" FSTYPE="" UUID="" PTTYPE="dos" LABEL="" MOUNTPOINT=""
P sda NAME="sda1" TYPE="part" SIZE="226609201152" MODEL="" SERIAL="" TRAN="" FSTYPE="ext4" UUID="3aa823ae-6343-47bd-a9e7-521a641ad0b3" PTTYPE="dos" LABEL="" MOUNTPOINT="/"
P sda NAME="sda2" TYPE="part" SIZE="13445824512" MODEL="" SERIAL="" TRAN="" FSTYPE="swap" UUID="60c36a62-a64f-4dc4-8377-007446dc4c12" PTTYPE="dos" LABEL="" MOUNTPOINT="[SWAP]"
S sda smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sda Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sda 
S sda === START OF INFORMATION SECTION ===
S sda Model Family:     WD Blue / Red / Green SSDs
S sda Device Model:     WDC WDS240G2G0A-00JH30
S sda Serial Number:    SERIAL-claw-9-sda
S sda LU WWN Device Id: 0 000000 000000000
S sda Firmware Version: UF220400
S sda User Capacity:    240,057,409,536 bytes [240 GB]
S sda Sector Size:      512 bytes logical/physical
S sda Rotation Rate:    Solid State Device
S sda Form Factor:      2.5 inches
S sda TRIM Command:     Available, deterministic
S sda Device is:        In smartctl database 7.3/5528
S sda ATA Version is:   ACS-3, ACS-2 T13/2015-D revision 3
S sda SATA Version is:  SATA 3.2, 6.0 Gb/s (current: 6.0 Gb/s)
S sda Local Time is:    Mon Nov 23 17:05:25 2026 PST
S sda SMART support is: Available - device has SMART capability.
S sda SMART support is: Enabled
S sda 
S sda === START OF READ SMART DATA SECTION ===
S sda SMART overall-health self-assessment test result: PASSED
S sda 
S sda SMART Attributes Data Structure revision number: 1
S sda Vendor Specific SMART Attributes with Thresholds:
S sda ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S sda   5 Reallocated_Sector_Ct   0x0032   100   100   000    Old_age   Always       -       7
S sda   9 Power_On_Hours          0x0032   100   100   000    Old_age   Always       -       30212
S sda  12 Power_Cycle_Count       0x0032   100   100   000    Old_age   Always       -       1138
S sda 165 Block_Erase_Count       0x0032   100   100   000    Old_age   Always       -       18741
S sda 166 Minimum_PE_Cycles_TLC   0x0032   100   100   ---    Old_age   Always       -       152
S sda 167 Max_Bad_Blocks_per_Die  0x0032   100   100   ---    Old_age   Always       -       13
S sda 168 Maximum_PE_Cycles_TLC   0x0032   100   100   ---    Old_age   Always       -       200
S sda 169 Total_Bad_Blocks        0x0032   100   100   ---    Old_age   Always       -       146
S sda 170 Grown_Bad_Blocks        0x0032   100   100   ---    Old_age   Always       -       7
S sda 171 Program_Fail_Count      0x0032   100   100   000    Old_age   Always       -       0
S sda 172 Erase_Fail_Count        0x0032   100   100   000    Old_age   Always       -       0
S sda 173 Average_PE_Cycles_TLC   0x0032   100   100   000    Old_age   Always       -       152
S sda 174 Unexpected_Power_Loss   0x0032   100   100   000    Old_age   Always       -       58
S sda 184 End-to-End_Error        0x0032   100   100   ---    Old_age   Always       -       0
S sda 187 Reported_Uncorrect      0x0032   100   100   000    Old_age   Always       -       0
S sda 188 Command_Timeout         0x0032   100   100   ---    Old_age   Always       -       0
S sda 194 Temperature_Celsius     0x0022   063   056   000    Old_age   Always       -       37 (Min/Max 15/56)
S sda 199 UDMA_CRC_Error_Count    0x0032   100   100   ---    Old_age   Always       -       0
S sda 230 Media_Wearout_Indicator 0x0032   100   100   000    Old_age   Always       -       0x35361e283536
S sda 232 Available_Reservd_Space 0x0033   100   100   005    Pre-fail  Always       -       96
S sda 233 NAND_GB_Written_TLC     0x0032   100   100   ---    Old_age   Always       -       37999
S sda 234 NAND_GB_Written_SLC     0x0032   100   100   000    Old_age   Always       -       149341
S sda 241 Host_Writes_GiB         0x0030   100   100   000    Old_age   Offline      -       53410
S sda 242 Host_Reads_GiB          0x0030   100   100   000    Old_age   Offline      -       18806
S sda 244 Temp_Throttle_Status    0x0032   000   100   ---    Old_age   Always       -       0
S sda 
disk sdb
disk.sdb.sizeBytes 1000204886016
disk.sdb.rotational 1
disk.sdb.removable 0
disk.sdb.model WDC WD10EZEX-08W
disk.sdb.scheduler mq-deadline
disk.sdb.kind ata
disk.sdb.mountpoints none
P sdb NAME="sdb" TYPE="disk" SIZE="1000204886016" MODEL="WDC WD10EZEX-08WN4A0" SERIAL="SERIAL-claw-9-sdb" TRAN="sata" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
S sdb smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdb Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdb 
S sdb === START OF INFORMATION SECTION ===
S sdb Model Family:     Western Digital Blue
S sdb Device Model:     WDC WD10EZEX-08WN4A0
S sdb Serial Number:    SERIAL-claw-9-sdb
S sdb LU WWN Device Id: 0 000000 000000000
S sdb Firmware Version: 02.01A02
S sdb User Capacity:    1,000,204,886,016 bytes [1.00 TB]
S sdb Sector Sizes:     512 bytes logical, 4096 bytes physical
S sdb Rotation Rate:    7200 rpm
S sdb Form Factor:      3.5 inches
S sdb Device is:        In smartctl database 7.3/5528
S sdb ATA Version is:   ACS-3 T13/2161-D revision 3b
S sdb SATA Version is:  SATA 3.1, 6.0 Gb/s (current: 6.0 Gb/s)
S sdb Local Time is:    Mon Nov 23 17:05:25 2026 PST
S sdb SMART support is: Available - device has SMART capability.
S sdb SMART support is: Enabled
S sdb 
S sdb === START OF READ SMART DATA SECTION ===
S sdb SMART overall-health self-assessment test result: PASSED
S sdb 
S sdb SMART Attributes Data Structure revision number: 16
S sdb Vendor Specific SMART Attributes with Thresholds:
S sdb ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S sdb   1 Raw_Read_Error_Rate     0x002f   200   200   051    Pre-fail  Always       -       0
S sdb   3 Spin_Up_Time            0x0027   184   172   021    Pre-fail  Always       -       1758
S sdb   4 Start_Stop_Count        0x0032   100   100   000    Old_age   Always       -       828
S sdb   5 Reallocated_Sector_Ct   0x0033   200   200   140    Pre-fail  Always       -       0
S sdb   7 Seek_Error_Rate         0x002e   200   200   000    Old_age   Always       -       0
S sdb   9 Power_On_Hours          0x0032   057   056   000    Old_age   Always       -       31581
S sdb  10 Spin_Retry_Count        0x0032   100   100   000    Old_age   Always       -       0
S sdb  11 Calibration_Retry_Count 0x0032   100   100   000    Old_age   Always       -       0
S sdb  12 Power_Cycle_Count       0x0032   100   100   000    Old_age   Always       -       103
S sdb 192 Power-Off_Retract_Count 0x0032   200   200   000    Old_age   Always       -       26
S sdb 193 Load_Cycle_Count        0x0032   177   177   000    Old_age   Always       -       70662
S sdb 194 Temperature_Celsius     0x0022   107   089   000    Old_age   Always       -       36
S sdb 196 Reallocated_Event_Count 0x0032   200   200   000    Old_age   Always       -       0
S sdb 197 Current_Pending_Sector  0x0032   200   200   000    Old_age   Always       -       0
S sdb 198 Offline_Uncorrectable   0x0030   200   200   000    Old_age   Offline      -       0
S sdb 199 UDMA_CRC_Error_Count    0x0032   200   200   000    Old_age   Always       -       0
S sdb 200 Multi_Zone_Error_Rate   0x0008   200   200   000    Old_age   Offline      -       0
S sdb 
STORAGE-END
`;

/** claw-9 again, NOT root: lsblk still answers, smartctl is present but cannot open the device. */
export const CLAW9_NOROOT = `STORAGE-BEGIN v1
storage.root no
storage.smartTool /usr/sbin/smartctl
disk sda
disk.sda.sizeBytes 240057409536
disk.sda.rotational 0
disk.sda.removable 0
disk.sda.model WDC WDS240G2G0A-
disk.sda.scheduler mq-deadline
disk.sda.kind ata
disk.sda.mountpoints /,[SWAP]
P sda NAME="sda" TYPE="disk" SIZE="240057409536" MODEL="WDC WDS240G2G0A-00JH30" SERIAL="SERIAL-claw-9-sda" TRAN="sata" FSTYPE="" UUID="" PTTYPE="dos" LABEL="" MOUNTPOINT=""
P sda NAME="sda1" TYPE="part" SIZE="226609201152" MODEL="" SERIAL="" TRAN="" FSTYPE="ext4" UUID="3aa823ae-6343-47bd-a9e7-521a641ad0b3" PTTYPE="dos" LABEL="" MOUNTPOINT="/"
P sda NAME="sda2" TYPE="part" SIZE="13445824512" MODEL="" SERIAL="" TRAN="" FSTYPE="swap" UUID="60c36a62-a64f-4dc4-8377-007446dc4c12" PTTYPE="dos" LABEL="" MOUNTPOINT="[SWAP]"
S sda smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sda Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sda 
S sda Smartctl open device: /dev/sda failed: Permission denied
disk sdb
disk.sdb.sizeBytes 1000204886016
disk.sdb.rotational 1
disk.sdb.removable 0
disk.sdb.model WDC WD10EZEX-08W
disk.sdb.scheduler mq-deadline
disk.sdb.kind ata
disk.sdb.mountpoints none
P sdb NAME="sdb" TYPE="disk" SIZE="1000204886016" MODEL="WDC WD10EZEX-08WN4A0" SERIAL="SERIAL-claw-9-sdb" TRAN="sata" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
S sdb smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdb Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdb 
S sdb Smartctl open device: /dev/sdb failed: Permission denied
STORAGE-END
`;

/** claw-9 as root with STORAGE_SMARTCTL pointed at nothing: the "no SMART tool" path. No fleet node lacks smartctl (2026-11-23, all reachable claws carry /usr/sbin/smartctl), so this is the one capture whose environment was arranged. */
export const CLAW9_NOTOOL = `STORAGE-BEGIN v1
storage.root yes
storage.smartTool absent
disk sda
disk.sda.sizeBytes 240057409536
disk.sda.rotational 0
disk.sda.removable 0
disk.sda.model WDC WDS240G2G0A-
disk.sda.scheduler mq-deadline
disk.sda.kind ata
disk.sda.mountpoints /,[SWAP]
P sda NAME="sda" TYPE="disk" SIZE="240057409536" MODEL="WDC WDS240G2G0A-00JH30" SERIAL="SERIAL-claw-9-sda" TRAN="sata" FSTYPE="" UUID="" PTTYPE="dos" LABEL="" MOUNTPOINT=""
P sda NAME="sda1" TYPE="part" SIZE="226609201152" MODEL="" SERIAL="" TRAN="" FSTYPE="ext4" UUID="3aa823ae-6343-47bd-a9e7-521a641ad0b3" PTTYPE="dos" LABEL="" MOUNTPOINT="/"
P sda NAME="sda2" TYPE="part" SIZE="13445824512" MODEL="" SERIAL="" TRAN="" FSTYPE="swap" UUID="60c36a62-a64f-4dc4-8377-007446dc4c12" PTTYPE="dos" LABEL="" MOUNTPOINT="[SWAP]"
disk sdb
disk.sdb.sizeBytes 1000204886016
disk.sdb.rotational 1
disk.sdb.removable 0
disk.sdb.model WDC WD10EZEX-08W
disk.sdb.scheduler mq-deadline
disk.sdb.kind ata
disk.sdb.mountpoints none
P sdb NAME="sdb" TYPE="disk" SIZE="1000204886016" MODEL="WDC WD10EZEX-08WN4A0" SERIAL="SERIAL-claw-9-sdb" TRAN="sata" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
STORAGE-END
`;

/** claw-10: two NTFS data disks (sdb GPT, sdc MBR), and sdb has SMART DISABLED — the drive says so, which is not a failure. */
export const CLAW10 = `STORAGE-BEGIN v1
storage.root yes
storage.smartTool /usr/sbin/smartctl
disk sda
disk.sda.sizeBytes 1000204886016
disk.sda.rotational 0
disk.sda.removable 0
disk.sda.model Samsung SSD 870
disk.sda.scheduler mq-deadline
disk.sda.kind ata
disk.sda.mountpoints /,[SWAP]
P sda NAME="sda" TYPE="disk" SIZE="1000204886016" MODEL="Samsung SSD 870 EVO 1TB" SERIAL="SERIAL-claw-10-sda" TRAN="ata" FSTYPE="" UUID="" PTTYPE="dos" LABEL="" MOUNTPOINT=""
P sda NAME="sda1" TYPE="part" SIZE="983116546048" MODEL="" SERIAL="" TRAN="" FSTYPE="ext4" UUID="781ee2c5-5bb4-4b8f-86f4-185f0ec8d5c8" PTTYPE="dos" LABEL="" MOUNTPOINT="/"
P sda NAME="sda2" TYPE="part" SIZE="1024" MODEL="" SERIAL="" TRAN="" FSTYPE="" UUID="" PTTYPE="dos" LABEL="" MOUNTPOINT=""
P sda NAME="sda5" TYPE="part" SIZE="17085497344" MODEL="" SERIAL="" TRAN="" FSTYPE="swap" UUID="3a29b91b-6ea2-45b6-ac31-929813d5cefc" PTTYPE="dos" LABEL="" MOUNTPOINT="[SWAP]"
S sda smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sda Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sda 
S sda === START OF INFORMATION SECTION ===
S sda Model Family:     Samsung based SSDs
S sda Device Model:     Samsung SSD 870 EVO 1TB
S sda Serial Number:    SERIAL-claw-10-sda
S sda LU WWN Device Id: 0 000000 000000000
S sda Firmware Version: SVT01B6Q
S sda User Capacity:    1,000,204,886,016 bytes [1.00 TB]
S sda Sector Size:      512 bytes logical/physical
S sda Rotation Rate:    Solid State Device
S sda Form Factor:      2.5 inches
S sda TRIM Command:     Available, deterministic, zeroed
S sda Device is:        In smartctl database 7.3/5528
S sda ATA Version is:   ACS-4 T13/BSR INCITS 529 revision 5
S sda SATA Version is:  SATA 3.3, 6.0 Gb/s (current: 6.0 Gb/s)
S sda Local Time is:    Mon Nov 23 17:05:26 2026 PST
S sda SMART support is: Available - device has SMART capability.
S sda SMART support is: Enabled
S sda 
S sda === START OF READ SMART DATA SECTION ===
S sda SMART overall-health self-assessment test result: PASSED
S sda 
S sda SMART Attributes Data Structure revision number: 1
S sda Vendor Specific SMART Attributes with Thresholds:
S sda ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S sda   5 Reallocated_Sector_Ct   0x0033   098   098   010    Pre-fail  Always       -       22
S sda   9 Power_On_Hours          0x0032   096   096   000    Old_age   Always       -       19931
S sda  12 Power_Cycle_Count       0x0032   099   099   000    Old_age   Always       -       340
S sda 177 Wear_Leveling_Count     0x0013   098   098   000    Pre-fail  Always       -       34
S sda 179 Used_Rsvd_Blk_Cnt_Tot   0x0013   098   098   010    Pre-fail  Always       -       22
S sda 181 Program_Fail_Cnt_Total  0x0032   100   100   010    Old_age   Always       -       0
S sda 182 Erase_Fail_Count_Total  0x0032   100   100   010    Old_age   Always       -       0
S sda 183 Runtime_Bad_Block       0x0013   098   098   010    Pre-fail  Always       -       22
S sda 187 Uncorrectable_Error_Cnt 0x0032   099   099   000    Old_age   Always       -       2886
S sda 190 Airflow_Temperature_Cel 0x0032   070   057   000    Old_age   Always       -       30
S sda 195 ECC_Error_Rate          0x001a   199   199   000    Old_age   Always       -       2886
S sda 199 CRC_Error_Count         0x003e   100   100   000    Old_age   Always       -       0
S sda 235 POR_Recovery_Count      0x0012   099   099   000    Old_age   Always       -       157
S sda 241 Total_LBAs_Written      0x0032   099   099   000    Old_age   Always       -       75177940727
S sda 
disk sdb
disk.sdb.sizeBytes 3000592982016
disk.sdb.rotational 1
disk.sdb.removable 0
disk.sdb.model ST3000DM001-1CH1
disk.sdb.scheduler mq-deadline
disk.sdb.kind ata
disk.sdb.mountpoints none
P sdb NAME="sdb" TYPE="disk" SIZE="3000592982016" MODEL="ST3000DM001-1CH166" SERIAL="SERIAL-claw-10-sdb" TRAN="ata" FSTYPE="" UUID="" PTTYPE="gpt" LABEL="" MOUNTPOINT=""
P sdb NAME="sdb1" TYPE="part" SIZE="3000591450112" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="D0E43614E435FD72" PTTYPE="gpt" LABEL="Raw Vid Backup" MOUNTPOINT=""
S sdb smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdb Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdb 
S sdb === START OF INFORMATION SECTION ===
S sdb Model Family:     Seagate Barracuda 7200.14 (AF)
S sdb Device Model:     ST3000DM001-1CH166
S sdb Serial Number:    SERIAL-claw-10-sdb
S sdb LU WWN Device Id: 0 000000 000000000
S sdb Firmware Version: CC27
S sdb User Capacity:    3,000,592,982,016 bytes [3.00 TB]
S sdb Sector Sizes:     512 bytes logical, 4096 bytes physical
S sdb Rotation Rate:    7200 rpm
S sdb Form Factor:      3.5 inches
S sdb Device is:        In smartctl database 7.3/5528
S sdb ATA Version is:   ACS-2, ACS-3 T13/2161-D revision 3b
S sdb SATA Version is:  SATA 3.1, 6.0 Gb/s (current: 3.0 Gb/s)
S sdb Local Time is:    Mon Nov 23 17:05:26 2026 PST
S sdb SMART support is: Available - device has SMART capability.
S sdb SMART support is: Disabled
S sdb 
S sdb SMART Disabled. Use option -s with argument 'on' to enable it.
S sdb (override with '-T permissive' option)
disk sdc
disk.sdc.sizeBytes 1000204886016
disk.sdc.rotational 1
disk.sdc.removable 0
disk.sdc.model WDC WD1002FAEX-0
disk.sdc.scheduler mq-deadline
disk.sdc.kind ata
disk.sdc.mountpoints none
P sdc NAME="sdc" TYPE="disk" SIZE="1000204886016" MODEL="WDC WD1002FAEX-00Z3A0" SERIAL="SERIAL-claw-10-sdc" TRAN="ata" FSTYPE="" UUID="" PTTYPE="dos" LABEL="" MOUNTPOINT=""
P sdc NAME="sdc1" TYPE="part" SIZE="1000202043392" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="8E7E69067E68E903" PTTYPE="dos" LABEL="Storage1" MOUNTPOINT=""
S sdc smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdc Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdc 
S sdc === START OF INFORMATION SECTION ===
S sdc Model Family:     Western Digital Caviar Black
S sdc Device Model:     WDC WD1002FAEX-00Z3A0
S sdc Serial Number:    SERIAL-claw-10-sdc
S sdc LU WWN Device Id: 0 000000 000000000
S sdc Firmware Version: 05.01D05
S sdc User Capacity:    1,000,204,886,016 bytes [1.00 TB]
S sdc Sector Size:      512 bytes logical/physical
S sdc Device is:        In smartctl database 7.3/5528
S sdc ATA Version is:   ATA8-ACS (minor revision not indicated)
S sdc SATA Version is:  SATA 3.0, 6.0 Gb/s (current: 3.0 Gb/s)
S sdc Local Time is:    Mon Nov 23 17:05:26 2026 PST
S sdc SMART support is: Available - device has SMART capability.
S sdc SMART support is: Enabled
S sdc 
S sdc === START OF READ SMART DATA SECTION ===
S sdc SMART overall-health self-assessment test result: PASSED
S sdc 
S sdc SMART Attributes Data Structure revision number: 16
S sdc Vendor Specific SMART Attributes with Thresholds:
S sdc ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S sdc   1 Raw_Read_Error_Rate     0x002f   200   200   051    Pre-fail  Always       -       0
S sdc   3 Spin_Up_Time            0x0027   174   165   021    Pre-fail  Always       -       4266
S sdc   4 Start_Stop_Count        0x0032   087   087   000    Old_age   Always       -       13495
S sdc   5 Reallocated_Sector_Ct   0x0033   200   200   140    Pre-fail  Always       -       0
S sdc   7 Seek_Error_Rate         0x002e   200   200   000    Old_age   Always       -       0
S sdc   9 Power_On_Hours          0x0032   039   039   000    Old_age   Always       -       45005
S sdc  10 Spin_Retry_Count        0x0032   100   100   000    Old_age   Always       -       0
S sdc  11 Calibration_Retry_Count 0x0032   100   100   000    Old_age   Always       -       0
S sdc  12 Power_Cycle_Count       0x0032   098   098   000    Old_age   Always       -       2839
S sdc 192 Power-Off_Retract_Count 0x0032   200   200   000    Old_age   Always       -       88
S sdc 193 Load_Cycle_Count        0x0032   196   196   000    Old_age   Always       -       13406
S sdc 194 Temperature_Celsius     0x0022   112   104   000    Old_age   Always       -       35
S sdc 196 Reallocated_Event_Count 0x0032   200   200   000    Old_age   Always       -       0
S sdc 197 Current_Pending_Sector  0x0032   200   200   000    Old_age   Always       -       0
S sdc 198 Offline_Uncorrectable   0x0030   200   200   000    Old_age   Offline      -       0
S sdc 199 UDMA_CRC_Error_Count    0x0032   200   200   000    Old_age   Always       -       0
S sdc 200 Multi_Zone_Error_Rate   0x0008   200   200   000    Old_age   Offline      -       0
S sdc 
STORAGE-END
`;

/** claw-4: SSD root, a second 1TB SATA disk with a partition, and a USB card reader (sdc-sdf) whose bridge hides SMART; empty slots read 0 bytes. */
export const CLAW4 = `STORAGE-BEGIN v1
storage.root yes
storage.smartTool /usr/sbin/smartctl
disk sda
disk.sda.sizeBytes 1000204886016
disk.sda.rotational 0
disk.sda.removable 0
disk.sda.model WDC  WDS100T2B0B
disk.sda.scheduler mq-deadline
disk.sda.kind ata
disk.sda.mountpoints /boot/efi,/,[SWAP]
P sda NAME="sda" TYPE="disk" SIZE="1000204886016" MODEL="WDC WDS100T2B0B-00YS70" SERIAL="SERIAL-claw-4-sda" TRAN="sata" FSTYPE="" UUID="" PTTYPE="gpt" LABEL="" MOUNTPOINT=""
P sda NAME="sda1" TYPE="part" SIZE="1023410176" MODEL="" SERIAL="" TRAN="" FSTYPE="vfat" UUID="614B-C837" PTTYPE="gpt" LABEL="" MOUNTPOINT="/boot/efi"
P sda NAME="sda2" TYPE="part" SIZE="982064824320" MODEL="" SERIAL="" TRAN="" FSTYPE="ext4" UUID="d6d2cf64-91b3-49a5-b690-e711c1abec20" PTTYPE="gpt" LABEL="" MOUNTPOINT="/"
P sda NAME="sda3" TYPE="part" SIZE="17114857472" MODEL="" SERIAL="" TRAN="" FSTYPE="swap" UUID="069c122c-b2c9-4b7d-a6b0-36c998d7fd25" PTTYPE="gpt" LABEL="" MOUNTPOINT="[SWAP]"
S sda smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sda Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sda 
S sda === START OF INFORMATION SECTION ===
S sda Model Family:     WD Blue / Red / Green SSDs
S sda Device Model:     WDC  WDS100T2B0B-00YS70
S sda Serial Number:    SERIAL-claw-4-sda
S sda LU WWN Device Id: 0 000000 000000000
S sda Firmware Version: 401000WD
S sda User Capacity:    1,000,204,886,016 bytes [1.00 TB]
S sda Sector Size:      512 bytes logical/physical
S sda Rotation Rate:    Solid State Device
S sda Form Factor:      M.2
S sda TRIM Command:     Available, deterministic, zeroed
S sda Device is:        In smartctl database 7.3/5528
S sda ATA Version is:   ACS-4 T13/BSR INCITS 529 revision 5
S sda SATA Version is:  SATA 3.3, 6.0 Gb/s (current: 6.0 Gb/s)
S sda Local Time is:    Mon Nov 23 17:05:27 2026 PST
S sda SMART support is: Available - device has SMART capability.
S sda SMART support is: Enabled
S sda 
S sda === START OF READ SMART DATA SECTION ===
S sda SMART overall-health self-assessment test result: PASSED
S sda 
S sda SMART Attributes Data Structure revision number: 4
S sda Vendor Specific SMART Attributes with Thresholds:
S sda ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S sda   5 Reallocated_Sector_Ct   0x0032   100   100   ---    Old_age   Always       -       0
S sda   9 Power_On_Hours          0x0032   100   100   ---    Old_age   Always       -       16344
S sda  12 Power_Cycle_Count       0x0032   100   100   ---    Old_age   Always       -       1416
S sda 165 Block_Erase_Count       0x0032   100   100   ---    Old_age   Always       -       90289472612
S sda 166 Minimum_PE_Cycles_TLC   0x0032   100   100   ---    Old_age   Always       -       1
S sda 167 Max_Bad_Blocks_per_Die  0x0032   100   100   ---    Old_age   Always       -       39
S sda 168 Maximum_PE_Cycles_TLC   0x0032   100   100   ---    Old_age   Always       -       17
S sda 169 Total_Bad_Blocks        0x0032   100   100   ---    Old_age   Always       -       499
S sda 170 Grown_Bad_Blocks        0x0032   100   100   ---    Old_age   Always       -       0
S sda 171 Program_Fail_Count      0x0032   100   100   ---    Old_age   Always       -       0
S sda 172 Erase_Fail_Count        0x0032   100   100   ---    Old_age   Always       -       0
S sda 173 Average_PE_Cycles_TLC   0x0032   100   100   ---    Old_age   Always       -       8
S sda 174 Unexpected_Power_Loss   0x0032   100   100   ---    Old_age   Always       -       30
S sda 184 End-to-End_Error        0x0032   100   100   ---    Old_age   Always       -       0
S sda 187 Reported_Uncorrect      0x0032   100   100   ---    Old_age   Always       -       0
S sda 188 Command_Timeout         0x0032   100   100   ---    Old_age   Always       -       0
S sda 194 Temperature_Celsius     0x0022   064   060   ---    Old_age   Always       -       36 (Min/Max 14/60)
S sda 199 UDMA_CRC_Error_Count    0x0032   100   100   ---    Old_age   Always       -       0
S sda 230 Media_Wearout_Indicator 0x0032   002   002   ---    Old_age   Always       -       0x021800500218
S sda 232 Available_Reservd_Space 0x0033   100   100   004    Pre-fail  Always       -       100
S sda 233 NAND_GB_Written_TLC     0x0032   100   100   ---    Old_age   Always       -       8265
S sda 234 NAND_GB_Written_SLC     0x0032   100   100   ---    Old_age   Always       -       26752
S sda 241 Host_Writes_GiB         0x0030   253   253   ---    Old_age   Offline      -       22043
S sda 242 Host_Reads_GiB          0x0030   253   253   ---    Old_age   Offline      -       18475
S sda 244 Temp_Throttle_Status    0x0032   000   100   ---    Old_age   Always       -       0
S sda 
disk sdb
disk.sdb.sizeBytes 1000204886016
disk.sdb.rotational 1
disk.sdb.removable 0
disk.sdb.model ST1000DM003-1SB1
disk.sdb.scheduler mq-deadline
disk.sdb.kind ata
disk.sdb.mountpoints none
P sdb NAME="sdb" TYPE="disk" SIZE="1000204886016" MODEL="ST1000DM003-1SB102" SERIAL="SERIAL-claw-4-sdb" TRAN="sata" FSTYPE="" UUID="" PTTYPE="gpt" LABEL="" MOUNTPOINT=""
P sdb NAME="sdb1" TYPE="part" SIZE="524288000" MODEL="" SERIAL="" TRAN="" FSTYPE="vfat" UUID="0EDA-9E18" PTTYPE="gpt" LABEL="ESP" MOUNTPOINT=""
P sdb NAME="sdb2" TYPE="part" SIZE="134217728" MODEL="" SERIAL="" TRAN="" FSTYPE="" UUID="" PTTYPE="gpt" LABEL="" MOUNTPOINT=""
P sdb NAME="sdb3" TYPE="part" SIZE="554495377408" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="3216EC2616EBE8B5" PTTYPE="gpt" LABEL="New Volume" MOUNTPOINT=""
P sdb NAME="sdb4" TYPE="part" SIZE="901775360" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="9882CF1282CEF3B2" PTTYPE="gpt" LABEL="" MOUNTPOINT=""
P sdb NAME="sdb5" TYPE="part" SIZE="429496729600" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="44A2B614A2B60A86" PTTYPE="gpt" LABEL="New Volume" MOUNTPOINT=""
P sdb NAME="sdb6" TYPE="part" SIZE="471859200" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="CABCD84DBCD835A3" PTTYPE="gpt" LABEL="WINRETOOLS" MOUNTPOINT=""
P sdb NAME="sdb7" TYPE="part" SIZE="14176747520" MODEL="" SERIAL="" TRAN="" FSTYPE="ntfs" UUID="7ED2D94CD2D908F3" PTTYPE="gpt" LABEL="Image" MOUNTPOINT=""
S sdb smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdb Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdb 
S sdb === START OF INFORMATION SECTION ===
S sdb Model Family:     Seagate Barracuda 7200.14 (AF)
S sdb Device Model:     ST1000DM003-1SB102
S sdb Serial Number:    SERIAL-claw-4-sdb
S sdb LU WWN Device Id: 0 000000 000000000
S sdb Firmware Version: CC43
S sdb User Capacity:    1,000,204,886,016 bytes [1.00 TB]
S sdb Sector Sizes:     512 bytes logical, 4096 bytes physical
S sdb Rotation Rate:    7200 rpm
S sdb Form Factor:      3.5 inches
S sdb Device is:        In smartctl database 7.3/5528
S sdb ATA Version is:   ATA8-ACS T13/1699-D revision 4
S sdb SATA Version is:  SATA 3.0, 6.0 Gb/s (current: 6.0 Gb/s)
S sdb Local Time is:    Mon Nov 23 17:05:27 2026 PST
S sdb SMART support is: Available - device has SMART capability.
S sdb SMART support is: Enabled
S sdb 
S sdb === START OF READ SMART DATA SECTION ===
S sdb SMART overall-health self-assessment test result: PASSED
S sdb 
S sdb SMART Attributes Data Structure revision number: 10
S sdb Vendor Specific SMART Attributes with Thresholds:
S sdb ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
S sdb   1 Raw_Read_Error_Rate     0x000f   100   063   006    Pre-fail  Always       -       2286065
S sdb   3 Spin_Up_Time            0x0003   097   097   000    Pre-fail  Always       -       0
S sdb   4 Start_Stop_Count        0x0032   085   085   020    Old_age   Always       -       16135
S sdb   5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       0
S sdb   7 Seek_Error_Rate         0x000f   078   060   045    Pre-fail  Always       -       72833838
S sdb   9 Power_On_Hours          0x0032   080   080   000    Old_age   Always       -       17774
S sdb  10 Spin_Retry_Count        0x0013   100   100   097    Pre-fail  Always       -       0
S sdb  12 Power_Cycle_Count       0x0032   099   099   020    Old_age   Always       -       2022
S sdb 183 Runtime_Bad_Block       0x0032   100   100   000    Old_age   Always       -       0
S sdb 184 End-to-End_Error        0x0032   100   100   099    Old_age   Always       -       0
S sdb 187 Reported_Uncorrect      0x0032   100   100   000    Old_age   Always       -       0
S sdb 188 Command_Timeout         0x0032   100   100   000    Old_age   Always       -       0 0 0
S sdb 189 High_Fly_Writes         0x003a   100   100   000    Old_age   Always       -       0
S sdb 190 Airflow_Temperature_Cel 0x0022   069   060   040    Old_age   Always       -       31 (Min/Max 24/32)
S sdb 193 Load_Cycle_Count        0x0032   092   092   000    Old_age   Always       -       16768
S sdb 194 Temperature_Celsius     0x0022   031   013   000    Old_age   Always       -       31 (0 13 0 0 0)
S sdb 195 Hardware_ECC_Recovered  0x001a   100   001   000    Old_age   Always       -       2286065
S sdb 197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       0
S sdb 198 Offline_Uncorrectable   0x0010   100   100   000    Old_age   Offline      -       0
S sdb 199 UDMA_CRC_Error_Count    0x003e   200   200   000    Old_age   Always       -       0
S sdb 240 Head_Flying_Hours       0x0000   100   253   000    Old_age   Offline      -       11152h+15m+30.868s
S sdb 241 Total_LBAs_Written      0x0000   100   253   000    Old_age   Offline      -       14393775273
S sdb 242 Total_LBAs_Read         0x0000   100   253   000    Old_age   Offline      -       10901879349
S sdb 
disk sdc
disk.sdc.sizeBytes 0
disk.sdc.rotational 0
disk.sdc.removable 1
disk.sdc.model Compact Flash
disk.sdc.scheduler mq-deadline
disk.sdc.kind ata
disk.sdc.mountpoints none
P sdc NAME="sdc" TYPE="disk" SIZE="0" MODEL="Compact Flash" SERIAL="SERIAL-claw-4-sdf" TRAN="usb" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
S sdc smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdc Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdc 
S sdc /dev/sdc: Unknown USB bridge [0x058f:0x6362 (0x100)]
S sdc Please specify device type with the -d option.
S sdc 
S sdc Use smartctl -h to get a usage summary
S sdc 
disk sdd
disk.sdd.sizeBytes 0
disk.sdd.rotational 0
disk.sdd.removable 1
disk.sdd.model SD/MMC
disk.sdd.scheduler mq-deadline
disk.sdd.kind ata
disk.sdd.mountpoints none
P sdd NAME="sdd" TYPE="disk" SIZE="0" MODEL="SD/MMC" SERIAL="SERIAL-claw-4-sdf" TRAN="usb" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
S sdd smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdd Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdd 
S sdd /dev/sdd: Unknown USB bridge [0x058f:0x6362 (0x100)]
S sdd Please specify device type with the -d option.
S sdd 
S sdd Use smartctl -h to get a usage summary
S sdd 
disk sde
disk.sde.sizeBytes 0
disk.sde.rotational 0
disk.sde.removable 1
disk.sde.model MS/MS-PRO
disk.sde.scheduler mq-deadline
disk.sde.kind ata
disk.sde.mountpoints none
P sde NAME="sde" TYPE="disk" SIZE="0" MODEL="MS/MS-PRO" SERIAL="SERIAL-claw-4-sdf" TRAN="usb" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
S sde smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sde Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sde 
S sde /dev/sde: Unknown USB bridge [0x058f:0x6362 (0x100)]
S sde Please specify device type with the -d option.
S sde 
S sde Use smartctl -h to get a usage summary
S sde 
disk sdf
disk.sdf.sizeBytes 0
disk.sdf.rotational 0
disk.sdf.removable 1
disk.sdf.model xD-Picture
disk.sdf.scheduler mq-deadline
disk.sdf.kind ata
disk.sdf.mountpoints none
P sdf NAME="sdf" TYPE="disk" SIZE="0" MODEL="xD-Picture" SERIAL="SERIAL-claw-4-sdf" TRAN="usb" FSTYPE="" UUID="" PTTYPE="" LABEL="" MOUNTPOINT=""
S sdf smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.117+deb13-amd64] (local build)
S sdf Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S sdf 
S sdf /dev/sdf: Unknown USB bridge [0x058f:0x6362 (0x100)]
S sdf Please specify device type with the -d option.
S sdf 
S sdf Use smartctl -h to get a usage summary
S sdf 
STORAGE-END
`;

/** claw-2: one NVMe, the key/value SMART log shape. */
export const CLAW2 = `STORAGE-BEGIN v1
storage.root yes
storage.smartTool /usr/sbin/smartctl
disk nvme0n1
disk.nvme0n1.sizeBytes 128035676160
disk.nvme0n1.rotational 0
disk.nvme0n1.removable 0
disk.nvme0n1.model SAMSUNG KUS020203M-B000
disk.nvme0n1.scheduler none
disk.nvme0n1.kind nvme
disk.nvme0n1.mountpoints /boot/efi,/,[SWAP]
P nvme0n1 NAME="nvme0n1" TYPE="disk" SIZE="128035676160" MODEL="SAMSUNG KUS020203M-B000" SERIAL="SERIAL-claw-2-nvme0n1" TRAN="nvme" FSTYPE="" UUID="" PTTYPE="gpt" LABEL="" MOUNTPOINT=""
P nvme0n1 NAME="nvme0n1p1" TYPE="part" SIZE="1023410176" MODEL="" SERIAL="" TRAN="nvme" FSTYPE="vfat" UUID="B25A-5A9A" PTTYPE="gpt" LABEL="" MOUNTPOINT="/boot/efi"
P nvme0n1 NAME="nvme0n1p2" TYPE="part" SIZE="120401690624" MODEL="" SERIAL="" TRAN="nvme" FSTYPE="ext4" UUID="591acf4e-befb-4c1f-91c6-325cb8bd0e26" PTTYPE="gpt" LABEL="" MOUNTPOINT="/"
P nvme0n1 NAME="nvme0n1p3" TYPE="part" SIZE="6609174528" MODEL="" SERIAL="" TRAN="nvme" FSTYPE="swap" UUID="6002a2b8-1d18-4321-a86f-8afed00f2bc9" PTTYPE="gpt" LABEL="" MOUNTPOINT="[SWAP]"
S nvme0n1 smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.18.7-surface-1] (local build)
S nvme0n1 Copyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org
S nvme0n1 
S nvme0n1 === START OF INFORMATION SECTION ===
S nvme0n1 Model Number:                       SAMSUNG KUS020203M-B000
S nvme0n1 Serial Number:                      SERIAL-claw-2-nvme0n1
S nvme0n1 Firmware Version:                   DXB86M1Q
S nvme0n1 PCI Vendor/Subsystem ID:            0x144d
S nvme0n1 IEEE OUI Identifier:                0x002538
S nvme0n1 Total NVM Capacity:                 128,035,676,160 [128 GB]
S nvme0n1 Unallocated NVM Capacity:           0
S nvme0n1 Controller ID:                      3
S nvme0n1 NVMe Version:                       1.2
S nvme0n1 Number of Namespaces:               1
S nvme0n1 Namespace 1 Size/Capacity:          128,035,676,160 [128 GB]
S nvme0n1 Namespace 1 Utilization:            73,188,696,064 [73.1 GB]
S nvme0n1 Namespace 1 Formatted LBA Size:     512
S nvme0n1 Local Time is:                      Mon Nov 23 17:05:27 2026 PST
S nvme0n1 
S nvme0n1 === START OF SMART DATA SECTION ===
S nvme0n1 SMART overall-health self-assessment test result: PASSED
S nvme0n1 
S nvme0n1 SMART/Health Information (NVMe Log 0x02)
S nvme0n1 Critical Warning:                   0x00
S nvme0n1 Temperature:                        62 Celsius
S nvme0n1 Available Spare:                    100%
S nvme0n1 Available Spare Threshold:          10%
S nvme0n1 Percentage Used:                    7%
S nvme0n1 Data Units Read:                    10,844,859 [5.55 TB]
S nvme0n1 Data Units Written:                 22,086,246 [11.3 TB]
S nvme0n1 Host Read Commands:                 224,863,764
S nvme0n1 Host Write Commands:                284,848,536
S nvme0n1 Controller Busy Time:               1,669
S nvme0n1 Power Cycles:                       54
S nvme0n1 Power On Hours:                     530
S nvme0n1 Unsafe Shutdowns:                   23
S nvme0n1 Media and Data Integrity Errors:    0
S nvme0n1 Error Information Log Entries:      73
S nvme0n1 Warning  Comp. Temperature Time:    0
S nvme0n1 Critical Comp. Temperature Time:    0
S nvme0n1 Temperature Sensor 1:               62 Celsius
S nvme0n1 
STORAGE-END
`;
