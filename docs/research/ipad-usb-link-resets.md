# iPad USB disconnects and the hanging installer

Updated 2026-09-13, Asia/Kuala_Lumpur. Installation previously stopped at
`[Installing] 100%`; another attempt reported `muxError`. That progress line
alone does not establish that installation and verification completed.

## Current measurements

The iPad initially used the ASMedia hub at `2-9`, port 2. The earlier Claude
investigation recorded repeated kernel SuperSpeed resets and a `hub_event`
stack calling `usb_reset_device`. That identifies the kernel path performing
the reset. It does not prove that the cable, hub hardware, or software is the
underlying cause.

During the follow-up investigation the iPad moved to root port `2-3` on Intel
controller `0000:00:14.0`, at 10000 Mbit/s. This showed a different pattern:
USB disconnect and fresh enumeration, often every three seconds, rather than
only a warm reset of the existing device. usbmuxd exited after removal and
started on arrival. Its service restart counter was zero; these were not
observed daemon crashes.

- At 04:33:40, usbmuxd was temporarily runtime-masked for 20 seconds and then
  automatically restored. After one final enumeration at 04:33:42, the link
  stayed present until restoration. Disconnects resumed afterward. The stock
  udev rule leaves a new device unconfigured until usbmuxd configures it, so
  this test does not distinguish a daemon bug from a problem with the active
  USB configuration or its drivers/power state.
- At 04:36, device handshakes began succeeding. An extended test obtained five
  successful iPadOS version reads, followed by an SSL handshake failure at
  04:37:41 and a kernel disconnect at 04:37:42. A successful short check is
  therefore insufficient evidence of a repaired link.
- At 04:38:11, `idevicepair validate` succeeded and `ideviceinfo` returned
  iPadOS 26.6.2. Repeated Trust requests are not the remedy for an already
  validated pairing interrupted by transport loss.
- An attempted per-device U1/U2 power-management test made no change. The
  `power/usb3_hardware_lpm_u1` and `u2` attributes are read-only. The kernel's
  supported control is the port's `usb3_lpm_permit`, not these status files.
  That first attempt did not change the port policy.
- At 04:39:45, the first installation retry failed in the new preflight with
  an SSL handshake error alongside another kernel disconnect. Pairing
  validation succeeded again afterward.
- At 04:41:18, a bounded test set only the verified iPad root port's
  `usb3_lpm_permit` to `0`. Both device U1/U2 status files then read `disabled`.
  The original `u1_u2` policy was scheduled for automatic restoration after
  three minutes. No controller or hub reset was used.
- During this test, `bash scripts/install-ios.sh` installed LWFA 0.2.9 (9),
  reached `[Verifying] 100%`, printed `Successfully installed!`, and exited 0.
  This verifies that installation attempt, not a permanent repair of the
  intermittent transport fault.
- The full 04:41:18 to 04:44:18 interval had zero disconnects and repeated
  successful handshakes. Restoring `u1_u2` at 04:44:18 brought the first
  disconnect at 04:44:20, followed by repeated disconnects at 04:44:23,
  04:44:26, 04:44:28 and 04:44:29. This reversal supports port link power
  management as the trigger on this connection.
- The user approved disabling power saving until reboot. The verified iPad
  port was set back to `0`; both U1/U2 status files read `disabled` and device
  handshakes resumed. This is runtime-only and applies to root port `2-3`.
  It is not a global USB autosuspend setting or a persistent udev rule.

Installed versions: usbmuxd 1.1.1-4, libusbmuxd 2.1.1-2,
libimobiledevice 1.4.0-2, libusb 1.0.30-1, kernel 7.1.8-1-eins0fx-lto.

## Installer changes

`scripts/ios-usb-preflight.sh` checks USB discovery and performs three bounded
lockdown handshakes before authentication. The installer checks the same
selected device again after authentication, then passes its UDID explicitly
to xtool. Missing devices, handshake failures, and devices lost during these
checks now stop installation rather than print a warning and wait indefinitely.
This does not prevent a subsequent USB failure during transfer.

`python3 scripts/test-ios-usb-preflight.py` exercises missing devices, discovery
failure, failed handshakes, disconnects before/after authentication, ambiguous
selection, explicit selection, and successful installation dispatch using fake
transport tools. These tests verify script behavior, not USB hardware stability.

## System changes and storage protection

The two active Claude processes working in lwfa were terminated at the user's
request to prevent concurrent USB changes. The temporary usbmuxd mask was removed
and the service restored. No pairing records were deleted or printed.

The earlier global LPM quirk had already been removed. Both old hub port-disable
flags were zero when checked, so the previously documented USB 2 workaround was
no longer in effect. No persistent USB settings were added in this follow-up.

The dgnrt backing drive is USB storage, not unrelated to USB: it uses `/dev/sda`
through UAS at `4-2`, on separate controller `0000:02:00.0`. Its decrypted btrfs
filesystem is mounted at `/run/media/eins0fx/theark`. No controller reset,
storage unbind, dgnrt file modification, or dgnrt service restart was performed.

## Sources and limits

- [usbmuxd upstream](https://github.com/libimobiledevice/usbmuxd) documents udev
  activation, last-device exit, and pairing-record ownership.
- [Linux USB ABI](https://github.com/torvalds/linux/blob/master/Documentation/ABI/testing/sysfs-bus-usb)
  documents the per-port `usb3_lpm_permit` interface.
- [Linux USB sysfs implementation](https://github.com/torvalds/linux/blob/master/drivers/usb/core/sysfs.c)
  marks the USB 3 U1/U2 device attributes read-only.
- [libimobiledevice issue 1325](https://github.com/libimobiledevice/libimobiledevice/issues/1325)
  and [usbmuxd issue 92](https://github.com/libimobiledevice/usbmuxd/issues/92)
  concern missing-device recovery. They do not establish the cause of these
  direct-port disconnects or prove that installing usbmuxd-git fixes them.
- [usbmuxd issue 238](https://github.com/libimobiledevice/usbmuxd/issues/238)
  concerns a Mac attached as if it were an iOS device. It does not support the
  earlier claim that usbmuxd-git fixes this iPad's rediscovery.

Disabling this port's U1/U2 link power management is a reproduced workaround.
The deeper reason this iPad/controller combination fails with U1/U2 enabled
has not been isolated to a specific kernel, firmware, or device defect.
