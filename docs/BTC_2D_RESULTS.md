# BTC-2D — consent-scoped remote desktop control

Branch: `btc-2df-control-timetable`, based on BTC-2B+C `5226456b382cad2048297eab2ebfd5ed49d08438`.

## Implementation and trust boundary

RemoteControl has its own protocol, bounded consent policy, meeting adapter and platform adapters. It has no Timetable dependencies. A current authenticated meeting participant requests a real screen-track SID; sharing alone grants nothing. The sharing computer presents verified identity/fingerprint in a native consent dialog. Approval grants at most three minutes to one controller, bound to both current participant leases, meeting, screen and hosting authority. Requests expire in 30 seconds. Removal, blocking, host fencing, screen stop, network loss, controller navigation and explicit emergency stop revoke access.

Input traverses the existing authenticated pinned-TLS meeting host. **The host can access input; this is not host-blind E2EE.** Nothing logs keys or clipboard. Input supports normalized pointer movement/click/drag, bounded scroll, short Unicode text and a small navigation-key allowlist. No modifiers/system shortcuts, clipboard, remote filesystem, commands, unattended access or persistent grants. Ordered input coalesces movements; uncertain delivery never retries input. Queues, packet sizes and rates are bounded. Viewer GET requests cannot consume input or keep a native target heartbeat alive.

macOS uses CGEvent plus normal Accessibility, Input Monitoring and Screen Recording permissions. Windows uses non-elevated SendInput, rejects elevated/protected targets and non-default input desktops. Native monitoring stops on local keyboard/mouse activity. Native heartbeat expires after one second, independently of renderer/server timers. Native heartbeat and three-minute deadlines use monotonic clocks, so wall-clock rollback cannot prolong injection. Capture tickets bind the selected display to the exact meeting, published screen SID and renderer owner; legacy/window capture or a new selection cannot reuse a previous control binding. Whole selected displays are supported; window-only remote input is intentionally unavailable because safe window-scoped injection is not implemented. Keyboard focus must stay within the shared display. Mobile devices are controllers only: approved screen view, explicit drag mode, touchpad/tap/scroll and constrained text controls; no mobile controlled-host API.

## Evidence at this checkpoint

- PASS: eight independent policy/sender/coordinate tests: consent, rejection, identity/lease binding, replay, expiry, disconnect, controller replacement, stale scoped revocation, queue/rate limits, ordered button edges and fail-closed delivery.
- PASS: actual local LiveKit integration authenticates both participants, discovers an actual published screen track, requires consent, rejects forged credentials/replay, and revokes on membership removal.
- PASS: Mac Swift native compilation and ad-hoc signature; actual OS-authorized typing into a disposable Electron window and rejection after stop. Existing installed CLAN profiles were not used or changed.
- PASS: full desktop/mobile shared interface typecheck at this checkpoint.
- NOT TESTED at this checkpoint: Windows native runtime/UIPI, physical multi-monitor resizing, lock/protected prompts, physical permission denial/revocation and four-platform cross-device control. Windows compilation/CI and mobile compilation results are recorded in the combined verification document when completed.

No installer was rebuilt. Build the native helper with `sh native/remote-control/build.sh`; desktop packaging requires and bundles its platform helper. Normal OS permission approval is required; no security policy or Hardened Runtime setting is disabled. Future signed packaging must sign embedded helpers consistently with the application.

## Acceptance

The bounded authenticated implementation and available Mac native fixture pass. The complete physical four-platform acceptance gate remains **INCOMPLETE**, not a claim of release readiness. Validate the sharing indicator, emergency stop, local-input priority, screen stop, disconnect, permission revocation and DPI/multiple-display behavior on real Mac/Windows hosts and Android/iPhone controllers before distribution.
