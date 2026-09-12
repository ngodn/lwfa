# Physical sticks stop updating on iPad

Investigated on 2026-09-12, Asia/Kuala_Lumpur, after the 1.5.8 release.

The user reports both physical sticks stopped working while buttons still
worked. No service restart or configuration change was performed during this
investigation. Logs show prior service restarts around 16:29.

## Measurements

The passive Linux recording from 16:31:07 to 16:32:37 captured three A presses
and one left-stick click on the production controller at `/dev/input/event23`.
There were no EV_ABS events and no SYN_DROPPED events. This recording is at
`/tmp/lwfa-sticks-20260912.json`.

The later browser recording, supplied as
`/home/eins0fx/Uploads/lwfa-controller-trace (1).json`, started at 16:39:52.
It contains all 3,526 samples over 42.364 seconds, with no ring-buffer truncation.
It identifies Chrome 150 on iPadOS 26.6 and an
`8BitDo Ultimate 2 Wireless Extended Gamepad` with standard mapping.

All four raw axis values remained exactly constant:

| Axis | Value throughout recording |
| --- | --- |
| Left X | -0.14515408873558044 |
| Left Y | -0.9925400614738464 |
| Right X | 0 |
| Right Y | 0 |

The same recording contains 45 button presses, 90 forwarded button messages,
and zero axis messages. Gamepad timestamps have 90 distinct values. Every
sample reports the page focused, visible, connected, and forwarding; the
largest polling gap is 32 ms.

## Interpretation and next check

`diagnostics.ts` copies the raw `navigator.getGamepads()` axes. Recovery and
polling create separate snapshots and do not mutate those raw arrays. The
recorded stick values therefore stopped changing before lwfa's filtering and
transport. The trace does not distinguish a controller/connection problem from
an iPadOS/browser input-provider problem. The two recordings are separate tests,
not synchronized captures of the same events.

The requested check was to power-cycle only the physical controller. The user
instead restarted the iPad and reported that both sticks work again. This
supports a failure in the iPad-side input path, but restarting also resets the
browser and controller connection, so it does not isolate iPadOS itself.
The passive follow-up recording is `/tmp/lwfa-sticks-reconnect-20260912.json`;
it cannot establish which action restored input without a matching timeline.
No engine code change is justified by this evidence alone.
