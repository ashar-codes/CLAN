# Mobile whiteboard text reliability, RC1

The prior Android logs (`design/beta/v0.1.0/xdF*.txt`, `xdD1.txt`) prove that the test sometimes failed to observe
phone text on the host within 40 seconds. They did not capture a local board commit, operation ID, socket state, host
acknowledgment or persisted row. They therefore cannot distinguish a missed tap from a lost/delayed operation. The
screen shown after `xdD1` was produced by the harness teardown.

The first instrumented RC run reproduced the input failure: a [native screenshot](../design/beta/v0.1.0-rc1/whiteboard-input-failure.png) shows the keyboard covering the inline
**Add** button below the 420 px canvas. UI automation found the offscreen button in the accessibility tree and tapped
its stale bounds; no local text object appeared. The editor now opens in a top-positioned accessible modal, with Add and
Cancel visible above the keyboard. The outer in-class `ScrollView` also preserves child taps while typing. Independently,
code inspection found a delivery gap: once committed, the mobile
connection could silently drop `wb.ops` when its socket was not open; the board retained the operation but retried only
after a reconnect snapshot. It also ignored the durable host `wb.ack`. A transient send race on an otherwise established
session could leave an optimistic local object absent from the host indefinitely. Host permission checks, append-only
operation IDs and acknowledgment-after-persistence were already correct and remain unchanged.

RC1 preserves the existing operation protocol and reducer. Child taps survive the keyboard. A transport-only pending
queue retries the **same** IDs at a bounded interval until the host ack or echoed operation, replays after a reconnect,
and removes rejected IDs on `wb.nack` before requesting host truth. Duplicate delivery is safe because the host stores
unique operation IDs. Deterministic queue tests cover dropped send/retry, duplicate and delayed ack, reconnect, thrown
send and rejection; the existing host tests cover duplicate persistence, ordered replay and permission denial.

The cross-device harness now uses a disposable eight-hex-character text suffix, checks for the text in the phone's
native board accessibility layer immediately after one Add tap, then checks the host's persisted board. The local-only
headless host reports the first 12 hex characters of SHA-256(op ID), which provides a sanitized correlation marker
without logging content beyond disposable test text or exposing the raw ID. A local-commit failure means input/automation;
a committed local object absent at the host means transport/ack/persistence; an acknowledged host row absent on the
phone means broadcast/rendering. This instrumentation does not assert which path caused the historical failures.
