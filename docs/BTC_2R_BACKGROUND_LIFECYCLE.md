# BTC-2R background lifecycle

| OS/state | Actual contract |
| --- | --- |
| Mac/Windows, window closed | Explicit Keep tray preference preserves window/renderer/main networking. Default close quits. Persistent local setting; Quit always terminates availability. |
| Mac/Windows login | Separate explicit packaged-app tray checkbox uses Electron supported login API; disabled for development runtime. No automatic opt-in. Physical login/reboot behavior remains NOT TESTED. |
| Desktop sleep/offline/terminated | Unavailable; resume/interface poll wakes retry and rebinds discovery. A listener or advertisement alone is not authenticated presence. |
| Android foreground | Native TCP sockets plus in-process signed/encrypted People transport; UI entry is not needed after runtime initialization. |
| Android background/locked, Keep enabled | Visible connected-device foreground service, partial wake lock, native retry pulses and native link-property/network callbacks keep the in-process React Native runtime active subject to OS/OEM policy. Camera/mic are not activated to receive invitations. Notification Stop and explicit availability controls remain authoritative. |
| Android process killed/force-stop/reboot | NOT_STICKY, no headless authenticated process recreation or boot startup. No promise of continued availability. User must open once; Keep preferences restore only in foreground after permissions. Do not claim this as an always-running native independent service. |
| iOS active/resume | Foreground native transport; resume clears discovery state and retries pinned authenticated networking. |
| iOS background/suspended/terminated | No guaranteed LAN listening. Current calls/capture follow existing OS constraints. No PushKit/APNs service deployed. |

Android diagnostics show real service running, battery optimization and background restriction state. Users may inspect Settings → Apps → CLAN → Notifications/Battery and Xiaomi autostart/battery controls themselves; CLAN never alters these silently. Force-stop cannot be bypassed. Native pulses replace reliance on background JS intervals, but still require the app process/JS event loop. Process recreation is an outstanding architectural limitation, not falsely marked fixed.

Reliable suspended-iOS incoming calls require provisioned APNs/PushKit and CallKit, signed bounded invitations, an explicitly authorized internet push path, and Apple policy-compliant call handling. Credentials/infrastructure/consent are absent. No misleading background entitlement or external account/service was introduced. Local notifications cannot awaken an absent LAN listener.

OS API references: [Android connected-device foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types), [Apple VoIP PushKit/CallKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit), [Electron login settings](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows). Connected-device prerequisites use existing network-change permission; microphone service type is added only for an explicitly accepted active call. No camera type or push credentials are invented.

Native pulses also enforce the direct session's existing 20-second unanswered-request and 45-second liveness deadlines using elapsed wall-clock checks. Actual Android interface changes invalidate obsolete sessions before authenticated redial; foreground/resume refresh leaves healthy sessions intact. Two emulator background runs passed, with 18.4-second queued delivery after network return in the measured repeat. No claim of instant reconnection, autonomous process recreation, audible ringing or physical OEM behavior follows from this evidence.
